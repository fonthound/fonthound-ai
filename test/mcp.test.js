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
const { createServer } = require('../server/fonthound-mcp.js');

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

// A stand-in for child_process.execFile on Windows. Answers reg.exe from
// regAnswers; tasklist.exe from `ready` (a list of answers, the last one
// repeats: true = FontHound's window is listed, 'siw' = its hidden
// single-instance window, 'na' = no window yet, false = not running);
// explorer.exe exits with 1 (as the real one does); fonthound.exe (the
// hand-over) exits at once with `handover` (null = ok), or never ('hang').
function fakeWin({ regAnswers = {}, ready = [true], handover = null } = {}) {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => {
    const call = { cmd, args, killed: false };
    calls.push(call);
    const child = { unref() {}, kill() { call.killed = true; } };
    if (/reg\.exe$/i.test(cmd)) {
      const v = regAnswers[args[1]];
      setImmediate(() => (v ? cb(null, '\r\n' + args[1] + '\r\n    (Default)    REG_SZ    ' + v + '\r\n') : cb(new Error('not found'))));
    } else if (/tasklist\.exe$/i.test(cmd)) {
      const r = ready.length > 1 ? ready.shift() : ready[0];
      const out = r === true ? '"fonthound.exe","4242","Console","1","50,000 K","Running","PC\\Ed","0:00:01","FontHound"\r\n'
        : r === 'siw' ? '"fonthound.exe","4242","Console","1","50,000 K","Running","PC\\Ed","0:00:01","app.fonthound.desktop-siw"\r\n'
          : r === 'na' ? '"fonthound.exe","4242","Console","1","50,000 K","Running","PC\\Ed","0:00:00","N/A"\r\n'
            : 'INFO: No tasks are running which match the specified criteria.\r\n';
      setImmediate(() => cb(null, out, ''));
    } else if (/explorer\.exe$/i.test(cmd)) {
      setImmediate(() => cb(Object.assign(new Error('Command failed'), { code: 1 })));
    } else if (handover !== 'hang') {
      setImmediate(() => cb(handover));
    }
    return child;
  };
  const started = () => calls.filter((c) => !/(reg|tasklist)\.exe$/i.test(c.cmd));
  return { calls, execFile, started };
}
const WIN = { SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\Ed\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Ed\\AppData\\Local', TEMP: 'C:\\Users\\Ed\\AppData\\Local\\Temp' };
const EXPLORER = 'C:\\Windows\\explorer.exe';
const quiet = () => {};
const fast = { readyTimeout: 3000, readyPoll: 500, handoverTimeout: 50 };

test('open_fonthound: FontHound already open, so the line is handed to it (no shell, no explorer)', async () => {
  const exe = 'D:\\Apps\\FontHound\\fonthound.exe';
  const frame = path.join(dir, 'frame.png');
  fs.writeFileSync(frame, 'png');
  const fx = fakeWin({ regAnswers: { 'HKCU\\Software\\fonthound\\FontHound': 'D:\\Apps\\FontHound' } });
  const s = createServer({ env: WIN, platform: 'win32', execFile: fx.execFile, fileExists: (p) => p === exe || p === frame, log: quiet });
  const r = await s.callTool('open_fonthound', { line: '  Lemon "Season" & co  ', frame_path: frame });
  assert.ok(!r.isError, r.content[0].text);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.status, 'opened');
  assert.ok(Date.parse(out.since) <= Date.now());
  assert.equal(fx.calls[0].cmd, 'C:\\Windows\\System32\\reg.exe');
  // one argument each, as given: nothing to quote or escape; a frame outside %APPDATA% is passed as it is
  assert.deepEqual(fx.started(), [{ cmd: exe, args: ['--mockup-line', 'Lemon "Season" & co', '--mockup-frame', frame], killed: false }]);
  const list = fx.calls.find((c) => /tasklist/.test(c.cmd));
  assert.equal(list.cmd, 'C:\\Windows\\System32\\tasklist.exe');
  assert.deepEqual(list.args, ['/V', '/FI', 'IMAGENAME eq fonthound.exe', '/FO', 'CSV', '/NH']);
  // the hidden single-instance window counts as open too
  const fx2 = fakeWin({ regAnswers: { 'HKLM\\Software\\fonthound\\FontHound': 'D:\\Apps\\FontHound' }, ready: ['siw'] });
  const s2 = createServer({ env: WIN, platform: 'win32', execFile: fx2.execFile, fileExists: (p) => p === exe, log: quiet });
  assert.equal(JSON.parse((await s2.callTool('open_fonthound', { line: 'שלום' })).content[0].text).status, 'opened');
  assert.deepEqual(fx2.started().map((c) => c.args), [['--mockup-line', 'שלום']]);
});

