// Runtime configuration edited from the UI, persisted as JSON in DATA_DIR (mount a volume
// there to survive redeploys).
//
//   integration: a connection to a template source, with its credentials
//                (figma: access token, canva: OAuth client + tokens, static: built in)
//   project:     one set of templates reached through an integration (a Figma file, a Canva
//                template filter, ...). `source` is meaningful only to that integration.
//
// Built-in entries need no setup: the "static" integration/project (demo samples) and, when
// FIGMA_TOKEN / FIGMA_FILE_KEY are set, an "env" integration/project.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { isEmpty, readAll, writeAll } from './db.js';
import { HttpError } from './errors.js';

const DATA_DIR = process.env.DATA_DIR ?? path.resolve('data');
const LEGACY_FILE = path.join(DATA_DIR, 'config.json'); // storage before SQLite: imported once, then set aside
const SECRETS = ['token', 'clientSecret', 'tokens']; // never sent to the browser

// Brings state saved by older versions up to the current shape.
function normalize(saved) {
  const st = { integrations: [], projects: [], defaultProjectId: '', apiKeys: [], hidden: [], renames: {}, ...saved };
  if (saved.token && !saved.integrations?.length) { // very old: one token and a list of files
    st.integrations = [{ id: 'figma', name: 'Figma', type: 'figma', token: saved.token }];
    st.projects = (saved.files ?? []).map((f) => ({ id: f.fileKey, name: f.name, integrationId: 'figma', source: f.fileKey }));
    st.defaultProjectId = saved.defaultFileKey ?? '';
  }
  st.projects = st.projects.map(({ fileKey, ...p }) => (fileKey !== undefined ? { ...p, source: fileKey } : p)); // projects used to store `fileKey`
  return st;
}

let state;
if (isEmpty() && existsSync(LEGACY_FILE)) {
  try {
    state = normalize(JSON.parse(readFileSync(LEGACY_FILE, 'utf8')));
    writeAll(state);
    renameSync(LEGACY_FILE, `${LEGACY_FILE}.migrated`); // kept as a backup, never read again
    console.log('Imported config.json into creatives.db (the old file is kept as config.json.migrated)');
  } catch (e) {
    console.warn(`Could not import config.json: ${e.message}`);
  }
}
state ??= readAll();

function persist() {
  writeAll(state);
}

const STATIC_INTEGRATION = { id: 'static', name: 'Static samples', type: 'static', builtin: true };
const STATIC_PROJECT = { id: 'static', name: 'Static samples', integrationId: 'static', source: '', builtin: true };

// The environment's Figma token appears as an integration until the user edits or deletes it:
// editing saves a stored copy (same id), deleting hides it for good.
const envIntegration = () => (process.env.FIGMA_TOKEN && !state.hidden.includes('env') && !state.integrations.some((i) => i.id === 'env')
  ? { id: 'env', name: 'Environment (FIGMA_TOKEN)', type: 'figma', token: process.env.FIGMA_TOKEN, fromEnv: true } : null);
const envProject = () => (process.env.FIGMA_TOKEN && process.env.FIGMA_FILE_KEY && !state.hidden.includes('env') && !state.hidden.includes('env-project')
  ? { id: 'env', name: 'Default file (FIGMA_FILE_KEY)', integrationId: 'env', source: process.env.FIGMA_FILE_KEY, builtin: true } : null);

const allIntegrations = () => [...state.integrations, envIntegration(), STATIC_INTEGRATION].filter(Boolean);
// The generated projects keep their name in `renames`, since they aren't stored themselves.
const named = (p) => (p && state.renames[p.id] ? { ...p, name: state.renames[p.id] } : p);
const allProjects = () => [...state.projects, named(envProject()), state.hidden.includes('static') ? null : named(STATIC_PROJECT)].filter(Boolean);

export const getIntegration = (id) => allIntegrations().find((i) => i.id === id);
export const getProject = (id) => allProjects().find((p) => p.id === id);
export const findProjectBySource = (source) => allProjects().find((p) => p.source && p.source === source);
export const firstIntegrationOfType = (type) => allIntegrations().find((i) => i.type === type);

// Explicit default, else the env project, else the first linked project, else the demo samples.
// null when every project has been removed.
export function getDefaultProject() {
  return getProject(state.defaultProjectId) ?? envProject() ?? state.projects[0] ?? allProjects()[0] ?? null;
}

// What the browser may see: everything except secrets, plus hints about them.
export function publicConfig(describe = () => ({})) {
  return {
    defaultProjectId: getDefaultProject()?.id ?? '',
    samplesHidden: state.hidden.includes('static'),
    integrations: allIntegrations().map((i) => {
      const pub = Object.fromEntries(Object.entries(i).filter(([k]) => !SECRETS.includes(k)));
      return {
        ...pub,
        tokenHint: i.token ? `…${i.token.slice(-4)}` : '',
        connected: i.type === 'canva' ? Boolean(i.tokens?.access_token) : undefined,
        ...describe(i.type),
      };
    }),
    projects: allProjects(),
  };
}

const newId = () => randomUUID().slice(0, 8);
const clean = (v) => String(v ?? '').trim();

