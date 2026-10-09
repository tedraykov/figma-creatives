// End-to-end test of the static integration: no Figma token, no network. Run: CHROME_PATH=... node test/static-provider.js
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
Object.assign(process.env, {
  AUTH_DISABLED: 'true', GOOGLE_FONTS: 'false', PORT: '3998',
  DATA_DIR: join(here, 'out', 'data-static'), STATIC_DIR: join(here, '..', 'samples'),
});
delete process.env.FIGMA_TOKEN;
delete process.env.PROVIDER;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith('http://localhost')) throw new Error(`static integration must not use the network: ${url}`);
  return realFetch(url, opts);
};

await import('../src/server.js');
const base = 'http://localhost:3998';
const auth = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
const out = join(here, 'out');
mkdirSync(out, { recursive: true });
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); };
const get = (p) => fetch(base + p, { headers: auth });

let r = await get('/config');
const cfg = await r.json();
assert(cfg.defaultProjectId === 'static' && cfg.integrations.some((i) => i.type === 'static'), 'defaults to the static project without a token');

r = await get('/templates');
const t = await r.json();
assert(t.integration === 'static' && Object.keys(t.templates.promo).sort().join() === '16x9,1x1,9x16', 'lists sample templates and ratios');
assert(t.templates.promo['1x1'].url === undefined, 'static samples have no original to open');
assert(t.templates.promo['1x1'].fields.map((f) => f.key).join() === 'background,image,headline,body,cta', 'discovers dynamic fields');

r = await fetch(`${base}/render`, { method: 'POST', headers: auth, body: JSON.stringify({ template: 'promo', ratio: '9x16', data: { headline: 'Static provider works', cta: 'Go' } }) });
assert(r.status === 200 && r.headers.get('content-type') === 'image/png' && r.headers.get('x-render-height') === '1920', 'renders 9x16 from samples');
writeFileSync(join(out, 'static_9x16.png'), Buffer.from(await r.arrayBuffer()));

r = await fetch(`${base}/render`, { method: 'POST', headers: auth, body: JSON.stringify({ template: 'promo', ratio: '1x1', output: 'preview' }) });
const page = await r.text();
assert(r.headers.get('content-type').startsWith('text/html') && r.headers.get('x-render-width') === '1080' && page.includes('parent.postMessage'), 'preview output is a self-contained page for the browser');

r = await fetch(`${base}/render`, { method: 'POST', headers: auth, body: JSON.stringify({ template: 'nope', ratio: '1x1' }) });
assert(r.status === 404, 'unknown template returns 404');

r = await fetch(`${base}/render`, { method: 'POST', headers: auth, body: JSON.stringify({ template: '../x', ratio: '1x1' }) });
assert(r.status === 404, 'path traversal in template name is rejected');

r = await fetch(`${base}/integrations`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Work', token: 'figd_secret_abcd' }) });
const withInt = await r.json();
const work = withInt.integrations.find((i) => i.name === 'Work');
assert(r.status === 200 && work.tokenHint === '…abcd' && !JSON.stringify(withInt).includes('figd_secret'), 'integrations are created and tokens never returned');

r = await fetch(`${base}/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ link: 'not a link!', integrationId: work.id }) });
assert(r.status === 400, 'invalid project link is rejected');

r = await fetch(`${base}/integrations/static`, { method: 'DELETE', headers: auth });
assert(r.status === 404, 'built-in integrations are read-only');

r = await fetch(`${base}/integrations/${work.id}`, { method: 'DELETE', headers: auth });
assert(r.status === 200, 'unused integration can be deleted');

r = await fetch(`${base}/projects/static`, { method: 'PUT', headers: auth, body: JSON.stringify({ name: 'Demo' }) });
assert((await r.json()).projects.find((p) => p.id === 'static').name === 'Demo', 'a generated project can be renamed too');
r = await fetch(`${base}/projects/static`, { method: 'DELETE', headers: auth });
const none = await r.json();
assert(r.status === 200 && !none.projects.length && none.defaultProjectId === '' && none.samplesHidden, 'every project can be removed, including the demo samples');
assert((await get('/templates')).status === 404, 'with no project linked, the API says so');
r = await fetch(`${base}/projects/restore-samples`, { method: 'POST', headers: auth });
const back = await r.json();
assert(back.projects.some((p) => p.id === 'static') && back.defaultProjectId === 'static', 'the demo samples can be restored');

console.log('\nStatic integration tests passed.');
process.exit(0);
