import type { RequestHandler } from "express";

export interface PlatformCorsOptions {
  /**
   * The one web app origin allowed to call the sign-in and iTwin Platform endpoints, such as
   * `http://localhost:3000`. Any origin when not given, as for the RPC routes.
   */
  appOrigin?: string;
}

/**
 * CORS for the sign-in and iTwin Platform endpoints.
 *
 * Separate from the RPC routes' CORS because these are called with headers the RPC
 * configuration does not allow: the iModels client sends `Prefer`, and the picker
 * `Cache-Control`. Every preflight is answered here, so none falls through to the RPC
 * catch-all.
 */
export function platformCors(options: PlatformCorsOptions): RequestHandler {
  return (req, res, next) => {
    const origin = req.get("origin");
    if (options.appOrigin === undefined)
      res.header("Access-Control-Allow-Origin", "*");
    else if (origin === options.appOrigin) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Vary", "Origin");
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Authorization, Accept, Content-Type, Prefer, Cache-Control, X-Correlation-Id");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  };
}
