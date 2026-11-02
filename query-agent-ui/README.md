# query_agent_ui

The query agent's client library and React controls, for iTwin.js apps. The agent answers
questions about an iModel by writing and running ECSql. The client runs every query on the
app's own iModel, and the agent function (a separate service) decides what to ask next.
[`docs/design.md`](docs/design.md) describes how the client and the controls work.

## Packages

| Package | Holds |
|---|---|
| `packages/client` | `AgentClient`, the query runner, the turn driver, the startup query list, and the API types |
| `packages/react` | `AgentChat` (the chat and the ask box), `AgentWorkbench` (the chat with the answer's results and earlier chats beside it; it shows nothing of how the agent worked), and the feedback form |

### Use the client

```ts
import { AgentClient, queryRunner } from "@query-agent/client";

// Start it when the iModel opens: it runs the startup query list at once.
const client = AgentClient.start({ runQuery: queryRunner(imodel), imodelName: imodel.name, functionUrl });

const run = await client.ask("How many pipes are there?", {
  onStatus: (status) => show(status.phase), // "exploring", "thinking" or "querying"
});
console.log(run.answer, run.query);
```

### In Node

For tests and scripts, `@query-agent/client/node` starts iTwin.js's frontend in Node, so the
queries go to a backend by RPC, as a browser's do. It needs `global-jsdom` and `jsdom`.

```ts
import { connectionFromProps, startNodeFrontend } from "@query-agent/client/node";

await startNodeFrontend(backendUrl);
const imodel = connectionFromProps(connectionPropsFromTheBackend);
```

### The controls

```tsx
import { AgentWorkbench } from "@query-agent/react";
import "@query-agent/react/styles.css";

<AgentWorkbench
  client={client}                       // a started AgentClient, or undefined: "not set up"
  editorText={() => editor.value}       // sent with each question
  onUseQuery={(ecsql) => editor.setValue(ecsql)}
  onFeedback={(feedback) => send(feedback)} // only what the user saw and wrote, after they review it
/>
```

While a run is in progress the chat shows "Exploring", "Thinking" or "Running a query", with
moving dots. Nothing is uploaded by the controls: feedback goes to the host's `onFeedback`.

## Build and test

`npm install`, `npm run build`, `npm test`.
