import type { AuthorizationClient } from "@itwin/core-common";

/**
 * An AuthorizationClient that hands out an empty token.
 *
 * Commands that only work on a local iModel file never call the hub, but starting
 * IModelHost without an authorization client would send them through the interactive
 * sign-in flow. Passing this to `startIModelHost` keeps them offline.
 */
export const noopAuthClient: AuthorizationClient = {
  // Non-empty on purpose: an empty token reads as "not signed in" and can send callers
  // back through the sign-in flow this client exists to avoid.
  getAccessToken: async () => "noop-token",
};
