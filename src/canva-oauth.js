// "Connect with Canva": OAuth 2.0 authorization code + PKCE for a Canva integration. Admin only
// (a signed-in session). The resulting tokens are stored on the integration and refreshed by canva.js.
import { createHash, randomBytes } from 'node:crypto';
import { b64, cookies, publicBase, setCookie, sign, unsign } from './auth.js';
import { getIntegration, setIntegrationTokens } from './config.js';
import { HttpError } from './errors.js';
import { clearAllCaches } from './integrations/index.js';
import { CANVA_AUTHORIZE_URL, CANVA_SCOPES, canvaTokenRequest } from './integrations/canva.js';

export const canvaRedirectUri = (req) => `${publicBase(req)}/integrations/canva/callback`;

export function canvaOAuthRoutes(app, requireSession) {
  app.get('/integrations/:id/connect', requireSession, (req, res, next) => {
    try {
      const integration = getIntegration(req.params.id);
      if (integration?.type !== 'canva') throw new HttpError(404, 'Not a Canva integration');
      const state = randomBytes(16).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      setCookie(res, req, 'canva_oauth', sign(b64({ state, verifier, id: integration.id, exp: Date.now() + 10 * 60_000 })), 600);
      const url = new URL(CANVA_AUTHORIZE_URL);
      url.search = new URLSearchParams({
        response_type: 'code', client_id: integration.clientId, redirect_uri: canvaRedirectUri(req), scope: CANVA_SCOPES, state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 's256',
      }).toString();
      res.redirect(url.toString());
    } catch (e) { next(e); }
  });

  app.get('/integrations/canva/callback', requireSession, async (req, res, next) => {
    try {
      const txn = unsign(cookies(req).canva_oauth);
      if (!txn || req.query.state !== txn.state) throw new HttpError(400, 'Canva sign-in expired. Try connecting again.');
      if (req.query.error) throw new HttpError(400, `Canva refused the connection: ${req.query.error_description ?? req.query.error}`);
      const integration = getIntegration(txn.id);
      if (integration?.type !== 'canva') throw new HttpError(404, 'Integration not found');
      const tokens = await canvaTokenRequest(integration, {
        grant_type: 'authorization_code', code: String(req.query.code), code_verifier: txn.verifier, redirect_uri: canvaRedirectUri(req),
      });
      setIntegrationTokens(integration.id, tokens);
      setCookie(res, req, 'canva_oauth', '', 0);
      clearAllCaches();
      res.redirect('/?connected=canva');
    } catch (e) { next(e); }
  });
}
