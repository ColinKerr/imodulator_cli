# Testing

## Node version

The tests need **Node 24** (`.nvmrc`, and `engines` in package.json). The iTwin native addon is
built for one Node ABI; loading it into another dies with a SIGSEGV inside
`napi_module_register_by_symbol` and no message at all. `src/test/temp-workspace.ts` checks the
version first so a wrong `node` reports that instead of crashing.

## Isolation

Every test process gets its own working directory. `src/test/temp-workspace.ts` runs as a vitest
setup file -- before any test module is imported -- and points `IMOD_CACHE_DIR` at a fresh
temporary directory, which is also the IModelHost workspace. Nothing under `~/.imod/cache` is
ever touched, so a test run cannot collide with another run or with a live `imod serve backend`.

- `testCacheDir()` is that cache. Use it instead of making one.
- `testTempDir(prefix)` is for a test's own files (outputs, copies, stand-in builds). It lives
  under the same root, so the shared teardown removes it and no test has to.
- Nothing else may write outside those directories -- notably not into `dist`.
- `HubMockFixture.startup` refuses to start a host whose cache is not a temporary directory, so
  a file that skips this fails by name rather than as a lock error somewhere else.
- Teardown stops any server the run left behind. A detached `imod serve` outlives the run and
  holds the workspace profile open, which breaks every later run until it is killed by hand.

Because each process is isolated, test **files run in parallel** (`pool: "forks"`, vitest's
default isolation, one process per file). That is what makes the suite take about 8s rather
than 32s. A test that needs process-wide state to itself -- IModelHost, HubMock -- still gets
it, because that state never leaves its file's process.

## Design
Testing should be done using a 'HubMock' extracted from `core/backend/src/internal/HubMock.ts` in the itwinjs-core repo found here: `https://github.com/iTwin/itwinjs-core`.

For testing auth should be mocked, it is not necessary with hub mock.

Tests should be written using `vitest` package.


## Coverage

Write tests for each command that confirms it functions as described in documentation and that it fails gracefully when invalid input is provided.


## Naming

Tests should be grouped using `describe` methods that identify the command and optionally use sub `describe` methods if there are a large number of individual tests for a command that should be grouped.

Individual tests should have names that clearly state what is being tested in the context of it's containing `describe`.


## File names and directory structure

Tests should be stored in a `src/test` directory.

Tests for each command should be in their own file named like <command>.test.ts.

The directory structure of the `src/test` directory should match the organization of the `src/commands` directory.


