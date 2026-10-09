// Canva integration against a stubbed Canva Connect API: listing, autofill + export, token refresh.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'canva-'));
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); };

const { createCanvaIntegration } = await import('../src/integrations/canva.js');
const config = await import('../src/config.js');

// A 4x3 PNG header is enough for the size detection.
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]), Buffer.from([0, 0, 0, 4, 0, 0, 0, 3]), Buffer.alloc(8)]);

const calls = [];
let refreshes = 0, autofillBody = null, exportBody = null;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), method = opts.method ?? 'GET';
  const body = typeof opts.body === 'string' && opts.headers?.['Content-Type'] === 'application/json' ? JSON.parse(opts.body) : opts.body;
  calls.push(`${method} ${u.replace('https://api.canva.com/rest/v1', '')}`);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
  if (u.includes('/oauth/token')) { refreshes++; return json({ access_token: `at-${refreshes}`, refresh_token: `rt-${refreshes}`, expires_in: 3600 }); }
  if (u.includes('/brand-templates?')) return json({ items: [
    { id: 'BT1', title: 'promo/1x1', updated_at: 5, view_url: 'https://www.canva.com/design/BT1/view', thumbnail: { width: 400, height: 400, url: 'https://thumb/1' } },
    { id: 'BT2', title: 'promo/9x16', updated_at: 6, thumbnail: { width: 225, height: 400, url: 'https://thumb/2' } },
    { id: 'BT3', title: 'Not a template', updated_at: 7 }] });
  if (u.endsWith('/brand-templates/BT1/dataset')) return json({ dataset: { headline: { type: 'text' }, hero: { type: 'image' }, sales: { type: 'chart' } } });
  if (u.endsWith('/brand-templates/BT2/dataset')) return json({ dataset: { headline: { type: 'text' } } });
  if (u.endsWith('/url-asset-uploads')) return json({ job: { id: 'U1', status: 'in_progress' } });
  if (u.endsWith('/url-asset-uploads/U1')) return json({ job: { id: 'U1', status: 'success', asset: { id: 'ASSET1' } } });
  if (u.endsWith('/autofills')) { autofillBody = body; return json({ job: { id: 'A1', status: 'in_progress' } }); }
  if (u.endsWith('/autofills/A1')) return json({ job: { id: 'A1', status: 'success', result: { type: 'create_design', design: { id: 'D1' } } } });
  if (u.endsWith('/exports')) { exportBody = body; return json({ job: { id: 'E1', status: 'in_progress' } }); }
  if (u.endsWith('/exports/E1')) return json({ job: { id: 'E1', status: 'success', urls: ['https://download/file.png'] } });
  if (u === 'https://download/file.png') return new Response(png);
  return json({ message: 'unexpected ' + u }, 500);
};

// Validation: required fields on add, and names can't be emptied on edit.
const bad = (fn) => { try { fn(); return null; } catch (e) { return e.status; } };
assert(bad(() => config.addIntegration({ type: 'figma', token: 't' })) === 400, 'an integration needs a name');
assert(bad(() => config.addIntegration({ name: 'x', type: 'figma' })) === 400, 'a Figma integration needs a token');
assert(bad(() => config.addIntegration({ name: 'x', type: 'canva', clientId: 'a' })) === 400, 'a Canva integration needs a client secret');
assert(bad(() => config.addIntegration({ name: 'x', type: 'canva', clientSecret: 'a' })) === 400, 'a Canva integration needs a client ID');

// Configuration: secrets stay on the server.
const created = config.addIntegration({ name: 'Brand Canva', type: 'canva', clientId: 'cid', clientSecret: 'csecret' });
config.setIntegrationTokens(created.id, { access_token: 'at-0', refresh_token: 'rt-0', expires_at: Date.now() + 3_600_000 });
const pub = JSON.stringify(config.publicConfig());
assert(!pub.includes('csecret') && !pub.includes('at-0') && !pub.includes('rt-0') && pub.includes('"connected":true'), 'Canva secrets and tokens never reach the browser');

