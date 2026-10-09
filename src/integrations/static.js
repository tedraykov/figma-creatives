// Static source that reads Figma-shaped node trees from a local folder, so the app
// can be tried and tested with no Figma account or network access.
//
// Layout of `dir`:
//   <template>/<ratio>.json            a frame node tree, same shape as the Figma REST API returns
//   <template>/<ratio>/<layerId>.png   optional export for a static layer (":" in the id becomes "_")
// Static layers without a PNG are simply not drawn. See samples/ for a working example.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../errors.js';

const SAFE = /^[\w .-]+$/;

export function createStaticIntegration({ dir = 'samples' } = {}) {
  const root = path.resolve(dir);

  const readDirs = async (p) => {
    try {
      return await readdir(p, { withFileTypes: true });
    } catch {
      return [];
    }
  };

  return {
    type: 'static',
    label: 'Static samples',

    async check() {
      const { name, version } = await this.listTemplates();
      return { name, version };
    },

    async listTemplates() {
      const templates = {};
      let newest = 0;
      for (const t of await readDirs(root)) {
        if (!t.isDirectory() || !SAFE.test(t.name)) continue;
        for (const f of await readDirs(path.join(root, t.name))) {
          if (!f.isFile() || !f.name.endsWith('.json')) continue;
          const ratio = f.name.slice(0, -5);
          if (!SAFE.test(ratio)) continue;
          templates[t.name] ??= {};
          templates[t.name][ratio] = `${t.name}/${ratio}`; // the frame id is its relative path
          newest = Math.max(newest, (await stat(path.join(root, t.name, f.name))).mtimeMs);
        }
      }
      return { name: `Static samples (${dir})`, version: String(newest), templates };
    },

    async getFrames(_source, frameIds) {
      const result = {};
      for (const id of frameIds) {
        const [t, r, ...rest] = id.split('/');
        if (rest.length || !SAFE.test(t ?? '') || !SAFE.test(r ?? '')) throw new HttpError(404, `Frame ${id} not found`);
        try {
          result[id] = JSON.parse(await readFile(path.join(root, t, `${r}.json`), 'utf8'));
        } catch (e) {
          throw new HttpError(e.code === 'ENOENT' ? 404 : 500, `Cannot read static frame ${id}: ${e.message}`);
        }
      }
      return result;
    },

    async exportNodes(_source, frameId, nodeIds) {
      const [t, r] = frameId.split('/');
      const result = {};
      for (const id of nodeIds) {
        try {
          const buf = await readFile(path.join(root, t, r, `${id.replace(/[:;]/g, '_')}.png`));
          result[id] = `data:image/png;base64,${buf.toString('base64')}`;
        } catch {
          result[id] = null;
        }
      }
      return result;
    },

    clearCache: () => 0,
  };
}
