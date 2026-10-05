// End-to-end test with a mocked Figma API: starts the server, renders a template,
// and writes the output to test/out/. Run: CHROME_PATH=/path/to/chrome npm test
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => readFileSync(join(here, 'fixtures', f));

process.env.FIGMA_TOKEN = 'test';
process.env.FIGMA_FILE_KEY = 'FILE';
process.env.API_KEY = 'secret';
process.env.GOOGLE_FONTS = 'false';
process.env.PORT = '3999';

const O = { x: 100, y: 200 }; // frame offset on the canvas
const bb = (x, y, w, h) => ({ x: O.x + x, y: O.y + y, width: w, height: h });
const white = { r: 1, g: 1, b: 1, a: 1 };

const frame = {
  id: '1:1', name: 'promo/1x1', type: 'FRAME',
  absoluteBoundingBox: bb(0, 0, 1080, 1080), fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
  children: [
    { id: '1:2', name: 'Background', type: 'RECTANGLE', absoluteBoundingBox: bb(0, 0, 1080, 1080), absoluteRenderBounds: bb(0, 0, 1080, 1080) },
    { id: '1:3', name: '#image', type: 'RECTANGLE', cornerRadius: 32, absoluteBoundingBox: bb(90, 90, 900, 520),
      fills: [{ type: 'IMAGE', scaleMode: 'FILL' }] },
    { id: '1:4', name: '#headline', type: 'TEXT', characters: 'Headline', absoluteBoundingBox: bb(90, 650, 900, 200),
      fills: [{ type: 'SOLID', color: white }],
      style: { fontFamily: 'DejaVu Sans', fontWeight: 700, fontSize: 88, lineHeightPx: 96, letterSpacing: -1,
        textAlignHorizontal: 'CENTER', textAlignVertical: 'CENTER', textAutoResize: 'NONE' } },
    { id: '1:5', name: 'Button', type: 'FRAME', cornerRadius: 40, absoluteBoundingBox: bb(390, 900, 300, 80),
      fills: [{ type: 'SOLID', color: { r: 1, g: 0.35, b: 0.47, a: 1 } }],
      children: [
        { id: '1:6', name: '#cta', type: 'TEXT', characters: 'Shop', absoluteBoundingBox: bb(480, 920, 120, 40),
          fills: [{ type: 'SOLID', color: white }],
          style: { fontFamily: 'DejaVu Sans', fontWeight: 700, fontSize: 32, lineHeightPx: 40, textCase: 'UPPER',
            textAlignHorizontal: 'CENTER', textAutoResize: 'WIDTH_AND_HEIGHT' } },
      ] },
    { id: '1:7', name: 'Logo', type: 'VECTOR', absoluteBoundingBox: bb(890, 30, 160, 60), absoluteRenderBounds: bb(890, 30, 160, 60) },
    { id: '1:8', name: '#badge', type: 'TEXT', characters: 'NEW', absoluteBoundingBox: bb(30, 30, 200, 50),
      fills: [{ type: 'SOLID', color: white }], style: { fontFamily: 'DejaVu Sans', fontSize: 30 } },
  ],
};

const exportsPng = { '1:2': fx('bg.png'), '1:7': fx('logo.png') };
const realFetch = globalThis.fetch;
let figmaCalls = 0;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  if (u.startsWith('https://api.figma.com/v1/')) {
    figmaCalls++;
    if (u.includes('/files/FILE?depth')) {
      return json({ name: 'Fixture', version: '42', document: { type: 'DOCUMENT', children: [{ type: 'CANVAS', children: [frame] }] } });
    }
    if (u.includes('/files/FILE/nodes')) return json({ nodes: { '1:1': { document: frame } } });
    if (u.includes('/images/FILE')) {
      const ids = decodeURIComponent(new URL(u).searchParams.get('ids')).split(',');
      return json({ images: Object.fromEntries(ids.map((id) => [id, `https://s3.mock/${id}.png`])) });
    }
  }
  if (u.startsWith('https://s3.mock/')) {
    const id = u.slice('https://s3.mock/'.length, -4);
    return new Response(exportsPng[id]);
  }
  return realFetch(url, opts);
};

await import('../src/server.js');
const base = 'http://localhost:3999';
const auth = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
const out = join(here, 'out');
mkdirSync(out, { recursive: true });

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); };

let r = await realFetch(`${base}/templates`);
assert(r.status === 401, 'rejects requests without API key');

r = await realFetch(`${base}/templates`, { headers: auth });
const t = await r.json();
assert(t.templates.promo['1x1'].fields.map((f) => f.key).join() === 'image,headline,cta,badge', 'discovers dynamic fields');

const product = `data:image/png;base64,${fx('product.png').toString('base64')}`;
r = await realFetch(`${base}/render`, {
  method: 'POST', headers: auth,
  body: JSON.stringify({
    template: 'promo', ratio: '1x1',
    data: {
      image: product,
      headline: 'Autumn sale: everything you need for long evenings at home, now up to 40% off',
      cta: 'Shop now',
      badge: '',
    },
  }),
});
assert(r.status === 200 && r.headers.get('content-type') === 'image/png', 'renders a PNG');
const report = JSON.parse(r.headers.get('x-render-report'));
assert(report.some((s) => s.key === 'headline' && s.to < s.from), 'shrinks overflowing headline');
writeFileSync(join(out, 'promo_1x1.png'), Buffer.from(await r.arrayBuffer()));

const before = figmaCalls;
r = await realFetch(`${base}/render`, {
  method: 'POST', headers: auth,
  body: JSON.stringify({ template: 'promo', ratio: '1x1', format: 'jpg', data: { headline: 'Short', image: product } }),
});
assert(r.status === 200 && r.headers.get('content-type') === 'image/jpeg', 'renders a JPG');
assert(figmaCalls === before, 'second render is served from cache');
writeFileSync(join(out, 'promo_1x1_short.jpg'), Buffer.from(await r.arrayBuffer()));

r = await realFetch(`${base}/render`, {
  method: 'POST', headers: auth, body: JSON.stringify({ template: 'promo', ratio: '9x16', data: {} }),
});
assert(r.status === 404, 'unknown ratio returns 404');

r = await realFetch(`${base}/render`, {
  method: 'POST', headers: auth,
  body: JSON.stringify({ template: 'promo', ratio: '1x1', data: { image: 'data:image/png;base64,AAAA' } }),
});
assert(r.status === 422, 'broken image URL returns 422');

console.log('\nAll tests passed. Output in test/out/');
process.exit(0);
