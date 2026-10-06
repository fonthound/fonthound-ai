'use strict';

// The FontHound MCP server: the protocol over real stdio, and each tool with a
// sample selection, a missing one, and a stand-in for starting the app.
//   node --test   (from claude-plugin/)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createServer, quoteWindowsArg, windowsCommandLine, WMI_SCRIPT } = require('../server/fonthound-mcp.js');

const SERVER = path.join(__dirname, '..', 'server', 'fonthound-mcp.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-mcp-'));
const fontFile = path.join(dir, 'JosefinSans-Bold.ttf');
fs.writeFileSync(fontFile, 'font');
const selFile = path.join(dir, 'ai-selection.json');
const missingFile = path.join(dir, 'nothing-here.json');

function sample(sent) {
  const look = { sizePx: 150, sizePercentOfFrameWidth: 7.81, color: '#ffd84a', tracking: 0, letterSpacingEm: 0, leadingPx: 0, lineHeightPx: 180,
    stroke: null, shadow: null, box: null, rotationDeg: 0, position: { xPercent: 50, yPercent: 50, anchor: 'center' } };
  return {
    version: 1, app: 'FontHound', host: 'FontHound', updated: new Date().toISOString(), sent: sent || null,
    instruction: 'Use these fonts…', line: 'שלום עולם', direction: 'rtl', frame: { width: 1920, height: 1080 },
    fonts: [
      { option: 1, family: 'Josefin Sans', style: 'Bold', postscriptName: 'JosefinSans-Bold', fullName: 'Josefin Sans Bold', weight: 700, italic: false, stretch: 100,
        css: { fontFamily: '"Josefin Sans"', fontWeight: 700, fontStyle: 'normal' }, source: 'installed', file: fontFile, note: null, look },
      { option: 2, family: 'Acumin Pro', style: 'Bold', postscriptName: 'AcuminPro-Bold', fullName: 'Acumin Pro Bold', weight: 700, italic: false, stretch: 100,
        css: { fontFamily: '"Acumin Pro"', fontWeight: 700, fontStyle: 'normal' }, source: 'adobe-fonts', file: null, note: 'installed via Adobe Fonts, load by name only', look },
      { option: 3, family: 'Gone Font', style: 'Regular', postscriptName: 'GoneFont-Regular', fullName: 'Gone Font', weight: 400, italic: false, stretch: 100,
        css: { fontFamily: '"Gone Font"', fontWeight: 400, fontStyle: 'normal' }, source: 'installed', file: path.join(dir, 'gone.ttf'), note: null, look },
    ],
  };
}
fs.writeFileSync(selFile, JSON.stringify(sample()));

