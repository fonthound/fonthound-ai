# FontHound AI

Pick the fonts for your video titles by eye, in your own installed fonts, and
have Claude use exactly those fonts and that look when it builds the video.

This plugin connects Claude Code (and other AI apps that support MCP) to
[FontHound](https://fonthound.app), a font browser for video editors on Windows.
When you ask Claude for a video, an intro, titles or a promo (Remotion, HTML,
ffmpeg, Pillow...), Claude asks once whether you want to pick the fonts
yourself. If you do, it opens FontHound with your title already typed in. You
see the line in every font on your computer, Adobe Fonts included, put your
favourites on a frame of your video, set the size, colour, tracking, stroke,
shadow and box, and press **Send to AI**. Claude then builds the video with
exactly those fonts and that look: the exact PostScript names, the font files,
the sizes in pixels of your frame. It never swaps in another font. If you'd
rather Claude chose, say so and it won't ask again in that project.

Claude may suggest a direction in words ("a warm serif would suit a restaurant
promo"), but you pick the actual fonts. The plugin has no tool that lists every
installed font and no tool that recommends fonts.

## Requirements

- **FontHound for Windows** on the same computer, licensed or in its trial
  (free 14-day trial, no card: https://fonthound.app/download). FontHound is a
  paid app ($9.90 a year after the trial); this plugin is free. A macOS version
  of FontHound is coming; until then the plugin's tools only open FontHound on
  Windows.
- **Node.js** (the local server is one plain JavaScript file with no
  dependencies; Claude Code users usually have Node already).

## What's inside

- **Skill `fonthound`**: tells Claude when to offer FontHound (once per project),
  how to read your selection, and how to load the fonts (CSS `local()`,
  `@font-face` with the file, Remotion, ffmpeg `drawtext`, Pillow), never
  substituting a font.
- **A small local MCP server** (`server/fonthound-mcp.js`, readable Node.js, no
  dependencies, started as `node ${CLAUDE_PLUGIN_ROOT}/server/fonthound-mcp.js`)
  with four tools:
  - `get_font_selection`: the fonts you sent from FontHound and their look;
  - `get_font_files`: each picked font's file and whether it exists;
  - `open_fonthound`: opens FontHound on its Fonts tab with your title (and
    optionally a still from your video);
  - `wait_for_selection`: waits until you press Send to AI (5 minutes at a
    time, then Claude checks in and waits again).

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

## Install

### Claude Code

From Claude's plugin directory: open `/plugin`, find **FontHound**, install.
Plugins from the directory update automatically.

Or from this repository, in Claude Code in a terminal:

```
/plugin marketplace add fonthound/fonthound-ai
/plugin install fonthound@fonthound
```

In the Claude desktop app, the `/plugin` command needs Claude Code's
interactive terminal, so run these in a terminal instead (Command Prompt,
PowerShell or Terminal), then start a new session in the app:

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

The same local server works in any app that supports MCP. Download this
repository (Code → Download ZIP, or `git clone https://github.com/fonthound/fonthound-ai`),
put it somewhere permanent, and point the app at `server/fonthound-mcp.js`.
Replace `PATH` below with that folder (on Windows use forward slashes, e.g.
`C:/Tools/fonthound-ai`). Then ask: "Use the fonts I picked in FontHound."

**Claude Desktop** (Settings → Developer → Edit Config, `claude_desktop_config.json`),
**Cursor** (`~/.cursor/mcp.json`), **Windsurf** (`~/.codeium/windsurf/mcp_config.json`)
and **Gemini CLI** (`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "fonthound": { "command": "node", "args": ["PATH/server/fonthound-mcp.js"] }
  }
}
```

**VS Code** (GitHub Copilot agent mode; `.vscode/mcp.json` in your project, or the
user `mcp.json`):

```json
{
  "servers": {
    "fonthound": { "type": "stdio", "command": "node", "args": ["PATH/server/fonthound-mcp.js"] }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.fonthound]
command = "node"
args = ["PATH/server/fonthound-mcp.js"]
```

Only Claude Code uses the skill, so only there does Claude offer FontHound on
its own; elsewhere, ask for your FontHound fonts. The tools are the same.

### Chat apps without MCP

Press **Send to AI** in FontHound and paste. The copied text has the exact
names, files and look.

## What it reads, writes and runs (privacy)

Everything stays on your computer. The plugin sends nothing over the network,
collects nothing, and reads nothing from your conversations.

- **Reads one file.** When you change the Mockup or press **Send to AI**,
  FontHound writes your selection to
  `%APPDATA%\FontHound\ai-selection.json` (macOS:
  `~/Library/Application Support/FontHound/ai-selection.json`). It holds the
  title line, the frame size, and for each option the font's names, its file
  path and the look. The server reads that file and checks whether the picked
  font files exist. FontHound deletes the file when you empty the Mockup, and
  writes it only while it is licensed or in its trial.
- **Runs FontHound, and only when Claude calls `open_fonthound`.** On Windows,
  if FontHound isn't open, the server asks the Windows shell to open
  `fonthound.exe` (it runs `explorer.exe` with the program's path, exactly like
  a double-click), waits until FontHound's window is there (it checks with
  Windows' `tasklist.exe`), then runs `fonthound.exe --mockup-line "<your title>"
  [--mockup-frame "<image>"]`, which hands the line to the open FontHound and
  exits. `fonthound.exe` is found through FontHound's own registry entry
  (`reg.exe query`). On a Mac: `open -a FontHound --args ...`. No shell, no
  PowerShell, no scripts: each program is started directly with plain
  arguments.

  Why the shell: the Claude desktop app on Windows is a packaged (MSIX) app,
  and programs it starts see a private copy of `%APPDATA%` and
  `%LOCALAPPDATA%`. A FontHound started directly from there would keep its
  selection and its licence in that private copy. Opened by the Windows shell,
  it runs as a normal app.
- **Writes almost nothing.** If the still frame you pass lives under
  `%APPDATA%` or `%LOCALAPPDATA%`, the server copies it to
  `%TEMP%\FontHound\claude-frame.<ext>` so FontHound can see it. It writes
  nothing else and deletes nothing.
- **An old private copy.** Version 0.1.2 and earlier of this plugin could leave
  a private copy of `ai-selection.json` in the Claude app's storage
  (`%LOCALAPPDATA%\Packages\Claude_...\LocalCache\Roaming\FontHound\`), which
  hides the real one from Claude. If the server finds one, it tells you where it
  is so you can delete it; it never deletes it itself. It never looks at
  licence files.
- File paths contain your Windows account name; they're only in that local file
  and in the text Send to AI puts on your clipboard, never in images FontHound
  exports.
- Adobe Fonts are named but never given a file path (they are Creative Cloud's
  protected copies); Claude loads them by name, which works for renders on your
  computer. For cloud rendering, fonts must be uploaded: check your fonts'
  licences; Adobe Fonts can't be uploaded.

FontHound's privacy policy: https://fonthound.app/privacy.html

## Troubleshooting

- **"FontHound isn't installed"**: install FontHound (free trial at
  https://fonthound.app/download), then ask again.
- **FontHound opens but without your title** (`opened-without-line`): type the
  title on the Fonts tab yourself; everything else works the same.
- **FontHound doesn't open** (`not-opened`): open it from the Start menu, type
  the title, pick, press Send to AI; Claude is waiting for it.
- **Claude never sees your Send to AI**: make sure FontHound is licensed or in
  its trial. If Claude says an old copy hides your selection, delete the file it
  names and try again.
- Support: support@fonthound.app

## Tests

```
node --test
```

`FONTHOUND_SELECTION_FILE` and `FONTHOUND_EXE` point the server at other paths
(the tests use them).

## Changes

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
