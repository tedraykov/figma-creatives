# Creatives

A self-hosted service that turns design templates into marketing creatives. Designers edit templates in Figma (or Canva); Creatives reads them live (no importing), swaps in your copy and images, and returns a PNG, JPG or WebP. n8n calls it and uploads the result to Google Drive. A web UI lets you link projects, browse templates and preview them with your own copy.

## How it works (Figma)

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

## Projects and integrations

- An **integration** is a connection to a template source, with its credentials. Add them once in Settings:
  - **Figma**: a personal access token. Frames named `template/ratio` are rebuilt as HTML and screenshotted, with live preview in the browser and text auto-fit.
  - **Canva**: an OAuth client from the Canva developer portal (register the redirect URL shown in Settings, then click Connect). Brand templates titled `template/ratio` with autofill fields are filled and exported by Canva. Needs a Canva Enterprise account (the Autofill API requires it). Text and image fields only; Canva can't hide a field, and previews cost a real design export (no live preview). Each render creates a design in the connected account, and Canva has no API to delete it.
  - **Static samples**: built in, demo templates from `STATIC_DIR` (default `samples/`).
- A **project** is one set of templates reached through an integration: a Figma file link, or an optional title filter for Canva. Projects are listed in the sidebar (collapsible), and one is the default.
- With nothing configured the default project is the static samples, so the app can be tried with no account. If `FIGMA_TOKEN` / `FIGMA_FILE_KEY` are set, an "Environment" integration and project appear too.
- API requests take an optional `projectId`; without it the default project is used. A raw `fileKey` is still accepted for older clients.

The static integration reads Figma-shaped JSON: `<template>/<ratio>.json` per frame, plus optional `<template>/<ratio>/<layerId>.png` exports for static layers (`:` in ids becomes `_`). `node --env-file=.env scripts/snapshot-figma.mjs` copies a real Figma file into that format.

Adding an integration means implementing the interface documented in `src/integrations/index.js` and registering it there. Sources that expose frame trees (Figma, static) only implement the small frame-source interface in `src/integrations/figma.js` and get rendering from `frames.js`.

## Access control

Two kinds of caller, two mechanisms:

- **People (the web UI)** sign in through any OpenID Connect provider. Auth0's free plan (25,000 monthly users, social logins included) works well, as do Google, Okta or Clerk. Only emails in `ALLOWED_EMAILS` get in, so a public sign-up on your provider can't reach your settings.
- **Machines (n8n)** use API keys generated in **Settings → API keys**. Create one per client, name it, and copy it when shown (it can't be shown again). Keys only grant `/templates`, `/render` and `/cache/clear`, never settings. In n8n, use a Header Auth credential: `Authorization: Bearer <key>`.

Environment:

| Variable | Purpose |
|---|---|
| `OIDC_ISSUER` | Provider URL, e.g. `https://your-tenant.eu.auth0.com/` |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | From a "Regular Web Application" in your provider |
| `ALLOWED_EMAILS` | Comma-separated emails, or `@yourcompany.com` for a whole domain |
| `PUBLIC_URL` | Optional, e.g. `https://figma-creatives.tedraykov.me`; otherwise taken from the request |
| `AUTH_DISABLED=true` | Skips sign-in. Local use only: anyone who can reach the server can read and change your settings |

In Auth0: create a Regular Web Application, add `https://<your-domain>/auth/callback` to Allowed Callback URLs (and `http://localhost:3000/auth/callback` for local use) and `https://<your-domain>` to Allowed Logout URLs.

Without `OIDC_*` and without `AUTH_DISABLED`, the UI stays locked and says why. The render API is always closed until you generate a key.

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