// a server process over stdio; send() resolves with the reply to that id
function startProcess(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve) => {
    const n = ++id;
    waiting.set(n, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  return { child, send, notify, stop: () => child.kill() };
}
const body = (r) => JSON.parse(r.result.content[0].text);

test('initialize, initialized, ping, tools/list over stdio', async () => {
  const s = startProcess({ FONTHOUND_SELECTION_FILE: selFile });
  try {
    const init = await s.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'fonthound');
    assert.ok(init.result.capabilities.tools);
    // an unknown protocol version gets the server's own
    assert.equal((await s.send('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18');
    s.notify('notifications/initialized');
    assert.deepEqual((await s.send('ping')).result, {});
    const list = await s.send('tools/list');
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['get_font_files', 'get_font_selection', 'open_fonthound', 'wait_for_selection']);
    // never a list of every font, never a recommender
    assert.ok(!list.result.tools.some((t) => /list_fonts|installed_fonts|recommend|suggest|similar/i.test(t.name)));
    for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');
    assert.equal((await s.send('nope/method')).error.code, -32601);
  } finally { s.stop(); }
});

test('get_font_selection and get_font_files with a sample selection', async () => {
  const s = startProcess({ FONTHOUND_SELECTION_FILE: selFile });
  try {
    const r = body(await s.send('tools/call', { name: 'get_font_selection', arguments: {} }));
    assert.equal(r.status, 'ok');
    assert.equal(r.selection.line, 'שלום עולם');
    assert.equal(r.selection.fonts[0].postscriptName, 'JosefinSans-Bold');
    const f = body(await s.send('tools/call', { name: 'get_font_files', arguments: {} }));
    assert.deepEqual(f.fonts.map((x) => [x.option, x.exists]), [[1, true], [2, false], [3, false]]);
    assert.equal(f.fonts[0].file, fontFile);
    assert.equal(f.fonts[1].file, null);
    assert.match(f.fonts[1].note, /Adobe Fonts, load by name only/);
    assert.match(f.fonts[2].note, /no longer there/);
    const u = await s.send('tools/call', { name: 'no_such_tool', arguments: {} });
    assert.equal(u.error.code, -32602);
  } finally { s.stop(); }
});

test('a missing, emptied or damaged selection file: "no-selection"', async () => {
  for (const content of [null, '', '{"version":1,"app":"FontHound","fonts":[]}', '{not json']) {
    const file = content === null ? missingFile : path.join(dir, `odd-${Math.random()}.json`);
    if (content !== null) fs.writeFileSync(file, content);
    const s = createServer({ env: { FONTHOUND_SELECTION_FILE: file } });
    for (const name of ['get_font_selection', 'get_font_files']) {
      const r = JSON.parse((await s.callTool(name, {})).content[0].text);
      assert.equal(r.status, 'no-selection');
      assert.match(r.message, /open FontHound/);
    }
  }
});

test('the selection file is per user, where FontHound writes it', () => {
  const win = createServer({ env: { APPDATA: 'C:\\Users\\Ed\\AppData\\Roaming' }, platform: 'win32' });
  assert.equal(win.selectionFile(), 'C:\\Users\\Ed\\AppData\\Roaming\\FontHound\\ai-selection.json');
  const mac = createServer({ env: {}, platform: 'darwin', homedir: () => '/Users/ed' });
  assert.equal(mac.selectionFile(), '/Users/ed/Library/Application Support/FontHound/ai-selection.json');
});

// a stand-in for child_process.execFile: records the call, answers `reg`
function fakeExec(regAnswers = {}) {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args });
    if (cmd === 'reg') {
      const v = regAnswers[args[1]];
      setImmediate(() => (v ? cb(null, `\r\n${args[1]}\r\n    (Default)    REG_SZ    ${v}\r\n`) : cb(new Error('not found'))));
    }
    return { unref() {} };
  };
  return { calls, execFile };
}

test('open_fonthound starts fonthound.exe with --mockup-line (and --mockup-frame)', async () => {
  const exe = 'D:\\Apps\\FontHound\\fonthound.exe';
  const frame = path.join(dir, 'frame.png');
  fs.writeFileSync(frame, 'png');
  const fx = fakeExec({ 'HKCU\\Software\\fonthound\\FontHound': 'D:\\Apps\\FontHound' });
  const s = createServer({ env: {}, platform: 'win32', execFile: fx.execFile, fileExists: (p) => p === exe || p === frame });
  const r = await s.callTool('open_fonthound', { line: '  Lemon "Season" & co  ', frame_path: frame });
  assert.ok(!r.isError, r.content[0].text);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.status, 'opened');
  assert.ok(Date.parse(out.since) <= Date.now());
  const run = fx.calls.find((c) => c.cmd !== 'reg');
  assert.equal(run.cmd, exe);
  // one argument each, as given: no shell, nothing to quote or escape
  assert.deepEqual(run.args, ['--mockup-line', 'Lemon "Season" & co', '--mockup-frame', frame]);
  // without a frame
  const fx2 = fakeExec({ 'HKLM\\Software\\fonthound\\FontHound': 'D:\\Apps\\FontHound' });
  const s2 = createServer({ env: {}, platform: 'win32', execFile: fx2.execFile, fileExists: (p) => p === exe });
  await s2.callTool('open_fonthound', { line: 'שלום' });
  assert.deepEqual(fx2.calls.find((c) => c.cmd !== 'reg').args, ['--mockup-line', 'שלום']);
});

