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
|                                                                                                                        <ECSql help> |
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

**`imod serve console` starts the backend if one is not already running.** The console is useless
without it, so starting it is part of starting the console; `--imodel-path` is passed on, so the
iModel is already open when the page loads. A backend that is already running is left exactly as
it is, port and open iModels included.

Which backend gets stopped follows from who started it. The console's record of the backend
carries `startedBy: "console"`, and `imod serve console --stop` stops that backend as well --
but never one the user started themselves, which is theirs to stop. `imod serve stop-all` still
stops everything either way.

`/config.json` reports the backend to the browser, so the page can say when there is none rather
than failing mysteriously. The backend is looked up on each request, so it can be restarted
without restarting the console.

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
    - Going back or forward loads that query into the Query Editor.  It does not run it: landing on an expensive query should not set it going.
    - Each half is enabled on its own, so a direction with entries offers its menu even when the arrow is at the end of that direction.
    - History records queries that were run.  Re-running the current entry is not a new point in history, and running a query after going back discards the entries ahead, as a browser's session history does.
    - The pair is mirrored: Back is arrow then drop down, Forward is drop down then arrow, so the arrows sit on the outside and point away from each other.
    - Menus list the nearest entries first, capped at 20, one line each with the full query as a tooltip.  They close on a second click of the same half, on a click elsewhere, or on Escape.

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
- Right aligned
  - Row Count - `Count:` is the count of the whole query formatted with a thousands separator. It comes from a second query that wraps the first as a derived table:
    ```sql
    SELECT COUNT(*) FROM (<the query>)
    ```
    The count query is run after the first page of real results is loaded. Queries that cannot be wrapped -- a pragma, for one -- fall back to the number of rows fetched.

All buttons in the command bar should have an icon with hover text giving the name of the button.

## Content area

Holds the Query Editor and Results Table controls separated by a resizable divider.  Initial split between the two is 50/50.

### Query Editor

A Monaco based ECSql editor with auto complete.  Auto complete is driven by ECSql queries to the ECDbMeta schema.  Selected text is run when the run button is clicked or command/windows+enter is hit.

ECSql notes:
- A Schema name or schema alias is a valid prefix for a class name.  e.g. BisCore.Element and bis.Element are both valid.  So schema name and schema alias must be valid keys to look up classes.
- ecsql built in functions should be included in intellisense.  They can be found here: https://www.itwinjs.org/learning/ecsqlreference/ecsqlfunctions/

#### Query Help

The ECSql help button hovering in the upper right corner expands a side panel with the full ECSql Reference docs found here: https://www.itwinjs.org/learning/ecsqlreference/ or in itwinjs-core source here: docs/learning/ECSqlReference/index.md.

The side panel can be pinned to stay open or if not it closes when the user clicks in the query editor text window.

The docs are **vendored**, not fetched: `web/help/ecsqlreference` is a verbatim copy of that directory from itwinjs-core (MIT, notice in `web/help/LICENSE.md`, commit in `web/help/PROVENANCE.json`), refreshed with `npm run sync:ecsql-help -- <path-to-itwinjs-core>`. A console pointed at a local briefcase is normally offline, so the reference has to be there without a network.

The build renders all 28 pages into a **single** HTML document (`build/ecsql-help.ts`, run as a Vite plugin so the dev server and a production build go through the same step). One document means every cross reference becomes a plain anchor within the panel, with no navigation to write, and the browser's own find searches the whole reference at once.

- Heading ids are prefixed with their page -- `join--inner-join` -- because heading text repeats across pages; four of them have a `Returns` heading.
- Links between pages become anchors, links out of the reference go to the pinned commit on GitHub, and external links open in a new tab.
- **The build fails if a link no longer resolves.** These anchors are written by hand, so a heading renamed upstream would otherwise be invisible until someone clicked it. Links already broken upstream are listed in `KNOWN_BROKEN_LINKS` and fall back to the top of the page they point at.

Panel behaviour:
- It sits beside the panes rather than over them, so a pinned panel narrows the results instead of covering them.
- Its left edge is a **resizable divider**: dragging it widens the reference and gives back the space when narrowed. It starts at 420px, will not go below 260px, and always leaves 320px for the editor and results. The divider lives inside the panel so it appears and disappears with it. A width chosen once holds for the rest of the session, including across closing and reopening.
- Closing it also unpins it, so it never reopens in a state the user did not ask for.
- Escape closes it on the same terms as a click in the editor: only when it is not pinned.
- Anchor clicks are handled by the panel, not the browser, so following a link does not put a fragment on the console's own URL.
- The document is fetched on first open and kept, since most sessions never ask for it.

