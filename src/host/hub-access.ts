import { BackendIModelsAccess } from "@itwin/imodels-access-backend";

let instance: BackendIModelsAccess | undefined;

export function getHubAccess(): BackendIModelsAccess {
  if (!instance)
    instance = new BackendIModelsAccess();
  return instance;
}
