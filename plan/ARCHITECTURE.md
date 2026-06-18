# Architecture

## Tech

Uses Node.js and TypeScript

## Dependencies
iModulator CLI is built using the following packages 
CLI command structure and parsing: yargs

iModel and iTwin Platform APIs: @itwin/core-backend, @itwin/core-bentley, @itwin/core-common, @itwin/imodels-access-backend, @itwin/node-cli-authorization, @itwin/ecschema-metadata, @itwin/ecschema-editing, @itwin-ecschema-locaters

> Note: use the latest version of the @itwin packages to ensure compatibility.

SQLite: better-sqlite3

## Command design

All CLI command should be written so other CLI commands can call them as functions so new commands can be written by combining multiple existing commands.  For example the `imod hub download checkpoint --imodel-id <GUID> --latest` would call the function behind the `imod auth` command to make sure the cached oidc token is up to date, then the function behind the `imod hub checkpoint --imodel-id <GUID>` to get the id of the latest checkpoint id before using the @itwin/core-backend API to download the appropriate cache directory.

Each command should exist in it's own typescript file within a subfolder named after it's parent command.  e.g. `imod hub briefcase download` should be in a file `download.ts` within the directory path `./src/commands/hub/briefcase`.

Commands that require detailed description should have a markdown file in the `./plan/commands/` sub directory that matches the location of the actual command in `./src/commands/`.

## Storage and Cache

A local cache directory is used to store downloaded iModels in the local cache directory using the file structure defined by iTwin.js.  Other data entered by the user or downloaded from iTwin Platform APIs is stored in a sqlite db also stored in the local cache directory

