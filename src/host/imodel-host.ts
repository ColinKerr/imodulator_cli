import { IModelHost, type IModelHostOptions } from "@itwin/core-backend";
import { Logger, LogLevel } from "@itwin/core-bentley";
import { ensureCacheDir } from "../cache/cache-dir";
import { getAuthorizationClient } from "../auth/auth-client";
import { getHubAccess } from "./hub-access";
import { NodeCliAuthorizationClient } from "@itwin/node-cli-authorization/lib/cjs/Client";

let started = false;

export async function startIModelHost(): Promise<void> {
  if (started)
    return;
  Logger.initializeToConsole();
  Logger.setLevelDefault(LogLevel.Warning);
  const authClient = getAuthorizationClient() as NodeCliAuthorizationClient;
  const options: IModelHostOptions = {
    cacheDir: ensureCacheDir(),
    hubAccess: getHubAccess(),
    authorizationClient: authClient,
  };
  await IModelHost.startup(options);
  await authClient.signIn();
  await authClient.getAccessToken();
  started = true;
}

export async function shutdownIModelHost(): Promise<void> {
  if (!started)
    return;
  await IModelHost.shutdown();
  started = false;
}
