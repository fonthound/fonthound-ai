#!/usr/bin/env node
'use strict';

// FontHound's local MCP server for Claude Code. It hands Claude the fonts the
// user picked by eye in FontHound's Mockup, exactly, so a video is rendered
// in those fonts and nothing else.
//
// Everything stays on this computer: no network, no dependencies. It reads
// one file that FontHound writes when the user changes the Mockup or presses
// "Send to AI":
//   Windows: %APPDATA%\FontHound\ai-selection.json
//   macOS:   ~/Library/Application Support/FontHound/ai-selection.json
// and it can start the FontHound app with a line to try (open_fonthound).
//
// Tools:
//   get_font_selection  the selection (names, PostScript names, files, look)
//   get_font_files      each chosen font's file and whether it exists
//   open_fonthound      opens FontHound on its Fonts tab with the user's title line
//   wait_for_selection  waits until the user presses "Send to AI"
// Deliberately absent: a list of every installed font, and any tool that
// picks or recommends fonts. The user picks; the AI uses what was picked.
//
// Protocol: MCP over stdio, newline-delimited JSON-RPC 2.0, written by hand
// (initialize, ping, tools/list, tools/call, progress notifications).
// Run: node fonthound-mcp.js
// FONTHOUND_SELECTION_FILE and FONTHOUND_EXE override the two paths (tests).
//
// The Claude desktop app on Windows is an MSIX package. Everything it starts
// (this server, and a FontHound started directly from here) gets the
// package's file virtualization: writes under %APPDATA% and %LOCALAPPDATA%
// land in %LOCALAPPDATA%\Packages\<package>\LocalCache\..., and reads
// prefer that private copy (%TEMP% is not virtualized). A FontHound started
// inside the package would keep its selection and its license in private
// copies. So on Windows FontHound is always started by the Windows shell
// (explorer.exe with the path of fonthound.exe, as a double-click would),
// which runs it as a normal app; the line then reaches it through
// FontHound's own single-instance hand-over: a second fonthound.exe with
// the arguments passes them to the open window and exits at once. This
// server writes nothing in the user's folders except, when the frame is
// under %APPDATA% or %LOCALAPPDATA%, a copy of it in %TEMP%\FontHound.

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const NAME = 'fonthound';
const VERSION = '0.1.6';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DOWNLOAD = 'https://fonthound.app/download';
const NO_SELECTION = 'No FontHound selection yet. Ask the user to open FontHound, put the fonts they like in the Mockup and press "Send to AI", then try again.';
const OPENED = 'FontHound is open on its Fonts tab with the line shown in every font. Ask the user to add the fonts they like to the Mockup (+), adjust the look there, and press "Send to AI". Then call wait_for_selection with this `since`.';
const IMAGE = /\.(png|jpe?g|webp|bmp|gif)$/i;
// wait_for_selection: picking fonts by eye takes a while, but a chat waiting
// on a tool shows little, so one wait is short and Claude calls again
const WAIT_DEFAULT_S = 300;
const WAIT_MAX_S = 1800;
const PROGRESS_EVERY_MS = 15000;
// Starting FontHound on Windows: how long its window may take to appear,
// and how long the hand-over of the line may take
const READY_TIMEOUT_MS = 30000;
const READY_POLL_MS = 500;
const HANDOVER_TIMEOUT_MS = 4000;

