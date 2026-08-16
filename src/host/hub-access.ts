import { IModelHost } from "@itwin/core-backend";
import { BackendIModelsAccess } from "@itwin/imodels-access-backend";
import type { AuthorizationCallback } from "@itwin/imodels-client-management";
import { ReportingUploadClientStorage } from "./upload-storage";

let instance: BackendIModelsAccess | undefined;

/**
 * Shared hub access for all `imod hub` commands.
 *
 * Callers deliberately do **not** pass `accessToken` to these operations. Doing so freezes
 * one token for the whole operation; leaving it out makes BackendIModelsAccess authorize
 * every request through `IModelHost.getAccessToken()`, which asks the host's
 * AuthorizationClient again and so picks up a refreshed token. `TokenArg.accessToken` is
 * optional precisely for this: "If not present, use IModelHost.getAccessToken".
 */
export function getHubAccess(): BackendIModelsAccess {
  // Custom upload client used to report status and allow control of upload parameters.
  if (!instance)
    instance = new BackendIModelsAccess({ cloudStorage: new ReportingUploadClientStorage() });
  return instance;
}

/**
 * Authorization for calls made straight to `getHubAccess().iModelsClient`, which take an
 * AuthorizationCallback rather than going through BackendIModelsAccess. Like the operations
 * above, it re-asks the host on every request so an expiring token is refreshed.
 */
export function getHubAuthorization(): AuthorizationCallback {
  return async () => {
    const accessToken = await IModelHost.getAccessToken();
    const [scheme, token] = accessToken.split(" ");
    if (!scheme || !token)
      throw new Error("No usable access token; sign in with 'imod auth' and try again.");
    return { scheme, token };
  };
}
