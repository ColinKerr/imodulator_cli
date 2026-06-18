# Testing


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


