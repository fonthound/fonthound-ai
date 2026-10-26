# FontHound AI

Pick the fonts by eye, in your own installed fonts, whenever Claude makes
something with text, and have Claude use exactly those fonts and that look.

This plugin connects Claude Code (and other AI apps that support MCP) to
[FontHound](https://fonthound.app), a font browser for video editors and
designers on Windows. Whenever you ask Claude to make something with text and a
font has to be chosen (a video, motion graphics, a GIF, an image, a thumbnail,
a poster, an ad, a social post, a banner, slides, logo text, captions, lower
thirds, a UI mockup's headlines), in any tool (Remotion, HyperFrames, HTML/CSS,
ffmpeg, Pillow, matplotlib...), Claude first asks one short question: "Want to
pick the fonts by eye in FontHound?" If you do, it opens FontHound with your
text already typed in. You see the line in every font on your computer, Adobe
Fonts included, put your favourites on a frame of your work, set the size,
colour, tracking, stroke, shadow and box, and press **Send to AI**. Claude then
builds it with exactly those fonts and that look: the exact PostScript names,
the font files, the sizes in pixels of your frame. It never swaps in another
font. If another skill leads the build (a video framework, say), the font
question still comes first and your picks become its typography.

Claude asks once per task. Say no (or "you choose") and it won't ask again in
that conversation; if you already sent fonts, it just uses them.

Claude may suggest a direction in words ("a warm serif would suit a restaurant
promo"), but you pick the actual fonts. The plugin has no tool that lists every
installed font and no tool that recommends fonts.

## Requirements

- **FontHound for Windows** on the same computer, licensed or in its trial
  (free 7-day trial: https://fonthound.app/download?utm_source=claude-plugin&utm_medium=plugin).
  FontHound is a paid app ($19 a year). A macOS version of FontHound is
  coming (waitlist:
  https://fonthound.app/download?utm_source=claude-plugin&utm_medium=plugin);
  until then the plugin works on Windows only.
- **Nothing else.** FontHound 1.0.1 or newer runs the plugin's server itself
  (`fonthound.exe --mcp`), so no Node.js is needed. With an older FontHound, the
  plugin uses its own JavaScript server instead, which needs Node.js; updating
  FontHound removes that need.

## What's inside

- **Skill `fonthound`**: tells Claude to offer FontHound before it chooses any
  font (once per task),
  how to read your selection, and how to load the fonts (CSS `local()`,
  `@font-face` with the file, Remotion, ffmpeg `drawtext`, Pillow), never
  substituting a font.
- **A prompt hook** (`hooks/hooks.json`): with every prompt, Claude Code adds
  one short line telling Claude to follow the FontHound skill if the request
  will make it choose a font for visible text, in any language and any tool,
  and to ignore it otherwise. The skill alone was picked up only sometimes. The
  hook is a plain `echo` of that line: it runs no program, reads nothing, sends
  nothing and never blocks the prompt.
- **A local MCP server.** Claude Code starts `server/fonthound.cmd`, a short
  launcher that runs FontHound's own program as the server
  (`fonthound.exe --mcp`). With a FontHound older than 1.0.1 it runs
  `server/fonthound-mcp.js` (readable Node.js, no dependencies) with Node.js
  instead; both give the same five tools:
  - `get_font_selection`: the fonts you sent from FontHound and their look;
  - `get_font_files`: each picked font's file and whether it exists;
  - `open_fonthound`: opens FontHound on its Fonts tab with your text (and
    optionally a still from your video);
  - `wait_for_selection`: waits until you press Send to AI (5 minutes at a
    time, then Claude checks in and waits again);
  - `offer_font_picking`: the step before Claude chooses any font for something
    with text: whether FontHound is installed, and the one question to ask you
    (it opens nothing);
  - `fonthound_status`: whether FontHound is installed on this computer (it
    opens nothing).

  And one prompt, **Pick fonts with FontHound**, for apps that list prompts in
  their menu.

If a picked font looks like a trial, demo or personal-use file (from its file
name or its name table), the selection says so (`licenseHint`) and Claude
mentions it once; nothing is blocked.

## Examples

1. "Make a 10-second Remotion intro that says **Lemon Season**." Claude asks
   whether you want to pick the fonts in FontHound, opens it with "Lemon Season"
   typed in, waits for Send to AI, then renders the intro in your fonts.
2. "Add lower thirds with the speaker's name to this clip with ffmpeg; I'll pick
   the font." Claude renders a still of the clip, opens FontHound with the name
   over that still, and uses the font file you picked in `drawtext`.
3. After pressing Send to AI yourself: "Use my FontHound fonts for the title
   card in this HTML page." Claude reads the selection and writes the CSS with
   the exact family, weight, size, colour and stroke.
4. "Make a YouTube thumbnail with Pillow that says **I Quit Coffee**." Claude
   asks the same one question before choosing a font; say "you choose" and it
   picks one itself and won't ask again in that conversation.

## Install

### Claude Code

From Claude's plugin directory: open `/plugin`, find **FontHound**, install.
Plugins from the directory update automatically.

Or from this repository: paste this into Claude Code (the Claude desktop app
or a terminal). Claude installs it for you; click **Allow** when it asks.

```
Install the FontHound plugin: add the marketplace fonthound/fonthound-ai, then install fonthound@fonthound.
```

Then start a new Claude session: the plugin loads there.

By hand, in a terminal:

```
claude plugin marketplace add fonthound/fonthound-ai
claude plugin install fonthound@fonthound
```

### Updating

Installed from the directory: updates arrive by themselves. Installed from this
repository: run `/plugin`, open **Marketplaces**, choose **fonthound** and
switch on **auto-update** once; or update by hand with
`claude plugin marketplace update fonthound` then
`claude plugin update fonthound@fonthound`, and restart Claude.

### Other AI apps (MCP)

FontHound works with **Claude Code** (the terminal, the VS Code extension and
the Claude desktop app's Code tab). FontHound Setup adds this plugin for you
when you keep **Claude Code** ticked.

The same server works in any app that supports MCP: point the app at
FontHound's program with the argument `--mcp`. Replace `EXE` below with its
path, by default `C:/Users/<you>/AppData/Local/Programs/FontHound/fonthound.exe`
or `C:/Program Files/FontHound/fonthound.exe` (forward slashes). Then ask:
"Use the fonts I picked in FontHound."

**Cursor** (`~/.cursor/mcp.json`), **Windsurf** (`~/.codeium/windsurf/mcp_config.json`)
and **Gemini CLI** (`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "fonthound": { "command": "EXE", "args": ["--mcp"] }
  }
}
```

**VS Code** (GitHub Copilot agent mode; `.vscode/mcp.json` in your project, or the
user `mcp.json`):

```json
{
  "servers": {
    "fonthound": { "type": "stdio", "command": "EXE", "args": ["--mcp"] }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.fonthound]
command = "EXE"
args = ["--mcp"]
```

With a FontHound older than 1.0.1, use Node.js and this repository's
`server/fonthound-mcp.js` instead (`"command": "node", "args": ["PATH/server/fonthound-mcp.js"]`).

Claude Code uses the skill; the server also gives every app a short version
of it (its MCP instructions), so Claude offers FontHound on its own there too
where the app passes them on. Elsewhere, ask for your FontHound fonts. The
tools are the same.

### Chat apps without MCP

Press **Send to AI** in FontHound and paste. The copied text has the exact
names, files and look.

## What it reads, writes and runs (privacy)

Everything stays on your computer. The plugin sends nothing over the network,
collects nothing, and reads nothing from your conversations.

- **Reads your selection.** When you change the Mockup or press **Send to AI**,
  FontHound writes your selection to
  `%APPDATA%\FontHound\ai-selection.json` (macOS:
  `~/Library/Application Support/FontHound/ai-selection.json`). It holds the
  text, the frame size, and for each option the font's names, its file
  path and the look. The server reads that file and checks whether the picked
  font files exist. When Claude asks for the files, it also reads each picked
  font file's licence fields (its licence text and URL, and its embedding
  flag) to say whether the font is under an open licence. FontHound deletes the file when you empty the Mockup, and
  writes it only while it is licensed or in its trial.
- **Adds one line to each prompt** (the hook above): an `echo` of a fixed
  sentence; your prompt isn't read or stored.
- **Starts the server.** `server/fonthound.cmd` reads the path FontHound
  wrote for it (`%APPDATA%\FontHound\app-path.txt`), else looks in
  FontHound's install folders, and runs `fonthound.exe --mcp` when the file
  `claude\fonthound-mcp.txt` is beside it (the sign of a FontHound that has the
  server). Otherwise it runs `node server/fonthound-mcp.js` if Node.js is
  installed, or stops with a message. It only checks files and starts one
  program. The server is the same either way, as described below.
- **Runs FontHound, and only when Claude calls `open_fonthound`.** On Windows,
  the server finds `fonthound.exe` in FontHound's install folders
  (`%LOCALAPPDATA%\Programs\FontHound`, `C:\Program Files\FontHound`), or
  through FontHound's Start-menu shortcut if you installed it elsewhere. It
  knows FontHound is open from one file: the lock file FontHound's window holds
  in its own data folder while it runs. If FontHound isn't open, the server asks
  the Windows shell to open it (it runs `explorer.exe` with the program's path,
  exactly like a double-click) and waits until that file is there; then it runs
  `fonthound.exe --mockup-line "<your text>" [--mockup-frame "<image>"]`,
  which hands the line to the open FontHound and exits. On a Mac: if
  `FontHound.app` is in `/Applications` or `~/Applications`,
  `open -a FontHound --args ...`. `fonthound_status` makes the same file
  check (is `fonthound.exe` or `FontHound.app` there?) and starts nothing. The server itself uses no shell, no PowerShell, no
  registry, no list of running programs: each program is started directly with
  plain arguments.

  Why the shell: the Claude desktop app on Windows is a packaged (MSIX) app,
  and programs it starts see a private copy of `%APPDATA%` and
  `%LOCALAPPDATA%`. A FontHound started directly from there would keep its
  selection and its licence in that private copy. Opened by the Windows shell,
  it runs as a normal app.
- **Writes almost nothing.** If the still frame you pass lives under
  `%APPDATA%` or `%LOCALAPPDATA%`, the server copies it to
  `%TEMP%\FontHound\claude-frame.<ext>` so FontHound can see it. It writes
  nothing else and deletes nothing.
- File paths contain your Windows account name; they're only in that local file
  and in the text Send to AI puts on your clipboard, never in images FontHound
  exports.
- Adobe Fonts are named but never given a file path (they are Creative Cloud's
  protected copies); Claude loads them by name, which works for renders on your
  computer. For cloud rendering, fonts must be uploaded: check your fonts'
  licences; Adobe Fonts can't be uploaded.

FontHound's privacy policy: https://fonthound.app/privacy.html

## Troubleshooting

- **Claude has no FontHound tools** (`/mcp` shows `fonthound` as failed):
  update FontHound to 1.0.1 or newer (it offers the update when it opens, or
  https://fonthound.app/download?utm_source=claude-plugin&utm_medium=plugin),
  then restart Claude Code. With an older FontHound the plugin needs Node.js.
- **"FontHound isn't installed"**: install FontHound (free 7-day trial at
  https://fonthound.app/download?utm_source=claude-plugin&utm_medium=plugin), then
  ask again.
- **FontHound opens but without your text** (`opened-without-line`): type the
  text on the Fonts tab yourself; everything else works the same.
- **FontHound doesn't open** (`not-opened`): open it from the Start menu, type
  the text, pick, press Send to AI; Claude is waiting for it.
- **Claude never sees your Send to AI**: make sure FontHound is licensed or in
  its trial.
- **Your antivirus removed the plugin** (versions up to 0.1.6 asked Windows for
  the list of running programs and read the registry, which some antivirus
  behaviour monitors flag): update to 0.1.7 or later, which does neither. If it
  still happens, restore the file from quarantine, add an exception and write to
  support@fonthound.app.
- Support: support@fonthound.app

## Tests

```
node --test
```

`FONTHOUND_SELECTION_FILE` and `FONTHOUND_EXE` point the server at other paths
(the tests use them).

## Changes

- **0.2.2**: FontHound's free trial is now 7 days: the "not installed" message,
  the skill and this README say so.
- **0.2.1**: the directory description now says it's for Claude Code with FontHound for Windows.
- **0.2.0** (continued): a prompt hook adds one constant line to every prompt,
  so Claude asks about FontHound for every job that chooses fonts, not only
  sometimes; Claude judges relevance itself, in any language.
- **0.2.0** (continued): a new read-only tool, `offer_font_picking`, whose
  description tells Claude to offer FontHound before it chooses any font, and a
  prompt, "Pick fonts with FontHound" (in Claude Code, a slash command). The skill
  now says the picks fix the typeface and Claude still designs the piece; the
  Mockup's look is a starting point (`look.styled` says what the user set).
- **0.2.0**: no Node.js needed. The plugin starts FontHound's own program as
  its server (`fonthound.exe --mcp`, FontHound 1.0.1 or newer) through a short
  launcher, `server/fonthound.cmd`; with an older FontHound it uses the
  JavaScript server as before (that needs Node.js). The server now gives Claude
  the skill's rules in short (MCP instructions), for apps that load no skill.
  If FontHound's tools aren't there, Claude says once how to connect FontHound
  (install or update it), then chooses the fonts itself.

- **0.1.10**: FontHound has launched: without FontHound, Claude links the free
  14-day trial (fonthound.app/download, which offers the Mac waitlist on a Mac)
  instead of the beta, which has ended.
- **0.1.9**: a new read-only tool, `fonthound_status`, says whether FontHound
  is installed (the same file check `open_fonthound` makes; it opens nothing and
  sends nothing), so Claude checks before it asks. Without FontHound on Windows,
  Claude says in one sentence what FontHound is and links the beta (the trial since 0.1.10) (once
  per conversation), then chooses the fonts itself; on a Mac it says FontHound
  is Windows-only for now, links the Mac waitlist and chooses the fonts.
  `open_fonthound` gives the same messages instead of the old trial link.
- **0.1.8**: follows FontHound 0.8.4, where the Get fonts tab became the Fonts
  tab's Free / All switch: a free font that isn't installed yet is installed from
  Fonts tab > Free > Install.
- **0.1.7**: Claude offers FontHound before it chooses any font for anything
  with text (videos, images, thumbnails, posters, slides, captions...), in any
  tool, once per task, and before another skill builds. The local server no
  longer reads the registry, lists running programs or looks in other apps'
  folders (antivirus behaviour monitors such as Bitdefender's flagged 0.1.3):
  it finds FontHound in its folders or Start-menu shortcut, and knows it is open
  from a file. Fonts previewed in FontHound's Free list (Fonts tab) without installing
  come with a web-font stylesheet (Google Fonts only for Google's own fonts) and
  what to tell the user; local() names in the order full name, PostScript name.
  Fonts bundled in Store apps (WindowsApps) load by name; file:// noted as
  blocked in any page served over http. Rendering anywhere but your own
  computer: `get_font_files` reads each font's licence from its file, and
  before any step sends a font file to another service, Claude uploads an
  open-licence font, asks you to reply Continue or Cancel for any other font
  (never uploading by default), and never uploads Adobe Fonts. Rendering on
  your computer: no licence talk.
- **0.1.6**: works with OpenMontage (your picks go into its Remotion and HyperFrames renders, loaded from the font files); clearer rules for Pillow and ffmpeg.
- **0.1.5**: FontHound is opened by the Windows shell instead of PowerShell/WMI,
  and the line is handed to it through FontHound's own single-instance
  hand-over; the server no longer deletes anything (an old private copy of the
  selection is reported with its path instead); clearer statuses and messages.
- **0.1.4**: when you send more than one font, Claude asks how to use them instead of taking the first.
- **0.1.3**: in the Claude desktop app on Windows, Send to AI always arrives and
  FontHound opened from Claude keeps your licence: FontHound now starts outside
  the app's private storage, and a stale private selection left by 0.1.2 is
  removed. `wait_for_selection` waits 5 minutes at a time and shows progress.
- **0.1.2**: opened from Claude, FontHound starts on its Fonts tab with your line.
- **0.1.1**: Windows font names in Send to AI, trial-font hints.

## Licence

MIT. Support: support@fonthound.app.
