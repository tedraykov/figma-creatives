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

const isAuto = (n) => n.layoutMode === 'HORIZONTAL' || n.layoutMode === 'VERTICAL';

// Builds an ordered list of draw operations (Figma paint order = children order).
// A container with dynamic layers inside becomes a "flex" op holding its own ops. Auto-layout
// containers are rebuilt as CSS flexbox, so they resize with their text. Other containers keep
// absolute positioning.
export function planFrame(frame, data) {
  const walk = (parent, ops = []) => {
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
        if (isAuto(child) || isAuto(parent)) {
          ops.push({ kind: 'flex', node: child, items: walk(child) });
          continue;
        }
        // Container with dynamic layers inside: draw its own fill, then its children.
        if (child.type !== 'GROUP' && child.type !== 'BOOLEAN_OPERATION') ops.push({ kind: 'box', node: child });
        walk(child, ops);
        continue;
      }

      ops.push({ kind: 'static', node: child });
    }
    return ops;
  };
  return walk(frame);
}

const flatten = (ops) => ops.flatMap((o) => (o.kind === 'flex' ? [o, ...flatten(o.items)] : [o]));

export const staticNodeIds = (ops) => flatten(ops).filter((o) => o.kind === 'static').map((o) => o.node.id);

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

// ---------- auto layout ----------
const JUSTIFY = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' };
const ALIGN = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' };

// 'FIXED' | 'HUG' | 'FILL' along one axis. Older files lack layoutSizing*, so derive it.
function sizingOf(n, parent, axis) {
  const s = axis === 'h' ? n.layoutSizingHorizontal : n.layoutSizingVertical;
  if (s) return s;
  if (n.type === 'TEXT') {
    const mode = n.style?.textAutoResize;
    if (mode === 'WIDTH_AND_HEIGHT' || (mode === 'HEIGHT' && axis === 'v')) return 'HUG';
  }
  if (isAuto(n) && n.layoutMode && !parent) {
    const primary = (n.layoutMode === 'HORIZONTAL') === (axis === 'h');
    const mode = primary ? n.primaryAxisSizingMode : n.counterAxisSizingMode;
    return mode === 'AUTO' ? 'HUG' : 'FIXED';
  }
  if (parent) {
    const primary = (parent.layoutMode === 'HORIZONTAL') === (axis === 'h');
    if (primary ? n.layoutGrow === 1 : n.layoutAlign === 'STRETCH') return 'FILL';
  }
  return 'FIXED';
}

// Size rules for an element, as a flex child of `parent` (or alone when parent is null).
// `fixed` pins both sizes to the design (static exports can't resize).
function sizeCss(n, parent, b, fixed = false) {
  const row = parent?.layoutMode === 'HORIZONTAL';
  let css = '';
  for (const axis of ['h', 'v']) {
    const dim = axis === 'h' ? 'width' : 'height';
    const size = axis === 'h' ? b.width : b.height;
    const s = fixed ? 'FIXED' : sizingOf(n, parent, axis);
    const main = parent && row === (axis === 'h');
    if (s === 'FILL' && parent) css += main ? `flex:1 1 0;min-${dim}:0;` : 'align-self:stretch;';
    else if (s === 'HUG') css += main ? 'flex:none;' : '';
    else css += `${dim}:${px(size)};${main ? 'flex:none;' : ''}`;
  }
  return css;
}

// Where an element goes: in the parent's flow, or absolutely against `origin` (a box with x/y).
function placeCss(n, b, origin, parent, fixed) {
  if (parent && n.layoutPositioning !== 'ABSOLUTE') return `position:relative;${sizeCss(n, parent, b, fixed)}`;
  return `position:absolute;left:${px(b.x - origin.x)};top:${px(b.y - origin.y)};${sizeCss(n, null, b, fixed)}`;
}

function flexCss(n) {
  const row = n.layoutMode === 'HORIZONTAL';
  return `display:flex;flex-direction:${row ? 'row' : 'column'};` +
    `justify-content:${JUSTIFY[n.primaryAxisAlignItems] ?? 'flex-start'};align-items:${ALIGN[n.counterAxisAlignItems] ?? 'flex-start'};` +
    `gap:${px(n.itemSpacing ?? 0)};padding:${[n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map((v) => px(v ?? 0)).join(' ')};`;
}

