// Canva integration (Canva Connect API). Unlike Figma, Canva exposes no layer tree, so nothing is
// rebuilt here: a brand template is autofilled with the data, exported to an image, and downloaded.
//
// Requirements on the Canva side:
//   - an integration (OAuth client) created in the Canva developer portal; the user connects once
//   - the connecting user is in a Canva Enterprise organization (the Autofill API needs it)
//   - brand templates titled "template/ratio" (e.g. "promo/1x1") with autofill data fields
//     (text and image fields are supported)
import { HttpError } from '../errors.js';

const API = 'https://api.canva.com/rest/v1';
const TOKEN_URLS = ['https://api.canva.com/auth/v1/oauth/token', `${API}/oauth/token`];
export const CANVA_AUTHORIZE_URL = 'https://www.canva.com/api/oauth/authorize';
export const CANVA_SCOPES = 'brandtemplate:meta:read brandtemplate:content:read design:meta:read design:content:read design:content:write asset:read asset:write';

const TEMPLATE_NAME = /^\s*([^/]+?)\s*\/\s*([^/]+?)\s*$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const basic = (c) => `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`;

// Exchanges an authorization code or refresh token. Tries the current token URL, then the older one.
export async function canvaTokenRequest(credentials, params) {
  let last;
  for (const url of TOKEN_URLS) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic(credentials) },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) { last = res; continue; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, `Canva token request failed: ${body.error_description ?? body.error ?? res.status}`);
    return { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: Date.now() + (body.expires_in ?? 3600) * 1000 };
  }
  throw new HttpError(502, `Canva token endpoint not found (${last?.status})`);
}

// Image dimensions straight from the file, so the response can report them.
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return { width: 0, height: 0 };
}

