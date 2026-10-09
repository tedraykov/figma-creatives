// Copies templates from a Figma file into the static integration's folder, so they can be
// used later without Figma access (and without spending API quota).
//
//   node --env-file=.env scripts/snapshot-figma.mjs [fileKey] [outDir]
//
// Uses FIGMA_TOKEN and FIGMA_FILE_KEY from the environment. Costs about 3 Figma calls:
// the file index, one batched node fetch, and one image export per 50 static layers.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { planFrame, staticNodeIds } from '../src/layout.js';
import { createFigmaIntegration } from '../src/integrations/figma.js';

const fileKey = process.argv[2] ?? process.env.FIGMA_FILE_KEY;
const out = path.resolve(process.argv[3] ?? 'samples');
const EXPORT_SCALE = 2; // static layers are stored at 2x so 2x renders stay sharp

if (!fileKey) throw new Error('Pass a file key or set FIGMA_FILE_KEY');
const figma = createFigmaIntegration({ token: process.env.FIGMA_TOKEN });

const index = await figma.listTemplates(fileKey);
const entries = Object.entries(index.templates).flatMap(([t, ratios]) => Object.entries(ratios).map(([r, id]) => ({ t, r, id })));
if (!entries.length) throw new Error('No "template/ratio" frames found in this file');

const frames = await figma.getFrames(fileKey, entries.map((e) => e.id), index.version);
const layerIds = entries.flatMap((e) => staticNodeIds(planFrame(frames[e.id], {})));
const images = await figma.exportNodes(fileKey, null, [...new Set(layerIds)], index.version, EXPORT_SCALE);

for (const { t, r, id } of entries) {
  const frame = frames[id];
  await rm(path.join(out, t, r), { recursive: true, force: true });
  await mkdir(path.join(out, t, r), { recursive: true });
  await writeFile(path.join(out, t, `${r}.json`), `${JSON.stringify(frame, null, 2)}\n`);
  for (const layer of staticNodeIds(planFrame(frame, {}))) {
    const uri = images[layer];
    if (uri) await writeFile(path.join(out, t, r, `${layer.replace(/[:;]/g, '_')}.png`), Buffer.from(uri.split(',')[1], 'base64'));
  }
  console.log(`saved ${t}/${r}`);
}
console.log(`\nFrom "${index.name}" (version ${index.version}) into ${out}`);