function textOp(op, frame, parent) {
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
  const flowing = parent && n.layoutPositioning !== 'ABSOLUTE';
  if (flowing) {
    // Inside auto layout the parent decides position and, for hug/fill text, the size.
    const wrap = mode === 'WIDTH_AND_HEIGHT' ? 'pre' : 'pre-wrap';
    geometry = `${placeCss(n, b, frame, parent)}white-space:${wrap};`;
    if (mode !== 'WIDTH_AND_HEIGHT' && mode !== 'HEIGHT') {
      fit = true;
      geometry += `display:flex;flex-direction:column;justify-content:${V_ALIGN[s.textAlignVertical] ?? 'flex-start'};`;
    }
  } else if (mode === 'WIDTH_AND_HEIGHT') {
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

  return `<div class="${flowing ? 'flow' : 'layer'}${fit ? ' fit' : ''}" data-key="${esc(fieldKey(n))}" style="${geometry}${opacity(n)}${font};overflow-wrap:break-word;">` +
    `<span style="${clamp}">${esc(op.text)}</span></div>`;
}

function imageOp(op, frame, parent) {
  const n = op.node;
  const imgFill = visibleFills(n).find((f) => f.type === 'IMAGE');
  const fitMode = imgFill?.scaleMode === 'FIT' ? 'contain' : 'cover';
  const b = n.absoluteBoundingBox;
  const pos = parent ? `${placeCss(n, b, frame, parent)}` : box(b, frame);
  return `<div class="${parent ? 'flow' : 'layer'}" style="${pos}${radius(n)}${opacity(n)}overflow:hidden;">` +
    `<img data-key="${esc(fieldKey(n))}" src="${esc(op.src)}" style="width:100%;height:100%;object-fit:${fitMode};display:block;"></div>`;
}

function staticOp(op, frame, exports, parent) {
  const uri = exports[op.node.id];
  const bb = op.node.absoluteBoundingBox;
  const b = op.node.absoluteRenderBounds ?? bb;
  if (!uri || !b) return '';
  if (!parent || op.node.layoutPositioning === 'ABSOLUTE') return `<img class="layer" src="${uri}" style="${box(b, frame)}">`;
  // In a flow the node keeps its design size; the export (which may bleed past it, e.g. shadows) is placed inside.
  return `<div class="flow" style="${placeCss(op.node, bb, frame, parent, true)}">` +
    `<img class="layer" src="${uri}" style="${box(b, bb)}"></div>`;
}

function boxOp(op, frame) {
  const color = solidColor(op.node);
  if (!color) return '';
  return `<div class="layer" style="${box(op.node.absoluteBoundingBox, frame)}${radius(op.node)}${opacity(op.node)}background:${color};"></div>`;
}

// A container whose children include dynamic layers. Auto-layout containers lay out their children
// as flexbox and size themselves from them; other containers just anchor their absolutely placed children.
function flexOp(op, frame, exports, parent) {
  const n = op.node;
  const b = n.absoluteBoundingBox;
  const color = solidColor(n);
  const inner = renderOps(op.items, b, exports, isAuto(n) ? n : null);
  const place = placeCss(n, b, frame, parent);
  return `<div class="${parent && n.layoutPositioning !== 'ABSOLUTE' ? 'flow' : 'layer'}" style="${place}${isAuto(n) ? flexCss(n) : ''}${radius(n)}${opacity(n)}${color ? `background:${color};` : ''}">${inner}</div>`;
}

// `parent` is the auto-layout container the ops flow in, or null when they sit at absolute positions.
function renderOps(ops, origin, exports, parent = null) {
  return ops.map((op) => {
    if (op.kind === 'text') return textOp(op, origin, parent);
    if (op.kind === 'image') return imageOp(op, origin, parent);
    if (op.kind === 'box') return boxOp(op, origin);
    if (op.kind === 'flex') return flexOp(op, origin, exports, parent);
    return staticOp(op, origin, exports, parent);
  }).join('\n');
}

function googleFontsLink(ops) {
  const families = new Map();
  for (const op of flatten(ops)) {
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
  const body = renderOps(ops, f, exports);

  return `<!doctype html>
<html><head><meta charset="utf-8">
${GOOGLE_FONTS ? googleFontsLink(ops) : ''}
<style>
  html,body{margin:0;padding:0;}
  #frame{position:relative;width:${px(f.width)};height:${px(f.height)};overflow:hidden;background:${bg};
    -webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;}
  .layer{position:absolute;box-sizing:border-box;margin:0;}
  .flow{position:relative;box-sizing:border-box;margin:0;}
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