test('open_fonthound: FontHound not installed, bad input, macOS', async () => {
  const fx = fakeExec({});
  const s = createServer({ env: { LOCALAPPDATA: 'C:\\nope', ProgramFiles: 'C:\\nope' }, platform: 'win32', execFile: fx.execFile, fileExists: () => false });
  const r = await s.callTool('open_fonthound', { line: 'Hi' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /isn't installed[\s\S]*fonthound\.app\/download/);
  assert.ok(!fx.calls.some((c) => c.cmd !== 'reg'), 'nothing started');
  assert.equal((await s.callTool('open_fonthound', {})).isError, true);
  assert.equal((await s.callTool('open_fonthound', { line: '   ' })).isError, true);
  assert.equal((await s.callTool('open_fonthound', { line: 'x'.repeat(1001) })).isError, true);
  const withExe = createServer({ env: { FONTHOUND_EXE: 'C:\\fh.exe' }, platform: 'win32', execFile: fx.execFile, fileExists: (p) => p === 'C:\\fh.exe' });
  assert.match((await withExe.callTool('open_fonthound', { line: 'Hi', frame_path: path.join(dir, 'missing.png') })).content[0].text, /frame_path/);
  assert.match((await withExe.callTool('open_fonthound', { line: 'Hi', frame_path: fontFile })).content[0].text, /frame_path/);
  // macOS: open -a FontHound --args ...
  const mx = fakeExec();
  const mac = createServer({ env: {}, platform: 'darwin', execFile: mx.execFile });
  await mac.callTool('open_fonthound', { line: 'Hi' });
  assert.deepEqual(mx.calls[0], { cmd: 'open', args: ['-a', 'FontHound', '--args', '--mockup-line', 'Hi'] });
  // elsewhere: a clear message
  assert.match((await createServer({ env: {}, platform: 'linux' }).callTool('open_fonthound', { line: 'Hi' })).content[0].text, /Windows/);
});

test('wait_for_selection returns as soon as Send to AI is pressed', async () => {
  const file = path.join(dir, 'wait.json');
  const since = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(sample('2020-01-01T00:00:00.000Z'))); // an older send doesn't count
  const s = createServer({ env: { FONTHOUND_SELECTION_FILE: file }, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) });
  const t0 = Date.now();
  setTimeout(() => {
    // a change without a send (the Mockup following the user) doesn't count either
    fs.writeFileSync(file, JSON.stringify(sample('2020-01-01T00:00:00.000Z')));
  }, 80);
  setTimeout(() => fs.writeFileSync(file, JSON.stringify(sample(new Date().toISOString()))), 250);
  const r = JSON.parse((await s.callTool('wait_for_selection', { since, timeout_s: 10 })).content[0].text);
  assert.equal(r.status, 'ok');
  assert.equal(r.selection.fonts.length, 3);
  assert.ok(Date.now() - t0 >= 240 && Date.now() - t0 < 3000);
});

test('wait_for_selection times out cleanly', async () => {
  const s = createServer({ env: { FONTHOUND_SELECTION_FILE: missingFile } });
  const t0 = Date.now();
  const r = await s.callTool('wait_for_selection', { timeout_s: 1 });
  assert.ok(!r.isError);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.status, 'timeout');
  assert.match(out.message, /finished picking/);
  assert.ok(Date.now() - t0 >= 950 && Date.now() - t0 < 2500);
});

// a clock that only moves when the server sleeps: 20 minutes in no time
function fakeClock(start = Date.parse('2026-10-05T10:00:00.000Z')) {
  let t = start;
  let slept = 0;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; slept += ms; },
    slept: () => slept,
    set: (v) => { t = v; },
  };
}

test('wait_for_selection waits 300 s by default, 1800 s at most', async () => {
  const clock = fakeClock();
  const s = createServer({ env: { FONTHOUND_SELECTION_FILE: missingFile }, now: clock.now, sleep: clock.sleep });
  const out = JSON.parse((await s.callTool('wait_for_selection', {})).content[0].text);
  assert.equal(out.status, 'timeout');
  assert.equal(out.timeout_s, 300);
  assert.equal(clock.slept(), 300 * 1000);
  assert.equal(out.since, new Date(Date.parse('2026-10-05T10:00:00.000Z')).toISOString());
  assert.match(out.message, /get_font_selection/);
  const capped = fakeClock();
  const s2 = createServer({ env: { FONTHOUND_SELECTION_FILE: missingFile }, now: capped.now, sleep: capped.sleep });
  const out2 = JSON.parse((await s2.callTool('wait_for_selection', { timeout_s: 99999 })).content[0].text);
  assert.equal(out2.timeout_s, 1800);
  assert.equal(capped.slept(), 1800 * 1000);
  const def = s.TOOLS.find((t) => t.name === 'wait_for_selection').inputSchema.properties.timeout_s.description;
  assert.match(def, /1-1800, default 300/);
});

