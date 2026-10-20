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

- **People (the web UI)** sign in through any OpenID Connect provider. Auth0's free plan (25,000 monthly users, social logins included) works well, as do Google, Okta or Clerk. Restrict sign-ups at the provider (invitation-only, or an allowlist) so strangers can't create accounts; optionally set `ALLOWED_EMAILS` as a second lock.
- **Machines (n8n)** use API keys generated in **Settings → API keys**. Create one per client, name it, and copy it when shown (it can't be shown again). Keys only grant `/templates`, `/render`, `/campaigns` and `/cache/clear`, never settings. In n8n, use a Header Auth credential: `Authorization: Bearer <key>`.

Environment:

| Variable | Purpose |
|---|---|
| `OIDC_ISSUER` | Provider URL, e.g. `https://your-tenant.eu.auth0.com/` |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | From a "Regular Web Application" in your provider |
| `ALLOWED_EMAILS` | Optional. Comma-separated emails, or `@yourcompany.com` for a whole domain. Unset = any verified user of your provider gets in |
| `PUBLIC_URL` | Optional, e.g. `https://figma-creatives.tedraykov.me`; otherwise taken from the request |
| `OIDC_TOKEN_AUTH` | Optional: `basic` or `post`, to override how the client secret is sent |
| `AUTH_DISABLED=true` | Skips sign-in. Local use only: anyone who can reach the server can read and change your settings |

Any OpenID Connect provider works. Two setups are known to work:

**Clerk (email-only sign-in)**
1. In the Clerk Dashboard, open **User & authentication**: enable **Email** with *Email verification code* (and/or link), and leave Password, Phone and Username off. Under **SSO connections**, enable no social providers.
2. Under **Restrictions**, set sign-ups to invitation-only, or add an allowlist, so strangers can't create accounts. This is what keeps strangers out when `ALLOWED_EMAILS` is unset.
3. Open **OAuth applications**, then **Add application**, and create one. Select the scopes `openid`, `email` and `profile`, and add the redirect URI `https://<your-domain>/auth/callback`. Copy the **Client ID** and **Client Secret** (the secret is shown once).
4. Set `OIDC_ISSUER` to your instance's **Frontend API URL** (for example `https://example-name-12.clerk.accounts.dev`; the Discovery URL is that plus `/.well-known/openid-configuration`), plus `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`.

**Auth0:** create a Regular Web Application, add `https://<your-domain>/auth/callback` to Allowed Callback URLs (and `http://localhost:3000/auth/callback` for local use) and your domain to Allowed Logout URLs.

The app authenticates at the token endpoint with HTTP Basic (what Clerk requires) and reads the email from the ID token, or from the provider's user-info endpoint when the ID token leaves it out. Set `OIDC_TOKEN_AUTH=post` only for a provider that accepts nothing but the secret in the request body.

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

**`/campaigns`** (API key): `POST` queues `{ campaign, date?, driveFolder?, jobs: [{ template, ratio, language, data }] }`, `GET` lists pending campaigns, `GET /campaigns/:id` returns the payload, `POST /campaigns/:id/done` (with an optional `pageUrl`) completes it and `DELETE` discards it.

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

`n8n-workflow.json` holds both flows on one canvas, each with its own form: **Creatives from Google Sheets** (top) and **Export to Drive** (bottom, see below). Import it once, then:

1. Open the **Settings (sheet)** node and set `sheetUrl` (the tab comes from the `#gid=` in the URL; a URL without it reads the first tab) and, optionally, `projectName` (the Creatives project to build in; empty means the default project). The form no longer asks for them.
2. In **Read sheet**, connect your Google account (a Google Sheets credential).
3. In **Queue campaign**, **Get projects** and **Get templates**, use a Header Auth credential: name `Authorization`, value `Bearer <key>`, with a key created in **Settings → API keys**.

**One Google Sheet holds many campaigns (for example a month), one block per campaign.** Row 1 is a header with `field` and one column per language, defined once for the whole sheet. Freeze it (View → Freeze → 1 row) and the languages stay visible wherever you scroll. Each block below has a title row with the campaign name (column A) and date (column B), then one row per field. A blank row separates blocks. See `example-campaigns-sheet-blocks.xlsx`.

| field | en | de | bg |
|---|---|---|---|
| **autumn-sale** | 2026-10-05 | | |
| headline | Autumn sale | Herbstangebot | Есенна разпродажба |
| body | Up to 40% off | Bis zu 40 % Rabatt | |
| cta | Shop now | Jetzt kaufen | |
| background | https://…/bg.jpg | | https://…/bg.jpg |
| | | | |
| **halloween** | 2026-10-30 | | |
| headline | Spooky deals | Gruselige Angebote | |
| cta | Trick or treat | Süßes oder Saures | |

- Campaigns can have different fields. Add a field by adding a row, a language by adding a column in the header. A campaign renders only the languages with at least one cell filled in, so `halloween` above produces `en` and `de` only.
- `field` names are the layer names in the design (`headline` → `#headline`, `badge` → `#badge`, …) and are not case-sensitive. There is no fixed list.
- An empty cell is not sent, so the design keeps its default for that layer. A cell containing only `-` hides the layer.
- Keep the blank row between blocks, write `field` in cell A1, and don't merge cells. The workflow stops with an error that names the row if a block is malformed.
- The sheet holds content only. The **project** comes from the Settings node, and the **templates** and **aspect ratios** are chosen in the form each time you run it. The lists come live from Creatives (`GET /projects`, then `GET /templates?projectId=…`), so new templates and ratios appear without editing the workflow.

Running the form takes three short steps: an optional language list (for example `en, de`), then the campaign (listed from the sheet), then one or more `template/ratio` choices. The flow does not render anything. It queues the campaign (`POST /campaigns`), and the Figma plugin builds it into a page.

- **Date:** each campaign's title row needs a date in column B. Day-first (`12.10.2026`) and `2026-10-12` both work. The flow stops with an error if it can't read it, because the Drive folders are named from it.
- **Emphasis:** wrap part of a text cell in double asterisks (`Shop **now**`). The plugin styles that part like the template layer's own emphasised text (for example the "LOVED" in another font), or the Bold weight of its font if the layer has none.

## Figma plugin

`figma-plugin/` is a development plugin (Figma desktop app → Plugins → Development → Import plugin from manifest → `figma-plugin/manifest.json`). It cannot be triggered from n8n, since Figma only runs plugins inside the app, so it works as an inbox:

1. Run the n8n form. The campaign is queued on the service.
2. Open the plugin in the file that holds the templates. Under **Connection**, enter the service URL and an API key once. It lists the pending campaigns.
3. **Generate** creates a page `<date> <campaign>` with one section per language. Each section has a clone of every chosen `template/ratio` frame, named `template/ratio/language`, with the `#fields` filled. Review and adjust it by hand, then export.

- A text value replaces the layer's text, `""` (a `-` in the sheet) hides it, and a missing key keeps the design. An image URL becomes the layer's image fill.
- Templates are found by name (`template/ratio`) in the open file. Fonts must be installed or shared in the Figma organisation. Tick the Inter fallback to test layout without them.
- `figma-plugin/seed/` is a throwaway plugin that builds stand-in `H/Desktop` and `H/Mobile` templates for trying this in any file, and `figma-plugin/example-payload.json` can be pasted under "Paste a payload instead".

## Exporting to Drive

The second flow in `n8n-workflow.json` is the second half. Review and adjust the generated page in Figma, then run its form with the **page link** (right-click the page in Figma's Pages list → Copy link). It exports every visible frame named `template/ratio/language` as a JPG through Figma's image API (so the output is exactly what you reviewed) and files it in Drive:

```
<root> / 2026 / 10. October / 12.10.2026 Autumn Sale / Desktop / 1210-CC-BG.jpg
```

- The campaign folder comes from the page name, `DD.MM.YYYY Campaign`, which the plugin sets from the sheet. Renaming the page changes the folder, but keep that format.
- There is one format folder per `ratio` (`Desktop`, `Mobile`, as named in Figma). Files are `DDMM-CC-LANG.jpg` (`CC` is literal, `LANG` is the language from the frame name in capitals). A campaign page is expected to use one template; if two frames would produce the same file in the same folder, the flow stops with an error.
- Hide a frame to leave it out of the export. Frames named anything else are ignored.
- **Root folder:** set `driveRootFolderUrl` in the **Settings** node of the export flow. It is not asked in the form. Year, month and campaign folders are reused if they exist and created if not.
- Credentials: a Header Auth credential `X-Figma-Token` for the two Figma nodes, and a Google Drive OAuth2 credential for the Drive nodes (the `Find …` and `Ensure …` HTTP nodes use it as a predefined credential). Uploads go to *My Drive*; pick a shared drive in **Upload to Drive** if needed.
- Exporting again uploads new files next to the old ones (Drive allows duplicate names). Figma renders text with fonts available to it, so check one export to confirm Cera PRO appears.

## Test

`npm install && CHROME_PATH=/path/to/chrome npm test` runs an end-to-end render against a mocked Figma API and writes the output to `test/out/`.

## Limitations

- Dynamic text uses one style per layer. Mixed styles inside a single text layer (a bold word in a sentence) render in the layer's base style.
- Rotation, blend modes and effects (shadows, blur) are ignored on dynamic layers. Static layers keep them.
- Auto layout doesn't reflow: if a dynamic label gets longer, a static button shape behind it won't grow. Size containers for the longest expected copy, or keep labels as fixed text boxes so they auto-shrink.
- Clipping and masks on groups that contain dynamic layers aren't reproduced.
- Frames with image or gradient fills: move the fill into a rectangle layer (`GET /templates` warns about this).
