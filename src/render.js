import puppeteer from 'puppeteer-core';
import { pageLayoutScript } from './layout.js';
import { HttpError } from './figma.js';

const CHROME_PATH = process.env.CHROME_PATH ?? '/usr/bin/chromium';
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? 2);
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 30000);

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none', '--hide-scrollbars'],
      })
      .then((browser) => {
        browser.on('disconnected', () => { browserPromise = null; });
        return browser;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

// Simple semaphore so a burst of n8n items doesn't open dozens of tabs.
let active = 0;
const queue = [];
async function withSlot(fn) {
  if (active >= MAX_CONCURRENCY) await new Promise((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

export async function renderHtml(html, { width, height, scale = 1, format = 'png', quality = 90, strictImages = true }) {
  return withSlot(async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: Math.ceil(width), height: Math.ceil(height), deviceScaleFactor: scale });
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: RENDER_TIMEOUT_MS });
      const report = await page.evaluate(pageLayoutScript());

      if (strictImages && report.failed.length) {
        throw new HttpError(422, `Could not load image(s) for: ${report.failed.join(', ')}`);
      }

      const type = format === 'jpg' || format === 'jpeg' ? 'jpeg' : format;
      const el = await page.$('#frame');
      const image = await el.screenshot({
        type,
        ...(type === 'png' ? { omitBackground: true } : { quality }),
      });
      return { image: Buffer.from(image), report };
    } finally {
      await page.close().catch(() => {});
    }
  });
}

export async function closeBrowser() {
  if (browserPromise) (await browserPromise).close().catch(() => {});
}
