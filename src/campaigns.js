// Campaigns queued by the n8n flow for the Figma plugin to build into a page. The payload is
// { campaign, date?, jobs: [{ template, ratio, language, data }], assets? } (see figma-plugin/code.js).
// assets maps a key to an image as a data URL; a job's data value "asset:<key>" points at it, so private
// images (for example from Google Drive) reach the plugin without being public.
import { randomBytes } from 'node:crypto';
import { HttpError } from './errors.js';
import { deleteCampaign, finishCampaign, getCampaign, insertCampaign, listCampaigns } from './db.js';

const isString = (v) => typeof v === 'string' && v.trim() !== '';

function validate(body) {
  if (!body || typeof body !== 'object' || !isString(body.campaign)) throw new HttpError(400, 'Body must include "campaign"');
  if (!Array.isArray(body.jobs) || !body.jobs.length) throw new HttpError(400, 'Body must include a non-empty "jobs" array');
  body.jobs.forEach((j, i) => {
    for (const k of ['template', 'ratio', 'language']) if (!isString(j?.[k])) throw new HttpError(400, `jobs[${i}] needs "${k}"`);
    if (j.data !== undefined && (typeof j.data !== 'object' || j.data === null || Array.isArray(j.data))) throw new HttpError(400, `jobs[${i}].data must be an object`);
  });
  const assets = body.assets ?? {};
  if (typeof assets !== 'object' || assets === null || Array.isArray(assets)) throw new HttpError(400, '"assets" must be an object');
  for (const [k, v] of Object.entries(assets)) if (typeof v !== 'string' || !v.startsWith('data:image/')) throw new HttpError(400, `assets.${k} must be an image data URL`);
  body.jobs.forEach((j, i) => {
    for (const [k, v] of Object.entries(j.data ?? {})) if (typeof v === 'string' && v.startsWith('asset:') && !(v.slice(6) in assets)) throw new HttpError(400, `jobs[${i}].data.${k} points at a missing asset`);
  });
  return {
    campaign: body.campaign.trim(), date: body.date ? String(body.date) : '',
    jobs: body.jobs.map((j) => ({ template: j.template, ratio: j.ratio, language: j.language, data: j.data ?? {} })),
    ...(Object.keys(assets).length ? { assets } : {}),
  };
}

const summary = (c) => ({
  id: c.id, name: c.payload.campaign, date: c.payload.date, createdAt: c.createdAt,
  languages: [...new Set(c.payload.jobs.map((j) => j.language))], frames: c.payload.jobs.length,
});

export function queueCampaign(body) {
  const payload = validate(body);
  const id = randomBytes(6).toString('hex');
  insertCampaign(id, payload.campaign, payload);
  return { id, ...summary(getCampaign(id)) };
}

export const pendingCampaigns = () => listCampaigns('pending').map(summary);

export function campaignPayload(id) {
  const c = getCampaign(id);
  if (!c) throw new HttpError(404, `Campaign "${id}" not found`);
  return { id: c.id, status: c.status, ...c.payload };
}

export function completeCampaign(id, pageUrl) {
  if (!finishCampaign(id, pageUrl)) throw new HttpError(404, `Campaign "${id}" not found`);
}

export function discardCampaign(id) {
  if (!deleteCampaign(id)) throw new HttpError(404, `Campaign "${id}" not found`);
}