test('open_fonthound: FontHound not open, so the Windows shell starts it, then the line is handed over', async () => {
  const exe = 'C:\\Program Files\\FontHound\\fonthound.exe';
  const clock = fakeClock();
  // not listed, then a process without a window yet, then its window
  const fx = fakeWin({ ready: [false, 'na', 'na', true] });
  const s = createServer({ env: { ...WIN, FONTHOUND_EXE: exe }, platform: 'win32', execFile: fx.execFile, fileExists: (p) => p === exe,
    now: clock.now, sleep: clock.sleep, timing: fast, log: quiet });
  const out = JSON.parse((await s.callTool('open_fonthound', { line: 'Hi there' })).content[0].text);
  assert.equal(out.status, 'opened');
  assert.deepEqual(fx.started(), [
    { cmd: EXPLORER, args: [exe], killed: false }, // the path only: explorer.exe takes no arguments for the app
    { cmd: exe, args: ['--mockup-line', 'Hi there'], killed: false },
  ]);
  assert.equal(clock.slept(), 1000);
});

test('open_fonthound: a frame under %APPDATA% or %LOCALAPPDATA% is handed over as a copy in %TEMP%', async () => {
  const exe = 'C:\\Program Files\\FontHound\\fonthound.exe';
  const frame = 'C:\\Users\\Ed\\AppData\\Local\\Remotion\\Still Frame.PNG';
  const copies = [];
  const fx = fakeWin();
  const s = createServer({ env: { ...WIN, FONTHOUND_EXE: exe }, platform: 'win32', execFile: fx.execFile, fileExists: (p) => p === exe || p === frame,
    fs: { mkdir: () => {}, copyFile: (a, b) => copies.push([a, b]) }, log: quiet });
  await s.callTool('open_fonthound', { line: 'Hi', frame_path: frame });
  const copy = 'C:\\Users\\Ed\\AppData\\Local\\Temp\\FontHound\\claude-frame.png';
  assert.deepEqual(copies, [[frame, copy]]);
  assert.deepEqual(fx.started()[0].args, ['--mockup-line', 'Hi', '--mockup-frame', copy]);
  // a frame elsewhere: no copy
  await s.callTool('open_fonthound', { line: 'Hi', frame_path: exe.replace('fonthound.exe', 'x.png') }).catch(() => {});
  assert.equal(copies.length, 1);
});

test('open_fonthound: FontHound never opens, so the user opens it (nothing else is tried)', async () => {
  const exe = 'C:\\Program Files\\FontHound\\fonthound.exe';
  const clock = fakeClock();
  const fx = fakeWin({ ready: [false] });
  const s = createServer({ env: { ...WIN, FONTHOUND_EXE: exe }, platform: 'win32', execFile: fx.execFile, fileExists: (p) => p === exe,
    now: clock.now, sleep: clock.sleep, timing: fast, log: quiet });
  const r = await s.callTool('open_fonthound', { line: 'Hi there' });
  assert.ok(!r.isError);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.status, 'not-opened');
  assert.equal(out.line, 'Hi there');
  assert.ok(out.since);
  assert.match(out.message, /didn't open within 3 s[\s\S]*open FontHound themselves[\s\S]*wait_for_selection/);
  // only explorer.exe: fonthound.exe is never started directly from here
  assert.deepEqual(fx.started().map((c) => c.cmd), [EXPLORER]);
});

