// Figma REST API client: template discovery, frame trees and static-layer exports.
// Everything is cached in memory and keyed by the file's version, so a design change
// in Figma is picked up automatically once the template index cache expires.

const API = 'https://api.figma.com/v1';
const TOKEN = process.env.FIGMA_TOKEN;
const TTL_MS = Number(process.env.CACHE_TTL_SECONDS ?? 300) * 1000;
const MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES ?? 1000);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- tiny TTL cache ----------
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires && hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value, ttl = 0) {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: ttl ? Date.now() + ttl : 0 });
  return value;
}

export function clearCache() {
  const n = cache.size;
  cache.clear();
  return n;
}

// ---------- HTTP ----------
async function figmaGet(path, attempt = 0) {
  if (!TOKEN) throw new HttpError(500, 'FIGMA_TOKEN is not set');
  const res = await fetch(API + path, { headers: { 'X-Figma-Token': TOKEN } });
  if (res.status === 429 && attempt < 3) {
    const wait = Number(res.headers.get('retry-after') ?? 5) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(wait, 30000)));
    return figmaGet(path, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new HttpError(res.status === 404 ? 404 : 502, `Figma API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// ---------- templates ----------
const TEMPLATE_NAME = /^\s*([^/]+?)\s*\/\s*([^/]+?)\s*$/;
const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'INSTANCE']);

// Finds every frame named "template/ratio" (e.g. "promo/1x1") on any page,
// including frames placed inside sections.
export async function getTemplateIndex(fileKey) {
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

  return cacheSet(key, { version: file.version, name: file.name, templates }, TTL_MS);
}

export async function resolveTemplate(fileKey, template, ratio) {
  const index = await getTemplateIndex(fileKey);
  const ratios = index.templates[template];
  if (!ratios) {
    throw new HttpError(404, `Template "${template}" not found. Available: ${Object.keys(index.templates).join(', ') || 'none'}`);
  }
  const nodeId = ratios[ratio];
  if (!nodeId) {
    throw new HttpError(404, `Ratio "${ratio}" not found for "${template}". Available: ${Object.keys(ratios).join(', ')}`);
  }
  return { nodeId, version: index.version };
}

// Full node trees for one or more frames, cached per file version.
export async function getFrames(fileKey, nodeIds, version) {
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
}

// Exports nodes as PNG data URIs. Exports cover each node's render bounds
// (including shadows and other effects), so place them at absoluteRenderBounds.
export async function exportNodes(fileKey, nodeIds, version, scale) {
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
}
