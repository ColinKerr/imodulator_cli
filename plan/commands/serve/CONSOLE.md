# console command details

Implementation details for the `imod serve console` command.

The console is a simple web application with a Monaco text editor for writing ECSql queries and a virtualized table to see the results.  

Design mockup:
```
---------------------------------------------------------------------------------------------------------------------------------------
| eyeModel Console | Pick iModel <name, id or path of opened iModel>                <Back button/dropdown> <Forwards button/dropdown> |
---------------------------------------------------------------------------------------------------------------------------------------
| <Run button> <Explain button> <Format button> <Save results button>                                              Count: <Row count> |
---------------------------------------------------------------------------------------------------------------------------------------
|                                                                                                                                     |
|                                                                                                                                     |
|                                                                                                                                     |
|                                                                                                                                     |
|                                                       < Query Editor >                                                              |
|                                                                                                                                     |
|                                                                                                                                     |
|                                                                                                                                     |
|                                                                                                                                     |
|_____________________________________________________________________________________________________________________________________| <--- Resizable divider
|                                                                                                                                     |
|                                                                                                                                     |
|                                                                                                                                     |
|                                                                                                                                     |
|                                                                                                                                     |
|                                                       < Results Table >                                                             |
|                                                                                                                                     |
|                                                                                                                                     |
|                                                                                                                                     |
|                                                                                                                                     |
---------------------------------------------------------------------------------------------------------------------------------------
```

## Options

- `--stop` (Optional) - Stops the process if it is running.
- `--imodel-path` (Optional) - Starts the console with the iModel specified the this parameter opened by default.
- `--port` (Optional) - Port to listen on. Defaults to 8080. Pass `0` to bind any free port.

## Architecture

The console is an iTwin.js frontend. It serves only static assets and a little configuration;
the iModel and every query come from `imod serve backend` over the standard RPC interfaces.

```
browser ──(assets, /config.json)──► imod serve console  :8080
   └────(queryRows, tiles over RPC)────► imod serve backend :3001
```

`imod serve console` warns when no backend is running, and `/config.json` reports the same to the
browser so the page can say so rather than failing mysteriously. The backend is looked up on each
request, so it can be started or restarted without restarting the console.

The connection is a small `IModelConnection` subclass wrapping the props from the backend's
`POST /open`: the base class constructor is protected and has only two abstract members
(`isClosed`, `close`). It deliberately never calls `IModelReadRpcInterface.getConnectionProps`,
which is the one read operation that tries to download a checkpoint from iModelHub instead of
using the iModel the backend already has open.

Because the browser calls the backend cross-origin, and RPC sends custom `X-` headers, every call
is preceded by a CORS preflight; the backend answers those directly.

The frontend is bundled with Vite into `dist/web` (`npm run build:web`, folded into `npm run
build`). `@itwin/core-frontend` cannot be loaded unbundled -- it has no `exports` map and imports
bare specifiers across a deep dependency tree.

## Top Bar

The top bar contains:

- Left aligned
  - The application name: eyeModel Console
  - Pick iModel button. A browser file picker cannot give the server a path it can open, so this
    lists what the backend has open plus everything in the cache (`GET /imodels`), with a field to
    paste a path to any other iModel.
- Right aligned
  - Back and Forwards split buttons.  Clicking on the arrow goes back or forwards, clicking on the drop down shows the queries in back or forwards history list.

## Command bar

The command bar contains:

- Left aligned
  - Run button.  Runs the query currently in the Query Editor via `IModelConnection.createQueryReader`, the standard query RPC.  
    - Only enabled when there is text in the Query Editor.
    - If there is selected text only the selected text is run, else the all text is run.
  - Explain button. Wraps the query as `PRAGMA explain_query('<query>')` -- doubling any quotes so a literal cannot end the pragma string -- runs it through the same query RPC, and shows the results in the Results Table.  
    - Only enabled when there is text in the Query Editor.
    - If there is selected text only try to explain the selected text, else all text is passed to explain pragma.
  - Format button. Format the ECSql in the Query Editor.  
    - Only enabled when there is text in the Query Editor.
  - Save Results button.  Saves the results for a query in a csv file.
    - Only enabled when there are results in the Results Table.

All buttons in the command bar should have an icon with hover text giving the name of the button.

## Content area

Holds the Query Editor and Results Table controls separated by a resizable divider.  Initial split between the two is 50/50.

### Query Editor

A Monaco based ECSql editor with auto complete.  Auto complete is driven by ECSql queries to the ECDbMeta schema.  Selected text is run when the run button is clicked or command/windows+enter is hit.

#### Schema info

The Schema info is queried from the iModel using ECDbMeta queries and is exposed for use in the query editor and results table.

### Results Table

Shows either the rows from running the query or the results from explaining the query.  

- Table has a header with the column name as specified in the ECSql query or returned as the underlying db.
- Columns are resizable and are initially sized to show the entire header and the results from the first page of results.
- Column values that overflow the column are truncated.  When a row has truncated data a chevron is shown that can expand the row to show the full results word wrapped to fit in the current column space.
- Query result columns that are schema class or property ids specified by the query metadata should be augmented with the name of the schema class or property. e.g. `0x42 (BisCore.Element)` where the id `0x42` is normal text and the class name `(BisCore.Element)` is lighter.  The names are gathered using the Schema info gathered by the Query Editor.


## Row count

`Count:` is the count of the whole query, not of the rows fetched. It comes from a second query
that wraps the first as a derived table:

```sql
SELECT COUNT(*) FROM (<the query>)
```

That is a second execution, so it runs after the first page of rows is on screen and fills the
count in when it lands. Queries that cannot be wrapped -- a pragma, for one -- fall back to the
number of rows fetched.

## Formatting

Monaco has no SQL formatter. It registers `DocumentFormattingEditProvider` only for css, html and
json; its SQL support is a Monarch tokenizer and a keyword list. The console therefore has its own,
registered as a formatting provider for the `ecsql` language so the editor's own format action uses
it too.

It is deliberately conservative: it breaks lines at the major clauses, joins and connectors, and
leaves everything else -- expressions, functions, sub-selects -- exactly as written. String
literals and bracketed identifiers are never touched.

## Results Table

Virtualized by hand: only the rows in view exist in the DOM, so a large result renders in constant
time. Columns are sized from the header and the first 100 rows, which is what a user sees first;
measuring every row of a large result would cost more than it is worth.

Class id columns are annotated using the metadata `ECSqlReader.getMetaData()` returns, not by
guessing from column names: ECDb reports an `extendedType` of `ClassId` for class ids, `Id` for
instance ids and `NavId` for navigation properties. The class name comes from the schema info the
editor already loaded through ECDbMeta.
