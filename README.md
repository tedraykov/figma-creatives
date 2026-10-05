# Figma Template Renderer

A self-hosted service that renders Figma frames with real content. Designers edit templates in Figma; the renderer reads them live through the Figma API (no importing), swaps in your copy and images, and returns a PNG, JPG or WebP. n8n calls it and uploads the result to Google Drive.

## How it works

1. Finds frames named `template/ratio` in your Figma file.
2. Exports every static layer as a PNG through the Figma API, keeping the layer order.
3. Rebuilds the frame as an HTML page: static layers as images, `#` layers as real text and image elements styled from Figma (font, size, weight, line height, letter spacing, alignment, color, case, corner radius, image fit).
4. Headless Chromium waits for fonts and images, shrinks any copy that overflows its text box, and takes a screenshot.

Figma data and exports are cached per file version. Design changes are picked up within `CACHE_TTL_SECONDS` (default 5 minutes), or immediately after `POST /cache/clear`.

## Figma conventions

- **Template frames:** name each top-level frame `template/ratio`, for example `promo/1x1`, `promo/9x16`, `promo/16x9`. Frames can sit inside sections.
- **Dynamic layers:** prefix with `#`. The rest of the name is the data key, so `#headline` is filled from `data.headline`.
  - Text layer: takes a string.
  - Rectangle, ellipse or frame with an image fill: takes an image URL (or a data URI). Fill mode `Fill` maps to cover, `Fit` to contain.
- **Everything else** is static and rendered exactly as Figma draws it.
- **Backgrounds:** put the background in a rectangle layer rather than on the frame itself. Name it `#background` to make it swappable.
- **Text box sizing decides behavior:**
  - Fixed size: wraps, keeps vertical alignment, and auto-shrinks the font if the copy doesn't fit. Best for headlines.
  - Auto height: wraps at the box width and grows downward.
  - Auto width: one line, growing from its alignment anchor. Good for button labels.

Data semantics: a key that's missing keeps the Figma design; `""` or `null` hides the layer; any other value replaces it.

## Setup

1. Create a Figma personal access token with the `file_content:read` scope. The file key is the part after `/design/` in the file URL.
2. `cp .env.example .env` and fill in `FIGMA_TOKEN`, `FIGMA_FILE_KEY` and `API_KEY` (any long random string).
3. Put brand font files (`.ttf`, `.otf`, `.woff2`) in `fonts/`. Fonts available on Google Fonts load automatically.
4. `docker compose up -d --build`
5. Check it: `curl -H "Authorization: Bearer $API_KEY" http://localhost:3000/templates`

It runs anywhere Docker runs: a Proxmox LXC or VM, a small VPS, Fly.io, Railway or Render. If n8n runs in the cloud, the renderer needs a public HTTPS URL (a reverse proxy, or a Cloudflare Tunnel from a home server).

## API

All endpoints except `/health` need `Authorization: Bearer <API_KEY>` (or `X-API-Key`).

**`GET /templates`** lists templates, ratios, pixel sizes, dynamic fields and design warnings. Use it to check a file after editing.

**`POST /render`** returns the image as binary.

```json
{
  "template": "promo",
  "ratio": "9x16",
  "data": {
    "headline": "Autumn sale",
    "cta": "Shop now",
    "image": "https://example.com/product.jpg",
    "badge": ""
  },
  "format": "png",
  "scale": 2
}
```

Optional fields: `format` (`png`, `jpg`, `webp`), `scale` (up to 4, for retina output), `quality` (JPG/WebP), `fileKey` (render from a different Figma file), and `output: "html"` to get the generated HTML instead of an image, which helps with debugging layout.

Response headers: `X-Render-Width`, `X-Render-Height`, and `X-Render-Report`, which lists text layers that were shrunk to fit or still overflow.

Errors come back as JSON: `401` bad key, `404` unknown template or ratio, `422` an image URL couldn't be loaded, `502` Figma API problem.

**`POST /cache/clear`** forces the next render to re-read Figma.

## n8n

Import `n8n-workflow.json`, then:

1. In **Render**, set the URL to your renderer and create a Header Auth credential: name `Authorization`, value `Bearer <API_KEY>`.
2. In **Upload to Drive**, connect Google and set the folder ID.
3. Add your template names to the form's Template dropdown.

Each form submission renders one file per selected ratio and uploads them to Drive.

## Test

`npm install && CHROME_PATH=/path/to/chrome npm test` runs an end-to-end render against a mocked Figma API and writes the output to `test/out/`.

## Limitations

- Dynamic text uses one style per layer. Mixed styles inside a single text layer (a bold word in a sentence) render in the layer's base style.
- Rotation, blend modes and effects (shadows, blur) are ignored on dynamic layers. Static layers keep them.
- Auto layout doesn't reflow: if a dynamic label gets longer, a static button shape behind it won't grow. Size containers for the longest expected copy, or keep labels as fixed text boxes so they auto-shrink.
- Clipping and masks on groups that contain dynamic layers aren't reproduced.
- Frames with image or gradient fills: move the fill into a rectangle layer (`GET /templates` warns about this).
