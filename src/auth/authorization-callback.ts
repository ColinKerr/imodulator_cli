import type { AuthorizationCallback } from "@itwin/imodels-client-management";
import { getAccessToken } from "./auth-client";

export function getAuthorizationCallback(): AuthorizationCallback {
  return async () => {
    const raw = await getAccessToken();
    const space = raw.indexOf(" ");
    if (space > 0)
      return { scheme: raw.slice(0, space), token: raw.slice(space + 1) };
    return { scheme: "Bearer", token: raw };
  };
}