test('wait_for_selection: a Send just as the time runs out still counts', async () => {
  const file = path.join(dir, 'race.json');
  const start = Date.parse('2026-10-05T10:00:00.000Z');
  fs.writeFileSync(file, JSON.stringify(sample('2020-01-01T00:00:00.000Z')));
  let t = start;
  let wrote = false;
  // the user presses Send between the server's last look and its deadline check
  const now = () => {
    if (t >= start + 5000 && !wrote) {
      wrote = true;
      fs.writeFileSync(file, JSON.stringify(sample(new Date(start + 4999).toISOString())));
    }
    return t;
  };
  const s = createServer({ env: { FONTHOUND_SELECTION_FILE: file }, now, sleep: async (ms) => { t += ms; } });
  const out = JSON.parse((await s.callTool('wait_for_selection', { since: new Date(start).toISOString(), timeout_s: 5 })).content[0].text);
  assert.equal(wrote, true);
  assert.equal(out.status, 'ok');
  assert.equal(out.selection.sent, new Date(start + 4999).toISOString());
});

test('wait_for_selection: a Send before `since` is not taken at the deadline either', async () => {
  const file = path.join(dir, 'old.json');
  const start = Date.parse('2026-10-05T10:00:00.000Z');
  fs.writeFileSync(file, JSON.stringify(sample(new Date(start - 1000).toISOString())));
  const clock = fakeClock(start);
  const s = createServer({ env: { FONTHOUND_SELECTION_FILE: file }, now: clock.now, sleep: clock.sleep });
  const out = JSON.parse((await s.callTool('wait_for_selection', { since: new Date(start).toISOString(), timeout_s: 3 })).content[0].text);
  assert.equal(out.status, 'timeout');
  // what the skill does next: get_font_selection, compare `sent` with `since`
  const got = JSON.parse((await s.callTool('get_font_selection', {})).content[0].text);
  assert.ok(Date.parse(got.selection.sent) < Date.parse(out.since));
});

test('a licence hint passes through to Claude untouched', async () => {
  const file = path.join(dir, 'hint.json');
  const sel = sample(new Date().toISOString());
  sel.fonts[0].licenseHint = 'trial';
  fs.writeFileSync(file, JSON.stringify(sel));
  const got = JSON.parse((await createServer({ env: { FONTHOUND_SELECTION_FILE: file } }).callTool('get_font_selection', {})).content[0].text);
  assert.equal(got.selection.fonts[0].licenseHint, 'trial');
  assert.equal(got.selection.fonts[1].licenseHint, undefined);
});

test('the plugin manifest and the server agree on the version', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.version, '0.1.3');
  assert.match(fs.readFileSync(SERVER, 'utf8'), /const VERSION = '0\.1\.3';/);
});

// ---------- inside the Claude desktop app's MSIX package (Windows) ----------

// The CommandLineToArgvW rules, as Rust's std::env::args applies them to the
// arguments after the program: a reference to check the quoting against.
function splitWindowsArgs(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let cur = '';
    let quoted = false;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '\\') {
        let n = 0;
        while (line[i] === '\\') { n++; i++; }
        if (line[i] === '"') { cur += '\\'.repeat(n >> 1); if (n % 2) { cur += '"'; continue; } i--; continue; }
        cur += '\\'.repeat(n); i--; continue;
      }
      if (c === '"') { if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; continue; }
      if (!quoted && (c === ' ' || c === '\t')) break;
      cur += c;
    }
    out.push(cur);
  }
  return out;
}

const AWKWARD = ['Hi', 'שלום עולם', 'Lemon "Season" & co', 'ends with a slash\\', 'C:\\Program Files\\FontHound\\fonthound.exe',
  'quote at the end"', '\\"already\\" escaped', 'tab\there', 'two\nlines', '--Big Sale--', '%PATH% ^& | < > $env:X \'single\'', 'مرحبا', '日本語 テスト', ''];

