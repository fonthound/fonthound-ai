# FontHound AI

Your AI can make your video. The font should still be your call.

FontHound AI connects your AI tools (Claude Code, Claude Desktop, Cursor, VS Code, Codex CLI, Gemini CLI, Windsurf and any app that supports MCP) to [FontHound](https://fonthound.app), the font
browser for video editors. When you ask Claude for a video, an intro, titles or a
promo (Remotion, HTML, ffmpeg, Pillow...), Claude asks whether you want to pick
the fonts yourself. If you do, it opens FontHound with your title already typed
in. You see the line in every font on your computer, Adobe Fonts included, put
your favourites on a frame of your video, set the size, colour, tracking, stroke,
shadow and box, and press **Send to AI**. Claude then builds the video with
exactly those fonts and that look: the exact PostScript names, the font files,
the sizes in pixels of your frame. It never swaps in another font.

Claude may suggest a direction in words ("a warm serif would suit a restaurant
promo"), but you pick the actual fonts by eye. The plugin has no tool that lists
every installed font and no tool that recommends fonts.

## What's inside

- **Skill `fonthound`**: tells Claude when to offer FontHound, how to read your
  selection, and how to load the fonts (CSS `local()`, `@font-face` with the file,
  Remotion, ffmpeg `drawtext`, Pillow), never substituting a font.
- **A small local MCP server** (`server/fonthound-mcp.js`, plain Node.js, no
  dependencies) with four tools:
  - `get_font_selection`: the fonts you sent from FontHound and their look;
  - `get_font_files`: each font's file and whether it exists;
  - `open_fonthound`: opens FontHound on its Fonts tab with your title (and optionally a
    still from your video);
  - `wait_for_selection`: waits until you press Send to AI (up to 20 minutes;
    a Send that lands as the wait ends still counts).

If a picked font looks like a trial, demo or personal-use file (from its file
name or its name table), the selection says so (`licenseHint`) and Claude
mentions it once; nothing is blocked.

## Install

You need **FontHound** installed on the same computer, licensed or in its trial
(free 14-day trial: https://fonthound.app/download), and Node.js (Claude Code
users usually have it). FontHound runs on Windows; macOS is coming.

### Claude Code (recommended: Claude offers FontHound by itself)

In Claude Code in a terminal:

```
/plugin marketplace add fonthound/fonthound-ai
/plugin install fonthound@fonthound
```

**In the Claude desktop app**, the `/plugin` command needs Claude Code's
interactive terminal, so install from a terminal instead (Command Prompt,
PowerShell or Terminal), then start a new session in the app:

```
claude plugin marketplace add fonthound/fonthound-ai
claude plugin install fonthound@fonthound
```

Then ask for a video, for example "Make a 10-second Remotion intro that says
Lemon Season", or say "use my FontHound fonts" after pressing Send to AI.

### Other AI apps (MCP)

The same local server works in any app that supports MCP. Download this repository
(Code → Download ZIP, or `git clone https://github.com/fonthound/fonthound-ai`), put
it somewhere permanent, and point the app at `server/fonthound-mcp.js`. Replace
`PATH` below with that folder (on Windows use forward slashes, e.g.
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

Only Claude Code uses the skill, so only there does the AI offer FontHound on its
own; elsewhere, ask for your FontHound fonts. The tools are the same everywhere.

### Chat apps without MCP (ChatGPT, web chats)

Press **Send to AI** in FontHound and paste. The copied text has the exact names,
files and look.

## How it works, and privacy

Everything stays on your computer. Nothing is uploaded and nothing goes over the
network.

- When you change the Mockup or press **Send to AI**, FontHound writes your
  selection to one file:
  - Windows: `%APPDATA%\FontHound\ai-selection.json`
  - macOS: `~/Library/Application Support/FontHound/ai-selection.json`

  It holds the title line, the frame size, and for each option the font's names,
  its file path, and the look. FontHound deletes the file when you empty the
  Mockup. The app, the After Effects / Premiere Pro panel and the DaVinci Resolve
  plugin all write the same file (the last one wins). It's only written while
  FontHound is licensed or in its trial.
- The MCP server only reads that file, checks whether the chosen font files exist,
  and starts FontHound (`fonthound.exe --mockup-line "<your title>"
  [--mockup-frame "<image>"]`, found through FontHound's own registry entry; on a
  Mac `open -a FontHound --args ...`). It runs no shell and writes nothing.
- File paths contain your Windows account name; they're only in that local file
  and in the text Send to AI puts on your clipboard, never in images FontHound
  exports.
- Adobe Fonts are named but never given a file path (they are Creative Cloud's
  protected copies); Claude loads them by name, which works for renders on your
  computer. For cloud rendering, fonts must be uploaded: check your fonts'
  licences; Adobe Fonts can't be uploaded.

Without the plugin, Send to AI still copies the same information as Markdown;
paste it into any AI tool.

## Tests

```
node --test
```

`FONTHOUND_SELECTION_FILE` and `FONTHOUND_EXE` point the server at other paths
(the tests use them).

## Licence

MIT. FontHound itself is a paid app ($9.90 a year after a 14-day free trial);
this plugin is free. Support: support@fonthound.app.
