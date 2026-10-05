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
2. Tell the user: "FontHound is open with your title. Put the fonts you like in
   the Mockup, adjust the look, and press **Send to AI**."
3. Call `wait_for_selection` with the `since` that `open_fonthound` returned
   (use `timeout_s: 300`). When it returns `status: "timeout"`, ask the user
   whether they're done; then wait again, or call `get_font_selection`.
4. If `open_fonthound` says FontHound isn't installed, tell the user (free 14-day
   trial at https://fonthound.app/download) and ask whether you should choose instead.

## 3. Use the selection exactly

`get_font_selection` (or `wait_for_selection`) returns:

- `line`, `direction` (`rtl` for Hebrew/Arabic), `frame` (`width`, `height`: the
  frame the look was designed on; px values are in its pixels).
- `fonts[]`, options 1-5 in the user's order. Option 1 is the default; use other
  options only where the user says so (or ask). Each has `family`, `style`,
  `postscriptName`, `fullName`, `weight`, `italic`, `css`, `file` (absolute path,
  or null), `source` (`installed`, `adobe-fonts`, `not-installed`), `note`, and
  `look`: `sizePx`, `sizePercentOfFrameWidth`, `color`, `tracking` (1/1000 em) and
  `letterSpacingEm`, `leadingPx` and `lineHeightPx`, `stroke`, `shadow` (with
  `offsetXPx`/`offsetYPx`), `box`, `rotationDeg`, `position` (`xPercent`,
  `yPercent` of the text's centre).

Rules:

- **Use the exact names. Never substitute another font**, not even a "similar"
  one, and never quietly fall back. If a font can't be loaded by name or file,
  stop and tell the user which one and why.
- **Load by name first, then from `file`.** `get_font_files` says whether each file
  still exists.
- **Adobe Fonts (`source: "adobe-fonts"`) have no file:** load them by name only
  (CSS `local()`); they work in renders on this computer. Never copy or upload
  Creative Cloud's font files. If a tool can only take a file (ffmpeg, Pillow),
  say so and offer an HTML/Remotion render instead.
- **`not-installed`:** a free Google font the user previewed without installing.
  Ask them to install it (FontHound > Get fonts) or load it from Google Fonts.
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
use `layout_engine=ImageFont.Layout.RAQM` where available.

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