test('quoteWindowsArg: every argument comes back exactly (reference rules)', () => {
  for (const a of AWKWARD) assert.deepEqual(splitWindowsArgs(quoteWindowsArg(a)), [a], JSON.stringify(a));
  assert.equal(quoteWindowsArg('plain'), 'plain');
  assert.equal(quoteWindowsArg('a b'), '"a b"');
  assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArg('dir\\'), 'dir\\');
  assert.equal(quoteWindowsArg('my dir\\'), '"my dir\\\\"');
  const line = windowsCommandLine('C:\\Program Files\\FontHound\\fonthound.exe', ['--mockup-line', 'Lemon "Season"', '--mockup-frame', 'C:\\Temp\\a b.png']);
  assert.deepEqual(splitWindowsArgs(line), ['C:\\Program Files\\FontHound\\fonthound.exe', '--mockup-line', 'Lemon "Season"', '--mockup-frame', 'C:\\Temp\\a b.png']);
});

test('quoteWindowsArg: a real Windows process gets every argument exactly', { skip: process.platform !== 'win32' }, async () => {
  const args = AWKWARD.filter((a) => a !== '');
  const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
  // verbatim: the command line is exactly what quoteWindowsArg built
  const child = spawn(process.execPath, ['-e', quoteWindowsArg(script), ...args.map(quoteWindowsArg)], { windowsVerbatimArguments: true, argv0: quoteWindowsArg(process.execPath) });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  await new Promise((r) => child.on('close', r));
  assert.deepEqual(JSON.parse(out), args);
});

