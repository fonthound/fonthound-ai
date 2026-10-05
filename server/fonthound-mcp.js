#!/usr/bin/env node
'use strict';

// FontHound's local MCP server for Claude Code. It hands Claude the fonts the
// user picked by eye in FontHound's Mockup, exactly, so a video is rendered
// in those fonts and nothing else.
//
// Everything stays on this computer: no network, no dependencies, no data
// written anywhere. It reads one file that FontHound writes when the user
// changes the Mockup or presses "Send to AI":
//   Windows: %APPDATA%\FontHound\ai-selection.json
//   macOS:   ~/Library/Application Support/FontHound/ai-selection.json
// and it can start the FontHound app with a line to try (open_fonthound).
//
// Tools:
//   get_font_selection  the selection (names, PostScript names, files, look)
//   get_font_files      each chosen font's file and whether it exists
//   open_fonthound      opens FontHound's Mockup with the user's title line
//   wait_for_selection  waits until the user presses "Send to AI"
// Deliberately absent: a list of every installed font, and any tool that
// picks or recommends fonts. The user picks; the AI uses what was picked.
//
// Protocol: MCP over stdio, newline-delimited JSON-RPC 2.0, written by hand
// (initialize, ping, tools/list, tools/call). Run: node fonthound-mcp.js
// FONTHOUND_SELECTION_FILE and FONTHOUND_EXE override the two paths (tests).

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const NAME = 'fonthound';
const VERSION = '0.1.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DOWNLOAD = 'https://fonthound.app/download';
const NO_SELECTION = 'No FontHound selection yet. Ask the user to open FontHound, put the fonts they like in the Mockup and press "Send to AI", then try again.';
const IMAGE = /\.(png|jpe?g|webp|bmp|gif)$/i;

