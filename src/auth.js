// Sign-in for the web UI through any OpenID Connect provider (Auth0, Google, Clerk, Okta...).
// Authorization-code flow with PKCE; the session is a signed, HTTP-only cookie.
// Machine clients (n8n) don't use this: they send an API key issued in Settings.
//
//   OIDC_ISSUER         e.g. https://your-tenant.eu.auth0.com/ or a Clerk Frontend API URL
//   OIDC_CLIENT_ID / OIDC_CLIENT_SECRET
//   ALLOWED_EMAILS      optional: comma-separated emails (or @domain.com entries); unset = any verified user of the provider
//   PUBLIC_URL          optional, e.g. https://figma-creatives.example.com (else derived from the request)
//   AUTH_DISABLED=true  skip sign-in entirely (local use only)
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getSetting, setSetting } from './db.js';
import { HttpError } from './errors.js';

const env = process.env;
const DATA_DIR = env.DATA_DIR ?? path.resolve('data');
const SESSION_DAYS = 7;

export const authDisabled = () => env.AUTH_DISABLED === 'true';
const oidcConfigured = () => Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET);
const allowed = () => (env.ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const isAllowed = (email) => !allowed().length || allowed().some((a) => (a.startsWith('@') ? email.endsWith(a) : email === a));

// Random secret kept in the database, so no env var is needed for cookie signing. An older
// session-secret file is adopted once, so existing sessions survive the move to SQLite.
let secret;
function sessionSecret() {
  if (secret) return secret;
  secret = getSetting('session_secret');
  if (!secret) {
    const legacy = path.join(DATA_DIR, 'session-secret');
    try { secret = readFileSync(legacy, 'utf8').trim(); } catch { /* none */ }
    secret ||= randomBytes(32).toString('hex');
    setSetting('session_secret', secret);
  }
  return secret;
}

export const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const sign = (payload) => `${payload}.${createHmac('sha256', sessionSecret()).update(payload).digest('base64url')}`;
export function unsign(value) {
  const i = value?.lastIndexOf('.') ?? -1;
  if (i < 1) return null;
  const payload = value.slice(0, i);
  const want = createHmac('sha256', sessionSecret()).update(payload).digest();
  const got = Buffer.from(value.slice(i + 1), 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

export const cookies = (req) => Object.fromEntries((req.get('cookie') ?? '').split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k));
const secureCookie = (req) => req.protocol === 'https';
export function setCookie(res, req, name, value, maxAgeSec) {
  res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${secureCookie(req) ? '; Secure' : ''}; Max-Age=${maxAgeSec}`);
}

export const sessionUser = (req) => (authDisabled() ? { email: 'local', name: 'Local (auth disabled)' } : unsign(cookies(req).session));

// ---------- OIDC ----------
let discovery;
async function getDiscovery() {
  if (!discovery) {
    const issuer = env.OIDC_ISSUER.replace(/\/?$/, '/');
    const res = await fetch(`${issuer}.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new HttpError(502, `OIDC discovery failed (${res.status})`);
    const doc = await res.json();
    discovery = { doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri)) };
  }
  return discovery;
}
export const publicBase = (req) => (env.PUBLIC_URL ?? `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const redirectUri = (req) => `${(env.PUBLIC_URL ?? `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/auth/callback`;

export function authRoutes(app) {
  app.get('/auth/me', (req, res) => {
    const user = sessionUser(req);
    if (user) return res.json({ email: user.email, name: user.name, authDisabled: authDisabled() });
    res.status(401).json({ error: 'Not signed in', configured: oidcConfigured() });
  });

  app.get('/auth/login', async (req, res, next) => {
    try {
      if (!oidcConfigured()) throw new HttpError(503, 'Sign-in is not configured. Set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET.');
      const { doc } = await getDiscovery();
      const state = randomBytes(16).toString('base64url');
      const nonce = randomBytes(16).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      setCookie(res, req, 'oidc', sign(b64({ state, nonce, verifier, exp: Date.now() + 10 * 60_000 })), 600);
      const url = new URL(doc.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code', client_id: env.OIDC_CLIENT_ID, redirect_uri: redirectUri(req), scope: 'openid email profile',
        state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      }).toString();
      res.redirect(url.toString());
    } catch (e) { next(e); }
  });

  app.get('/auth/callback', async (req, res, next) => {
    try {
      const txn = unsign(cookies(req).oidc);
      if (!txn || req.query.state !== txn.state) throw new HttpError(400, 'Sign-in session expired. Try again.');
      if (req.query.error) throw new HttpError(401, `Sign-in failed: ${req.query.error_description ?? req.query.error}`);
      const { doc, jwks } = await getDiscovery();
      // HTTP Basic is the standard way to authenticate at the token endpoint (Clerk requires it); the
      // secret goes in the body only for providers that list nothing but client_secret_post.
      const methods = doc.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
      const basic = env.OIDC_TOKEN_AUTH === 'basic' || (env.OIDC_TOKEN_AUTH !== 'post' && (methods.includes('client_secret_basic') || !methods.includes('client_secret_post')));
      const form = { grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri(req), client_id: env.OIDC_CLIENT_ID, code_verifier: txn.verifier };
      if (!basic) form.client_secret = env.OIDC_CLIENT_SECRET;
      const tokenRes = await fetch(doc.token_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(basic ? { Authorization: `Basic ${Buffer.from(`${encodeURIComponent(env.OIDC_CLIENT_ID)}:${encodeURIComponent(env.OIDC_CLIENT_SECRET)}`).toString('base64')}` } : {}),
        },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(10000),
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok || !tokens.id_token) throw new HttpError(401, `Token exchange failed: ${tokens.error_description ?? tokens.error ?? tokenRes.status}`);
      const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: doc.issuer, audience: env.OIDC_CLIENT_ID });
      if (payload.nonce !== txn.nonce) throw new HttpError(401, 'Invalid sign-in response (nonce mismatch)');
      // Some providers (Clerk) leave the email out of the ID token: ask the user-info endpoint, and check it is the same person.
      let claims = payload;
      if (!payload.email && doc.userinfo_endpoint && tokens.access_token) {
        const ui = await fetch(doc.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10000) });
        const info = ui.ok ? await ui.json() : {};
        if (info.sub && info.sub === payload.sub) claims = { ...payload, ...info };
      }
      const email = String(claims.email ?? '').toLowerCase();
      if (!email || claims.email_verified === false) throw new HttpError(403, 'Your account has no verified email address.');
      if (!isAllowed(email)) throw new HttpError(403, `${email} is not allowed to use this app. Add it to ALLOWED_EMAILS.`);
      setCookie(res, req, 'session', sign(b64({ email, name: claims.name ?? email, exp: Date.now() + SESSION_DAYS * 86_400_000 })), SESSION_DAYS * 86400);
      setCookie(res, req, 'oidc', '', 0);
      res.redirect('/');
    } catch (e) { next(e); }
  });

  app.get('/auth/logout', (req, res) => {
    setCookie(res, req, 'session', '', 0);
    res.redirect('/');
  });
}

// Admin routes: a signed-in user only. Non-GET requests must come from this site (CSRF defence on top of SameSite=Lax).
export function requireSession(req, _res, next) {
  const user = sessionUser(req);
  if (!user) return next(new HttpError(401, 'Sign in required'));
  const origin = req.get('origin');
  if (!['GET', 'HEAD'].includes(req.method) && origin && new URL(origin).host !== req.get('host')) {
    return next(new HttpError(403, 'Cross-site request blocked'));
  }
  req.user = user;
  next();
}

export function warnAuth() {
  if (authDisabled()) console.warn('AUTH_DISABLED=true: the web UI and settings are open to anyone who can reach this server.');
  else if (!oidcConfigured()) console.warn('Sign-in is not configured (OIDC_*): the web UI is locked until it is. See README.');
  else if (!allowed().length) console.warn('ALLOWED_EMAILS is not set: anyone who can sign in with your provider can use this app. Restrict sign-ups there.');
}
