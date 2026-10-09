// Sign-in end to end against a fake OpenID Connect provider (discovery, authorize, token, JWKS).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

const here = dirname(fileURLToPath(import.meta.url));
const IDP = 'http://localhost:3995', APP = 'http://localhost:3994';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

// The fake provider signs in whichever email the test sets in `nextEmail`.
let nextEmail = 'me@example.com';
const codes = new Map();
const idp = createServer(async (req, res) => {
  const url = new URL(req.url, IDP);
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (url.pathname === '/.well-known/openid-configuration') return json({ issuer: `${IDP}/`, authorization_endpoint: `${IDP}/authorize`, token_endpoint: `${IDP}/token`, userinfo_endpoint: `${IDP}/userinfo`, token_endpoint_auth_methods_supported: ['client_secret_basic'], jwks_uri: `${IDP}/jwks` });
  if (url.pathname === '/jwks') return json({ keys: [jwk] });
  if (url.pathname === '/authorize') {
    const p = url.searchParams, code = `code-${codes.size}`;
    codes.set(code, { nonce: p.get('nonce'), challenge: p.get('code_challenge'), email: nextEmail });
    res.statusCode = 302; res.setHeader('location', `${p.get('redirect_uri')}?code=${code}&state=${p.get('state')}`); return res.end();
  }
  if (url.pathname === '/token') {
    const form = new URLSearchParams(await new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)); }));
    const c = codes.get(form.get('code'));
    // Like Clerk: the client authenticates with HTTP Basic, and a secret in the body is not accepted.
    const basic = req.headers.authorization === `Basic ${Buffer.from('client-1:shh').toString('base64')}`;
    if (!c || !basic || form.has('client_secret') || createHash('sha256').update(form.get('code_verifier')).digest('base64url') !== c.challenge) { res.statusCode = 400; return json({ error: 'invalid_grant' }); }
    // ...and the ID token carries no email: it is only available from the user-info endpoint.
    const id_token = await new SignJWT({ nonce: c.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject(`user-${c.email}`).setIssuer(`${IDP}/`).setAudience('client-1').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    return json({ id_token, access_token: `at-${c.email}`, token_type: 'Bearer' });
  }
  if (url.pathname === '/userinfo') {
    const email = String(req.headers.authorization ?? '').replace('Bearer at-', '');
    return json({ sub: `user-${email}`, email, email_verified: true, name: 'Test User' });
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => idp.listen(3995, r));

const env = { ...process.env, PORT: '3994', DATA_DIR: mkdtempSync(join(tmpdir(), 'oidc-')), STATIC_DIR: join(here, '..', 'samples'), GOOGLE_FONTS: 'false',
  OIDC_ISSUER: `${IDP}/`, OIDC_CLIENT_ID: 'client-1', OIDC_CLIENT_SECRET: 'shh', ALLOWED_EMAILS: 'me@example.com, @corp.test' };
for (const k of ['AUTH_DISABLED', 'FIGMA_TOKEN', 'FIGMA_FILE_KEY']) delete env[k];
const child = spawn(process.execPath, [join(here, '..', 'src', 'server.js')], { env, stdio: 'ignore' });
const stop = (code) => { child.kill(); idp.close(); process.exit(code); };
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); stop(1); } console.log('ok -', msg); };
for (let i = 0; i < 50; i++) { if (await fetch(`${APP}/health`).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 100)); }

// Walks login -> IdP -> callback, carrying cookies by hand. Returns the callback response and the session cookie.
async function signIn(email) {
  nextEmail = email;
  const login = await fetch(`${APP}/auth/login`, { redirect: 'manual' });
  const oidc = login.headers.getSetCookie().find((c) => c.startsWith('oidc=')).split(';')[0];
  const authorize = await fetch(login.headers.get('location'), { redirect: 'manual' });
  const cb = await fetch(authorize.headers.get('location'), { redirect: 'manual', headers: { cookie: oidc } });
  const session = cb.headers.getSetCookie().find((c) => c.startsWith('session=') && !c.includes('Max-Age=0'))?.split(';')[0];
  return { cb, session };
}
const asUser = (path, cookie, opts = {}) => fetch(APP + path, { ...opts, headers: { 'Content-Type': 'application/json', cookie, ...(opts.headers ?? {}) } });

assert((await fetch(`${APP}/config`)).status === 401, 'settings are locked before sign-in');

const ok = await signIn('Me@Example.com');
assert(ok.cb.status === 302 && ok.session, 'an allowed email signs in and gets a session cookie');
assert((await asUser('/auth/me', ok.session).then((r) => r.json())).email === 'me@example.com', 'the session identifies the user');
assert((await asUser('/config', ok.session)).status === 200, 'the session opens settings');
assert((await asUser('/config', `${ok.session}x`)).status === 401, 'a tampered session is rejected');
assert((await asUser('/api-keys', ok.session, { method: 'POST', body: '{"name":"x"}', headers: { origin: 'https://evil.test' } })).status === 403, 'cross-site writes are blocked');

assert((await signIn('someone@corp.test')).session, 'a whole allowed domain can sign in');
const denied = await signIn('stranger@example.org');
assert(denied.cb.status === 403 && !denied.session, 'an email outside the allow-list is refused');

const made = await asUser('/api-keys', ok.session, { method: 'POST', body: '{"name":"n8n"}' }).then((r) => r.json());
assert((await fetch(`${APP}/templates`, { headers: { Authorization: `Bearer ${made.key}` } })).status === 200, 'a key generated while signed in works for the API');
assert((await asUser(`/api-keys/${made.created}`, ok.session, { method: 'DELETE' })).status === 200, 'a key can be revoked while signed in');
assert((await fetch(`${APP}/templates`, { headers: { Authorization: `Bearer ${made.key}` } })).status === 401, 'a revoked key stops working');
stop(0);