#### Formatting

A custom formatter is registered as a formatting provider for the `ecsql` language so it is integrated with the Monaco formatting system.

The formatter breaks lines at the major clauses, joins and connectors, and leaves everything else (expressions, functions, sub-selects) exactly as written. String literals and bracketed identifiers are never touched.

#### Schema info

The Schema info is queried from the iModel using ECDbMeta queries and is exposed for use in the query editor and results table.

Classes and properties are indexed under **both the schema name and its alias**, so `BisCore.Element`
and `bis.Element` resolve identically. The alias is read from `meta.ECSchemaDef.Alias`. Keys are
lower cased: ECSql identifiers are case-insensitive, so `BIS.element` completes too. Schema names
and aliases are unique across an iModel, so the two key spaces cannot collide.

Properties are gathered through each class's **whole ancestry**, by joining
`meta.ClassHasAllBaseClasses` (Source is the derived class, Target the base, and the closure
includes the class itself). Completing only declared properties would offer nothing where it
matters most: `Generic.PhysicalObject` declares zero of its own and inherits all twenty. A property
overridden in a subclass is declared twice in the ancestry, so duplicates are dropped.

The class id map keeps the canonical `Schema.Class`, never the alias, since that is what the
results table shows.

#### Table aliases

Completion after `e.` resolves the alias a query binds, so `FROM bis.Element e` makes `e.` offer
Element's properties. `parseTableAliases` reads the FROM and JOIN clauses only: each introduces a
comma separated list of table references, so the clause is taken as a region and split, which binds
both sources in `FROM a.X x, b.Y y` while keeping a `SELECT a, b.c` list from being mistaken for a
table reference. It understands `AS`, `ONLY`, brackets and the `schema:class` spelling, and will not
mistake a following keyword (`WHERE`, `ORDER`, ...) for an alias.

A table alias takes precedence over a schema of the same name: inside `FROM bis.Element bis`,
`bis.` means the element. Aliases are also offered as completions in their own right.

This is deliberately shallow -- enough to bind an alias to a class, not an ECSql parser. Anything it
cannot recognise it skips, which costs a completion rather than producing a wrong one.

#### Built-in functions

The eight ECSql built-ins from the function reference are offered with their signatures and
snippet insertion. SQLite's scalar functions are a separate, much longer reference and are not
included; mixing them in would bury these eight.

### Results Table

Shows either the rows from running the query or the results from explaining the query.  

- Table has a header with the column name as specified in the ECSql query or returned as the underlying db.
- Columns are resizable and are initially sized to show the entire header and the results from the first 100 rows.
- Column values that overflow the column are truncated.  
- When a row has truncated data a hover over is used to show expanded content in a word wrapped box 50% wider than the column.  If the content is over 2x longer than can fit in the column it is considered extra long and a chevron is shown that can expand the row to show the full results word wrapped to fit in the current column space.
- The Table has a fixed column on the left hand side to hold chevrons shown when a row is truncated.  The column is always shown but the chevron is only shown if a row has a truncated column that is considered extra long.
- Columns are annotated using the metadata `ECSqlReader.getMetaData()` returns
- Query result columns that are class ids specified by the query metadata should be augmented with the name of the class. `ClassId` and `navigation` columns should have their class name shown.  e.g. `0x42 (BisCore.Element)` where the id `0x42` is normal text and the class name `(BisCore.Element)` is lighter.  The names are gathered using the Schema info gathered by the Query Editor.
- Virtualized so only rows in the view exist int eh dom.

##### Truncation, hover and chevrons

Whether a value fits is estimated from its length rather than measured, since measuring every
cell would cost a layout pass per row. The annotation counts toward the width: it is drawn in
the same cell.

Two thresholds, from one measurement:

| content vs what the column fits | behaviour |
|---|---|
| fits | plain cell |
| overflows | cell gets a hover showing the whole value |
| more than twice | the row also gets a chevron |

The hover is a single element positioned against the cell in viewport coordinates, so it escapes
both the cell's own clipping and the table's overflow, and it is half again as wide as the column
so the wrapped text has somewhere to go. It is bound by delegation, not per cell: rows are rebuilt
on every scroll, so per-cell listeners would be attached and discarded continuously. It hides on
scroll, because its position is taken from the cell and scrolling would strand it, and it does not
appear over a row that is already expanded.

##### Results Paging

The Results Table loads a page at a time. The query reader is kept in the consoles state and used to request subsequent pages as the user scrolls.

The first page is 1,000 rows and each scroll to the end pulls another page.




