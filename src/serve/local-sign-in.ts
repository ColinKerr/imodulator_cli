import { createHash, randomBytes } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { platformCors, type PlatformCorsOptions } from "./platform-cors";

/**
 * A local OpenID Connect sign-in that needs no account.
 *
 * It answers the authorization code flow with PKCE the way a browser sign-in client
 * (`oidc-client-ts`, under `@itwin/browser-authorization`) drives it, so a web app that
 * signs in to the iTwin Platform can be pointed here instead. Every sign-in succeeds at once,
 * silent ones (`prompt=none`) included, as one local user.
 *
 * The tokens carry no signature (`alg: none`) and grant nothing: they exist so the app has
 * one to send. Nothing here or in the RPC routes checks them; what keeps this local is that
 * the server listens on 127.0.0.1 only, and it sends a sign-in back only to an address on
 * this machine or to the configured app origin.
 */
export function localSignIn(options: PlatformCorsOptions): Router {
  const router = express.Router();
  router.use(platformCors(options));
  router.use(express.urlencoded({ extended: false }));

  /** Codes issued and not yet exchanged. */
  const codes = new Map<string, IssuedCode>();

  router.get("/.well-known/openid-configuration", (req, res) => {
    const issuer = issuerOf(req);
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/connect/authorize`,
      token_endpoint: `${issuer}/connect/token`,
      end_session_endpoint: `${issuer}/connect/endsession`,
      userinfo_endpoint: `${issuer}/connect/userinfo`,
      jwks_uri: `${issuer}/.well-known/openid-configuration/jwks`,
      response_types_supported: ["code"],
      response_modes_supported: ["query", "fragment"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["none"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["openid", "profile", "email", "itwin-platform"],
    });
  });

  // The tokens are unsigned, so there are no keys to publish.
  router.get("/.well-known/openid-configuration/jwks", (_req, res) => res.json({ keys: [] }));

  router.get("/connect/authorize", (req, res) => {
    const redirectUri = queryString(req, "redirect_uri");
    const clientId = queryString(req, "client_id");
    if (!redirectUri || !clientId)
      return page(res, 400, "The sign-in request names no client_id or redirect_uri.");
    if (!isAllowedRedirect(redirectUri, options.appOrigin))
      return page(res, 400, `A sign-in is sent back only to this machine${options.appOrigin ? ` or ${options.appOrigin}` : ""}, not to ${redirectUri}.`);

    const back = new URL(redirectUri);
    const params = new URLSearchParams();
    const state = queryString(req, "state");
    if (state !== undefined)
      params.set("state", state);
    if (queryString(req, "response_type") !== "code") {
      params.set("error", "unsupported_response_type");
    } else {
      // Codes a client never came back for are dropped as new ones are issued.
      for (const [old, issued] of codes) {
        if (issued.expiresAt < Date.now())
          codes.delete(old);
      }
      const code = randomBytes(24).toString("base64url");
      codes.set(code, {
        clientId,
        redirectUri,
        codeChallenge: queryString(req, "code_challenge"),
        codeChallengeMethod: queryString(req, "code_challenge_method") ?? "plain",
        nonce: queryString(req, "nonce"),
        scope: queryString(req, "scope") ?? "",
        expiresAt: Date.now() + CODE_LIFETIME_MS,
      });
      params.set("code", code);
    }
    // The client asked for the answer in the fragment or, by default, the query.
    if (queryString(req, "response_mode") === "fragment")
      back.hash = params.toString();
    else
      params.forEach((value, name) => back.searchParams.set(name, value));
    res.redirect(302, back.toString());
  });

  router.post("/connect/token", (req, res) => {
    const form = (req.body ?? {}) as Record<string, string | undefined>;
    if (form.grant_type !== "authorization_code")
      return tokenError(res, "unsupported_grant_type", "Only the authorization code grant is supported.");
    const code = form.code ?? "";
    const issued = codes.get(code);
    // A code is used once, as at any real sign-in.
    codes.delete(code);
    if (!issued || issued.expiresAt < Date.now())
      return tokenError(res, "invalid_grant", "The code is unknown, used or expired.");
    if (form.client_id !== issued.clientId || form.redirect_uri !== issued.redirectUri)
      return tokenError(res, "invalid_grant", "The client_id or redirect_uri differs from the sign-in request's.");
    if (issued.codeChallenge !== undefined && !verifierMatches(form.code_verifier, issued.codeChallenge, issued.codeChallengeMethod))
      return tokenError(res, "invalid_grant", "The code_verifier does not match the code_challenge.");

    const issuer = issuerOf(req);
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: issuer, sub: LOCAL_USER.sub, iat: now, nbf: now, exp: now + TOKEN_LIFETIME_S };
    res.json({
      access_token: unsignedJwt({ ...claims, aud: "itwin-platform", client_id: issued.clientId, scope: issued.scope }),
      token_type: "Bearer",
      expires_in: TOKEN_LIFETIME_S,
      scope: issued.scope,
      id_token: unsignedJwt({ ...claims, aud: issued.clientId, ...(issued.nonce ? { nonce: issued.nonce } : {}), name: LOCAL_USER.name }),
    });
  });

  router.get("/connect/userinfo", (_req, res) => res.json(LOCAL_USER));

  router.get("/connect/endsession", (req, res) => {
    const back = queryString(req, "post_logout_redirect_uri");
    if (!back || !isAllowedRedirect(back, options.appOrigin))
      return page(res, 200, "Signed out of the local sign-in.");
    const url = new URL(back);
    const state = queryString(req, "state");
    if (state !== undefined)
      url.searchParams.set("state", state);
    res.redirect(302, url.toString());
  });

  return router;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod: string;
  nonce?: string;
  scope: string;
  expiresAt: number;
}

const CODE_LIFETIME_MS = 60_000;
const TOKEN_LIFETIME_S = 3600;
const LOCAL_USER = { sub: "local-user", name: "Local user", email: "local-user@localhost" };

/** The sign-in's own base URL, as the caller reached it: the app's configured authority. */
function issuerOf(req: Request): string {
  return `${req.protocol}://${req.get("host")}${req.baseUrl}`;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Only an address on this machine, or the app origin the server was given. */
export function isAllowedRedirect(uri: string, appOrigin: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return false;
  return LOOPBACK_HOSTS.has(url.hostname) || (appOrigin !== undefined && url.origin === appOrigin);
}

function verifierMatches(verifier: string | undefined, challenge: string, method: string): boolean {
  if (!verifier)
    return false;
  const computed = method === "S256" ? createHash("sha256").update(verifier).digest("base64url") : verifier;
  return computed === challenge;
}

function unsignedJwt(claims: object): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
}

function tokenError(res: Response, error: string, description: string): void {
  res.status(400).json({ error, error_description: description });
}

function page(res: Response, status: number, message: string): void {
  res.status(status).type("text/plain").send(message);
}

function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === "string" ? value : undefined;
}
