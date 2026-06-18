import type { CommandModule } from "yargs";
import { getCacheDir } from "../../cache/cache-dir";

export function runCacheDir(): string {
  return getCacheDir();
}

export const cacheDirCommand: CommandModule = {
  command: "dir",
  describe: "Print the local cache directory",
  builder: (y) => y,
  handler: () => {
    console.log(runCacheDir());
  },
};
