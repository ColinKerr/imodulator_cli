import { NodeCliAuthorizationClient } from "@itwin/node-cli-authorization";
import type { AccessToken } from "@itwin/core-bentley";
import type { AuthorizationClient } from "@itwin/core-common";

const DEFAULT_SCOPE = [
  "itwin-platform",
].join(" ");

let client: AuthorizationClient | undefined;

function getClientId(): string {
  const id = process.env.IMOD_CLIENT_ID;
  if (!id || id.length === 0)
    throw new Error("IMOD_CLIENT_ID environment variable is not set. See README.md for setup.");
  return id;
}

async function getOrCreateClient(): Promise<AuthorizationClient> {
  if (client)
    return client;
  const nodeClient = new NodeCliAuthorizationClient({
    clientId: getClientId(),
    scope: process.env.IMOD_SCOPE ?? DEFAULT_SCOPE,
    issuerUrl: process.env.IMOD_ISSUER_URL,
    redirectUri: process.env.IMOD_REDIRECT_URI,
  });
  await nodeClient.signIn();
  client = nodeClient;
  return nodeClient;
}

export function setAuthorizationClient(authClient: AuthorizationClient): void {
  client = authClient;
}

export async function getAccessToken(): Promise<AccessToken> {
  const c = await getOrCreateClient();
  return c.getAccessToken();
}

export async function getAuthorizationClient(): Promise<AuthorizationClient> {
  return getOrCreateClient();
}

