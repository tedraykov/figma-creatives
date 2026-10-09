// Regenerates samples/promo: the static provider's demo template, modelled on the real
// "promo" design (gradient background, grey image slot, headline/body/CTA button).
// Static layers are drawn to PNGs with Chromium, standing in for Figma's exports.
//   CHROME_PATH=/path/to/chrome node scripts/make-samples.mjs
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const white = { r: 1, g: 1, b: 1, a: 1 };
const PINK = '#ff5c7a';
const bb = (x, y, w, h) => ({ x, y, width: w, height: h });

// Per-ratio geometry (frame coordinates).
const LAYOUTS = {
  '1x1': {
    W: 1080, H: 1080,
    circle: bb(660, 640, 840, 840),
    brand: { x: 72, base: 108 },
    image: { box: bb(72, 170, 936, 480), r: 48 },
    headline: { box: bb(72, 687, 936, 110), size: 72, align: 'CENTER' },
    body: { box: bb(72, 800, 936, 56), size: 32, align: 'CENTER' },
    button: { box: bb(390, 900, 300, 88), r: 44 },
  },
  '9x16': {
    W: 1080, H: 1920,
    circle: bb(660, 1480, 600, 600),
    brand: { x: 72, base: 108 },
    image: { box: bb(72, 190, 936, 980), r: 48 },
    headline: { box: bb(72, 1261, 936, 110), size: 88, align: 'CENTER' },
    body: { box: bb(72, 1397, 936, 56), size: 38, align: 'CENTER' },
    button: { box: bb(370, 1560, 340, 100), r: 50 },
  },
  '16x9': {
    W: 1920, H: 1080,
    circle: bb(1500, 640, 600, 600),
    brand: { x: 1050, base: 328 },
    image: { box: bb(72, 72, 900, 936), r: 36 },
    headline: { box: bb(1050, 344, 822, 110), size: 80, align: 'LEFT' },
    body: { box: bb(1050, 468, 822, 56), size: 36, align: 'LEFT' },
    button: { box: bb(1050, 640, 320, 96), r: 48 },
  },
};

const text = (id, name, characters, box, style, color) => ({
  id, name, type: 'TEXT', characters, absoluteBoundingBox: box,
  fills: [{ type: 'SOLID', color }],
  style: { fontFamily: 'Inter', lineHeightPx: Math.round(style.fontSize * 1.2), textAutoResize: 'NONE', textAlignVertical: 'CENTER', ...style },
});

function frameFor(ratio, L) {
  const { W, H } = L;
  const full = bb(0, 0, W, H);
  const btn = L.button.box;
  return {
    id: '1:1', name: `promo/${ratio}`, type: 'FRAME', absoluteBoundingBox: full,
    fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.12, b: 0.23, a: 1 } }],
    children: [
      { id: '1:2', name: '#background', type: 'RECTANGLE', absoluteBoundingBox: full, absoluteRenderBounds: full },
      { id: '1:3', name: 'Circle', type: 'ELLIPSE', absoluteBoundingBox: L.circle, absoluteRenderBounds: L.circle },
      { id: '1:4', name: 'BRAND', type: 'TEXT', characters: 'BRAND', absoluteBoundingBox: bb(L.brand.x, L.brand.base - 31, 160, 40), absoluteRenderBounds: bb(L.brand.x, L.brand.base - 31, 160, 40) },
      { id: '1:5', name: '#image', type: 'RECTANGLE', cornerRadius: L.image.r, absoluteBoundingBox: L.image.box, absoluteRenderBounds: L.image.box },
      text('1:6', '#headline', 'Your headline here', L.headline.box,
        { fontWeight: 700, fontSize: L.headline.size, textAlignHorizontal: L.headline.align }, white),
      text('1:7', '#body', 'Supporting copy goes here', L.body.box,
        { fontWeight: 400, fontSize: L.body.size, textAlignHorizontal: L.body.align }, { r: 0.79, g: 0.8, b: 0.88, a: 1 }),
      { id: '1:8', name: 'Button', type: 'FRAME', cornerRadius: L.button.r, absoluteBoundingBox: btn,
        fills: [{ type: 'SOLID', color: { r: 1, g: 0.36, b: 0.48, a: 1 } }],
        children: [
          { ...text('1:9', '#cta', 'SHOP NOW', bb(btn.x + btn.width / 2 - 60, btn.y + btn.height / 2 - 18, 120, 36),
            { fontWeight: 700, fontSize: 28, textAlignHorizontal: 'CENTER', textAutoResize: 'WIDTH_AND_HEIGHT', letterSpacing: 1.1 }, white) },
        ] },
    ],
  };
}

// HTML for each static layer's PNG, sized to its render bounds.
const FONT = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@700&display=block">';
const layerHtml = {
  '1:2': (L) => `<div style="width:${L.W}px;height:${L.H}px;background:linear-gradient(135deg,#1b1f3b,#3b1d4b)"></div>`,
  '1:3': (L) => `<div style="width:${L.circle.width}px;height:${L.circle.height}px;border-radius:50%;background:${PINK};opacity:.11"></div>`,
  '1:4': () => `${FONT}<div style="font:700 32px/40px Inter,sans-serif;color:#fff;letter-spacing:1px;white-space:pre">BRAND</div>`,
  '1:5': (L) => `<div style="width:${L.image.box.width}px;height:${L.image.box.height}px;border-radius:${L.image.r}px;background:#d9d9d9"></div>`,
};

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'],
});
const dir = join(root, 'samples', 'promo');
rmSync(dir, { recursive: true, force: true });

for (const [ratio, L] of Object.entries(LAYOUTS)) {
  const frame = frameFor(ratio, L);
  mkdirSync(join(dir, ratio), { recursive: true });
  writeFileSync(join(dir, `${ratio}.json`), `${JSON.stringify(frame, null, 2)}\n`);
  for (const node of frame.children) {
    const make = layerHtml[node.id];
    if (!make) continue;
    const b = node.absoluteRenderBounds;
    const page = await browser.newPage();
    await page.setViewport({ width: Math.ceil(b.width), height: Math.ceil(b.height) });
    await page.setContent(`<body style="margin:0;background:transparent">${make(L)}</body>`, { waitUntil: 'networkidle0' }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: Math.ceil(b.width), height: Math.ceil(b.height) } });
    writeFileSync(join(dir, ratio, `${node.id.replace(':', '_')}.png`), png);
    await page.close();
  }
}
await browser.close();
console.log('samples/promo regenerated');
