// Snapshots a mocked Figma file into a temp folder, then reads it back with the static integration.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'snap-'));
const png = readFileSync(join(here, 'fixtures', 'bg.png'));
const bb = { x: 0, y: 0, width: 100, height: 100 };
const frame = { id: '9:1', name: 'ad/1x1', type: 'FRAME', absoluteBoundingBox: bb, children: [
  { id: '9:2', name: 'Shape', type: 'RECTANGLE', absoluteBoundingBox: bb, absoluteRenderBounds: bb },
  { id: '9:3', name: '#title', type: 'TEXT', characters: 'Hi', absoluteBoundingBox: bb, style: { fontSize: 20 } },
] };

// Child process with a stubbed fetch, so the real script runs unchanged.
const stub = `
const json = (o) => new Response(JSON.stringify(o));
globalThis.fetch = async (u) => {
  u = String(u);
  if (u.includes('/files/F?depth')) return json({ name: 'Mock', version: '7', document: { type: 'DOCUMENT', children: [{ type: 'CANVAS', children: [${JSON.stringify(frame)}] }] } });
  if (u.includes('/files/F/nodes')) return json({ nodes: { '9:1': { document: ${JSON.stringify(frame)} } } });
  if (u.includes('/images/F')) return json({ images: { '9:2': 'https://s3.mock/x.png' } });
  if (u.startsWith('https://s3.mock/')) return new Response(Buffer.from('${png.toString('base64')}', 'base64'));
  throw new Error('unexpected ' + u);
};`;
const r = spawnSync(process.execPath, ['--input-type=module', '-e', `${stub}\nprocess.argv[2]='F';process.argv[3]=${JSON.stringify(out)};await import(${JSON.stringify(join(here, '..', 'scripts', 'snapshot-figma.mjs'))});`],
  { env: { ...process.env, FIGMA_TOKEN: 't' }, encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }

process.env.STATIC_DIR = out;
const { createStaticIntegration } = await import('../src/integrations/static.js');
const p = createStaticIntegration({ dir: out });
const idx = await p.listTemplates();
const ok = idx.templates.ad?.['1x1'] === 'ad/1x1'
  && (await p.getFrames('', ['ad/1x1']))['ad/1x1'].children.length === 2
  && (await p.exportNodes('', 'ad/1x1', ['9:2', '9:3']))['9:2']?.startsWith('data:image/png')
  && (await p.exportNodes('', 'ad/1x1', ['9:3']))['9:3'] === null;
if (!ok) { console.error('FAIL: snapshot did not round-trip'); process.exit(1); }
console.log('ok - snapshot round-trips through the static integration');
