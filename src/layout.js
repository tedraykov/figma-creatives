// Turns a Figma frame tree + content data into an HTML page that Chromium screenshots.
//
// Layer conventions:
//   #name         dynamic layer, filled from data.name
//                 TEXT nodes take a string; any other node (rectangle, ellipse, frame)
//                 with an image fill takes an image URL
//   everything else is static and exported from Figma as a PNG, keeping paint order
//
// Data semantics per dynamic layer:
//   key missing   keep the design as it is in Figma
//   "" or null    hide the layer
//   value         replace text / image

const GOOGLE_FONTS = (process.env.GOOGLE_FONTS ?? 'true') !== 'false';
const MIN_FONT_SIZE = Number(process.env.MIN_FONT_SIZE ?? 8);

const isDynamic = (n) => n.name.trim().startsWith('#');
export const fieldKey = (n) => n.name.trim().slice(1).trim().split(/\s+/)[0];
const hasDynamic = (n) => isDynamic(n) || (n.children ?? []).some(hasDynamic);
const visibleFills = (n) => (n.fills ?? []).filter((f) => f.visible !== false);

// Lists the dynamic fields of a frame, for /templates and validation.
export function listFields(frame) {
  const fields = [];
  const walk = (n) => {
    if (n.visible === false) return;
    if (isDynamic(n)) {
      fields.push({
        key: fieldKey(n),
        type: n.type === 'TEXT' ? 'text' : 'image',
        ...(n.type === 'TEXT' ? { default: n.characters } : {}),
      });
      return;
    }
    (n.children ?? []).forEach(walk);
  };
  (frame.children ?? []).forEach(walk);
  return fields;
}

// Collects warnings about design choices the renderer can't reproduce.
export function lintFrame(frame) {
  const warnings = [];
  const nonSolid = visibleFills(frame).some((f) => f.type !== 'SOLID');
  if (nonSolid) {
    warnings.push('Frame has an image or gradient fill. Move it into a rectangle layer (static, or "#background" to make it dynamic).');
  }
  const walk = (n) => {
    if (isDynamic(n)) {
      if (n.rotation && Math.abs(n.rotation) > 0.01) warnings.push(`"${n.name}" is rotated; rotation is ignored for dynamic layers.`);
      if (n.type !== 'TEXT' && !visibleFills(n).some((f) => f.type === 'IMAGE')) {
        warnings.push(`"${n.name}" is not text and has no image fill; it will be treated as an image slot.`);
      }
      return;
    }
    (n.children ?? []).forEach(walk);
  };
  (frame.children ?? []).forEach(walk);
  return warnings;
}

// Builds an ordered list of draw operations (Figma paint order = children order).
export function planFrame(frame, data) {
  const ops = [];
  const walk = (parent) => {
    for (const child of parent.children ?? []) {
      if (child.visible === false) continue;

      if (isDynamic(child)) {
        const key = fieldKey(child);
        const has = Object.prototype.hasOwnProperty.call(data, key);
        const value = data[key];
        if (has && (value === '' || value === null)) continue; // hidden
        if (child.type === 'TEXT') {
          ops.push({ kind: 'text', node: child, text: has ? String(value) : child.characters });
        } else if (has) {
          ops.push({ kind: 'image', node: child, src: String(value) });
        } else {
          ops.push({ kind: 'static', node: child }); // keep the Figma placeholder image
        }
        continue;
      }

      if (child.children && hasDynamic(child)) {
        // Container with dynamic layers inside: draw its own fill, then its children.
        if (child.type !== 'GROUP' && child.type !== 'BOOLEAN_OPERATION') ops.push({ kind: 'box', node: child });
        walk(child);
        continue;
      }

      ops.push({ kind: 'static', node: child });
    }
  };
  walk(frame);
  return ops;
}

export const staticNodeIds = (ops) => ops.filter((o) => o.kind === 'static').map((o) => o.node.id);