assert(bad(() => config.updateIntegration(created.id, { name: '  ' })) === 400 && bad(() => config.updateIntegration(created.id, { clientId: '' })) === 400, 'edits cannot empty the name or client ID');
config.updateIntegration(created.id, { name: 'Renamed', clientSecret: '' });
assert(config.getIntegration(created.id).name === 'Renamed' && config.getIntegration(created.id).tokens, 'renaming keeps the connection; a blank secret keeps the old one');
config.updateIntegration(created.id, { clientId: 'cid2' });
assert(!config.getIntegration(created.id).tokens, 'changing the client ID drops the tokens, so it must be reconnected');
config.setIntegrationTokens(created.id, { access_token: 'at-0', refresh_token: 'rt-0', expires_at: Date.now() + 3_600_000 });

const canva = createCanvaIntegration({
  getCredentials: () => config.getIntegration(created.id),
  saveTokens: (t) => config.setIntegrationTokens(created.id, t),
  pollTimeoutMs: 5000,
});

const index = await canva.listTemplates('');
assert(Object.keys(index.templates.promo).join() === '1x1,9x16' && !index.templates['Not a template'], 'lists brand templates named template/ratio');
assert(index.templates.promo['1x1'].fields.map((f) => `${f.key}:${f.type}`).join() === 'headline:text,hero:image', 'reads text and image fields from the dataset');
assert(index.templates.promo['1x1'].url === 'https://www.canva.com/design/BT1/view', 'links back to the brand template in Canva');
assert(index.templates.promo['1x1'].warnings.some((w) => w.includes('sales')) && index.templates.promo['1x1'].thumbnail, 'warns about unsupported fields and exposes the thumbnail');

const out = await canva.render('', { template: 'promo', ratio: '1x1', format: 'png', data: { headline: 'Hello', hero: 'https://img.test/a.jpg', sales: 'ignored', missing: 'x' } });
assert(autofillBody.brand_template_id === 'BT1' && autofillBody.data.headline.text === 'Hello' && autofillBody.data.hero.asset_id === 'ASSET1', 'autofills text and uploads image URLs as assets');
assert(!('sales' in autofillBody.data) && !('missing' in autofillBody.data), 'only supported dataset fields are sent');
assert(exportBody.design_id === 'D1' && exportBody.format.type === 'png' && out.image.equals(png) && out.width === 4 && out.height === 3, 'exports the design and returns the image with its size');

await canva.render('', { template: 'promo', ratio: '9x16', data: { headline: '' } });
assert(Object.keys(autofillBody.data).length === 0, 'empty values keep the design (Canva cannot hide fields)');

const webp = await canva.render('', { template: 'promo', ratio: '1x1', format: 'webp' }).then(() => null, (e) => e);
assert(webp?.status === 400, 'unsupported export formats are rejected');
const missing = await canva.render('', { template: 'nope', ratio: '1x1' }).then(() => null, (e) => e);
assert(missing?.status === 404, 'unknown template returns 404');

// Token refresh: an expired token is rotated once, and the new pair is saved.
config.setIntegrationTokens(created.id, { access_token: 'old', refresh_token: 'rt-old', expires_at: Date.now() - 1000 });
canva.clearCache();
await Promise.all([canva.listTemplates(''), canva.check('')]);
assert(refreshes === 1 && config.getIntegration(created.id).tokens.refresh_token === 'rt-1', 'refreshes an expired token once and stores the rotated refresh token');

// The environment's Figma token shows up as an editable, deletable integration.
process.env.FIGMA_TOKEN = 'envtok'; process.env.FIGMA_FILE_KEY = 'KEY';
const envInt = config.publicConfig().integrations.find((i) => i.id === 'env');
assert(envInt && envInt.fromEnv && !envInt.builtin && config.publicConfig().projects.some((p) => p.id === 'env'), 'the environment token appears as an editable integration');
config.updateIntegration('env', { name: 'My Figma' });
assert(config.getIntegration('env').name === 'My Figma' && config.getIntegration('env').token === 'envtok' && !config.publicConfig().integrations.find((i) => i.id === 'env').fromEnv, 'editing it keeps a stored copy with the token');
config.removeIntegration('env');
assert(!config.getIntegration('env') && !config.publicConfig().projects.some((p) => p.id === 'env'), 'deleting it removes it and its project for good');
process.exit(0);
