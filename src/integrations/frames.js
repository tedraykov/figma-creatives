// Turns a frame source (Figma, static samples) into a full integration: field discovery from the
// node trees, an HTML rebuild of each frame, and Chromium screenshots.
import { HttpError } from '../errors.js';
import { inlineGoogleFonts } from '../fonts.js';
import { buildHtml, lintFrame, listFields, pageLayoutScript, planFrame, staticNodeIds } from '../layout.js';
import { renderHtml } from '../render.js';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

export function frameIntegration(frames, meta) {
  async function resolve(source, template, ratio) {
    const index = await frames.listTemplates(source);
    const ratios = index.templates[template];
    if (!ratios) throw new HttpError(404, `Template "${template}" not found. Available: ${Object.keys(index.templates).join(', ') || 'none'}`);
    const nodeId = ratios[ratio];
    if (!nodeId) throw new HttpError(404, `Ratio "${ratio}" not found for "${template}". Available: ${Object.keys(ratios).join(', ')}`);
    return { nodeId, version: index.version };
  }

  // Builds the page for one template/ratio. `inline` embeds Google Fonts for server-side rendering.
  async function build(source, { template, ratio, data = {}, scale = 1 }, { inline }) {
    const { nodeId, version } = await resolve(source, template, ratio);
    const frame = (await frames.getFrames(source, [nodeId], version))[nodeId];
    const ops = planFrame(frame, data);
    const exports = await frames.exportNodes(source, nodeId, staticNodeIds(ops), version, scale);
    const raw = buildHtml(frame, ops, exports);
    const { width, height } = frame.absoluteBoundingBox;
    return { html: inline ? await inlineGoogleFonts(raw) : raw, width, height };
  }

  return {
    ...meta,
    livePreview: true,
    check: (source) => frames.check(source),
    clearCache: () => frames.clearCache(),

    async listTemplates(source) {
      const index = await frames.listTemplates(source);
      const ids = Object.values(index.templates).flatMap((r) => Object.values(r));
      const trees = ids.length ? await frames.getFrames(source, ids, index.version) : {};
      const templates = {};
      for (const [name, ratios] of Object.entries(index.templates)) {
        templates[name] = {};
        for (const [ratio, id] of Object.entries(ratios)) {
          const frame = trees[id];
          const b = frame.absoluteBoundingBox;
          templates[name][ratio] = {
            nodeId: id, width: b.width, height: b.height, fields: listFields(frame), warnings: lintFrame(frame),
            url: meta.templateUrl?.(source, id), // link back to the original design, when the source has one
          };
        }
      }
      return { name: index.name, version: index.version, templates };
    },

    // The page itself: "preview" adds the in-page script, so a browser can show the result without Chromium here.
    async html(source, req, { preview = false } = {}) {
      const { html, width, height } = await build(source, req, { inline: !preview });
      return {
        width, height,
        html: preview ? html.replace('</body>', `<script>${pageLayoutScript()}.then((r) => parent.postMessage({ renderReport: r }, '*'));</script></body>`) : html,
      };
    },

    async render(source, req) {
      const { format = 'png', scale = 1, quality = 90 } = req;
      const { html, width, height } = await build(source, req, { inline: true });
      const { image, report } = await renderHtml(html, { width, height, scale, format, quality });
      return { image, contentType: MIME[format], width: Math.round(width * scale), height: Math.round(height * scale), report: report.shrunk };
    },
  };
}
