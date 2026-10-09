// Integrations: one adapter per configured integration, all meeting the same interface so the
// server doesn't care whether templates come from Figma, Canva or a folder.
//
//   type, label, livePreview
//   linkHint           { label, placeholder, required } for the "link project" form
//   parseSource(input) -> the project's `source` string (throws 400 if invalid)
//   check(source)      -> { name, version }            validates access (used when linking)
//   listTemplates(source) -> { name, version, templates: { tpl: { ratio: { width, height, fields, warnings, thumbnail?, url? } } } }
//                         `url` links back to the original design in the source tool, when it has one
//   render(source, { template, ratio, data, format, scale, quality }) -> { image, contentType, width, height, report }
//   html(source, req, { preview }) -> { html, width, height }      only when livePreview is true
//   clearCache() -> number
import { getIntegration, setIntegrationTokens } from '../config.js';
import { HttpError } from '../errors.js';
import { createCanvaIntegration } from './canva.js';
import { createFigmaIntegration } from './figma.js';
import { frameIntegration } from './frames.js';
import { createStaticIntegration } from './static.js';

// Accepts a bare file key or any figma.com/file|design/<key>/... URL.
export function parseFigmaFileKey(input) {
  const s = String(input ?? '').trim();
  const m = s.match(/figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/);
  const key = m ? m[1] : /^[A-Za-z0-9]+$/.test(s) ? s : '';
  if (!key) throw new HttpError(400, 'Not a valid Figma file link or key');
  return key;
}

const META = {
  figma: {
    type: 'figma', label: 'Figma', parseSource: parseFigmaFileKey,
    // Opens the frame itself in Figma: node ids use "-" in URLs where the API uses ":".
    templateUrl: (fileKey, nodeId) => `https://www.figma.com/design/${fileKey}?node-id=${encodeURIComponent(String(nodeId).replace(/:/g, '-'))}`,
    linkHint: { label: 'Figma file link', placeholder: 'https://www.figma.com/design/…', required: true },
  },
  canva: {
    type: 'canva', label: 'Canva', parseSource: (input) => String(input ?? '').trim(),
    linkHint: { label: 'Template filter (optional)', placeholder: 'Only brand templates whose title matches', required: false },
  },
  static: { type: 'static', label: 'Static samples', parseSource: () => '', linkHint: null },
};

// Shown in Settings so the UI can adapt its forms to each integration type.
export const describeType = (type) => ({
  label: META[type]?.label ?? type,
  linkHint: META[type]?.linkHint ?? null,
  livePreview: type !== 'canva',
});

const staticIntegration = frameIntegration(createStaticIntegration({ dir: process.env.STATIC_DIR ?? 'samples' }), META.static);
const cache = new Map(); // integration id -> adapter

export function integrationFor(integrationId) {
  const config = getIntegration(integrationId);
  if (!config) throw new HttpError(404, 'Integration not found');
  if (config.type === 'static') return staticIntegration;
  if (!cache.has(config.id)) {
    const live = () => getIntegration(config.id); // read per request, so edits and rotated tokens apply at once
    if (config.type === 'figma') {
      cache.set(config.id, frameIntegration(createFigmaIntegration({
        token: () => live()?.token ?? '',
        cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 300),
        cacheMaxEntries: Number(process.env.CACHE_MAX_ENTRIES ?? 1000),
      }), META.figma));
    } else if (config.type === 'canva') {
      cache.set(config.id, {
        ...META.canva,
        ...createCanvaIntegration({
          getCredentials: () => live() ?? {},
          saveTokens: (tokens) => setIntegrationTokens(config.id, tokens),
          cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 300),
        }),
      });
    } else throw new HttpError(500, `Unsupported integration type "${config.type}"`);
  }
  return cache.get(config.id);
}

export const clearAllCaches = () => [staticIntegration, ...cache.values()].reduce((n, i) => n + i.clearCache(), 0);