test('open_fonthound: a hand-over that doesn\'t finish is closed again, and the user types the line', async () => {
  const exe = 'C:\\Program Files\\FontHound\\fonthound.exe';
  const fx = fakeWin({ handover: 'hang' });
  const s = createServer({ env: { ...WIN, FONTHOUND_EXE: exe }, platform: 'win32', execFile: fx.execFile, fileExists: (p) => p === exe, timing: fast, log: quiet });
  const out = JSON.parse((await s.callTool('open_fonthound', { line: 'Hi' })).content[0].text);
  assert.equal(out.status, 'opened-without-line');
  assert.match(out.message, /type the line on its Fonts tab[\s\S]*wait_for_selection/);
  assert.equal(fx.started()[0].killed, true);
  // a hand-over that fails outright says so too
  const fx2 = fakeWin({ handover: Object.assign(new Error('boom'), { code: 3 }) });
  const s2 = createServer({ env: { ...WIN, FONTHOUND_EXE: exe }, platform: 'win32', execFile: fx2.execFile, fileExists: (p) => p === exe, timing: fast, log: quiet });
  const out2 = JSON.parse((await s2.callTool('open_fonthound', { line: 'Hi' })).content[0].text);
  assert.equal(out2.status, 'opened-without-line');
  assert.match(out2.message, /hand-over failed \(3\)/);
});