test('the WMI script passes as one plain argument', () => {
  assert.ok(!/["\\]/.test(WMI_SCRIPT), 'no double quotes or backslashes');
  assert.match(WMI_SCRIPT, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.match(WMI_SCRIPT, /\$env:FONTHOUND_CMDLINE/);
});

// A stand-in file system: files { path: { ino, mtimeMs } }; folders follow from them.
function fakeFs(files, { unlinkFails = false } = {}) {
  const calls = { stat: [], unlink: [], copy: [], mkdir: [] };
  const norm = (p) => p.toLowerCase();
  const map = new Map(Object.entries(files).map(([p, v]) => [norm(p), v]));
  const fsx = {
    readdir: (d) => {
      const pre = norm(d) + '\\';
      const names = new Set();
      for (const p of Object.keys(files)) if (norm(p).startsWith(pre)) names.add(p.slice(pre.length).split('\\')[0]);
      if (!names.size) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [...names];
    },
    stat: (p) => {
      calls.stat.push(p);
      const f = map.get(norm(p));
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isFile: () => true, ino: BigInt(f.ino), dev: 7n, mtimeMs: BigInt(f.mtimeMs || 0) };
    },
    unlink: (p) => {
      calls.unlink.push(p);
      if (unlinkFails) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      map.delete(norm(p));
    },
    copyFile: (a, b) => calls.copy.push([a, b]),
    mkdir: (p) => calls.mkdir.push(p),
  };
  return { fsx, calls };
}

const L = 'C:\\Users\\Ed\\AppData\\Local';
const R = 'C:\\Users\\Ed\\AppData\\Roaming';
const CACHE = `${L}\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache`;
const PRIVATE_SEL = `${CACHE}\\Roaming\\FontHound\\ai-selection.json`;
const STARTED = Date.parse('2026-10-06T12:00:00.000Z');
// this process sees through Claude's package: its private config.json is what %APPDATA%\Claude\config.json shows
function claudePackage(extra = {}) {
  return {
    [`${CACHE}\\Roaming\\Claude\\config.json`]: { ino: 11 },
    [`${R}\\Claude\\config.json`]: { ino: 11 },
    [`${CACHE}\\Local\\FontHound\\license.json`]: { ino: 21 },
    [`${L}\\FontHound\\license.json`]: { ino: 21 },
    [`${L}\\Packages\\Other.App_123\\LocalCache\\Roaming\\Thing\\a.txt`]: { ino: 31 },
    [`${R}\\Thing\\a.txt`]: { ino: 32 },
    ...extra,
  };
}
const pkgEnv = { APPDATA: R, LOCALAPPDATA: L, TEMP: `${L}\\Temp`, SystemRoot: 'C:\\Windows' };
const quiet = () => {};

test('inside the package: a stale private ai-selection.json is removed, and the result says so', async () => {
  const { fsx, calls } = fakeFs(claudePackage({
    [PRIVATE_SEL]: { ino: 41, mtimeMs: Date.parse('2026-10-05T12:47:00.000Z') },
    [`${R}\\FontHound\\ai-selection.json`]: { ino: 41, mtimeMs: Date.parse('2026-10-05T12:47:00.000Z') }, // the real path shows the private copy
  }));
  const s = createServer({ env: pkgEnv, platform: 'win32', fs: fsx, startedAt: STARTED, log: quiet });
  assert.equal(s.packageCache(), CACHE);
  const r = JSON.parse((await s.callTool('get_font_selection', {})).content[0].text);
  assert.deepEqual(calls.unlink, [PRIVATE_SEL]);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /Removed a stale copy[\s\S]*Claude_pzs8sxrjxfjjc/);
  // said once
  assert.equal(JSON.parse((await s.callTool('get_font_selection', {})).content[0].text).notes, undefined);
  // license.json: never even looked at, never touched
  assert.ok(!calls.stat.some((p) => /license\.json/i.test(p)), calls.stat.join('\n'));
  assert.ok(!calls.unlink.some((p) => /license\.json/i.test(p)));
});

test('inside the package: a private copy written since the server started stays (a FontHound open inside it)', async () => {
  const { fsx, calls } = fakeFs(claudePackage({ [PRIVATE_SEL]: { ino: 41, mtimeMs: STARTED + 5000 } }));
  const s = createServer({ env: pkgEnv, platform: 'win32', fs: fsx, startedAt: STARTED, log: quiet });
  const r = JSON.parse((await s.callTool('get_font_selection', {})).content[0].text);
  assert.deepEqual(calls.unlink, []);
  assert.equal(r.notes, undefined);
});

test('outside any package: another package\'s copy is not ours to remove', async () => {
  const files = claudePackage({ [PRIVATE_SEL]: { ino: 41, mtimeMs: 1 } });
  files[`${R}\\Claude\\config.json`] = { ino: 12 }; // the real file, not the private one
  const { fsx, calls } = fakeFs(files);
  const s = createServer({ env: pkgEnv, platform: 'win32', fs: fsx, startedAt: STARTED, log: quiet });
  assert.equal(s.packageCache(), null);
  await s.callTool('get_font_selection', {});
  assert.deepEqual(calls.unlink, []);
  // macOS, and a test file override: never looked for
  const mac = createServer({ env: pkgEnv, platform: 'darwin', fs: fakeFs(claudePackage()).fsx });
  assert.equal(mac.packageCache(), null);
});

test('inside the package: a private copy that can\'t be removed is reported once, with its path', async () => {
  const { fsx, calls } = fakeFs(claudePackage({ [PRIVATE_SEL]: { ino: 41, mtimeMs: 1 } }), { unlinkFails: true });
  const s = createServer({ env: pkgEnv, platform: 'win32', fs: fsx, startedAt: STARTED, log: quiet });
  const r = JSON.parse((await s.callTool('get_font_files', {})).content[0].text);
  assert.match(r.notes[0], /couldn't be removed \(EPERM\)[\s\S]*delete this file/);
  assert.ok(r.notes[0].includes(PRIVATE_SEL));
  const again = JSON.parse((await s.callTool('get_font_files', {})).content[0].text);
  assert.equal(again.notes, undefined);
  assert.equal(calls.unlink.length, 1);
});

// a stand-in execFile for the package case: answers reg, records PowerShell
function fakeWmi(answer) {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'reg') setImmediate(() => cb(new Error('not found')));
    else setImmediate(() => answer(cb));
    return { unref() {} };
  };
  return { calls, execFile };
}