// ---------- HTML ----------
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const px = (v) => `${Math.round(v * 100) / 100}px`;

const rgba = (c, opacity = 1) =>
  `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${Math.round((c.a ?? 1) * opacity * 1000) / 1000})`;

function box(b, frame) {
  return `left:${px(b.x - frame.x)};top:${px(b.y - frame.y)};width:${px(b.width)};height:${px(b.height)};`;
}

function radius(n) {
  if (n.type === 'ELLIPSE') return 'border-radius:50%;';
  if (n.rectangleCornerRadii) return `border-radius:${n.rectangleCornerRadii.map(px).join(' ')};`;
  if (n.cornerRadius) return `border-radius:${px(n.cornerRadius)};`;
  return '';
}

const opacity = (n) => (n.opacity !== undefined && n.opacity < 1 ? `opacity:${n.opacity};` : '');

function solidColor(n) {
  const fill = visibleFills(n).find((f) => f.type === 'SOLID');
  return fill ? rgba(fill.color, fill.opacity ?? 1) : null;
}

const H_ALIGN = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' };
const V_ALIGN = { TOP: 'flex-start', CENTER: 'center', BOTTOM: 'flex-end' };
const CASE = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' };
const DECO = { UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' };

function textOp(op, frame) {
  const n = op.node;
  const s = n.style ?? {};
  const b = n.absoluteBoundingBox;
  const mode = n.style?.textAutoResize ?? n.textAutoResize ?? 'NONE';
  const align = H_ALIGN[s.textAlignHorizontal] ?? 'left';

  const font = [
    `font-family:'${s.fontFamily}',sans-serif`,
    `font-weight:${s.fontWeight ?? 400}`,
    `font-size:${px(s.fontSize ?? 16)}`,
    `font-style:${s.italic ? 'italic' : 'normal'}`,
    `line-height:${s.lineHeightPx && s.lineHeightUnit !== 'INTRINSIC_%' ? px(s.lineHeightPx) : 'normal'}`,
    `letter-spacing:${px(s.letterSpacing ?? 0)}`,
    `text-align:${align}`,
    `color:${solidColor(n) ?? '#000'}`,
    CASE[s.textCase] ? `text-transform:${CASE[s.textCase]}` : '',
    DECO[s.textDecoration] ? `text-decoration:${DECO[s.textDecoration]}` : '',
  ].filter(Boolean).join(';');

  let geometry;
  let fit = false;
  if (mode === 'WIDTH_AND_HEIGHT') {
    // Auto-width text grows from its alignment anchor, on one line.
    const top = px(b.y - frame.y);
    if (align === 'center') geometry = `left:${px(b.x - frame.x + b.width / 2)};top:${top};transform:translateX(-50%);white-space:pre;`;
    else if (align === 'right') geometry = `right:${px(frame.x + frame.width - (b.x + b.width))};top:${top};white-space:pre;`;
    else geometry = `left:${px(b.x - frame.x)};top:${top};white-space:pre;`;
  } else if (mode === 'HEIGHT') {
    // Auto-height text wraps at the box width and grows downward.
    geometry = `left:${px(b.x - frame.x)};top:${px(b.y - frame.y)};width:${px(b.width)};white-space:pre-wrap;`;
  } else {
    // Fixed box: wrap, align vertically, and shrink the font if the copy doesn't fit.
    fit = true;
    geometry = `${box(b, frame)}display:flex;flex-direction:column;justify-content:${V_ALIGN[s.textAlignVertical] ?? 'flex-start'};white-space:pre-wrap;`;
  }

  const clamp = mode === 'TRUNCATE' && s.maxLines
    ? `display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${s.maxLines};overflow:hidden;`
    : '';

  return `<div class="layer${fit ? ' fit' : ''}" data-key="${esc(fieldKey(n))}" style="${geometry}${opacity(n)}${font};overflow-wrap:break-word;">` +
    `<span style="${clamp}">${esc(op.text)}</span></div>`;
}

function imageOp(op, frame) {
  const n = op.node;
  const imgFill = visibleFills(n).find((f) => f.type === 'IMAGE');
  const fitMode = imgFill?.scaleMode === 'FIT' ? 'contain' : 'cover';
  return `<div class="layer" style="${box(n.absoluteBoundingBox, frame)}${radius(n)}${opacity(n)}overflow:hidden;">` +
    `<img data-key="${esc(fieldKey(n))}" src="${esc(op.src)}" style="width:100%;height:100%;object-fit:${fitMode};display:block;"></div>`;
}

function staticOp(op, frame, exports) {
  const uri = exports[op.node.id];
  const b = op.node.absoluteRenderBounds ?? op.node.absoluteBoundingBox;
  if (!uri || !b) return '';
  return `<img class="layer" src="${uri}" style="${box(b, frame)}">`;
}

function boxOp(op, frame) {
  const color = solidColor(op.node);
  if (!color) return '';
  return `<div class="layer" style="${box(op.node.absoluteBoundingBox, frame)}${radius(op.node)}${opacity(op.node)}background:${color};"></div>`;
}

function googleFontsLink(ops) {
  const families = new Map();
  for (const op of ops) {
    if (op.kind !== 'text' || !op.node.style?.fontFamily) continue;
    const s = op.node.style;
    const set = families.get(s.fontFamily) ?? new Set();
    set.add(`${s.italic ? 1 : 0},${s.fontWeight ?? 400}`);
    families.set(s.fontFamily, set);
  }
  return [...families].map(([family, variants]) => {
    const v = [...variants].sort((a, b) => {
      const [ia, wa] = a.split(',').map(Number);
      const [ib, wb] = b.split(',').map(Number);
      return ia - ib || wa - wb;
    });
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:ital,wght@${v.join(';')}&display=block`;
    return `<link rel="stylesheet" href="${url}">`;
  }).join('\n');
}

export function buildHtml(frame, ops, exports) {
  const f = frame.absoluteBoundingBox;
  const bg = solidColor(frame) ?? 'transparent';
  const body = ops.map((op) => {
    if (op.kind === 'text') return textOp(op, f);
    if (op.kind === 'image') return imageOp(op, f);
    if (op.kind === 'box') return boxOp(op, f);
    return staticOp(op, f, exports);
  }).join('\n');

  return `<!doctype html>
<html><head><meta charset="utf-8">
${GOOGLE_FONTS ? googleFontsLink(ops) : ''}
<style>
  html,body{margin:0;padding:0;}
  #frame{position:relative;width:${px(f.width)};height:${px(f.height)};overflow:hidden;background:${bg};
    -webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;}
  .layer{position:absolute;box-sizing:border-box;margin:0;}
</style></head>
<body><div id="frame">
${body}
</div></body></html>`;
}

// Runs inside the page: waits for fonts and images, shrinks overflowing fixed-box text.
export function pageLayoutScript(minFontSize = MIN_FONT_SIZE) {
  return `(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.complete ? null :
      new Promise((r) => { img.onload = img.onerror = r; })));
    const failed = [...document.images].filter((i) => !i.naturalWidth).map((i) => i.dataset.key || 'static layer');

    const shrunk = [];
    for (const el of document.querySelectorAll('.fit')) {
      const cs = getComputedStyle(el);
      let size = parseFloat(cs.fontSize);
      const lh = cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight) / size;
      const start = size;
      while ((el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) && size > ${minFontSize}) {
        size -= 0.5;
        el.style.fontSize = size + 'px';
        if (lh) el.style.lineHeight = (size * lh) + 'px';
      }
      if (size !== start) shrunk.push({ key: el.dataset.key, from: start, to: size });
      if (el.scrollHeight > el.clientHeight + 1) shrunk.push({ key: el.dataset.key, overflow: true });
    }
    return { failed, shrunk };
  })()`;
}
