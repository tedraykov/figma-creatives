// The campaign inbox: n8n queues a payload, the Figma plugin lists, fetches and completes it.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, PORT: '3994', DATA_DIR: mkdtempSync(join(tmpdir(), 'campaigns-')), STATIC_DIR: join(here, '..', 'samples'), GOOGLE_FONTS: 'false', AUTH_DISABLED: 'true' };
delete env.FIGMA_TOKEN;
const child = spawn(process.execPath, [join(here, '..', 'src', 'server.js')], { env, stdio: 'ignore' });
const stop = (code) => { child.kill(); process.exit(code); };
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); stop(1); } console.log('ok -', msg); };

const base = 'http://localhost:3994';
for (let i = 0; i < 50; i++) { if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 100)); }
const call = (path, opts = {}) => fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers } });
const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) });

const payload = {
  campaign: 'autumn-sale', date: '2026-10-05',
  jobs: [
    { template: 'H', ratio: 'Desktop', language: 'en', data: { headline: 'Autumn sale', cta: 'Shop **now**', note: '' } },
    { template: 'H', ratio: 'Desktop', language: 'de', data: { headline: 'Herbstangebot' } },
  ],
};

assert((await post('/campaigns', { campaign: 'x' })).status === 400, 'a payload without jobs is rejected');
assert((await post('/campaigns', { campaign: 'x', jobs: [{ template: 'H', ratio: 'Desktop' }] })).status === 400, 'a job needs a language');
assert((await post('/campaigns', { campaign: 'x', jobs: [{ template: 'H', ratio: 'Desktop', language: 'en', data: [] }] })).status === 400, 'job data must be an object');

const queued = await post('/campaigns', payload);
const made = await queued.json();
assert(queued.status === 201 && made.id && made.frames === 2 && made.languages.join() === 'en,de', 'a campaign is queued with a summary');

const list = await (await call('/campaigns')).json();
assert(list.campaigns.length === 1 && list.campaigns[0].name === 'autumn-sale' && !('jobs' in list.campaigns[0]), 'pending campaigns are listed as summaries');

const full = await (await call(`/campaigns/${made.id}`)).json();
assert(full.jobs.length === 2 && full.jobs[0].data.note === '' && full.jobs[1].data.cta === undefined, 'the payload comes back as queued, including empty (hide) values');

const preflight = await call('/campaigns', { method: 'OPTIONS' });
assert(preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === '*', 'the plugin iframe can call it (CORS preflight)');

assert((await post(`/campaigns/${made.id}/done`, { pageUrl: 'https://www.figma.com/design/KEY?node-id=1-2' })).status === 200, 'a campaign can be marked done');
assert((await (await call('/campaigns')).json()).campaigns.length === 0, 'done campaigns leave the inbox');
assert((await call('/campaigns/nope')).status === 404 && (await post('/campaigns/nope/done', {})).status === 404, 'unknown campaigns are 404');

const second = await (await post('/campaigns', payload)).json();
assert((await call(`/campaigns/${second.id}`, { method: 'DELETE' })).status === 200 && (await call(`/campaigns/${second.id}`)).status === 404, 'a campaign can be discarded');
stop(0);
