import { IModelHost, type IModelHostOptions } from "@itwin/core-backend";
import { Logger, LogLevel } from "@itwin/core-bentley";
import type { AuthorizationClient } from "@itwin/core-common";
import { ensureCacheDir } from "../cache/cache-dir";
import { getAuthorizationClient, setAuthorizationClient } from "../auth/auth-client";
import { getHubAccess } from "./hub-access";

let started = false;

/**
 * Start the shared IModelHost.
 * @param authorizationClient Optional custom auth client.  Default is NodeCliAuthorizationClient.
 */
export async function startIModelHost(authorizationClient?: AuthorizationClient): Promise<void> {
  if (started)
    return;
  Logger.initializeToConsole();
  Logger.setLevelDefault(LogLevel.Error);
  if (authorizationClient)
    setAuthorizationClient(authorizationClient);
  const options: IModelHostOptions = {
    cacheDir: ensureCacheDir(),
    hubAccess: getHubAccess(),
    authorizationClient: await getAuthorizationClient(),
  };
  await IModelHost.startup(options);
  started = true;
}

export async function shutdownIModelHost(): Promise<void> {
  if (!started)
    return;
  await IModelHost.shutdown();
  started = false;
}
