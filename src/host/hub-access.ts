import { IModelHost, type BackendHubAccess } from "@itwin/core-backend";
import { _hubAccess } from "@itwin/core-backend/lib/cjs/internal/Symbols.js";
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
 * The hub access the host is actually using.
 *
 * In production this is the very instance `getHubAccess()` returns, because `startIModelHost`
 * installs it on IModelHost. Under HubMock it is the mock, which takes IModelHost's hub access
 * over for the duration of a test -- so an operation reached through here can be tested, and
 * the same operation reached through `getHubAccess()` directly cannot.
 *
 * Prefer this for plain hub operations. `getHubAccess()` remains right where the concrete
 * `BackendIModelsAccess` is needed, notably for `iModelsClient`, which the mock does not have.
 */
export function getActiveHubAccess(): BackendHubAccess {
  return IModelHost[_hubAccess];
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
