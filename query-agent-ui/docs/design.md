# The client library and the controls: design

How the query agent's client library (`@query-agent/client`) and its React controls
(`@query-agent/react`) work, for an app that hosts them. The agent itself is a separate service,
the **agent function**; this document covers only what the app runs. The README shows the code to
get started.

## The parts

| Where | What it does |
|---|---|
| The app (browser or Node) | Starts an `AgentClient` for the open iModel. The client runs every query on the app's own iModel and sends the rows to the function |
| The agent function | Decides what to ask next: it talks to the model, and answers each turn with the queries to run, or with the answer |
| The app's backend | Serves the iModel to the app (iTwin.js RPC), as for any other query. It takes no part in the agent |

The function never reaches the iModel, and the app never sees the model. Between them is one HTTP
call, `POST <functionUrl>/turn`, made once per turn.

## Starting a client

```ts
const client = AgentClient.start({ runQuery: queryRunner(imodel), imodelName, functionUrl, getAccessToken });
```

- **`runQuery`** runs ECSql on the iModel. `queryRunner` makes one from anything with
  `createQueryReader`: an `IModelConnection` in a browser, or an `IModelDb` in Node. It must
  abbreviate blobs. With no `runQuery`, the client can still answer questions about ECSql itself.
- **The startup list** runs as soon as the client starts. It is a fixed list of queries
  (`startup-queries.json`, carried by the library) that describes the file: its connectors, its
  schemas, its largest classes and the like. Its rows go with every turn, and the function writes
  them into what the model is told. A query that fails is an empty result; a list that cannot run
  at all is left out, and the agent works without it.
- **One client per iModel.** What the agent finds is about one file, so a host starts a new client
  (and a new chat) when the iModel changes.

## Asking

`client.ask(question, options)` drives one run to its end and returns an `AgentRun`.

1. While the startup list is still running, the client waits for it, with the status `exploring`.
2. It sends a turn (`thinking`): the question, whether it can query, the iModel's name and startup
   rows, the editor's text, the chat's earlier questions, and the token.
3. The function answers with the queries to run, and how much of each to read (the caps). The
   client runs them one by one (`querying`, with the ECSql), and sends their rows, or their
   errors, with the next turn. A failed query is not an error of the run: the model sees the
   message and corrects the query.
4. This repeats until the function's answer says the run is done: the answer's text, its query,
   the answer as the model submitted it (`structured`), why it stopped, and a run id.
5. The client then reads the answer's query once (up to 200 rows), so the host can show the
   results (`run.answerRows`).

**The statuses** (`onStatus`): `exploring`, `thinking`, and `querying`. The controls show them as
"Exploring", "Thinking" and "Running a query".

**Stopping.** Abort the signal passed to `ask`. The client then sends one more turn saying the run
was stopped, and the function ends the run with what it has, without calling the model again.
The run ends with `stoppedBecause: "aborted"`.

**How a run ends** (`stoppedBecause`): `answered`; `stuck` (its queries kept failing, or the model
gave no answer); `steps` (it reached its step limit); or `aborted`. A run that stops early still
has an answer: what the agent could say, often with the last query that worked.

## Reading rows

The client reads each query only as far as the function's caps allow (`readCapped`):

- it stops before a row once it has `maxRows` rows;
- it stops before a row that would take the text past `maxChars`, but always keeps the first row;
- it cuts each string to `maxCellChars`, and records the cell and its full length in `clipped`.

The function formats the rows the model sees by the same rules, so the client never reads or sends
more than the model can be shown.

## The token

Every response carries a **token**, and the client sends it back with the next turn. Between
questions, the chat keeps the token of its last finished run (`run.token`) and sends it with the
next question.

## Earlier questions

A follow-up needs to know what was asked before. With each question the client sends the chat's
earlier questions as the user saw them (`EarlierQuestion`): the question, the answer, its query, how
it ended, and the answer's rows cut to `HISTORY_CAPS` (20 rows, 2,000 characters, 200 characters a
cell), or the query's error. `earlierQuestion(question, run)` builds one from a finished run, and
`contextOf(chat)` builds the whole list and picks the last token. A question that failed is left
out. The function shortens the list to fit what the model can take.

