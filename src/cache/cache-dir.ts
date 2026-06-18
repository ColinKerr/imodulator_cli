import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CACHE_ENV_VAR = "IMOD_CACHE_DIR";
const DEFAULT_CACHE_DIR_NAME = ".imod";

export function getCacheDir(): string {
  const fromEnv = process.env[CACHE_ENV_VAR];
  if (fromEnv && fromEnv.length > 0)
    return fromEnv;
  return path.join(os.homedir(), DEFAULT_CACHE_DIR_NAME, "cache");
}

export function ensureCacheDir(): string {
  const dir = getCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getIModelCacheDir(imodelId: string): string {
  return path.join(ensureCacheDir(), "imodels", imodelId);
}

export function ensureIModelCacheDir(imodelId: string): string {
  const dir = getIModelCacheDir(imodelId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
