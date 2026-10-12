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

// A stand-in for child_process.execFile on Windows: explorer.exe exits with 1
// (as the real one does); fonthound.exe (the hand-over) exits at once with
// `handover` (null = ok), or never ('hang').
function fakeWin({ handover = null } = {}) {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => {
    const call = { cmd, args, killed: false };
    calls.push(call);
    const child = { unref() {}, kill() { call.killed = true; } };
    if (/explorer\.exe$/i.test(cmd)) {
      setImmediate(() => cb(Object.assign(new Error('Command failed'), { code: 1 })));
    } else if (handover !== 'hang') {
      setImmediate(() => cb(handover));
    }
    return child;
  };
  return { calls, execFile, started: () => calls };
}
const WIN = { SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\Ed\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Ed\\AppData\\Local', TEMP: 'C:\\Users\\Ed\\AppData\\Local\\Temp', ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData' };
const EXPLORER = 'C:\\Windows\\explorer.exe';
const LOCK = 'C:\\Users\\Ed\\AppData\\Local\\app.fonthound.desktop\\EBWebView\\lockfile';
const quiet = () => {};
const fast = { readyTimeout: 3000, readyPoll: 500, handoverTimeout: 50 };
// fileExists for: these files, plus the lock file while `open()` says FontHound is open
function files(list, open = () => true) {
  return (p) => (p === LOCK ? open() : list.includes(p));
}
// a sequence of answers, the last one repeats
const seq = (...a) => () => (a.length > 1 ? a.shift() : a[0]);

test('open_fonthound: FontHound already open, so the line is handed to it (no shell, no explorer)', async () => {
  const exe = 'C:\\Users\\Ed\\AppData\\Local\\Programs\\FontHound\\fonthound.exe';
  const frame = path.join(dir, 'frame.png');
  fs.writeFileSync(frame, 'png');
  const fx = fakeWin();
  const s = createServer({ env: WIN, platform: 'win32', execFile: fx.execFile, fileExists: files([exe, frame]), log: quiet });
  const r = await s.callTool('open_fonthound', { line: '  Lemon "Season" & co  ', frame_path: frame });
  assert.ok(!r.isError, r.content[0].text);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.status, 'opened');
  assert.ok(Date.parse(out.since) <= Date.now());
  // one argument each, as given: nothing to quote or escape; a frame outside %APPDATA% is passed as it is
  assert.deepEqual(fx.started(), [{ cmd: exe, args: ['--mockup-line', 'Lemon "Season" & co', '--mockup-frame', frame], killed: false }]);
});

test('open_fonthound: FontHound is found in Program Files, its old folder, or through its Start-menu shortcut', async () => {
  for (const exe of ['C:\\Program Files\\FontHound\\fonthound.exe', 'C:\\Users\\Ed\\AppData\\Local\\FontHound\\fonthound.exe']) {
    const s = createServer({ env: WIN, platform: 'win32', fileExists: files([exe]) });
    assert.equal((await s.launchCommand('Hi')).cmd, exe);
  }
  // a folder the user chose: the shortcut's target (a minimal shortcut in the documented format, see shortcutBytes)
  const chosen = 'D:\\Apps\\FontHound\\fonthound.exe';
  const lnk = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\FontHound.lnk';
  const s = createServer({ env: WIN, platform: 'win32', fileExists: files([chosen]),
    fs: { readFile: (p) => { if (p === lnk) return shortcutBytes(chosen); throw new Error('ENOENT'); } } });
  assert.equal((await s.launchCommand('Hi')).cmd, chosen);
  assert.equal(s.shortcutTarget(lnk), chosen);
  // a shortcut to something else, or a damaged one, isn't taken
  const other = createServer({ env: WIN, platform: 'win32', fileExists: () => true, fs: { readFile: () => shortcutBytes('D:\\x\\other.exe') } });
  assert.equal(other.shortcutTarget('a.lnk'), 'D:\\x\\other.exe');
  const odd = createServer({ env: WIN, platform: 'win32', fileExists: () => false, fs: { readFile: () => Buffer.from('not a shortcut') } });
  assert.equal(odd.shortcutTarget('a.lnk'), null);
  assert.equal(await odd.launchCommand('Hi'), null);
});

