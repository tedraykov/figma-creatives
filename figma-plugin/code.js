// Builds a campaign page from a payload made by the n8n flow: for every language and template/ratio
// it clones the template frame, fills its #fields and lays the copies out in one section per language.
//
// Payload: { campaign, date?, jobs: [{ template, ratio, language, data: { field: value } }] }
//   data semantics match the renderer: key missing = keep the design, "" = hide the layer, value = replace.
// Text values may mark emphasis with **double asterisks** ("Shop **now**"). The emphasised range takes
// the template layer's own emphasis style (a differently styled part of its text, e.g. "LOVED" in another
// font), or the Bold weight of its font when the template has none.
// Template frames are top-level frames named "template/ratio" (on any page except generated ones).
// Generated frames are named "template/ratio/language", which the renderer does not treat as templates.

const GENERATED = 'creatives-campaign'; // plugin data marking pages this plugin made
const GAP = 80;
const TEMPLATE_NAME = /^\s*([^/]+?)\s*\/\s*([^/]+?)\s*$/;

figma.showUI(__html__, { width: 420, height: 600 });

// queueFormUrl / exportFormUrl are the production URLs of the two n8n form triggers (Creative form, Export form).
const DEFAULTS = {
  baseUrl: 'https://creatives.tedraykov.me', apiKey: '',
  queueFormUrl: 'https://n8n.tedraykov.me/form/96f7a369-fe8e-4f50-a8d0-5fe230793ae1',
  exportFormUrl: 'https://n8n.tedraykov.me/form/a6059373-4dca-454f-9874-b7f70815204a',
};

const log = (text, level = 'info') => figma.ui.postMessage({ type: 'log', level, text });

const isDynamic = (n) => n.name.trim().startsWith('#');
const fieldKey = (n) => n.name.trim().slice(1).trim().split(/\s+/)[0].toLowerCase();

async function findTemplates() {
  const found = new Map(); // "template/ratio" -> frame
  for (const page of figma.root.children) {
    if (page.getPluginData(GENERATED)) continue;
    await page.loadAsync();
    const frames = page.findAll((n) => n.type === 'FRAME' && (n.parent.type === 'PAGE' || n.parent.type === 'SECTION') && TEMPLATE_NAME.test(n.name));
    for (const f of frames) {
      const [, t, r] = f.name.match(TEMPLATE_NAME);
      if (!found.has(`${t}/${r}`)) found.set(`${t}/${r}`, f);
    }
  }
  return found;
}

function uniquePageName(base) {
  const names = new Set(figma.root.children.map((p) => p.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}

const FALLBACK = { family: 'Inter', style: 'Regular' };
const FALLBACK_BOLD = { family: 'Inter', style: 'Bold' };

// "Shop **now**" -> { text: "Shop now", ranges: [[5, 8]] }. An unmatched ** stays as typed.
function parseEmphasis(value) {
  let text = '';
  const ranges = [];
  let last = 0;
  for (const m of value.matchAll(/\*\*([\s\S]+?)\*\*/g)) {
    text += value.slice(last, m.index);
    ranges.push([text.length, text.length + m[1].length]);
    text += m[1];
    last = m.index + m[0].length;
  }
  return { text: text + value.slice(last), ranges };
}

// The style to give emphasised text: the template's own emphasis range if it has one, else Bold.
function emphasisStyle(node) {
  if (!node.characters.length) return null;
  const segs = node.getStyledTextSegments(['fontName', 'fontSize', 'fills']);
  const base = segs[0];
  const other = segs.find((g) => g.fontName.family !== base.fontName.family || g.fontName.style !== base.fontName.style);
  if (other) return { fontName: other.fontName, fontSize: other.fontSize, fills: other.fills };
  return { fontName: { family: base.fontName.family, style: 'Bold' } };
}

async function tryLoad(font) {
  try { await figma.loadFontAsync(font); return true; } catch (e) { return false; }
}

// With `fallback`, text whose font isn't available is switched to Inter so layout can still be checked.
async function setText(node, value, fallback) {
  const { text, ranges } = parseEmphasis(value);
  const emphasis = ranges.length ? emphasisStyle(node) : null;
  const fonts = node.characters.length ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName];
  let usedFallback = false;
  try {
    await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
  } catch (e) {
    if (!fallback) throw e;
    await figma.loadFontAsync(FALLBACK);
    node.fontName = FALLBACK;
    usedFallback = true;
    log(`  font missing, using ${FALLBACK.family} for this layer`, 'warn');
  }
  node.characters = text;
  if (!ranges.length) return;

  let style = emphasis;
  if (usedFallback || !style || !(await tryLoad(style.fontName))) {
    if (!fallback) throw new Error(`emphasis font ${style ? `"${style.fontName.family} ${style.fontName.style}"` : ''} could not be loaded`);
    await figma.loadFontAsync(FALLBACK_BOLD);
    style = { fontName: FALLBACK_BOLD };
  }
  for (const [from, to] of ranges) {
    node.setRangeFontName(from, to, style.fontName);
    if (style.fontSize) node.setRangeFontSize(from, to, style.fontSize);
    if (style.fills) node.setRangeFills(from, to, style.fills);
  }
}

const images = new Map(); // url -> Promise<Image>
function loadImage(url) {
  if (!images.has(url)) images.set(url, figma.createImageAsync(url));
  return images.get(url);
}

async function setImage(node, url) {
  const image = await loadImage(url);
  const old = Array.isArray(node.fills) ? node.fills.find((f) => f.type === 'IMAGE') : null;
  node.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: old ? old.scaleMode : 'FILL' }];
}

