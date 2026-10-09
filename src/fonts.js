// Makes Google Fonts self-contained: fetches each stylesheet once, inlines its font files
// as data URIs and caches the result. Renders then need no network round-trip
// (previously every render waited ~2s for fonts), and the HTML also works in a browser preview.
const LINK = /<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com\/[^"]+)">/g;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const cache = new Map(); // stylesheet URL -> Promise<string | null>

async function fetchInlinedCss(url) {
  const res = await fetch(url.replaceAll('&amp;', '&'), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`fonts css ${res.status}`);
  let css = await res.text();
  const files = [...new Set([...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map((m) => m[1]))];
  const uris = await Promise.all(files.map(async (f) => {
    const r = await fetch(f, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`font file ${r.status}`);
    const type = r.headers.get('content-type') ?? 'font/woff2';
    return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
  }));
  files.forEach((f, i) => { css = css.replaceAll(f, uris[i]); });
  return css;
}

// Replaces Google Fonts <link> tags with inline <style>. On failure the link stays, so the
// browser falls back to loading the fonts itself.
export async function inlineGoogleFonts(html) {
  const urls = [...new Set([...html.matchAll(LINK)].map((m) => m[1]))];
  if (!urls.length) return html;
  const css = new Map();
  await Promise.all(urls.map(async (u) => {
    if (!cache.has(u)) cache.set(u, fetchInlinedCss(u).catch((e) => { cache.delete(u); console.warn(`font inlining failed: ${e.message}`); return null; }));
    css.set(u, await cache.get(u));
  }));
  return html.replace(LINK, (tag, u) => (css.get(u) ? `<style>${css.get(u)}</style>` : tag));
}