## Access keys and refusals

A function may require an access key. The host gives the client `getAccessToken`, which is called
before every turn, and the client sends what it returns as `Authorization: Bearer <key>`. A key
given later is used at once, without starting the client again.

When the function refuses a turn for a reason the user can act on, the client throws
`TurnRefused`, with the HTTP status and the function's own sentence, which is meant to be shown as
it is:

| Status | Meaning | What a host does |
|---|---|---|
| 401 | No key, or a key the function does not know | Ask for a key |
| 403 | The key was removed | Ask for another key |
| 429 | The key has used up all credits, perhaps in the middle of a question | Ask for another key |
| 413 | The request is too long | Show the sentence; a shorter question or a new chat may help |
| 400 | The function could not read the turn, or could not open its token | Start a new chat |

Any other failure is a plain error. The controls then show "The agent could not finish.".

## What a host must tell its users

Everything below leaves the user's machine, for the agent function and then the model provider, Anthropic. A
host should say so where the user gives a key or starts a chat, as the console's Assistant does.

| What | Goes to the function | Goes on to Anthropic |
|---|---|---|
| Your question | Yes | Yes |
| The text in the query editor | Yes | Yes, up to the limits |
| The iModel's name | Yes | Yes |
| The results of the startup queries about the iModel | Yes | Yes |
| Earlier questions and answers in the chat, with some of their rows | Yes | Yes, shortened |
| The rows and errors of the queries the agent runs on your iModel | Yes | Yes, up to the limits on results |
| The iModel file itself | No | No |

## The controls

**`AgentChat`** is the chat and the ask box. Enter asks, and Shift+Enter starts a new line. While a
run is in progress, the control shows its status with moving dots and a Stop button. "New chat"
empties the chat.

| Prop | What it is for |
|---|---|
| `client` | A started `AgentClient`. Without one, the control says "The agent is not set up." |
| `editorText` | Read when a question is asked; sent as context for "fix this" or "what does this do" |
| `onUseQuery` | Adds "Use this query" beside an answer's query, to put it in the host's editor |
| `onAnswer` | Called with each finished answer: its text, query and outcome |
| `onRunFinished` | Called with each finished run, whole |
| `onRefused` | Called with a `TurnRefused`, after the control has shown its sentence |
| `onChange` | Called whenever the chat changes, so a host can keep it |
| `onFeedback` | Turns on the feedback form under each answer, and receives what the user sends |
| `question` | A question to ask as if typed; asked again whenever its `key` changes |
| `answerActions` | The host's own buttons under each finished answer |
| `renderAfterAnswer`, `renderAfterChat` | Drawn under each answer, and after the questions |
| `placeholder` | The ask box's placeholder |

**`AgentWorkbench`** is the chat, with two tabs beside it: **Results** (the last answer's rows, as
the client read them) and **History** (this page's earlier chats; "New chat" moves the current one
there, and a click reopens it). It takes the same props as `AgentChat`, except the render props.

**The feedback form** (`onFeedback`). The user rates an answer (right, partly or wrong), may
correct its text or its query, and may add a comment. They then see exactly what would be sent,
and choose to send it. It holds only what the user saw and wrote. The controls upload nothing: the
host receives the feedback and decides what to do with it. Without `onFeedback` the form is not
shown.

Import `@query-agent/react/styles.css` once. Its classes start with `qa-`.

## In Node

`@query-agent/client/node` starts iTwin.js's frontend in Node, so a script or a test can run the
client exactly as a browser does, with the queries going to a backend by RPC:
`startNodeFrontend(backendUrl)` once per process, then `connectionFromProps(props)` for an iModel
the backend has open. The frontend needs a DOM to start, so this loads `global-jsdom`; it needs
`global-jsdom` and `jsdom` installed.

## What a host must not do

- Read or change the token.
- Show or store anything of the agent's working beyond what `AgentRun` gives.
- Send the access key anywhere but the function.
