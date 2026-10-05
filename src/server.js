import express from 'express';
import {
  HttpError, clearCache, exportNodes, getFrames, getTemplateIndex, resolveTemplate,
} from './figma.js';
import { buildHtml, lintFrame, listFields, planFrame, staticNodeIds } from './layout.js';
import { closeBrowser, renderHtml } from './render.js';

const PORT = Number(process.env.PORT ?? 3000);
const API_KEY = process.env.API_KEY;
const DEFAULT_FILE_KEY = process.env.FIGMA_FILE_KEY;
const FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((req, _res, next) => {
  if (!API_KEY) return next();
  const header = req.get('authorization') ?? '';
  if (header === `Bearer ${API_KEY}` || req.get('x-api-key') === API_KEY) return next();
  next(new HttpError(401, 'Missing or invalid API key'));
});

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

function fileKeyFrom(req) {
  const key = req.body?.fileKey ?? req.query.fileKey ?? DEFAULT_FILE_KEY;
  if (!key) throw new HttpError(400, 'No fileKey given and FIGMA_FILE_KEY is not set');
  return key;
}

// Lists templates, ratios, sizes and dynamic fields found in the Figma file.
app.get('/templates', wrap(async (req, res) => {
  const fileKey = fileKeyFrom(req);
  const index = await getTemplateIndex(fileKey);
  const ids = Object.values(index.templates).flatMap((r) => Object.values(r));
  const frames = ids.length ? await getFrames(fileKey, ids, index.version) : {};

  const templates = {};
  for (const [name, ratios] of Object.entries(index.templates)) {
    templates[name] = {};
    for (const [ratio, id] of Object.entries(ratios)) {
      const frame = frames[id];
      const b = frame.absoluteBoundingBox;
      templates[name][ratio] = {
        nodeId: id,
        width: b.width,
        height: b.height,
        fields: listFields(frame),
        warnings: lintFrame(frame),
      };
    }
  }
  res.json({ file: index.name, version: index.version, templates });
}));

// Renders one template/ratio with the given data. Returns the image as binary.
app.post('/render', wrap(async (req, res) => {
  const { template, ratio, data = {}, format = 'png', scale = 1, quality = 90, output } = req.body ?? {};
  if (!template || !ratio) throw new HttpError(400, 'Body must include "template" and "ratio"');
  if (!FORMATS.has(format)) throw new HttpError(400, `format must be one of ${[...FORMATS].join(', ')}`);
  const s = Number(scale);
  if (!(s > 0 && s <= 4)) throw new HttpError(400, 'scale must be between 0 and 4');

  const fileKey = fileKeyFrom(req);
  const { nodeId, version } = await resolveTemplate(fileKey, template, ratio);
  const frame = (await getFrames(fileKey, [nodeId], version))[nodeId];

  const ops = planFrame(frame, data);
  const exports = await exportNodes(fileKey, staticNodeIds(ops), version, s);
  const html = buildHtml(frame, ops, exports);

  if (output === 'html') {
    res.type('html').send(html);
    return;
  }

  const { width, height } = frame.absoluteBoundingBox;
  const { image, report } = await renderHtml(html, { width, height, scale: s, format, quality });

  const fileName = `${template}_${ratio}.${format === 'jpeg' ? 'jpg' : format}`;
  res.set({
    'Content-Type': MIME[format],
    'Content-Disposition': `inline; filename="${fileName}"`,
    'X-Render-Width': String(Math.round(width * s)),
    'X-Render-Height': String(Math.round(height * s)),
    'X-Render-Report': JSON.stringify(report.shrunk),
  });
  res.send(image);
}));

app.post('/cache/clear', (_req, res) => res.json({ cleared: clearCache() }));

app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

const server = app.listen(PORT, () => {
  console.log(`figma-template-renderer listening on :${PORT}`);
  if (!API_KEY) console.warn('API_KEY is not set: the API is open to anyone who can reach it');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await closeBrowser();
    process.exit(0);
  });
}
