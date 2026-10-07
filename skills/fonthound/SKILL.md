---
name: fonthound
description: Use whenever the user asks for a video, motion graphics, an intro or outro, a title card, lower thirds, captions or subtitle styling, a promo, a reel or a thumbnail made with Remotion, HTML/CSS, ffmpeg, Pillow or similar, and whenever they mention FontHound or "my fonts" / "the fonts I picked". Lets the user pick the title fonts by eye in FontHound (their own installed fonts, on their own title) and hands Claude the exact names, files and look to use.
when_to_use: Before choosing any font for video titles, text overlays, captions or graphics; when the user says "use my FontHound fonts", "the fonts I picked", "my selection".
---

# FontHound: the user picks the fonts, Claude uses them exactly

FontHound is a font browser on the user's computer. In its Mockup the user sees
their title in their own installed fonts (Adobe Fonts included), over a frame of
their video, and keeps up to five options with a look (size, colour, tracking,
stroke, shadow, box, position). "Send to AI" hands that selection to you.

## 1. Ask once, before choosing any font

When a task puts text in a video or graphic and the fonts aren't settled yet, ask
the user one question, once per project:

> Want to pick the fonts yourself in FontHound (your installed fonts, on your own title), or should I choose?

- **They'll pick in FontHound:** go to step 2.
- **They want you to choose:** choose as you normally would; don't ask again in this project.
- **They already picked** ("use my FontHound fonts"): skip to step 3.

