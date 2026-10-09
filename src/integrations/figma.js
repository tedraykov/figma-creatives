// Figma source: reads frames live from the Figma REST API. It is wrapped by frames.js, which turns
// frames into rendered images (see integrations/index.js for the interface every integration meets).
//
// Frame source interface (shared with the static integration):
//   id, label
//   check(source)                              -> { name, version }   validates access
//   listTemplates(source)                      -> { name, version, templates: { tpl: { ratio: frameId } } }
//   getFrames(source, frameIds, version)       -> { frameId: figmaNodeTree }
//   exportNodes(source, frameId, ids, version, scale) -> { layerId: pngDataUri | null }
//   clearCache()                               -> number of cleared entries
// `source` is the Figma file key. Everything is cached in memory, keyed by the file's
// version, so a design change is picked up once the template index cache expires.
import { HttpError } from '../errors.js';

const API = 'https://api.figma.com/v1';
const TEMPLATE_NAME = /^\s*([^/]+?)\s*\/\s*([^/]+?)\s*$/;
const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'INSTANCE']);

// options.token: the personal access token, or a function returning it (so it can change at runtime).
export function createFigmaIntegration({ token, cacheTtlSeconds = 300, cacheMaxEntries = 1000 } = {}) {
  const getToken = typeof token === 'function' ? token : () => token;
  const ttl = cacheTtlSeconds * 1000;
  const cache = new Map();

  const cacheGet = (key) => {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (hit.expires && hit.expires < Date.now()) {
      cache.delete(key);
      return undefined;
    }
    return hit.value;
  };
  const cacheSet = (key, value, ttlMs = 0) => {
    if (cache.size >= cacheMaxEntries) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: ttlMs ? Date.now() + ttlMs : 0 });
    return value;
  };

  async function figmaGet(path, attempt = 0) {
    const t = getToken();
    if (!t) throw new HttpError(500, 'No Figma token configured (set it in the UI or FIGMA_TOKEN)');
    const res = await fetch(API + path, { headers: { 'X-Figma-Token': t } });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? 5) * 1000;
      if (wait > 30000 || attempt >= 3) {
        // Short limits are retried; a long one (e.g. a starter-plan quota) would hang the request.
        const tier = res.headers.get('x-figma-plan-tier');
        const hours = wait >= 3600000 ? ` (~${Math.round(wait / 3600000)}h)` : '';
        throw new HttpError(429, `Figma rate limit hit, retry after ${Math.round(wait / 1000)}s${hours}${tier ? `; plan tier: ${tier}` : ''}`);
      }
      await new Promise((r) => setTimeout(r, wait));
      return figmaGet(path, attempt + 1);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new HttpError(res.status === 404 ? 404 : 502, `Figma API ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }

  return {
    type: 'figma',
    label: 'Figma',

    async check(fileKey) {
      const file = await figmaGet(`/files/${fileKey}?depth=1`);
      return { name: file.name, version: file.version };
    },

    // Finds every frame named "template/ratio" (e.g. "promo/1x1") on any page,
    // including frames placed inside sections.
    async listTemplates(fileKey) {
      const key = `index:${fileKey}`;
      const cached = cacheGet(key);
      if (cached) return cached;

      const file = await figmaGet(`/files/${fileKey}?depth=3`);
      const templates = {};
      const walk = (node) => {
        if (FRAME_TYPES.has(node.type)) {
          const m = node.name.match(TEMPLATE_NAME);
          if (m) {
            templates[m[1]] ??= {};
            templates[m[1]][m[2]] = node.id;
            return; // don't look for templates inside templates
          }
        }
        (node.children ?? []).forEach(walk);
      };
      walk(file.document);

      return cacheSet(key, { version: file.version, name: file.name, templates }, ttl);
    },

    // Full node trees for one or more frames, cached per file version.
    async getFrames(fileKey, nodeIds, version) {
      const result = {};
      const missing = [];
      for (const id of nodeIds) {
        const hit = cacheGet(`frame:${fileKey}:${version}:${id}`);
        if (hit) result[id] = hit;
        else missing.push(id);
      }
      if (missing.length) {
        const data = await figmaGet(`/files/${fileKey}/nodes?ids=${encodeURIComponent(missing.join(','))}`);
        for (const id of missing) {
          const doc = data.nodes?.[id]?.document;
          if (!doc) throw new HttpError(404, `Node ${id} not found in file`);
          result[id] = cacheSet(`frame:${fileKey}:${version}:${id}`, doc);
        }
      }
      return result;
    },

    // Exports nodes as PNG data URIs. Exports cover each node's render bounds
    // (including shadows and other effects), so place them at absoluteRenderBounds.
    async exportNodes(fileKey, _frameId, nodeIds, version, scale) {
      const result = {};
      const missing = [];
      for (const id of nodeIds) {
        const hit = cacheGet(`img:${fileKey}:${version}:${scale}:${id}`);
        if (hit !== undefined) result[id] = hit;
        else missing.push(id);
      }

      for (let i = 0; i < missing.length; i += 50) {
        const batch = missing.slice(i, i + 50);
        const data = await figmaGet(
          `/images/${fileKey}?ids=${encodeURIComponent(batch.join(','))}&format=png&scale=${scale}`
        );
        if (data.err) throw new HttpError(502, `Figma export failed: ${data.err}`);

        await Promise.all(
          batch.map(async (id) => {
            const url = data.images?.[id];
            let uri = null; // null = nothing to draw (empty or invisible node)
            if (url) {
              const res = await fetch(url);
              if (!res.ok) throw new HttpError(502, `Downloading export for ${id} failed: ${res.status}`);
              const buf = Buffer.from(await res.arrayBuffer());
              uri = `data:image/png;base64,${buf.toString('base64')}`;
            }
            result[id] = cacheSet(`img:${fileKey}:${version}:${scale}:${id}`, uri);
          })
        );
      }
      return result;
    },

    clearCache() {
      const n = cache.size;
      cache.clear();
      return n;
    },
  };
}