export function addIntegration({ name, type = 'figma', token, clientId, clientSecret }) {
  let integration;
  if (!clean(name)) throw new HttpError(400, 'A name is required');
  if (type === 'figma') {
    if (!clean(token)) throw new HttpError(400, 'An access token is required');
    integration = { id: newId(), name: clean(name), type, token: clean(token) };
  } else if (type === 'canva') {
    if (!clean(clientId)) throw new HttpError(400, 'A client ID is required');
    if (!clean(clientSecret)) throw new HttpError(400, 'A client secret is required');
    integration = { id: newId(), name: clean(name), type, clientId: clean(clientId), clientSecret: clean(clientSecret) };
  } else {
    throw new HttpError(400, `Unknown integration type "${type}"`);
  }
  state.integrations.push(integration);
  persist();
  return integration;
}

export function updateIntegration(id, { name, token, clientId, clientSecret }) {
  let i = state.integrations.find((x) => x.id === id);
  if (!i && id === 'env' && envIntegration()) { // first edit of the environment integration: keep a stored copy
    const { fromEnv, ...copy } = envIntegration();
    state.integrations.push(copy);
    i = copy;
  }
  if (!i) throw new HttpError(404, 'Integration not found (built-in integrations are read-only)');
  // Blank secrets mean "keep the current one"; the name and client ID can be changed but never emptied.
  if (typeof name === 'string' && !clean(name)) throw new HttpError(400, 'A name is required');
  if (i.type === 'canva' && typeof clientId === 'string' && !clean(clientId)) throw new HttpError(400, 'A client ID is required');
  if (typeof name === 'string') i.name = clean(name);
  if (i.type === 'figma' && clean(token)) i.token = clean(token);
  if (i.type === 'canva') {
    if (typeof clientId === 'string' && clean(clientId) !== i.clientId) { i.clientId = clean(clientId); delete i.tokens; } // new client: reconnect
    if (clean(clientSecret)) { i.clientSecret = clean(clientSecret); delete i.tokens; }
  }
  persist();
}

// OAuth integrations store rotating tokens here (Canva refresh tokens are single-use).
export function setIntegrationTokens(id, tokens) {
  const i = state.integrations.find((x) => x.id === id);
  if (!i) throw new HttpError(404, 'Integration not found');
  i.tokens = tokens;
  persist();
}

export function removeIntegration(id) {
  const stored = state.integrations.some((x) => x.id === id);
  const fromEnv = id === 'env' && Boolean(envIntegration());
  if (!stored && !fromEnv) throw new HttpError(404, 'Integration not found (built-in integrations are read-only)');
  if (id === 'env' && !state.hidden.includes('env')) state.hidden.push('env'); // the environment integration comes back only if un-hidden by hand
  // Projects can't outlive their integration: they go with it.
  state.projects = state.projects.filter((p) => p.integrationId !== id);
  if (!getProject(state.defaultProjectId)) state.defaultProjectId = '';
  state.integrations = state.integrations.filter((x) => x.id !== id);
  persist();
}

export function addProject({ name, integrationId, source }) {
  const project = { id: newId(), name, integrationId, source };
  state.projects.push(project);
  if (!state.defaultProjectId) state.defaultProjectId = project.id;
  persist();
  return project;
}

export function updateProject(id, { name }) {
  if (name !== undefined && !clean(name)) throw new HttpError(400, 'A name is required');
  const p = state.projects.find((x) => x.id === id);
  if (p) p.name = clean(name);
  else if (getProject(id)) state.renames[id] = clean(name); // generated project: remember the new name
  else throw new HttpError(404, 'Project not found');
  persist();
}

// Any project can be removed. Stored ones are deleted; the two generated ones (the environment file and the
// demo samples) are hidden instead, and the demo samples can be brought back.
export function removeProject(id) {
  if (state.projects.some((x) => x.id === id)) state.projects = state.projects.filter((x) => x.id !== id);
  else if (id === 'env' && envProject()) state.hidden.push('env-project');
  else if (id === 'static' && !state.hidden.includes('static')) state.hidden.push('static');
  else throw new HttpError(404, 'Project not found');
  if (state.defaultProjectId === id) state.defaultProjectId = '';
  delete state.renames[id];
  persist();
}

export function restoreSamples() {
  state.hidden = state.hidden.filter((h) => h !== 'static');
  persist();
}

export function setDefaultProject(id) {
  if (!getProject(id)) throw new HttpError(404, 'Project not found');
  state.defaultProjectId = id;
  persist();
}

// ---------- API keys ----------
// Named keys issued from the UI. Only a SHA-256 hash is stored, so a key can be shown once, at creation.
const hashKey = (raw) => createHash('sha256').update(raw).digest('hex');

export function createApiKey(name) {
  const label = String(name ?? '').trim();
  if (!label) throw new HttpError(400, 'A name is required, so you can tell the keys apart later');
  const raw = `fr_${randomBytes(24).toString('base64url')}`;
  const record = { id: newId(), name: label, hash: hashKey(raw), hint: raw.slice(-4), createdAt: new Date().toISOString(), lastUsedAt: null };
  state.apiKeys.push(record);
  persist();
  return { key: raw, record };
}

let lastPersist = 0;
export function verifyApiKey(raw) {
  if (!raw) return false;
  const h = hashKey(raw);
  const record = state.apiKeys.find((k) => k.hash === h); // hashes of high-entropy keys: no timing oracle worth worrying about
  if (!record) return false;
  record.lastUsedAt = new Date().toISOString();
  if (Date.now() - lastPersist > 60_000) { lastPersist = Date.now(); persist(); }
  return true;
}

export const listApiKeys = () => state.apiKeys.map(({ hash, ...k }) => k);

export function revokeApiKey(id) {
  if (!state.apiKeys.some((k) => k.id === id)) throw new HttpError(404, 'API key not found');
  state.apiKeys = state.apiKeys.filter((k) => k.id !== id);
  persist();
}
