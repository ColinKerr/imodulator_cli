import { NodeCliAuthorizationClient } from "@itwin/node-cli-authorization";
import type { AccessToken } from "@itwin/core-bentley";
import type { AuthorizationClient } from "@itwin/core-common";

const DEFAULT_SCOPE = [
  "itwin-platform",
].join(" ");

let client: NodeCliAuthorizationClient | undefined;
let signedIn = false;

function getClientId(): string {
  const id = process.env.IMOD_CLIENT_ID;
  if (!id || id.length === 0)
    throw new Error("IMOD_CLIENT_ID environment variable is not set. See README.md for setup.");
  return id;
}

function getOrCreateClient(): NodeCliAuthorizationClient {
  if (client)
    return client;
  client = new NodeCliAuthorizationClient({
    clientId: getClientId(),
    scope: process.env.IMOD_SCOPE ?? DEFAULT_SCOPE,
    issuerUrl: process.env.IMOD_ISSUER_URL,
    redirectUri: process.env.IMOD_REDIRECT_URI,
  });
  return client;
}

export async function signIn(): Promise<void> {
  const c = getOrCreateClient();
  await c.signIn();
  signedIn = true;
}

export async function signOut(): Promise<void> {
  const c = getOrCreateClient();
  await c.signOut();
  signedIn = false;
}

export async function getAccessToken(): Promise<AccessToken> {
  const c = getOrCreateClient();
  if (!signedIn) {
    await c.signIn();
    signedIn = true;
  }
  return c.getAccessToken();
}

export function getAuthorizationClient(): AuthorizationClient {
  return getOrCreateClient();
}
