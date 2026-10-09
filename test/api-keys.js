// Access control without sign-in configured: the API needs a generated key, admin routes stay locked.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, PORT: '3996', DATA_DIR: mkdtempSync(join(tmpdir(), 'keys-')), STATIC_DIR: join(here, '..', 'samples'), GOOGLE_FONTS: 'false' };
for (const k of ['AUTH_DISABLED', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'FIGMA_TOKEN', 'FIGMA_FILE_KEY']) delete env[k];
const child = spawn(process.execPath, [join(here, '..', 'src', 'server.js')], { env, stdio: 'ignore' });
const stop = (code) => { child.kill(); process.exit(code); };
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); stop(1); } console.log('ok -', msg); };

const base = 'http://localhost:3996';
for (let i = 0; i < 50; i++) { if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 100)); }
const call = (path, key, opts = {}) => fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) } });

assert((await call('/templates')).status === 401, 'the render API is closed without a key');
assert((await call('/api-keys')).status === 401, 'settings are locked without a signed-in session');
assert((await call('/api-keys', null, { method: 'POST', body: '{"name":"x"}' })).status === 401, 'keys cannot be created without a session');
assert((await call('/auth/me')).status === 401, 'not signed in by default');
assert((await call('/auth/login')).status === 503, 'sign-in reports it is not configured');

// Keys are issued from Settings (an authenticated session); here the server runs with auth disabled to do that.
child.kill();
const env2 = { ...env, AUTH_DISABLED: 'true', PORT: '3996' };
const child2 = spawn(process.execPath, [join(here, '..', 'src', 'server.js')], { env: env2, stdio: 'ignore' });
for (let i = 0; i < 50; i++) { if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 100)); }
const unnamed = await call('/api-keys', null, { method: 'POST', body: JSON.stringify({ name: '   ' }) });
assert(unnamed.status === 400, 'a key needs a name');
const make = async (name) => (await call('/api-keys', null, { method: 'POST', body: JSON.stringify({ name }) })).json();
const a = await make('n8n production');
const b = await make('n8n staging');
assert(a.key.startsWith('fr_') && a.key !== b.key && b.keys.length === 2, 'multiple named keys can be generated');
assert(!JSON.stringify((await (await call('/api-keys')).json())).includes(a.key), 'listing never exposes key material');
child2.kill();

// Back with auth enabled: the keys (persisted as hashes) grant API access, but not admin access.
const child3 = spawn(process.execPath, [join(here, '..', 'src', 'server.js')], { env, stdio: 'ignore' });
for (let i = 0; i < 50; i++) { if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 100)); }
assert((await call('/templates', a.key)).status === 200, 'a generated key opens the render API');
assert((await call('/templates', b.key)).status === 200, 'a second key works too');
const listed = await (await call('/projects', a.key)).json();
assert(listed.projects?.length >= 1 && listed.projects.some((p) => p.default) && !JSON.stringify(listed).includes('source'), 'an API key can list projects (id, name, default) without sources');
assert((await call('/projects')).status === 401, 'the project list needs a key or session');
assert((await call('/api-keys', a.key)).status === 401, 'an API key cannot reach admin settings');
assert((await call('/templates', 'fr_wrong')).status === 401, 'an unknown key is rejected');
child3.kill();
process.exit(0);
