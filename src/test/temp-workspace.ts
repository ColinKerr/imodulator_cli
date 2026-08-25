/**
 * Gives every test process its own working directory.
 *
 * Registered as a vitest setup file, so this runs before a test module is imported. That
 * matters twice over: it covers every test file without anyone remembering to opt in, and it
 * is early enough that a module reading the cache directory at import time cannot capture the
 * developer's real one.
 *
 * Without it, tests share `~/.imod/cache` with each other and with any running `imod serve`,
 * which shows up as `Db is busy: Profile [...] is already in use by another process`.
 */

import { afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_KINDS, stopServerProcess } from "../serve/server-process";

/** Where this process's temporary directories live. Read by the helpers below. */
const ROOT_ENV_VAR = "IMOD_TEST_ROOT";

/**
 * The native addon is built for one Node ABI. Loading it into another dies with a SIGSEGV
 * inside `napi_module_register_by_symbol` and no message at all, so the version is checked
 * here where it can still be reported.
 */
const REQUIRED_NODE_MAJOR = 24;

function checkNodeVersion(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== REQUIRED_NODE_MAJOR)
    throw new Error(
      `These tests need Node ${REQUIRED_NODE_MAJOR}.x, but this is Node ${process.versions.node}. ` +
      `The iTwin native addon is built for one ABI and crashes without a message on another. Run "nvm use".`,
    );
}

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), `imod-test-${process.pid}-`));
  process.env[ROOT_ENV_VAR] = root;
  process.env.IMOD_CACHE_DIR = join(root, "cache");
  mkdirSync(process.env.IMOD_CACHE_DIR, { recursive: true });
  return root;
}

checkNodeVersion();
const root = createRoot();

/** The cache this process's tests work in, which is also the IModelHost workspace. */
export function testCacheDir(): string {
  const dir = process.env.IMOD_CACHE_DIR;
  if (!dir)
    throw new Error("IMOD_CACHE_DIR is not set: is src/test/temp-workspace.ts still a vitest setup file?");
  return dir;
}

/**
 * A directory for a test's own files -- outputs, downloads, copies of iModels.
 *
 * Made under this process's root so the one teardown clears everything, and no test has to
 * remember to remove what it wrote.
 */
export function testTempDir(prefix: string): string {
  const parent = process.env[ROOT_ENV_VAR];
  if (!parent)
    throw new Error(`${ROOT_ENV_VAR} is not set: is src/test/temp-workspace.ts still a vitest setup file?`);
  return mkdtempSync(join(parent, `${prefix}-`));
}

/**
 * Stop any server this process's tests started and left behind.
 *
 * A detached server outlives the test run that spawned it, and it holds the workspace profile
 * and the cache database open. Once its temporary cache is deleted underneath it, it is an
 * orphan that can only be found by hunting through `ps`. The records live in this process's
 * own cache directory, so this stops only servers belonging to this run.
 */
async function stopLeakedServers(): Promise<void> {
  for (const kind of SERVER_KINDS) {
    try {
      const result = await stopServerProcess(kind);
      if (result.stopped)
        console.warn(`test teardown stopped a leaked ${kind} server (pid ${result.record?.pid})`);
    } catch {
      // Teardown must not turn a leak into a failure that hides the real one.
    }
  }
}

// Registered before any test file's own hooks, so it runs after them: vitest unwinds `afterAll`
// in reverse, which leaves the host shut down and its files closed before the directory goes.
afterAll(async () => {
  await stopLeakedServers();
  rmSync(root, { recursive: true, force: true });
});