You may suggest a direction in words to help them look (for example: "for a
restaurant promo, a warm serif or a handwritten script would suit; try a few of
those in FontHound"). The user picks the actual fonts by eye in FontHound.

## 2. Open FontHound with their title, then wait

1. Call `open_fonthound` with `line` = the title exactly as it will appear (keep
   the user's language and line breaks). If you already rendered a still from the
   video, pass its absolute path as `frame_path` so they judge the fonts on the
   real shot.
2. Tell the user: "FontHound is open with your title in every font. Add the ones
   you like to the Mockup (+), adjust the look there, and press **Send to AI**."
3. Call `wait_for_selection` with the `since` that `open_fonthound` returned
   (leave `timeout_s` out: it waits 5 minutes). When it returns
   `status: "timeout"`, call `get_font_selection` first: if its selection's
   `sent` is after `since`, the user sent it meanwhile, so use it. Otherwise tell
   the user you're still waiting for **Send to AI** (or ask whether they're done),
   then call `wait_for_selection` again with the same `since`.
4. If `open_fonthound` says FontHound isn't installed, tell the user (free 14-day
   trial at https://fonthound.app/download) and ask whether you should choose instead.
   If it returns `status: "not-opened"`, ask the user to open FontHound from the
   Start menu and type the title on its Fonts tab, then wait as in step 3. If it
   returns `status: "opened-without-line"`, FontHound is open: ask the user to
   type the title on its Fonts tab, then wait as in step 3.
5. If a result has `status: "stale-copy"` (or a `warning`), an old copy of the
   selection left by an earlier version of this plugin hides the real one. Tell
   the user in a sentence and ask them to delete the one file named in the
   message (or delete it for them if they say yes), then try again.

## 3. Use the selection exactly

`get_font_selection` (or `wait_for_selection`) returns:

- `line`, `direction` (`rtl` for Hebrew/Arabic), `frame` (`width`, `height`: the
  frame the look was designed on; px values are in its pixels).
- `fonts[]`, options 1-5 in the user's order. **One option: use it. Two or more:
  don't pick one yourself.** The user sent several on purpose (to compare, or for
  different parts), so ask before rendering, listing them by number and name, e.g.
  "You sent 3 fonts: 1 Abril Fatface, 2 Adobe Gothic Std B, 3 Adobe Heiti Std R.
  Use one for everything (which?), split them (e.g. 1 for the title, 2 for the
  subtitle), or should I make a version with each?" Skip the question only when
  the user already said how to use them. Each has `family`, `style`,
  `postscriptName`, `fullName`, `weight`, `italic`, `stretch`, `css`, `file`
  (absolute path, or null), `source` (`installed`, `adobe-fonts`, `not-installed`),
  `note`, sometimes `licenseHint` (see below), and `look`: `sizePx`,
  `sizePercentOfFrameWidth`, `color`, `tracking` (1/1000 em) and
  `letterSpacingEm`, `leadingPx` and `lineHeightPx`, `stroke`, `shadow` (with
  `offsetXPx`/`offsetYPx`), `box`, `rotationDeg`, `position` (`xPercent`,
  `yPercent` of the text's centre).
- `sent`: when the user last pressed Send to AI.

Rules:

- **Use the exact names. Never substitute another font**, not even a "similar"
  one, and never quietly fall back. If a font can't be loaded by name or file,
  stop and tell the user which one and why.
- **Load by name first, then from `file`.** `get_font_files` says whether each file
  still exists.
- **Adobe Fonts (`source: "adobe-fonts"`) have no file:** load them by name only
  (CSS `local()`); they work in renders on this computer. Never copy or upload
  Creative Cloud's font files. ffmpeg's `subtitles`/ASS filter also takes a font
  by name (`force_style='FontName=…'`). If a tool can only take a file (ffmpeg
  `drawtext`, Pillow), say so and offer an HTML/Remotion render instead.
- **`not-installed`:** a free Google font the user previewed without installing.
  Ask them to install it (FontHound > Get fonts) or load it from Google Fonts.
- **`licenseHint`** (`trial`, `demo`, `personal-use` or `non-commercial`): the
  font's file name or name table suggests a restricted licence. Tell the user
  briefly, once (for example: "Note: Option 2 looks like a trial font; it usually
  can't be used in commercial work until bought."), then carry on with it. Don't
  refuse, don't swap it for another font, and don't repeat the warning.
- **Scale the look with the frame:** `value * (your width / frame.width)`.
- **Load the exact weight and style** (no faux bold or italic).
- **Rendering in the cloud** (Remotion Lambda, a hosted renderer)? The font file must
  be uploaded there: fine for open-licence fonts; for bought fonts the user must
  check their licence; Adobe Fonts can't be uploaded. Say this plainly.
- Nothing from FontHound goes anywhere else: don't paste file paths into public
  places; they include the user's Windows account name.

### Recipes

HTML / CSS (and Remotion, which renders in Chromium on this computer):

```css
@font-face {
  font-family: "Pick1";
  src: local("JosefinSans-Bold"), local("Josefin Sans Bold"),
       url("file:///C:/Users/me/AppData/Local/Microsoft/Windows/Fonts/JosefinSans-Bold.ttf");
  font-weight: 700; font-style: normal;
}
.title {
  font-family: "Pick1"; font-weight: 700;
  font-size: 150px;                 /* look.sizePx, scaled to your frame */
  letter-spacing: 0.04em;           /* look.letterSpacingEm */
  line-height: 180px;               /* look.lineHeightPx */
  color: #ffd84a;
  -webkit-text-stroke: 6px #1a1a1a; paint-order: stroke fill; /* stroke: 2 x widthPx, outside */
  text-shadow: 4.24px 4.24px 18px rgba(0,0,0,.6);             /* shadow offset/blur/opacity */
  position: absolute; left: 50%; top: 78%; transform: translate(-50%, -50%) rotate(0deg);
}
```

In Remotion, a `file://` URL is blocked in the browser context; prefer
`local()`, or copy an open-licence file into `public/` and use `staticFile()` with
`@remotion/fonts` `loadFont`. Wait for the font and fail loudly:

```ts
import { delayRender, continueRender, cancelRender } from "remotion";
const h = delayRender("FontHound font");
document.fonts.load('700 150px "Pick1"').then((faces) => {
  if (!faces.length) cancelRender(new Error('Font "Josefin Sans Bold" not found: open FontHound'));
  else continueRender(h);
});
```

ffmpeg (`drawtext` takes the file; escape the drive colon on Windows):

```bash
ffmpeg -i in.mp4 -vf "drawtext=fontfile='C\:/Users/me/AppData/Local/Microsoft/Windows/Fonts/JosefinSans-Bold.ttf':text='Lemon Season':fontsize=150:fontcolor=0xFFD84A:borderw=3:bordercolor=0x1A1A1A:shadowx=4:shadowy=4:x=(w-text_w)/2:y=h*0.78-text_h/2" out.mp4
```

Pillow:

```python
from PIL import ImageFont
font = ImageFont.truetype(r"C:\Users\me\AppData\Local\Microsoft\Windows\Fonts\JosefinSans-Bold.ttf", 150)
```

For Hebrew or Arabic (`direction: "rtl"`), set `direction: rtl` in CSS; in Pillow
use `layout_engine=ImageFont.Layout.RAQM`, but only if
`PIL.features.check("raqm")` is true (the usual Windows wheels lack it and draw
RTL text backwards): otherwise render the text with HTML or ffmpeg `drawtext`.

Whatever the tool, don't hand the pick to a template only as a theme or
`font-family` name: templates often hardcode their own fonts, or force
`font-weight: 700` (faux bold on a Regular). Check a rendered frame.

### OpenMontage

If the project uses OpenMontage (it has `AGENT_GUIDE.md`, `pipeline_defs/` and
`remotion-composer/`), the user's pick is the typography of the proposal's visual
identity: ask the FontHound question there, before the playbook is chosen. Then:

- Its stock scenes (`text_card`, `hero_title`, the HyperFrames scaffold's text
  card) ignore the theme's fonts or fake the weight, so put text in the picked
  fonts in an **atelier** composition (`composition_mode: "atelier"`), Remotion
  or HyperFrames, and say why when you propose it.
- Load the picks with the `@font-face` recipe above, not with
  `@remotion/google-fonts`. If you add the file to `url()`, copy it into that
  project's own folder (Remotion: the per-project `public_dir`, `staticFile()`;
  HyperFrames: the workspace, a relative `url()`). Adobe Fonts: `local()` only.
- Also set the playbook's `typography` to the picked family, so its DESIGN.md
  and reviews name the right font.
- Its typography guide and playbooks suggest fonts (Inter, Space Grotesk…).
  They apply only when the user asked you to choose.

## 4. Without the MCP tools

If the `fonthound` tools aren't available, read the selection file directly:

- Windows: `%APPDATA%\FontHound\ai-selection.json`
- macOS: `~/Library/Application Support/FontHound/ai-selection.json`

Same JSON (`version: 1`). If the user ran "Send to AI", the same data is also on
their clipboard as Markdown, which they can paste.

## 5. No selection?

If there's no file, or it has no fonts, tell the user: "Open FontHound, put the
fonts you like in the Mockup, press Send to AI, and tell me when you're done."
FontHound needs a licence or a trial (free 14-day trial: https://fonthound.app/download).
