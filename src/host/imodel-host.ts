import { IModelHost, type IModelHostOptions } from "@itwin/core-backend";
import { Logger, LogLevel } from "@itwin/core-bentley";
import { ensureCacheDir } from "../cache/cache-dir";
import { getAuthorizationClient } from "../auth/auth-client";
import { getHubAccess } from "./hub-access";

let started = false;

export async function startIModelHost(): Promise<void> {
  if (started)
    return;
  Logger.initializeToConsole();
  Logger.setLevelDefault(LogLevel.Trace);
  const options: IModelHostOptions = {
    cacheDir: ensureCacheDir(),
    hubAccess: getHubAccess(),
    authorizationClient: getAuthorizationClient(),
  };
  await IModelHost.startup(options);
  await options.authorizationClient?.getAccessToken();
  started = true;
}

export async function shutdownIModelHost(): Promise<void> {
  if (!started)
    return;
  await IModelHost.shutdown();
  started = false;
}