test('open_fonthound: FontHound not open, so the Windows shell starts it, then the line is handed over', async () => {
  const exe = 'C:\\Program Files\\FontHound\\fonthound.exe';
  const clock = fakeClock();
  // not open, then still starting twice, then its window is up
  const fx = fakeWin();
  const s = createServer({ env: { ...WIN, FONTHOUND_EXE: exe }, platform: 'win32', execFile: fx.execFile, fileExists: files([exe], seq(false, false, false, true)),
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
  const s = createServer({ env: { ...WIN, FONTHOUND_EXE: exe }, platform: 'win32', execFile: fx.execFile, fileExists: files([exe, frame]),
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
  const fx = fakeWin();
  const s = createServer({ env: { ...WIN, FONTHOUND_EXE: exe }, platform: 'win32', execFile: fx.execFile, fileExists: files([exe], () => false),
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
  const s = createServer({ env: { ...WIN, FONTHOUND_EXE: exe }, platform: 'win32', execFile: fx.execFile, fileExists: files([exe]), timing: fast, log: quiet });
  const out = JSON.parse((await s.callTool('open_fonthound', { line: 'Hi' })).content[0].text);
  assert.equal(out.status, 'opened-without-line');
  assert.match(out.message, /type the line on its Fonts tab[\s\S]*wait_for_selection/);
  assert.equal(fx.started()[0].killed, true);
  // a hand-over that fails outright says so too
  const fx2 = fakeWin({ handover: Object.assign(new Error('boom'), { code: 3 }) });
  const s2 = createServer({ env: { ...WIN, FONTHOUND_EXE: exe }, platform: 'win32', execFile: fx2.execFile, fileExists: files([exe]), timing: fast, log: quiet });
  const out2 = JSON.parse((await s2.callTool('open_fonthound', { line: 'Hi' })).content[0].text);
  assert.equal(out2.status, 'opened-without-line');
  assert.match(out2.message, /hand-over failed \(3\)/);
});

test('open_fonthound: FontHound not installed, bad input, macOS', async () => {
  const fx = fakeWin();
  const s = createServer({ env: { LOCALAPPDATA: 'C:\\nope', ProgramFiles: 'C:\\nope', ProgramData: 'C:\\nope' }, platform: 'win32', execFile: fx.execFile, fileExists: () => false, fs: { readFile: () => { throw new Error('ENOENT'); } } });
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

// A minimal OpenType file: a name table (licence text and URL, Windows
// platform, UTF-16BE) and an OS/2 table with `fsType`; `collection` wraps it in a .ttc.
function fontBytes({ text = '', url = '', fsType = 0, collection = false } = {}) {
  const strs = [[13, text], [14, url]].filter(([, v]) => v).map(([id, v]) => [id, Buffer.from(v, 'utf16le').swap16()]);
  const head = Buffer.alloc(6 + strs.length * 12);
  head.writeUInt16BE(strs.length, 2);
  head.writeUInt16BE(head.length, 4);
  let off = 0;
  strs.forEach(([id, b], i) => {
    const r = 6 + i * 12;
    head.writeUInt16BE(3, r); head.writeUInt16BE(1, r + 2); head.writeUInt16BE(0x409, r + 4);
    head.writeUInt16BE(id, r + 6); head.writeUInt16BE(b.length, r + 8); head.writeUInt16BE(off, r + 10);
    off += b.length;
  });
  const name = Buffer.concat([head, ...strs.map(([, b]) => b)]);
  const os2 = Buffer.alloc(96);
  os2.writeUInt16BE(fsType, 8);
  const pre = collection ? 16 : 0; // a collection header pointing at the one font
  const dir = Buffer.alloc(12 + 2 * 16);
  dir.writeUInt32BE(0x00010000, 0);
  dir.writeUInt16BE(2, 4);
  const nameAt = pre + dir.length;
  const os2At = nameAt + name.length;
  [['OS/2', os2At, os2.length], ['name', nameAt, name.length]].forEach(([tag, at, len], i) => {
    dir.write(tag, 12 + i * 16, 'latin1');
    dir.writeUInt32BE(at, 12 + i * 16 + 8);
    dir.writeUInt32BE(len, 12 + i * 16 + 12);
  });
  const ttc = Buffer.alloc(pre);
  if (collection) {
    ttc.write('ttcf', 0, 'latin1');
    ttc.writeUInt32BE(0x00010000, 4);
    ttc.writeUInt32BE(1, 8);
    ttc.writeUInt32BE(pre, 12);
  }
  return Buffer.concat([ttc, dir, name, os2]);
}

test('get_font_files: each font licence, read from its own file', async () => {
  const write = (name, opts) => { const f = path.join(dir, name); fs.writeFileSync(f, fontBytes(opts)); return f; };
  const ofl = write('ofl.ttf', { text: 'This Font Software is licensed under the SIL Open Font License, Version 1.1.', url: 'https://openfontlicense.org' });
  const apache = write('apache.ttf', { url: 'http://www.apache.org/licenses/LICENSE-2.0' });
  const bought = write('bought.otf', { text: 'Licensed under the Foundry EULA.', url: 'https://foundry.example/eula' });
  const mixed = write('mixed.ttf', { text: 'Microsoft supplied font. Any other use is prohibited. Some outlines under the Apache License.' });
  const locked = write('locked.ttf', { fsType: 0x0002 });
  const ttc = write('coll.ttc', { text: 'SIL Open Font License', collection: true });
  const s = createServer({ env: {} });
  assert.deepEqual(s.fontLicence(ofl), { kind: 'open', name: 'SIL Open Font License', url: 'https://openfontlicense.org' });
  assert.equal(s.fontLicence(apache).name, 'Apache License');
  assert.deepEqual(s.fontLicence(bought), { kind: 'unknown', name: 'Licensed under the Foundry EULA.', url: 'https://foundry.example/eula' });
  assert.equal(s.fontLicence(mixed).kind, 'unknown', 'a restricting text is never open');
  assert.equal(s.fontLicence(locked).kind, 'restricted-embedding');
  assert.equal(s.fontLicence(ttc).kind, 'open');
  assert.equal(s.fontLicence(fontFile), null, 'not a font: nothing claimed');
  assert.equal(s.fontLicence(path.join(dir, 'nope.ttf')), null);
  // through the tool: from the file, Adobe Fonts, a Google font previewed without installing
  const sel = sample();
  sel.fonts[0].file = ofl;
  sel.fonts[2] = { ...sel.fonts[2], source: 'not-installed', file: null, webFont: { from: 'Google Fonts', css: 'https://fonts.googleapis.com/css2?family=Gone' } };
  sel.fonts.push({ ...sel.fonts[0], option: 4, file: bought });
  const file = path.join(dir, 'licences.json');
  fs.writeFileSync(file, JSON.stringify(sel));
  const out = JSON.parse((await createServer({ env: { FONTHOUND_SELECTION_FILE: file } }).callTool('get_font_files', {})).content[0].text);
  assert.deepEqual(out.fonts.map((f) => f.licence.kind), ['open', 'adobe-fonts', 'open', 'unknown']);
  assert.equal(out.fonts[3].licence.url, 'https://foundry.example/eula');
});

test('the skill gates uploads of fonts that are not open-licensed', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'fonthound', 'SKILL.md'), 'utf8');
  const a = skill.indexOf('- **Fonts and third parties.**');
  assert.ok(a > 0, 'the rule is there');
  const rule = skill.slice(a, skill.indexOf('\n- ', a + 10));
  // silent on the user's computer
  assert.match(rule, /Rendering on the user's computer:[\s\S]*Say nothing about licences: no note, no question/);
  // a stop and an explicit Continue / Cancel decision before sending a non-open font
  assert.match(rule, /`unknown` or `restricted-embedding`: STOP before sending anything/);
  assert.match(rule, /Reply \*\*Continue\*\* to upload it, or[\s>]+\*\*Cancel\*\*/);
  assert.match(rule, /Upload only after an explicit "Continue"/);
  // never by default; Adobe Fonts never; nothing called allowed unless open
  assert.match(rule, /no answer: don't upload\. Never upload by default\./);
  assert.match(rule, /`adobe-fonts`: never upload it/);
  assert.match(rule, /Never say a font may be uploaded unless its `licence\.kind` is `open`/);
  // tool-neutral
  assert.ok(!/remotion|hyperframes|lambda|heygen|cloud run|ffmpeg|pillow/i.test(rule), 'no tool names');
});

test('the server does nothing an antivirus would read as suspicious', () => {
  const code = fs.readFileSync(SERVER, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  // no shell, PowerShell or WMI
  assert.ok(!/powershell|Invoke-CimMethod|Win32_Process|cmd\.exe|shell:\s*true|\bexecSync\b|\bspawn\(|[^.]\bexec\(/i.test(code));
  // no registry, no process or window listing, no hidden windows
  assert.ok(!/reg\.exe|tasklist|wmic|windowsHide|\bHK(CU|LM)\b/i.test(code));
  // no scan of other apps' package folders, no dynamic code, no encoded blobs
  assert.ok(!/\\\\Packages|'Packages'|readdir/i.test(code));
  assert.ok(!/\beval\(|new Function|base64|atob\(|fromCharCode/i.test(code));
  // the only programs it starts: explorer.exe (with FontHound's path) and fonthound.exe
  assert.equal((code.match(/execFile\(/g) || []).length, 3);
  assert.ok(!/unlink|rmSync|rmdir|writeFile/.test(code), 'deletes nothing, writes nothing but the frame copy');
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

// A Windows shortcut (.lnk) to `target`, laid out as [MS-SHLLINK] describes:
// the header, no item list, a LinkInfo with the local path in ANSI and Unicode.
function shortcutBytes(target) {
  const header = Buffer.alloc(0x4c);
  header.writeUInt32LE(0x4c, 0);
  header.writeUInt32LE(0x2 | 0x80, 0x14); // HasLinkInfo, IsUnicode
  const ansi = Buffer.from(target + ' ', 'latin1');
  const wide = Buffer.from(target + ' ', 'utf16le');
  const volume = Buffer.alloc(0x10);
  volume.writeUInt32LE(0x10, 0);
  const info = Buffer.alloc(0x24);
  const ansiAt = 0x24 + volume.length;
  const suffixAt = ansiAt + ansi.length;
  const wideAt = suffixAt + 1;
  info.writeUInt32LE(0x24, 4); // header size: Unicode offsets present
  info.writeUInt32LE(1, 8); // VolumeIDAndLocalBasePath
  info.writeUInt32LE(0x24, 0x0c);
  info.writeUInt32LE(ansiAt, 0x10);
  info.writeUInt32LE(suffixAt, 0x18);
  info.writeUInt32LE(wideAt, 0x1c);
  const body = Buffer.concat([info, volume, ansi, Buffer.alloc(1), wide]);
  body.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

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