function createServer(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const execFile = opts.execFile || childProcess.execFile;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now || Date.now;
  const homedir = opts.homedir || os.homedir;
  const fileExists = opts.fileExists || ((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  // the few file operations the Windows handling needs (tests pass stand-ins)
  const fsx = {
    readdir: (p) => fs.readdirSync(p),
    stat: (p) => fs.statSync(p, { bigint: true }),
    copyFile: (a, b) => fs.copyFileSync(a, b),
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
    ...opts.fs,
  };
  const timing = { readyTimeout: READY_TIMEOUT_MS, readyPoll: READY_POLL_MS, handoverTimeout: HANDOVER_TIMEOUT_MS, ...opts.timing };
  const log = opts.log || ((m) => process.stderr.write(`[fonthound] ${m}\n`));
  const win = path.win32;
  const windowsDir = env.SystemRoot || env.windir || 'C:\\Windows';
  const system32 = (exe) => win.join(windowsDir, 'System32', exe);

  // ---------- the selection file ----------

  function selectionFile() {
    if (env.FONTHOUND_SELECTION_FILE) return env.FONTHOUND_SELECTION_FILE;
    if (platform === 'win32') return win.join(env.APPDATA || win.join(homedir(), 'AppData', 'Roaming'), 'FontHound', 'ai-selection.json');
    if (platform === 'darwin') return path.posix.join(homedir(), 'Library', 'Application Support', 'FontHound', 'ai-selection.json');
    return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(homedir(), '.config'), 'FontHound', 'ai-selection.json');
  }

  // A stale private copy (Windows, inside an MSIX package such as the Claude
  // app). Plugin 0.1.2 and earlier started FontHound inside the package, so
  // its ai-selection.json could land in
  // %LOCALAPPDATA%\Packages\<package>\LocalCache\Roaming\FontHound\, and from
  // inside the package that copy hides the real file for good. This server
  // never deletes it: it says where it is so the user can. Found by its
  // effect: the copy and the path this server reads are the very same file.
  // Only that one file name is looked at, in each package folder, once;
  // after that only the copy found is checked again (until it's gone).
  function sameFile(a, b) {
    try {
      const x = fsx.stat(a);
      const y = fsx.stat(b);
      return x.isFile() && y.isFile() && BigInt(x.ino) !== 0n && BigInt(x.ino) === BigInt(y.ino) && BigInt(x.dev) === BigInt(y.dev);
    } catch { return false; }
  }
  let staleScanned = false;
  let stale = null;
  function staleCopy() {
    if (env.FONTHOUND_SELECTION_FILE || platform !== 'win32' || !env.LOCALAPPDATA) return null;
    const real = selectionFile();
    if (stale) {
      if (!sameFile(stale, real)) stale = null;
      return stale;
    }
    if (staleScanned) return null;
    staleScanned = true;
    let packages = [];
    try { packages = fsx.readdir(win.join(env.LOCALAPPDATA, 'Packages')); } catch { /* none */ }
    for (const name of packages) {
      const copy = win.join(env.LOCALAPPDATA, 'Packages', name, 'LocalCache', 'Roaming', 'FontHound', 'ai-selection.json');
      if (sameFile(copy, real)) {
        log(`stale private selection: ${copy}`);
        return (stale = copy);
      }
    }
    return null;
  }
  const staleMessage = (copy) => `FontHound's selection can't be read: an old copy in the Claude app's private storage hides the real one. It was left by an earlier version of this plugin, which started FontHound inside the Claude app. Ask the user to delete this one file (it is only that old copy; FontHound keeps the real selection elsewhere, and nothing else is affected), or delete it for them if they agree: ${copy}  Then call this tool again.`;

  // the parsed file (even without fonts), or null (no file, unreadable, damaged)
  function readFile() {
    let text;
    try { text = fs.readFileSync(selectionFile(), 'utf8'); } catch { return null; }
    try {
      const d = JSON.parse(text.replace(/^\uFEFF/, ''));
      return d && d.app === 'FontHound' && d.version === 1 ? d : null;
    } catch { return null; } // half-written or damaged: treated as none
  }

  // the selection, or null when there's none (no file, emptied, unreadable)
  function readSelection() {
    const d = readFile();
    return d && Array.isArray(d.fonts) && d.fonts.length ? d : null;
  }

  // ---------- starting FontHound ----------

  // a registry value (the installer's own key), or null; execFile only, no shell
  const reg = (key) => new Promise((resolve) => {
    execFile(system32('reg.exe'), ['query', key, '/ve'], { windowsHide: true }, (err, out) => {
      const m = !err && /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(String(out));
      resolve(m ? m[1].trim().replace(/^"|"$/g, '') : null);
    });
  });

  // where the installer put fonthound.exe: its registry entry (per user, or
  // for everyone), else the default folders (as premiere/panelupdate.js)
  async function windowsExe() {
    if (env.FONTHOUND_EXE) return fileExists(env.FONTHOUND_EXE) ? env.FONTHOUND_EXE : null;
    const dirs = [await reg('HKCU\\Software\\fonthound\\FontHound'), await reg('HKLM\\Software\\fonthound\\FontHound'),
      win.join(env.LOCALAPPDATA || win.join(homedir(), 'AppData', 'Local'), 'FontHound'),
      win.join(env.ProgramFiles || 'C:\\Program Files', 'FontHound')];
    return dirs.filter(Boolean).map((d) => win.join(d, 'fonthound.exe')).find(fileExists) || null;
  }

  // the program and arguments that open FontHound with `line`
  async function launchCommand(line, frame) {
    const args = ['--mockup-line', line, ...(frame ? ['--mockup-frame', frame] : [])];
    if (platform === 'win32') {
      const exe = await windowsExe();
      return exe ? { cmd: exe, args } : null;
    }
    if (platform === 'darwin') return { cmd: 'open', args: ['-a', 'FontHound', '--args', ...args] };
    return null;
  }

  // A frame under %APPDATA% or %LOCALAPPDATA% may exist only in a package's
  // private copy, invisible to FontHound: hand over a copy in %TEMP%, which
  // packages don't virtualize. Any other path is passed as it is.
  function shareFrame(frame) {
    const under = (dir) => dir && win.normalize(frame).toLowerCase().startsWith(win.normalize(dir).toLowerCase().replace(/\\?$/, '\\'));
    if (!under(env.APPDATA) && !under(env.LOCALAPPDATA)) return frame;
    const dir = win.join(env.TEMP || env.TMP || os.tmpdir(), 'FontHound');
    const copy = win.join(dir, 'claude-frame' + path.extname(frame).toLowerCase());
    if (win.normalize(frame).toLowerCase() === copy.toLowerCase()) return frame;
    try {
      fsx.mkdir(dir);
      fsx.copyFile(frame, copy);
      return copy;
    } catch (e) {
      log(`frame not copied (${e.message}); passing it as it is`);
      return frame;
    }
  }

  // Is a FontHound open and ready to take a line? tasklist lists one window
  // title per process: FontHound's own window, or the hidden window its
  // single-instance hand-over listens on ("<identifier>-siw"), which exists
  // before the main one. Either means a second fonthound.exe will hand over.
  const fontHoundReady = () => new Promise((resolve) => {
    execFile(system32('tasklist.exe'), ['/V', '/FI', 'IMAGENAME eq fonthound.exe', '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => {
      if (err) return resolve(false);
      const titles = String(out).split(/\r?\n/).filter((r) => /^"fonthound\.exe"/i.test(r)).map((r) => (/"([^"]*)"\s*$/.exec(r) || [])[1] || '');
      resolve(titles.some((t) => t === 'FontHound' || /-siw$/.test(t)));
    });
  });

  // Start fonthound.exe through the Windows shell: explorer.exe with its path
  // asks the shell to open it, as a double-click would, so it runs as a
  // normal app (outside any package). explorer.exe exits with 1 even when it
  // worked, so only "not found" counts as failure; then wait for the window.
  async function shellStart(exe) {
    const missing = await new Promise((resolve) => {
      execFile(win.join(windowsDir, 'explorer.exe'), [exe], { windowsHide: true }, (err) => resolve(!!(err && err.code === 'ENOENT')));
    });
    if (missing) return 'explorer.exe was not found';
    const until = now() + timing.readyTimeout;
    for (;;) {
      if (await fontHoundReady()) return null;
      if (now() >= until) return `FontHound didn't open within ${Math.round(timing.readyTimeout / 1000)} s`;
      await sleep(timing.readyPoll);
    }
  }

  // Hand `args` to the open FontHound: a second fonthound.exe passes them to
  // it and exits at once. One still running after the timeout didn't find
  // the open one and would become a second FontHound (inside the package,
  // when started from one), so it's closed again.
  function handOver(exe, args) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (why) => { if (!done) { done = true; clearTimeout(timer); resolve(why); } };
      const child = execFile(exe, args, { windowsHide: false }, (err) => finish(err ? `the hand-over failed (${err.code || err.message})` : null));
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* gone */ }
        finish('the open FontHound didn\'t take the line');
      }, timing.handoverTimeout);
    });
  }

  // Windows: FontHound open (started by the shell if needed), then the line
  // handed over. { ok: true } | { ok: false, opened, why }
  async function openOnWindows(exe, args) {
    let opened = await fontHoundReady();
    if (!opened) {
      const why = await shellStart(exe);
      if (why) return { ok: false, opened: false, why };
      opened = true;
    }
    const why = await handOver(exe, args);
    return why ? { ok: false, opened, why } : { ok: true };
  }

  // ---------- tools ----------

  const TOOLS = [
    {
      name: 'get_font_selection',
      title: 'Get the fonts picked in FontHound',
      description: 'Returns the fonts the user picked by eye in FontHound\'s Mockup (options 1-5): family, style, PostScript name, CSS font-family/weight/style, font file path (none for Adobe Fonts: load those by name only), and the look (size in px of the frame and % of frame width, colour, tracking, leading, stroke, shadow, background box, rotation, position), `licenseHint` when the font file looks like a trial, demo or personal-use font (tell the user once, then go on), plus the title line, the frame size and `sent` (when Send to AI was last pressed). Use these exact fonts; never substitute.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Get the fonts picked in FontHound', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'get_font_files',
      title: 'Check the picked fonts\' files',
      description: 'For each font picked in FontHound: its file path and whether the file exists on this computer, so it can be loaded from the file when loading by name fails (Remotion, HTML, ffmpeg, Pillow). Adobe Fonts have no path: load them by name only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Check the picked fonts\' files', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'open_fonthound',
      title: 'Open FontHound with the title',
      description: 'Opens the FontHound desktop app (installed on this computer) on its Fonts tab with the video\'s title line typed in, so the user sees the line in their own installed fonts and picks by eye; optionally sets a still frame from the video as the Mockup background. Starts FontHound if it isn\'t open. It does not pick fonts or return any. After calling it, call wait_for_selection with the returned `since`.',
      inputSchema: {
        type: 'object',
        properties: {
          line: { type: 'string', description: 'The title text exactly as it will appear in the video (up to 1000 characters).' },
          frame_path: { type: 'string', description: 'Optional absolute path to a PNG, JPEG, WebP, BMP or GIF still from the video, shown behind the fonts in the Mockup.' },
        },
        required: ['line'],
        additionalProperties: false,
      },
      annotations: { title: 'Open FontHound with the title', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'wait_for_selection',
      title: 'Wait for the user to send fonts',
      description: `Waits until the user presses "Send to AI" in FontHound (after \`since\`), then returns the selection like get_font_selection. Waits ${WAIT_DEFAULT_S / 60} minutes by default, then returns status "timeout" (with \`since\`); then call get_font_selection: if its selection's \`sent\` is after \`since\`, use it; otherwise tell the user you're still waiting (or ask whether they're done) and call wait_for_selection again with the same \`since\`.`,
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'ISO time from open_fonthound; only a "Send to AI" after it counts. Default: now.' },
          timeout_s: { type: 'number', description: `Seconds to wait (1-${WAIT_MAX_S}, default ${WAIT_DEFAULT_S}).` },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Wait for the user to send fonts', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ];

  const ok = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }], structuredContent: o });
  const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

  // ctx.progress(done, total, message): an MCP progress notification, when the client asked for them
  async function callTool(name, args, ctx = {}) {
    args = args && typeof args === 'object' ? args : {};
    // a stale private copy hides the real selection: say so instead of handing it out
    if (['get_font_selection', 'get_font_files', 'wait_for_selection'].includes(name) && staleCopy()) {
      return ok({ status: 'stale-copy', file: stale, message: staleMessage(stale) });
    }
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
      const launch = await launchCommand(line, frame && platform === 'win32' ? shareFrame(frame) : frame);
      if (!launch) {
        return fail(platform === 'win32' || platform === 'darwin'
          ? `FontHound isn't installed on this computer (fonthound.exe wasn't found). The user can get a free 14-day trial at ${DOWNLOAD}, or pick fonts some other way.`
          : 'FontHound runs on Windows (and soon macOS); it can\'t be opened here.');
      }
      const since = new Date(now()).toISOString();
      const extra = staleCopy() ? { warning: staleMessage(stale) } : {};
      if (platform === 'win32') {
        const r = await openOnWindows(launch.cmd, launch.args);
        if (r.ok) return ok({ status: 'opened', since, message: `${OPENED} (If FontHound doesn't come to the front, it's on the taskbar.)`, ...extra });
        log(`open_fonthound: ${r.why}`);
        return ok({
          status: r.opened ? 'opened-without-line' : 'not-opened',
          since,
          line,
          message: r.opened
            ? `FontHound is open, but the line couldn't be handed to it (${r.why}). Ask the user to type the line on its Fonts tab, add the fonts they like to the Mockup (+) and press "Send to AI". Then call wait_for_selection with this \`since\`.`
            : `FontHound couldn't be opened from here (${r.why}). Ask the user to open FontHound themselves (Start menu), type the line on its Fonts tab, add the fonts they like to the Mockup (+) and press "Send to AI". Then call wait_for_selection with this \`since\`.`,
          ...extra,
        });
      }
      try {
        await new Promise((resolve, reject) => {
          const child = execFile(launch.cmd, launch.args, { windowsHide: false }, (err) => { if (err && err.code === 'ENOENT') reject(err); });
          if (child && typeof child.unref === 'function') child.unref();
          // the app keeps running; a start that fails shows up at once
          setTimeout(resolve, 300);
        });
      } catch (e) {
        return fail(`FontHound couldn't be started (${e.message}). Ask the user to open FontHound themselves, type the line on its Fonts tab and press "Send to AI" when done.`);
      }
      return ok({ status: 'opened', since, message: OPENED });
    }
    if (name === 'wait_for_selection') {
      const since = Date.parse(args.since) || now();
      const seconds = Math.min(WAIT_MAX_S, Math.max(1, Number(args.timeout_s) || WAIT_DEFAULT_S));
      const start = now();
      const until = start + seconds * 1000;
      let nextProgress = start + PROGRESS_EVERY_MS;
      // the selection, if "Send to AI" was pressed after `since`
      const sentSince = () => {
        const sel = readSelection();
        return sel && Date.parse(sel.sent) > since ? sel : null;
      };
      for (;;) {
        const sel = sentSince();
        if (sel) return ok({ status: 'ok', selection: sel });
        if (now() >= until) break;
        if (ctx.progress && now() >= nextProgress) {
          ctx.progress(Math.round((now() - start) / 1000), seconds, 'Waiting for "Send to AI" in FontHound');
          nextProgress += PROGRESS_EVERY_MS;
        }
        await sleep(Math.min(1000, Math.max(0, until - now())));
      }
      // one last look: a Send that landed just as the time ran out still counts
      const late = sentSince();
      if (late) return ok({ status: 'ok', selection: late });
      const sinceIso = new Date(since).toISOString();
      // what the file shows: helps tell "still picking" from "nothing arrives"
      const file = readFile();
      const changed = file && Date.parse(file.updated) > since;
      return ok({
        status: 'timeout',
        since: sinceIso,
        timeout_s: seconds,
        lastUpdate: file ? file.updated || null : null,
        lastSent: file ? file.sent || null : null,
        message: `Nothing was sent from FontHound in ${seconds} s.${changed ? ' The Mockup did change meanwhile, so the user is still picking.' : ''} Call get_font_selection: if its selection's \`sent\` is after ${sinceIso}, the user sent it meanwhile, so use it. Otherwise tell the user you're waiting for "Send to AI" in the Mockup (or ask whether they've finished picking), then call wait_for_selection again with the same \`since\` to keep waiting.`,
      });
    }
    return null;
  }

  // ---------- JSON-RPC ----------

  // notify(message): sends a notification to the client (progress)
  async function handle(msg, notify) {
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
        const token = p._meta && p._meta.progressToken;
        const ctx = token !== undefined && token !== null && typeof notify === 'function'
          ? { progress: (progress, total, message) => notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress, total, message } }) }
          : {};
        try {
          const r = await callTool(p.name, p.arguments, ctx);
          return r ? reply(r) : error(-32602, `Unknown tool: ${p.name}`);
        } catch (e) {
          return reply(fail(`FontHound tool failed: ${e.message}`));
        }
      }
      default: return error(-32601, `Method not found: ${msg.method}`);
    }
  }

  return { handle, callTool, TOOLS, selectionFile, launchCommand, readSelection, staleCopy };
}

// stdio: one JSON message per line in, one per line out; logs go to stderr
function serveStdio(server, input = process.stdin, output = process.stdout) {
  let buf = '';
  const send = (m) => output.write(JSON.stringify(m) + '\n');
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
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      Promise.resolve(server.handle(msg, send)).then((r) => { if (r) send(r); });
    }
  });
}

module.exports = { createServer, serveStdio };
if (require.main === module) serveStdio(createServer());