// getCredentials() -> { clientId, clientSecret, tokens }, saveTokens(tokens) persists rotated tokens.
export function createCanvaIntegration({ getCredentials, saveTokens, cacheTtlSeconds = 300, pollTimeoutMs = 90000 }) {
  const ttl = cacheTtlSeconds * 1000;
  let listing = null; // { key, expires, value }
  const datasets = new Map(); // brand template id + updated_at -> dataset
  const assets = new Map(); // url -> asset id
  let refreshing = null;

  async function accessToken() {
    const creds = getCredentials();
    const t = creds.tokens;
    if (!t?.access_token) throw new HttpError(409, 'Canva is not connected. Open Settings and click Connect.');
    if (t.expires_at - 60_000 > Date.now()) return t.access_token;
    // Refresh tokens are single-use: share one in-flight refresh and persist the new pair at once.
    refreshing ??= canvaTokenRequest(creds, { grant_type: 'refresh_token', refresh_token: t.refresh_token })
      .then((fresh) => { saveTokens({ ...fresh, refresh_token: fresh.refresh_token ?? t.refresh_token }); return fresh; })
      .finally(() => { refreshing = null; });
    return (await refreshing).access_token;
  }

  async function api(method, path, { json, body, headers } = {}) {
    const res = await fetch(path.startsWith('http') ? path : API + path, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json ? JSON.stringify(json) : body,
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429) throw new HttpError(429, 'Canva rate limit hit. Try again shortly.');
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const msg = data.message ?? data.error_description ?? data.code ?? text.slice(0, 200);
      const hint = res.status === 403 ? ' (autofill needs a Canva Enterprise account and the right scopes)' : '';
      throw new HttpError(res.status === 404 ? 404 : res.status === 401 ? 502 : res.status < 500 ? 400 : 502, `Canva API ${res.status}: ${msg}${hint}`);
    }
    return data;
  }

  async function poll(path, label) {
    const deadline = Date.now() + pollTimeoutMs;
    for (let wait = 400; Date.now() < deadline; wait = Math.min(wait * 1.5, 3000)) {
      const { job } = await api('GET', path);
      if (job.status === 'success') return job;
      if (job.status === 'failed') throw new HttpError(502, `Canva ${label} failed: ${job.error?.message ?? job.error?.code ?? 'unknown error'}`);
      await sleep(wait);
    }
    throw new HttpError(504, `Canva ${label} timed out`);
  }

  async function uploadAsset(value, name) {
    if (assets.has(value)) return assets.get(value);
    let job;
    if (value.startsWith('data:')) {
      const m = value.match(/^data:[^;,]+(;base64)?,(.*)$/s);
      if (!m) throw new HttpError(400, 'Invalid image data URI');
      const buf = m[1] ? Buffer.from(m[2], 'base64') : Buffer.from(decodeURIComponent(m[2]));
      const start = await api('POST', '/asset-uploads', {
        body: buf, headers: { 'Content-Type': 'application/octet-stream', 'Asset-Upload-Metadata': JSON.stringify({ name_base64: Buffer.from(name).toString('base64') }) },
      });
      job = await poll(`/asset-uploads/${start.job.id}`, 'asset upload');
    } else {
      const start = await api('POST', '/url-asset-uploads', { json: { name, url: value } });
      job = await poll(`/url-asset-uploads/${start.job.id}`, 'asset upload');
    }
    const id = job.asset?.id;
    if (!id) throw new HttpError(502, 'Canva did not return an asset id');
    if (!value.startsWith('data:')) assets.set(value, id);
    return id;
  }

  async function templateIndex(query) {
    if (listing && listing.key === query && listing.expires > Date.now()) return listing.value;
    const items = [];
    let continuation;
    for (let page = 0; page < 10; page++) {
      const qs = new URLSearchParams({ limit: '100', dataset: 'non_empty', ...(query ? { query } : {}), ...(continuation ? { continuation } : {}) });
      const res = await api('GET', `/brand-templates?${qs}`);
      items.push(...res.items);
      continuation = res.continuation;
      if (!continuation) break;
    }

    const templates = {};
    const byName = [];
    for (const item of items) {
      const m = item.title.match(TEMPLATE_NAME);
      if (m) byName.push({ item, template: m[1], ratio: m[2] });
    }
    for (let i = 0; i < byName.length; i += 5) {
      await Promise.all(byName.slice(i, i + 5).map(async ({ item, template, ratio }) => {
        const dsKey = `${item.id}:${item.updated_at}`;
        if (!datasets.has(dsKey)) datasets.set(dsKey, (await api('GET', `/brand-templates/${item.id}/dataset`)).dataset ?? {});
        const fields = [], warnings = [];
        for (const [key, def] of Object.entries(datasets.get(dsKey))) {
          if (def.type === 'text' || def.type === 'image') fields.push({ key, type: def.type });
          else warnings.push(`Field "${key}" is a ${def.type}, which is not supported yet and keeps its design value.`);
        }
        templates[template] ??= {};
        templates[template][ratio] = {
          nodeId: item.id, width: item.thumbnail?.width ?? 0, height: item.thumbnail?.height ?? 0,
          fields, warnings, thumbnail: item.thumbnail?.url, url: item.view_url,
        };
      }));
    }
    const value = { name: 'Canva brand templates', version: String(Math.max(0, ...items.map((i) => i.updated_at ?? 0))), templates };
    listing = { key: query, expires: Date.now() + ttl, value };
    return value;
  }

  return {
    type: 'canva',
    label: 'Canva',
    livePreview: false, // Canva renders the design, so every preview is a real (slow) autofill + export

    check: async (query) => { await api('GET', '/brand-templates?limit=1'); return { name: query ? `Canva: ${query}` : 'Canva brand templates', version: '' }; },
    listTemplates: (query) => templateIndex(query),

    async render(query, { template, ratio, data = {}, format = 'png', quality = 90 }) {
      if (!MIME[format]) throw new HttpError(400, 'Canva exports support png and jpg only');
      const index = await templateIndex(query);
      const info = index.templates[template]?.[ratio];
      if (!info) throw new HttpError(404, `Template "${template}" / "${ratio}" not found in Canva. Available: ${Object.keys(index.templates).join(', ') || 'none'}`);

      // Missing key keeps the design. Canva has no way to hide a field, so "" is treated as missing.
      const fill = {};
      for (const f of info.fields) {
        const v = data[f.key];
        if (v === undefined || v === null || v === '') continue;
        fill[f.key] = f.type === 'text'
          ? { type: 'text', text: String(v) }
          : { type: 'image', asset_id: await uploadAsset(String(v), f.key) };
      }

      const start = await api('POST', '/autofills', { json: { brand_template_id: info.nodeId, title: `${template}/${ratio} ${new Date().toISOString()}`, data: fill } });
      const autofill = await poll(`/autofills/${start.job.id}`, 'autofill');
      const designId = autofill.result?.design?.id;
      if (!designId) throw new HttpError(502, 'Canva did not return a design');

      const fmt = format === 'png' ? { type: 'png' } : { type: 'jpg', quality };
      const exp = await api('POST', '/exports', { json: { design_id: designId, format: fmt } });
      const done = await poll(`/exports/${exp.job.id}`, 'export');
      const url = done.urls?.[0];
      if (!url) throw new HttpError(502, 'Canva export returned no file');
      const file = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!file.ok) throw new HttpError(502, `Downloading the Canva export failed: ${file.status}`);
      const image = Buffer.from(await file.arrayBuffer());
      return { image, contentType: MIME[format], ...imageSize(image), report: [] };
    },

    clearCache() { const n = (listing ? 1 : 0) + datasets.size + assets.size; listing = null; datasets.clear(); assets.clear(); return n; },
  };
}