test('open_fonthound: FontHound not installed, bad input, macOS', async () => {
  const fx = fakeWin();
  const s = createServer({ env: { LOCALAPPDATA: 'C:\\nope', ProgramFiles: 'C:\\nope' }, platform: 'win32', execFile: fx.execFile, fileExists: () => false });
  const r = await s.callTool('open_fonthound', { line: 'Hi' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /isn't installed[\s\S]*fonthound\.app\/download/);
  assert.deepEqual(fx.started(), [], 'nothing started');
  assert.equal((await s.callTool('open_fonthound', {})).isError, true);
  assert.equal((await s.callTool('open_fonthound', { line: '   ' })).isError, true);
  assert.equal((await s.callTool('open_fonthound', { line: 'x'.repeat(1001) })).isError, true);
  const withExe = createServer({ env: { FONTHOUND_EXE: 'C:\\fh.exe' }, platform: 'win32', execFile: fx.execFile, fileExists: (p) => p === 'C:\\fh.exe' });
  assert.match((await withExe.callTool('open_fonthound', { line: 'Hi', frame_path: path.join(dir, 'missing.png') })).content[0].text, /frame_path/);
  assert.match((await withExe.callTool('open_fonthound', { line: 'Hi', frame_path: fontFile })).content[0].text, /frame_path/);
  // macOS: open -a FontHound --args ...
  const calls = [];
  const mac = createServer({ env: {}, platform: 'darwin', execFile: (cmd, args) => { calls.push({ cmd, args }); return { unref() {} }; } });
  await mac.callTool('open_fonthound', { line: 'Hi' });
  assert.deepEqual(calls[0], { cmd: 'open', args: ['-a', 'FontHound', '--args', '--mockup-line', 'Hi'] });
  // elsewhere: a clear message
  assert.match((await createServer({ env: {}, platform: 'linux' }).callTool('open_fonthound', { line: 'Hi' })).content[0].text, /Windows/);
});

test('the server never runs a shell, PowerShell or WMI', () => {
  const src = fs.readFileSync(SERVER, 'utf8');
  assert.ok(!/powershell|Invoke-CimMethod|Win32_Process|cmd\.exe|shell:\s*true|\bexecSync\b|\bspawn\(|[^.]\bexec\(/i.test(src.replace(/^\s*\/\/.*$/gm, '')));
  assert.ok(!/unlink|rmSync|rmdir/.test(src), 'deletes nothing');
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
  const market = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(market.plugins[0].version, manifest.version);
  assert.ok(fs.readFileSync(SERVER, 'utf8').includes(`const VERSION = '${manifest.version}';`));
});

// ---------- a stale private copy inside an MSIX package (Windows) ----------

// A stand-in file system: files { path: ino }; folders follow from them.
function fakeFs(files) {
  const calls = { stat: [], readdir: [] };
  const norm = (p) => p.toLowerCase();
  const map = new Map(Object.entries(files).map(([p, v]) => [norm(p), { p, v }]));
  return {
    calls,
    fsx: {
      readdir: (d) => {
        calls.readdir.push(d);
        const pre = norm(d) + '\\';
        const names = new Set();
        for (const [k, { p }] of map) if (k.startsWith(pre)) names.add(p.slice(pre.length).split('\\')[0]);
        if (!names.size) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return [...names];
      },
      stat: (p) => {
        calls.stat.push(p);
        if (!map.has(norm(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { isFile: () => true, ino: BigInt(map.get(norm(p)).v), dev: 7n };
      },
      remove: (p) => map.delete(norm(p)),
    },
  };
}
const L = WIN.LOCALAPPDATA;
const R = WIN.APPDATA;
const PRIVATE_SEL = L + '\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\FontHound\\ai-selection.json';
const REAL_SEL = R + '\\FontHound\\ai-selection.json';

test('a stale private copy is reported with its path, never deleted', async () => {
  // inside the package the real path shows the private copy: the same file
  const { fsx, calls } = fakeFs({ [PRIVATE_SEL]: 41, [REAL_SEL]: 41, [L + '\\Packages\\Other.App_1\\LocalCache\\Roaming\\Thing\\a.txt']: 5 });
  const s = createServer({ env: WIN, platform: 'win32', fs: fsx, log: quiet });
  for (const tool of ['get_font_selection', 'get_font_files', 'wait_for_selection']) {
    const out = JSON.parse((await s.callTool(tool, { timeout_s: 1 })).content[0].text);
    assert.equal(out.status, 'stale-copy', tool);
    assert.equal(out.file, PRIVATE_SEL);
    assert.match(out.message, /old copy[\s\S]*Ask the user to delete this one file/);
    assert.ok(out.message.includes(PRIVATE_SEL));
  }
  // only FontHound's own file name was looked at in each package, and the package list read once
  assert.equal(calls.readdir.length, 1);
  assert.ok(calls.stat.every((p) => /FontHound\\ai-selection\.json$/i.test(p)), calls.stat.join('\n'));
  // once the user deleted it: back to normal (here the file is simply gone)
  fsx.remove(PRIVATE_SEL);
  fsx.remove(REAL_SEL);
  assert.equal(JSON.parse((await s.callTool('get_font_selection', {})).content[0].text).status, 'no-selection');
});

test('no stale copy: outside the package the copy is a different file; macOS and the test override never look', () => {
  const { fsx } = fakeFs({ [PRIVATE_SEL]: 41, [REAL_SEL]: 42 });
  assert.equal(createServer({ env: WIN, platform: 'win32', fs: fsx }).staleCopy(), null);
  const watched = fakeFs({ [PRIVATE_SEL]: 41, [REAL_SEL]: 41 });
  assert.equal(createServer({ env: WIN, platform: 'darwin', fs: watched.fsx }).staleCopy(), null);
  assert.equal(createServer({ env: { ...WIN, FONTHOUND_SELECTION_FILE: selFile }, platform: 'win32', fs: watched.fsx }).staleCopy(), null);
  assert.equal(watched.calls.readdir.length, 0);
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
