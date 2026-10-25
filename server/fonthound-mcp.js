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
//   open_fonthound      opens FontHound on its Fonts tab with the user's text
//   wait_for_selection  waits until the user presses "Send to AI"
//   fonthound_status    whether FontHound is installed here (opens nothing)
//   offer_font_picking  the same check, as the step before any font is chosen:
//                       the question to ask the user (its description is the trigger)
// and one prompt, pick-fonts ("Pick fonts with FontHound").
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
// land in a private copy (%TEMP% is not virtualized). A FontHound started
// inside the package would keep its selection and its license there. So on
// Windows FontHound is started by the Windows shell (explorer.exe with the
// path of fonthound.exe, as a double-click would), which runs it as a normal
// app; the line then reaches it through FontHound's own single-instance
// hand-over: a second fonthound.exe with the arguments passes them to the
// open window and exits at once.
//
// Kept deliberately plain, because antivirus behaviour monitors judge a
// script by what it does: no registry queries, no process or window
// listing, no scan of other apps' folders, no hidden windows, no shell.
// FontHound is found in its install folders or through its Start-menu
// shortcut, and "is it open?" is answered by a file: the lock file its
// window's web view holds while the app runs (Windows removes it when the
// app closes). The server only reads files, starts explorer.exe or
// fonthound.exe, and writes at most a copy of a still frame in
// %TEMP%\FontHound.

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const NAME = 'fonthound';
const VERSION = '0.2.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// Where someone without FontHound goes: the free 14-day trial at /download (on a
// Mac the same page offers the Mac waitlist instead)
const TRIAL_URL = 'https://fonthound.app/download?utm_source=claude-plugin&utm_medium=plugin';
const NOT_INSTALLED_WIN = `FontHound isn't installed. It's a Windows font browser that shows the user's own text in every font they have, so they pick by eye and send the picks straight to Claude. Free 14-day trial: ${TRIAL_URL}`;
const NOT_INSTALLED_MAC = `FontHound is for Windows today; the Mac version is coming. Join the Mac waitlist: ${TRIAL_URL}`;
const NOT_HERE = 'FontHound runs on Windows (and soon macOS); it can\'t be opened here.';
const NO_SELECTION = 'No FontHound selection yet. Ask the user to open FontHound, put the fonts they like in the Mockup and press "Send to AI", then try again.';
const OPENED = 'FontHound is open on its Fonts tab with the line shown in every font. Ask the user to add the fonts they like to the Mockup (+), adjust the look there, and press "Send to AI". Then call wait_for_selection with this `since`.';
// What Claude reads when it connects: the skill's rules in short, for the
// places that load no skill (the Claude desktop app's chat). The same text
// as INSTRUCTIONS in src-tauri/src/mcp.rs (fonthound --mcp).
const INSTRUCTIONS = [
  "FontHound is a font browser on the user's computer: they see their own text in their own installed fonts and pick by eye. These tools hand you exactly the fonts they picked.",
  "- Before you choose a font for anything with text (a video, image, thumbnail, poster, slide, logo, captions, a mockup's headlines), call offer_font_picking first. Installed: ask its question once per task, \"Want to pick the fonts by eye in FontHound?\" Not installed: pass on its message once per conversation, then choose the fonts yourself.",
  "- Don't ask again in a conversation where the user said no or \"you choose\", or when the fonts are already fixed (a brand font they named, a template whose fonts they keep).",
  "- Yes: call open_fonthound with the text exactly as it will appear (and frame_path, a still of the work, if you have one). Tell the user to add the fonts they like to the Mockup (+) and press Send to AI, then call wait_for_selection with the returned since. On \"timeout\", call get_font_selection: if its sent is after since, use it; otherwise say you're still waiting and call wait_for_selection again with the same since.",
  "- The picks fix the typeface: use the exact family, weight and style, and never substitute a font or quietly fall back. Still design the piece fully as you normally would (background, layout, palette, composition, supporting elements) for what the user asked. From `look`, keep only what the user styled (`look.styled`, the frame's `styled`: their own still or colour); the rest are FontHound's defaults, a starting point, not a spec. One option: use it. Several: ask whether to use one for everything, split them, or make a version with each.",
  "- Load fonts by name first (fullName, then postscriptName), then from file, in the exact weight and style. Adobe Fonts (source \"adobe-fonts\") load by name only. Scale what you take from the look by your width / frame.width.",
  "- licenseHint: tell the user once, briefly, then carry on with the font.",
  "- Before sending a font file to any third party (a cloud renderer, an upload), call get_font_files: only licence.kind \"open\" may go. Otherwise ask the user to reply Continue or Cancel, and never upload by default; Adobe Fonts never.",
  "- This server never chooses or recommends fonts: the user picks, you use what was picked.",
].join('\n');
// offer_font_picking: what Claude asks, and what it does next
const ASK = 'Want to pick the fonts by eye in FontHound?';
const NEXT_YES = 'If yes: call open_fonthound with the text exactly as it will appear (and frame_path, a still of the work, if you have one), tell the user to add the fonts they like to the Mockup (+) and press Send to AI, then call wait_for_selection with the returned `since` and use exactly the fonts that come back. If no: choose the fonts yourself and don\'t offer FontHound again in this conversation.';
const NEXT_NOT_INSTALLED = 'Say this once, in a few words, then choose the fonts yourself; don\'t offer FontHound again in this conversation.';
// the one MCP prompt: "Pick fonts with FontHound" (a client may list it in its menu)
const PROMPTS = [{
  name: 'pick-fonts',
  title: 'Pick fonts with FontHound',
  description: 'Pick the fonts for what Claude makes by eye in FontHound, on your own text, before Claude chooses any.',
  arguments: [{ name: 'text', description: 'The text to try in the fonts (a title, headline or caption). Optional.', required: false }],
}];
function promptText(text) {
  const what = text ? `this text: "${text}"` : 'the main text of what we\'re making';
  return `Before you choose any fonts for what we're making, open FontHound with ${what}, so I can pick the fonts by eye. Use open_fonthound, wait for my Send to AI with wait_for_selection, then use exactly the fonts I send.`;
}
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
    readFile: (p) => fs.readFileSync(p),
    copyFile: (a, b) => fs.copyFileSync(a, b),
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
    ...opts.fs,
  };
  const timing = { readyTimeout: READY_TIMEOUT_MS, readyPoll: READY_POLL_MS, handoverTimeout: HANDOVER_TIMEOUT_MS, ...opts.timing };
  const log = opts.log || ((m) => process.stderr.write(`[fonthound] ${m}\n`));
  const win = path.win32;
  const windowsDir = env.SystemRoot || env.windir || 'C:\\Windows';
  const localAppData = env.LOCALAPPDATA || win.join(homedir(), 'AppData', 'Local');

  // ---------- the selection file ----------

  function selectionFile() {
    if (env.FONTHOUND_SELECTION_FILE) return env.FONTHOUND_SELECTION_FILE;
    if (platform === 'win32') return win.join(env.APPDATA || win.join(homedir(), 'AppData', 'Roaming'), 'FontHound', 'ai-selection.json');
    if (platform === 'darwin') return path.posix.join(homedir(), 'Library', 'Application Support', 'FontHound', 'ai-selection.json');
    return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(homedir(), '.config'), 'FontHound', 'ai-selection.json');
  }

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

  // Where FontHound is: its install folders (for one user, for everyone,
  // and the folder of FontHound 0.7 and earlier), else wherever its
  // Start-menu shortcut points (a folder the user chose in Setup).
  function windowsExe() {
    if (env.FONTHOUND_EXE) return fileExists(env.FONTHOUND_EXE) ? env.FONTHOUND_EXE : null;
    const dirs = [win.join(localAppData, 'Programs', 'FontHound'),
      win.join(env.ProgramFiles || 'C:\\Program Files', 'FontHound'),
      win.join(localAppData, 'FontHound')];
    const found = dirs.map((d) => win.join(d, 'fonthound.exe')).find(fileExists);
    if (found) return found;
    const menus = [env.APPDATA && win.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      win.join(env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs')].filter(Boolean);
    for (const menu of menus) {
      for (const lnk of [win.join(menu, 'FontHound.lnk'), win.join(menu, 'FontHound', 'FontHound.lnk')]) {
        const target = shortcutTarget(lnk);
        if (target && /\\fonthound\.exe$/i.test(target) && fileExists(target)) return target;
      }
    }
    return null;
  }

  // The local path a Windows shortcut (.lnk) points to, or null. Reads the
  // documented Shell Link format ([MS-SHLLINK]): the header, the item list
  // (skipped), then the LinkInfo block with the target's local path.
  function shortcutTarget(lnk) {
    let b;
    try { b = fsx.readFile(lnk); } catch { return null; }
    try {
      if (b.length < 0x4c || b.readUInt32LE(0) !== 0x4c) return null;
      const flags = b.readUInt32LE(0x14);
      let at = 0x4c;
      if (flags & 0x1) at += 2 + b.readUInt16LE(at); // HasLinkTargetIDList
      if (!(flags & 0x2)) return null; // HasLinkInfo
      const headerSize = b.readUInt32LE(at + 4);
      if (!(b.readUInt32LE(at + 8) & 0x1)) return null; // VolumeIDAndLocalBasePath
      if (headerSize >= 0x24) { // a Unicode path too
        const start = at + b.readUInt32LE(at + 0x1c);
        let end = start;
        while (end + 1 < b.length && b.readUInt16LE(end) !== 0) end += 2;
        const p = b.toString('utf16le', start, end);
        if (p) return p;
      }
      const start = at + b.readUInt32LE(at + 0x10);
      const end = b.indexOf(0, start);
      return b.toString('latin1', start, end < 0 ? b.length : end) || null;
    } catch { return null; }
  }

  // macOS: FontHound.app in /Applications or ~/Applications (looked for by
  // a file inside the bundle, since a bundle is a folder)
  function macApp() {
    const apps = ['/Applications', path.posix.join(homedir(), 'Applications')].map((d) => path.posix.join(d, 'FontHound.app'));
    return apps.find((a) => fileExists(path.posix.join(a, 'Contents', 'Info.plist'))) || null;
  }

  // Is FontHound installed here? The same look open_fonthound takes, no more
  function installed() {
    if (platform === 'win32') return !!windowsExe();
    if (platform === 'darwin') return !!macApp();
    return false;
  }

  // what to tell the user when FontHound isn't installed here
  const notInstalled = () => (platform === 'win32' ? NOT_INSTALLED_WIN : platform === 'darwin' ? NOT_INSTALLED_MAC : NOT_HERE);

  // the program and arguments that open FontHound with `line`
  async function launchCommand(line, frame) {
    const args = ['--mockup-line', line, ...(frame ? ['--mockup-frame', frame] : [])];
    if (platform === 'win32') {
      const exe = await windowsExe();
      return exe ? { cmd: exe, args } : null;
    }
    if (platform === 'darwin') return macApp() ? { cmd: 'open', args: ['-a', 'FontHound', '--args', ...args] } : null;
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

  // Is FontHound open and ready to take a line? Its window's web view
  // (WebView2) holds a lock file in FontHound's web data folder while the
  // app runs; Windows removes it when the app closes, even after a crash.
  // The single-instance hand-over is set up before the web view starts, so
  // once the file is there, a second fonthound.exe hands over.
  const lockFile = () => win.join(localAppData, 'app.fonthound.desktop', 'EBWebView', 'lockfile');
  const fontHoundReady = () => fileExists(lockFile());

  // Start fonthound.exe through the Windows shell: explorer.exe with its path
  // asks the shell to open it, as a double-click would, so it runs as a
  // normal app (outside any package). explorer.exe exits with 1 even when it
  // worked, so only "not found" counts as failure; then wait for the window.
  async function shellStart(exe) {
    const missing = await new Promise((resolve) => {
      execFile(win.join(windowsDir, 'explorer.exe'), [exe], {}, (err) => resolve(!!(err && err.code === 'ENOENT')));
    });
    if (missing) return 'explorer.exe was not found';
    const until = now() + timing.readyTimeout;
    for (;;) {
      if (fontHoundReady()) return null;
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
      const child = execFile(exe, args, {}, (err) => finish(err ? `the hand-over failed (${err.code || err.message})` : null));
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* gone */ }
        finish('the open FontHound didn\'t take the line');
      }, timing.handoverTimeout);
    });
  }

  // Windows: FontHound open (started by the shell if needed), then the line
  // handed over. { ok: true } | { ok: false, opened, why }
  async function openOnWindows(exe, args) {
    let opened = fontHoundReady();
    if (!opened) {
      const why = await shellStart(exe);
      if (why) return { ok: false, opened: false, why };
      opened = true;
    }
    const why = await handOver(exe, args);
    return why ? { ok: false, opened, why } : { ok: true };
  }

  // ---------- a font's licence, from its own file ----------

  // Open licences, recognised in the font's licence description and URL
  // (name table IDs 13 and 14). Anything else is the user's to check.
  const OPEN_LICENCES = [
    ['SIL Open Font License', /SIL Open Font Licen[cs]e|\bOFL\b|openfontlicense\.org|scripts\.sil\.org\/OFL/i],
    ['Apache License', /Apache License|apache\.org\/licenses/i],
    ['Ubuntu Font Licence', /Ubuntu Font Licen[cs]e|ubuntu\.com\/legal\/font-licen[cs]e/i],
  ];

  // What a TrueType/OpenType file (or the first font of a collection) says
  // about its licence: { kind: 'open' | 'restricted-embedding' | 'unknown',
  // name, url }, or null when the file can't be read. Reads only the table
  // directory, the name table and the OS/2 table. 'restricted-embedding':
  // the maker set OS/2 fsType "Restricted License embedding" (bit 1), a sign
  // the file isn't meant to be passed on.
  function fontLicence(file) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const at = (pos, len) => {
        if (pos < 0 || len < 0 || pos + len > size) throw new Error('outside the file');
        const b = Buffer.alloc(len);
        fs.readSync(fd, b, 0, len, pos);
        return b;
      };
      let dir = 0;
      if (at(0, 4).toString('latin1') === 'ttcf') dir = at(12, 4).readUInt32BE(0);
      const numTables = at(dir + 4, 2).readUInt16BE(0);
      const records = at(dir + 12, numTables * 16);
      const tables = {};
      for (let i = 0; i < numTables; i++) {
        tables[records.toString('latin1', i * 16, i * 16 + 4)] = { offset: records.readUInt32BE(i * 16 + 8), length: records.readUInt32BE(i * 16 + 12) };
      }
      const strings = { 13: '', 14: '' };
      if (tables.name && tables.name.length < 4 * 1024 * 1024) {
        const n = at(tables.name.offset, tables.name.length);
        const count = n.readUInt16BE(2);
        const store = n.readUInt16BE(4);
        for (let i = 0; i < count; i++) {
          const r = 6 + i * 12;
          const platform = n.readUInt16BE(r);
          const id = n.readUInt16BE(r + 6);
          if (!(id in strings) || strings[id]) continue;
          const len = n.readUInt16BE(r + 8);
          const start = store + n.readUInt16BE(r + 10);
          if (start + len > n.length) continue;
          const raw = n.subarray(start, start + len);
          // Windows and Unicode platforms: UTF-16 big-endian; Mac: one byte a character
          strings[id] = platform === 1 ? raw.toString('latin1') : Buffer.from(raw).swap16().toString('utf16le');
        }
      }
      const text = strings[13].trim();
      const url = strings[14].trim() || null;
      // a text that also restricts use (a proprietary font with some open
      // components, say) is never taken as open
      const restricted = /prohibited|may only|not permitted|Microsoft supplied font|end[- ]user licen[cs]e|EULA/i.test(text);
      const open = !restricted && OPEN_LICENCES.find(([, re]) => re.test(text) || (url && re.test(url)));
      if (open) return { kind: 'open', name: open[0], url };
      const fsType = tables['OS/2'] && tables['OS/2'].length >= 10 ? at(tables['OS/2'].offset + 8, 2).readUInt16BE(0) : 0;
      return { kind: (fsType & 0x000f) === 0x0002 ? 'restricted-embedding' : 'unknown', name: text ? text.slice(0, 300) : null, url };
    } catch {
      return null;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
    }
  }

  // The licence for one picked font: from its file, else from where it came from
  function licenceOf(f, exists) {
    if (f.source === 'adobe-fonts') return { kind: 'adobe-fonts', name: 'Adobe Fonts', url: null };
    if (f.file && exists) return fontLicence(f.file) || { kind: 'unknown', name: null, url: null };
    const from = f.webFont && f.webFont.from;
    // Google Fonts and Fontsource carry only open-licence fonts
    if (from === 'Google Fonts' || from === 'Fontsource') return { kind: 'open', name: `open licence (${from})`, url: null };
    return { kind: 'unknown', name: null, url: null };
  }

  // ---------- tools ----------

  const TOOLS = [
    {
      name: 'offer_font_picking',
      title: 'Offer to pick the fonts in FontHound',
      description: 'Use BEFORE you choose any font for something you make that shows text: a poster, flyer, ad, thumbnail, social post, banner, slide or deck, logo or wordmark, video titles or captions, an image, an HTML/CSS page, an artifact or a design mockup. The user has FontHound, a font browser on this computer where they see their own text in their own installed fonts and pick by eye. Call this first (it opens nothing and sends nothing): it returns `ask`, one short question to put to the user, or `message` when FontHound isn\'t installed (say it once, then choose the fonts yourself). If the user says yes, call open_fonthound with the text, then wait_for_selection, and use exactly the fonts that come back. Don\'t call it again in a conversation where the user said no or "you choose", or when the fonts are already fixed (a brand font they named, a template whose fonts they keep).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Offer to pick the fonts in FontHound', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'get_font_selection',
      title: 'Get the fonts picked in FontHound',
      description: 'Returns the fonts the user picked by eye in FontHound\'s Mockup (options 1-5): family, style, PostScript name, CSS font-family/weight/style, font file path (none for Adobe Fonts: load those by name only), and the look (size in px of the frame and % of frame width, colour, tracking, leading, stroke, shadow, background box, rotation, position), `licenseHint` when the font file looks like a trial, demo or personal-use font (tell the user once, then go on), plus the title line, the frame size and `sent` (when Send to AI was last pressed). Use these exact fonts; never substitute. The fonts are fixed; the look is a starting point: `styled` lists what the user set for this piece (the rest are defaults), and you design the rest as the request asks.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Get the fonts picked in FontHound', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'get_font_files',
      title: 'Check the picked fonts\' files',
      description: 'For each font picked in FontHound: its file path and whether the file exists on this computer, so it can be loaded from the file when loading by name fails (Remotion, HTML, ffmpeg, Pillow). Adobe Fonts have no path: load them by name only. Also `licence` ({kind: "open" | "restricted-embedding" | "unknown" | "adobe-fonts", name, url}), read from the font file itself: call it before copying a font file to any other computer or service (a cloud renderer); only "open" means it may be uploaded.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Check the picked fonts\' files', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'open_fonthound',
      title: 'Open FontHound with the text',
      description: 'Opens the FontHound desktop app (installed on this computer) on its Fonts tab with the user\'s text typed in (a title, headline, caption, lower third, slide or poster line), so the user sees it in their own installed fonts and picks by eye; optionally sets a still of the work (a video frame, the image or slide background) as the Mockup background. Starts FontHound if it isn\'t open. It does not pick fonts or return any. After calling it, call wait_for_selection with the returned `since`.',
      inputSchema: {
        type: 'object',
        properties: {
          line: { type: 'string', description: 'The text exactly as it will appear: a title, headline, caption, lower third, slide or poster line, or quote (up to 1000 characters).' },
          frame_path: { type: 'string', description: 'Optional absolute path to a PNG, JPEG, WebP, BMP or GIF still of the work (a video frame, the image or slide background), shown behind the fonts in the Mockup.' },
        },
        required: ['line'],
        additionalProperties: false,
      },
      annotations: { title: 'Open FontHound with the text', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
    {
      name: 'fonthound_status',
      title: 'Check whether FontHound is installed',
      description: 'Checks whether the FontHound desktop app is installed on this computer, without opening it. Returns `installed` (true or false) and `platform` ("windows", "macos" or another), and when it isn\'t installed, `message`: what to tell the user, with the link to get it. It only looks for FontHound\'s program file in its install folders or Start-menu shortcut (Windows) or the Applications folder (macOS), and sends nothing anywhere. Call it before offering FontHound to the user.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Check whether FontHound is installed', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];

  const ok = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }], structuredContent: o });
  const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

  // ctx.progress(done, total, message): an MCP progress notification, when the client asked for them
  async function callTool(name, args, ctx = {}) {
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
        fonts: sel.fonts.map((f) => {
          const exists = f.file ? fileExists(f.file) : false;
          return {
            option: f.option, family: f.family, style: f.style, postscriptName: f.postscriptName, source: f.source,
            file: f.file || null, exists,
            note: f.file ? (exists ? null : 'the file is no longer there: load the font by name, or ask the user to check it is installed') : f.note,
            licence: licenceOf(f, exists),
          };
        }),
      });
    }
    if (name === 'offer_font_picking') {
      const where = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform;
      return ok(installed()
        ? { installed: true, platform: where, ask: ASK, next: NEXT_YES }
        : { installed: false, platform: where, message: notInstalled(), next: NEXT_NOT_INSTALLED });
    }
    if (name === 'fonthound_status') {
      const where = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform;
      return ok(installed() ? { installed: true, platform: where } : { installed: false, platform: where, message: notInstalled() });
    }
    if (name === 'open_fonthound') {
      const line = typeof args.line === 'string' ? args.line.trim() : '';
      if (!line) return fail('open_fonthound needs `line`: the text to try in FontHound.');
      if (line.length > 1000) return fail('The line is too long for FontHound (1000 characters at most).');
      let frame = null;
      if (args.frame_path !== undefined && args.frame_path !== '') {
        if (typeof args.frame_path !== 'string' || !IMAGE.test(args.frame_path) || !fileExists(args.frame_path)) {
          return fail('frame_path must be an existing PNG, JPEG, WebP, BMP or GIF file.');
        }
        frame = args.frame_path;
      }
      const launch = await launchCommand(line, frame && platform === 'win32' ? shareFrame(frame) : frame);
      if (!launch) return fail(notInstalled());
      const since = new Date(now()).toISOString();
      if (platform === 'win32') {
        const r = await openOnWindows(launch.cmd, launch.args);
        if (r.ok) return ok({ status: 'opened', since, message: `${OPENED} (If FontHound doesn't come to the front, it's on the taskbar.)` });
        log(`open_fonthound: ${r.why}`);
        return ok({
          status: r.opened ? 'opened-without-line' : 'not-opened',
          since,
          line,
          message: r.opened
            ? `FontHound is open, but the line couldn't be handed to it (${r.why}). Ask the user to type the line on its Fonts tab, add the fonts they like to the Mockup (+) and press "Send to AI". Then call wait_for_selection with this \`since\`.`
            : `FontHound couldn't be opened from here (${r.why}). Ask the user to open FontHound themselves (Start menu), type the line on its Fonts tab, add the fonts they like to the Mockup (+) and press "Send to AI". Then call wait_for_selection with this \`since\`.`,
        });
      }
      try {
        await new Promise((resolve, reject) => {
          const child = execFile(launch.cmd, launch.args, {}, (err) => { if (err && err.code === 'ENOENT') reject(err); });
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
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: NAME, title: 'FontHound', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'prompts/list': return reply({ prompts: PROMPTS });
      case 'prompts/get': {
        const p = msg.params || {};
        if (p.name !== 'pick-fonts') return error(-32602, `Unknown prompt: ${p.name}`);
        const text = p.arguments && typeof p.arguments.text === 'string' ? p.arguments.text.trim() : '';
        return reply({ description: PROMPTS[0].description, messages: [{ role: 'user', content: { type: 'text', text: promptText(text) } }] });
      }
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

  return { handle, callTool, TOOLS, PROMPTS, selectionFile, launchCommand, readSelection, shortcutTarget, fontLicence };
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