// Applies one job's data to a cloned frame. Returns warnings.
async function fill(frame, data, fallback) {
  const warnings = [];
  const layers = new Map();
  for (const n of frame.findAll(isDynamic)) layers.set(fieldKey(n), n);
  const keys = Object.keys(data);
  log(`  layers: ${[...layers.keys()].map((k) => `#${k}`).join(' ') || 'none'}`);

  for (const key of keys) {
    const node = layers.get(key.toLowerCase());
    if (!node) { warnings.push(`no layer #${key}`); continue; }
    const value = data[key];
    try {
      if (value === '' || value === null) node.visible = false;
      else if (node.type === 'TEXT') await setText(node, String(value), fallback);
      else await setImage(node, String(value));
      log(`  #${key} (${node.type}${node.type === 'TEXT' ? `, now "${node.characters}"` : ''})`);
    } catch (e) {
      warnings.push(`#${key}: ${e.message || e}`);
    }
  }
  return warnings;
}

async function generate(payload, fallback) {
  const jobs = Array.isArray(payload) ? payload : payload.jobs;
  if (!Array.isArray(jobs) || !jobs.length) throw new Error('The payload has no jobs.');
  const head = Array.isArray(payload) ? {} : payload;
  const campaign = head.campaign || 'campaign';
  // "2026-10-12" -> "12.10.2026". The export flow reads the date and name back from this page name,
  // and it becomes the campaign's Drive folder, so keep the format.
  const iso = String(head.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = iso ? `${iso[3]}.${iso[2]}.${iso[1]} ` : head.date ? `${head.date} ` : '';

  const templates = await findTemplates();
  const missing = [...new Set(jobs.map((j) => `${j.template}/${j.ratio}`))].filter((k) => !templates.has(k));
  if (missing.length) throw new Error(`Template frames not found in this file: ${missing.join(', ')}`);

  const page = figma.createPage();
  page.name = uniquePageName(`${date}${campaign}`);
  page.setPluginData(GENERATED, '1');

  const byLanguage = new Map();
  for (const j of jobs) {
    if (!byLanguage.has(j.language)) byLanguage.set(j.language, []);
    byLanguage.get(j.language).push(j);
  }

  let y = 0;
  let count = 0;
  for (const [language, list] of byLanguage) {
    const section = figma.createSection();
    section.name = language;
    page.appendChild(section);
    section.x = 0;
    section.y = y;

    let x = GAP;
    let tallest = 0;
    for (const job of list) {
      const clone = templates.get(`${job.template}/${job.ratio}`).clone();
      section.appendChild(clone);
      clone.name = `${job.template}/${job.ratio}/${language}`;
      clone.x = x;
      clone.y = GAP;
      x += clone.width + GAP;
      tallest = Math.max(tallest, clone.height);

      const warnings = await fill(clone, job.data || {}, fallback);
      warnings.forEach((w) => log(`${clone.name}: ${w}`, 'warn'));
      count++;
      log(`${clone.name}`);
    }
    section.resizeWithoutConstraints(Math.max(x, 100), tallest + GAP * 2);
    y += tallest + GAP * 2 + GAP * 2;
  }

  await figma.setCurrentPageAsync(page);
  figma.viewport.scrollAndZoomIntoView(page.children);
  // fileKey is only available to private plugins; without it the service just stores no link.
  const pageUrl = figma.fileKey ? `https://www.figma.com/design/${figma.fileKey}?node-id=${page.id.replace(':', '-')}` : null;
  return { page: page.name, count, pageUrl };
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'init') {
    const saved = await figma.clientStorage.getAsync('settings');
    figma.ui.postMessage({ type: 'settings', settings: { ...DEFAULTS, ...(saved || {}) } });
  } else if (msg.type === 'saveSettings') {
    await figma.clientStorage.setAsync('settings', msg.settings);
  } else if (msg.type === 'openForm') {
    figma.openExternal(msg.url);
  } else if (msg.type === 'generate') {
    try {
      const payload = JSON.parse(msg.payload);
      const { page, count, pageUrl } = await generate(payload, !!msg.fallback);
      log(`Done: ${count} frames on page "${page}".`, 'ok');
      figma.ui.postMessage({ type: 'done', ok: true, campaignId: msg.campaignId, pageUrl });
    } catch (e) {
      log(e.message || String(e), 'error');
      figma.ui.postMessage({ type: 'done', ok: false });
    }
  }
};
