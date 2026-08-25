import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/test/**/*.test.ts"],
    // Runs before every test module is imported: it gives the process its own cache and
    // IModelHost workspace, so no test can touch ~/.imod/cache or collide with another run.
    setupFiles: ["src/test/temp-workspace.ts"],
    // iTwin.js relies on process-wide native host state (IModelHost), and HubMock allows one
    // active mock per process, so every test file needs a process of its own -- which is what
    // forks with the default isolation gives it. Files can then run in parallel, because the
    // setup file above puts each of those processes in its own cache directory: the workspace
    // profile lock is exclusive per cache, so sharing one would serialise them anyway.
    pool: "forks",
    // Opening iModels and downloading mock briefcases can take a few seconds.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
