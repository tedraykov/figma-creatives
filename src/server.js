import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRoutes, requireSession, warnAuth } from './auth.js';
import { canvaOAuthRoutes } from './canva-oauth.js';
import { campaignPayload, completeCampaign, discardCampaign, pendingCampaigns, queueCampaign } from './campaigns.js';
import {
  addIntegration, addProject, createApiKey, findProjectBySource, firstIntegrationOfType, getDefaultProject, getIntegration,
  getProject, listApiKeys, publicConfig, removeIntegration, removeProject, restoreSamples, revokeApiKey, setDefaultProject,
  updateIntegration, updateProject, verifyApiKey,
} from './config.js';
import { HttpError } from './errors.js';
import { clearAllCaches, describeType, integrationFor } from './integrations/index.js';
import { closeBrowser } from './render.js';

const PORT = Number(process.env.PORT ?? 3000);
const FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp']);

const app = express();
app.set('trust proxy', true); // behind Traefik/Dokploy: req.protocol and secure cookies follow X-Forwarded-Proto
app.use(express.json({ limit: '50mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// The UI shell is public; every API call it makes carries the API key.
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

// Two kinds of caller. The web UI signs in through OIDC (session cookie) and may use everything.
// Machine clients (n8n) send an API key issued in Settings and may only render.
authRoutes(app);
canvaOAuthRoutes(app, requireSession);
const apiKeyOrSession = (req, _res, next) => {
  const presented = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '') || req.get('x-api-key') || '';
  if (presented && verifyApiKey(presented)) return next();
  requireSession(req, _res, next);
};
// The Figma plugin runs in a sandboxed iframe (Origin: null) and authenticates with a key header, not cookies,
// so it may call /campaigns from anywhere. Answered before auth so preflights get through.
app.use('/campaigns', (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-api-key',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
for (const route of ['/templates', '/render', '/cache', '/campaigns']) app.use(route, apiKeyOrSession);
// Read-only project list for machine clients (n8n picks a project, then passes its id as projectId).
// Sources and credentials stay out of it.
app.get('/projects', apiKeyOrSession, (_req, res) => {
  const fallback = getDefaultProject()?.id;
  const projects = publicConfig(describeType).projects.map((p) => ({
    id: p.id, name: p.name, integration: getIntegration(p.integrationId)?.type, default: p.id === fallback,
  }));
  res.json({ projects });
});
for (const route of ['/config', '/integrations', '/projects', '/api-keys']) app.use(route, requireSession);

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

// Which project a request targets: projectId, else a legacy fileKey/source, else the default project.
function projectFrom(req) {
  const id = req.body?.projectId ?? req.query.projectId;
  if (id) {
    const project = getProject(id);
    if (!project) throw new HttpError(404, `Project "${id}" not found`);
    return project;
  }
  const source = req.body?.source ?? req.query.source ?? req.body?.fileKey ?? req.query.fileKey;
  if (source) {
    // Older clients (the n8n workflow) pass a raw Figma file key: use its project, or the first Figma integration.
    const known = findProjectBySource(source);
    if (known) return known;
    const integration = firstIntegrationOfType('figma');
    if (!integration) throw new HttpError(400, 'No Figma integration is configured');
    return { id: 'adhoc', name: source, integrationId: integration.id, source };
  }
  const project = getDefaultProject();
  if (!project) throw new HttpError(404, 'No project is linked yet. Link one in the app first.');
  return project;
}

// API keys: named, issued here, shown once. Only hashes are stored.
app.get('/api-keys', (_req, res) => res.json({ keys: listApiKeys() }));
app.post('/api-keys', (req, res) => {
  const { key, record } = createApiKey(req.body?.name);
  res.json({ key, created: record.id, keys: listApiKeys() });
});
app.delete('/api-keys/:id', (req, res) => {
  revokeApiKey(req.params.id);
  res.json({ keys: listApiKeys() });
});

// Settings. Tokens are write-only: they are never returned, only their last 4 characters.
app.get('/config', (_req, res) => res.json(publicConfig(describeType)));

const saved = (res) => { clearAllCaches(); res.json(publicConfig(describeType)); };

app.post('/integrations', (req, res) => {
  addIntegration(req.body ?? {});
  saved(res);
});
app.put('/integrations/:id', (req, res) => {
  updateIntegration(req.params.id, req.body ?? {});
  saved(res);
});
app.delete('/integrations/:id', (req, res) => {
  removeIntegration(req.params.id);
  saved(res);
});

// Links a project. The integration parses the link and checks access before anything is saved.
app.post('/projects', wrap(async (req, res) => {
  const { link, integrationId, name } = req.body ?? {};
  const config = getIntegration(integrationId);
  if (!config || config.type === 'static') throw new HttpError(400, 'Choose an integration');
  const integration = integrationFor(config.id);
  const source = integration.parseSource(link);
  const info = await integration.check(source);
  addProject({ name: String(name ?? '').trim() || info.name, integrationId: config.id, source });
  saved(res);
}));
app.post('/projects/restore-samples', (_req, res) => {
  restoreSamples();
  saved(res);
});
app.put('/projects/:id', (req, res) => {
  if (req.body?.name !== undefined) updateProject(req.params.id, { name: req.body.name });
  if (req.body?.default) setDefaultProject(req.params.id);
  saved(res);
});
app.delete('/projects/:id', (req, res) => {
  removeProject(req.params.id);
  saved(res);
});

// Lists the project's templates, ratios, sizes and dynamic fields.
app.get('/templates', wrap(async (req, res) => {
  const project = projectFrom(req);
  const integration = integrationFor(project.integrationId);
  const index = await integration.listTemplates(project.source);
  res.json({ integration: integration.type, livePreview: integration.livePreview, project: project.id, file: index.name, version: index.version, templates: index.templates });
}));

// Renders one template/ratio with the given data. Returns the image as binary.
app.post('/render', wrap(async (req, res) => {
  const { template, ratio, data = {}, format = 'png', scale = 1, quality = 90, output } = req.body ?? {};
  if (!template || !ratio) throw new HttpError(400, 'Body must include "template" and "ratio"');
  if (!FORMATS.has(format)) throw new HttpError(400, `format must be one of ${[...FORMATS].join(', ')}`);
  const s = Number(scale);
  if (!(s > 0 && s <= 4)) throw new HttpError(400, 'scale must be between 0 and 4');

  const project = projectFrom(req);
  const integration = integrationFor(project.integrationId);
  const request = { template, ratio, data, format, scale: s, quality };

  if (output === 'html' || output === 'preview') {
    if (!integration.html) throw new HttpError(501, `${integration.label} has no live preview. Render an image instead.`);
    const { html, width, height } = await integration.html(project.source, request, { preview: output === 'preview' });
    res.set({ 'X-Render-Width': String(Math.round(width)), 'X-Render-Height': String(Math.round(height)) });
    res.type('html').send(html);
    return;
  }

  const { image, contentType, width, height, report } = await integration.render(project.source, request);
  res.set({
    'Content-Type': contentType,
    'Content-Disposition': `inline; filename="${template}_${ratio}.${format === 'jpeg' ? 'jpg' : format}"`,
    'X-Render-Width': String(width),
    'X-Render-Height': String(height),
    'X-Render-Report': JSON.stringify(report),
  });
  res.send(image);
}));

// Campaigns: n8n queues one per run, the Figma plugin lists the pending ones, builds the page and marks it done.
app.post('/campaigns', (req, res) => res.status(201).json(queueCampaign(req.body)));
app.get('/campaigns', (_req, res) => res.json({ campaigns: pendingCampaigns() }));
app.get('/campaigns/:id', (req, res) => res.json(campaignPayload(req.params.id)));
app.post('/campaigns/:id/done', (req, res) => { completeCampaign(req.params.id, req.body?.pageUrl); res.json({ ok: true }); });
app.delete('/campaigns/:id', (req, res) => { discardCampaign(req.params.id); res.json({ ok: true }); });

app.post('/cache/clear', (_req, res) => res.json({ cleared: clearAllCaches() }));

app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

const server = app.listen(PORT, () => {
  console.log(`Creatives listening on :${PORT}`);
  warnAuth();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await closeBrowser();
    process.exit(0);
  });
}