test('open_fonthound inside the package starts FontHound through WMI, outside it', async () => {
  const exe = `${pkgEnv.SystemRoot}\\..\\Program Files\\FontHound\\fonthound.exe`;
  const frame = 'D:\\clips\\still frame.PNG';
  const { fsx, calls: fcalls } = fakeFs(claudePackage());
  const w = fakeWmi((cb) => cb(null, '0 4242', ''));
  const s = createServer({ env: { ...pkgEnv, FONTHOUND_EXE: exe }, platform: 'win32', fs: fsx, execFile: w.execFile,
    fileExists: (p) => p === exe || p === frame, startedAt: STARTED, log: quiet });
  const line = 'שלום "עולם" C:\\dir\\';
  const r = JSON.parse((await s.callTool('open_fonthound', { line, frame_path: frame })).content[0].text);
  assert.equal(r.status, 'opened');
  assert.match(r.message, /wait_for_selection/);
  const ps = w.calls.find((c) => c.cmd !== 'reg');
  assert.equal(ps.cmd, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(ps.args, ['-NoProfile', '-NonInteractive', '-Command', WMI_SCRIPT]);
  // the frame goes through %TEMP%, which the package doesn't hide
  const copy = `${L}\\Temp\\FontHound\\claude-frame.png`;
  assert.deepEqual(fcalls.copy, [[frame, copy]]);
  assert.deepEqual(splitWindowsArgs(ps.opts.env.FONTHOUND_CMDLINE), [exe, '--mockup-line', line, '--mockup-frame', copy]);
  assert.equal(ps.opts.env.FONTHOUND_CWD, `${pkgEnv.SystemRoot}\\..\\Program Files\\FontHound`);
  assert.ok(ps.opts.timeout > 0);
  // fonthound.exe itself is never started from in here
  assert.ok(!w.calls.some((c) => c.cmd === exe));
});

test('open_fonthound inside the package: WMI refuses, so the user opens FontHound', async () => {
  const exe = 'C:\\Program Files\\FontHound\\fonthound.exe';
  for (const answer of [(cb) => cb(null, '9 0', ''), (cb) => cb(new Error('spawn powershell ENOENT'), '', '')]) {
    const w = fakeWmi(answer);
    const s = createServer({ env: { ...pkgEnv, FONTHOUND_EXE: exe }, platform: 'win32', fs: fakeFs(claudePackage()).fsx, execFile: w.execFile,
      fileExists: (p) => p === exe, startedAt: STARTED, log: quiet });
    const r = await s.callTool('open_fonthound', { line: 'Hi there' });
    assert.ok(!r.isError);
    const out = JSON.parse(r.content[0].text);
    assert.equal(out.status, 'not-opened');
    assert.equal(out.line, 'Hi there');
    assert.ok(out.since);
    assert.match(out.message, /open FontHound themselves[\s\S]*wait_for_selection/);
    assert.ok(!w.calls.some((c) => c.cmd === exe), 'no fallback to starting it inside the package');
  }
});

test('open_fonthound outside a package still starts fonthound.exe directly', async () => {
  const exe = 'C:\\Program Files\\FontHound\\fonthound.exe';
  const files = claudePackage();
  files[`${R}\\Claude\\config.json`] = { ino: 12 };
  const fx = fakeExec();
  const s = createServer({ env: { ...pkgEnv, FONTHOUND_EXE: exe }, platform: 'win32', fs: fakeFs(files).fsx, execFile: fx.execFile, fileExists: (p) => p === exe });
  await s.callTool('open_fonthound', { line: 'Hi' });
  assert.deepEqual(fx.calls, [{ cmd: exe, args: ['--mockup-line', 'Hi'] }]);
});

test('wait_for_selection sends progress while it waits, and its timeout says how to go on', async () => {
  const file = path.join(dir, 'progress.json');
  const start = Date.parse('2026-10-05T10:00:00.000Z');
  const sel = sample('2020-01-01T00:00:00.000Z');
  sel.updated = new Date(start + 1000).toISOString(); // the user is busy in the Mockup
  fs.writeFileSync(file, JSON.stringify(sel));
  const clock = fakeClock(start);
  const s = createServer({ env: { FONTHOUND_SELECTION_FILE: file }, now: clock.now, sleep: clock.sleep });
  const sent = [];
  const r = await s.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'wait_for_selection', arguments: { since: new Date(start).toISOString(), timeout_s: 60 }, _meta: { progressToken: 'p1' } } }, (m) => sent.push(m));
  assert.equal(sent.length, 3); // every 15 s of 60
  assert.deepEqual(sent.map((m) => [m.method, m.params.progressToken, m.params.total]), Array(3).fill(['notifications/progress', 'p1', 60]));
  assert.ok(sent[0].params.progress < sent[2].params.progress);
  const out = JSON.parse(r.result.content[0].text);
  assert.equal(out.status, 'timeout');
  assert.match(out.message, /still picking[\s\S]*call wait_for_selection again with the same `since`/);
  assert.equal(out.lastUpdate, sel.updated);
  // without a progress token: no notifications
  const quietSent = [];
  await s.handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'wait_for_selection', arguments: { timeout_s: 30 } } }, (m) => quietSent.push(m));
  assert.equal(quietSent.length, 0);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