function createServer(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const execFile = opts.execFile || childProcess.execFile;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const homedir = opts.homedir || os.homedir;
  const fileExists = opts.fileExists || ((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

  // ---------- the selection file ----------

  function selectionFile() {
    if (env.FONTHOUND_SELECTION_FILE) return env.FONTHOUND_SELECTION_FILE;
    if (platform === 'win32') return path.win32.join(env.APPDATA || path.win32.join(homedir(), 'AppData', 'Roaming'), 'FontHound', 'ai-selection.json');
    if (platform === 'darwin') return path.posix.join(homedir(), 'Library', 'Application Support', 'FontHound', 'ai-selection.json');
    return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(homedir(), '.config'), 'FontHound', 'ai-selection.json');
  }

  // the selection, or null when there's none (no file, emptied, unreadable)
  function readSelection() {
    let text;
    try { text = fs.readFileSync(selectionFile(), 'utf8'); } catch { return null; }
    try {
      const d = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (d && d.app === 'FontHound' && d.version === 1 && Array.isArray(d.fonts) && d.fonts.length) return d;
    } catch { /* half-written or damaged: treated as none */ }
    return null;
  }

  // ---------- starting FontHound ----------

  // a registry value (the installer's own key), or null; execFile only, no shell
  const reg = (key) => new Promise((resolve) => {
    execFile('reg', ['query', key, '/ve'], { windowsHide: true }, (err, out) => {
      const m = !err && /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(String(out));
      resolve(m ? m[1].trim().replace(/^"|"$/g, '') : null);
    });
  });

  // where the installer put fonthound.exe: its registry entry (per user, or
  // for everyone), else the default folders (as premiere/panelupdate.js)
  async function windowsExe() {
    if (env.FONTHOUND_EXE) return fileExists(env.FONTHOUND_EXE) ? env.FONTHOUND_EXE : null;
    const dirs = [await reg('HKCU\\Software\\fonthound\\FontHound'), await reg('HKLM\\Software\\fonthound\\FontHound'),
      path.win32.join(env.LOCALAPPDATA || path.win32.join(homedir(), 'AppData', 'Local'), 'FontHound'),
      path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'FontHound')];
    return dirs.filter(Boolean).map((d) => path.win32.join(d, 'fonthound.exe')).find(fileExists) || null;
  }

  // the program and arguments that open FontHound's Mockup with `line`
  async function launchCommand(line, frame) {
    const args = ['--mockup-line', line, ...(frame ? ['--mockup-frame', frame] : [])];
    if (platform === 'win32') {
      const exe = await windowsExe();
      return exe ? { cmd: exe, args } : null;
    }
    if (platform === 'darwin') return { cmd: 'open', args: ['-a', 'FontHound', '--args', ...args] };
    return null;
  }

  // ---------- tools ----------

  const TOOLS = [
    {
      name: 'get_font_selection',
      title: 'Get the fonts picked in FontHound',
      description: 'Returns the fonts the user picked by eye in FontHound\'s Mockup (options 1-5): family, style, PostScript name, CSS font-family/weight/style, font file path (none for Adobe Fonts: load those by name only), and the look (size in px of the frame and % of frame width, colour, tracking, leading, stroke, shadow, background box, rotation, position), plus the title line and the frame size. Use these exact fonts; never substitute.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'get_font_files',
      title: 'Check the picked fonts\' files',
      description: 'For each font picked in FontHound: its file path and whether the file exists on this computer, so it can be loaded from the file when loading by name fails (Remotion, HTML, ffmpeg, Pillow). Adobe Fonts have no path: load them by name only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'open_fonthound',
      title: 'Open FontHound with the title',
      description: 'Opens the FontHound app on this computer at its Mockup, with the video\'s title line typed in (and optionally a still frame from the video as the background), so the user can see the line in their own installed fonts and pick by eye. After calling it, call wait_for_selection with the returned `since`.',
      inputSchema: {
        type: 'object',
        properties: {
          line: { type: 'string', description: 'The title text exactly as it will appear in the video (up to 1000 characters).' },
          frame_path: { type: 'string', description: 'Optional absolute path to a PNG/JPEG/WebP still from the video, shown behind the fonts.' },
        },
        required: ['line'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'wait_for_selection',
      title: 'Wait for the user to send fonts',
      description: 'Waits until the user presses "Send to AI" in FontHound (after `since`), then returns the selection like get_font_selection. Returns status "timeout" if nothing was sent in time; then ask the user whether they are done.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'ISO time from open_fonthound; only a "Send to AI" after it counts. Default: now.' },
          timeout_s: { type: 'number', description: 'Seconds to wait (1-1800, default 600).' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ];

  const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj });
  const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

  async function callTool(name, args) {
    args = args && typeof args === 'object' ? args : {};
    if (name === 'get_font_selection') {
      const sel = readSelection();
      return ok(sel ? { status: 'ok', selection: sel } : { status: 'no-selection', message: NO_SELECTION });
    }
    if (name === 'get_font_files') {
      const sel = readSelection();
      if (!sel) return ok({ status: 'no-selection', message: NO_SELECTION });
      return ok({
        status: 'ok',
        fonts: sel.fonts.map((f) => ({
          option: f.option, family: f.family, style: f.style, postscriptName: f.postscriptName, source: f.source,
          file: f.file || null, exists: f.file ? fileExists(f.file) : false,
          note: f.file ? (fileExists(f.file) ? null : 'the file is no longer there: load the font by name, or ask the user to check it is installed') : f.note,
        })),
      });
    }
    if (name === 'open_fonthound') {
      const line = typeof args.line === 'string' ? args.line.trim() : '';
      if (!line) return fail('open_fonthound needs `line`: the title text to try in FontHound.');
      if (line.length > 1000) return fail('The line is too long for FontHound (1000 characters at most).');
      let frame = null;
      if (args.frame_path !== undefined && args.frame_path !== '') {
        if (typeof args.frame_path !== 'string' || !IMAGE.test(args.frame_path) || !fileExists(args.frame_path)) {
          return fail('frame_path must be an existing PNG, JPEG, WebP, BMP or GIF file.');
        }
        frame = args.frame_path;
      }
      const launch = await launchCommand(line, frame);
      if (!launch) {
        return fail(platform === 'win32' || platform === 'darwin'
          ? `FontHound isn't installed on this computer (fonthound.exe wasn't found). The user can get a free 14-day trial at ${DOWNLOAD}, or pick fonts some other way.`
          : 'FontHound runs on Windows (and soon macOS); it can\'t be opened here.');
      }
      const since = new Date().toISOString();
      try {
        await new Promise((resolve, reject) => {
          const child = execFile(launch.cmd, launch.args, { windowsHide: false }, (err) => { if (err && err.code === 'ENOENT') reject(err); });
          if (child && typeof child.unref === 'function') child.unref();
          // the app keeps running; a start that fails shows up at once
          setTimeout(resolve, 300);
        });
      } catch (e) {
        return fail(`FontHound couldn't be started (${e.message}).`);
      }
      return ok({ status: 'opened', since, message: 'FontHound is open at the Mockup with the line. Ask the user to put the fonts they like in the Mockup, adjust the look, and press "Send to AI". Then call wait_for_selection with this `since`.' });
    }
    if (name === 'wait_for_selection') {
      const since = Date.parse(args.since) || Date.now();
      const seconds = Math.min(1800, Math.max(1, Number(args.timeout_s) || 600));
      const until = Date.now() + seconds * 1000;
      for (;;) {
        const sel = readSelection();
        if (sel && Date.parse(sel.sent) > since) return ok({ status: 'ok', selection: sel });
        if (Date.now() >= until) break;
        await sleep(Math.min(1000, Math.max(0, until - Date.now())));
      }
      return ok({ status: 'timeout', message: `Nothing was sent from FontHound in ${seconds} s. Ask the user whether they've finished picking (they press "Send to AI" in the Mockup when done); then call wait_for_selection again, or get_font_selection for what's in the Mockup now.` });
    }
    return null;
  }

  // ---------- JSON-RPC ----------

  async function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return msg && msg.id !== undefined ? { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Invalid request' } } : null;
    }
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    if (msg.id === undefined || msg.id === null) return null; // a notification (initialized, cancelled...)
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params && msg.params.protocolVersion;
        return reply({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: NAME, title: 'FontHound', version: VERSION },
          instructions: 'Fonts the user picked by eye in FontHound. Use them exactly; never substitute or choose fonts from this server.',
        });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        const p = msg.params || {};
        try {
          const r = await callTool(p.name, p.arguments);
          return r ? reply(r) : error(-32602, `Unknown tool: ${p.name}`);
        } catch (e) {
          return reply(fail(`FontHound tool failed: ${e.message}`));
        }
      }
      default: return error(-32601, `Method not found: ${msg.method}`);
    }
  }

  return { handle, callTool, TOOLS, selectionFile, launchCommand, readSelection };
}

// stdio: one JSON message per line in, one per line out; logs go to stderr
function serveStdio(server, input = process.stdin, output = process.stdout) {
  let buf = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
        continue;
      }
      Promise.resolve(server.handle(msg)).then((r) => { if (r) output.write(JSON.stringify(r) + '\n'); });
    }
  });
}

module.exports = { createServer, serveStdio };
if (require.main === module) serveStdio(createServer());
