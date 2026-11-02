# iModulator CLI
The iModulator CLI tool uses iTwin.js to iTwin Platform APIs to help you work with iModels.  It is a developer focused tool for developers that want to create, update, transform and inspect iModels.

See [AGENT.md](./AGENT.md) for coding instructions.

## Running iModulator

To run iModulator CLI you must create a Client ID at https://developer.bentley.com that has Application Type: `Native`, Scopes `itwin-platform` and Redirect URIs `http://localhost:3000/signin-callback`

Create a `.env` file with the following contents.  Replace YOUR_CLIENT_ID with the one created in the developer portal.

```env
IMOD_CLIENT_ID=YOUR_CLIENT_ID
IMOD_SCOPE=itwin-platform
IMOD_REDIRECT_URI=http://localhost:3000/signin-callback
IMOD_ISSUER_URL=https://ims.bentley.com
```

### The query console's Assistant

The Assistant tab of `imod serve console` answers questions about the open iModel with the
query agent function, a separate service. To turn it on, add the function's URL to `.env`:

```env
IMOD_AGENT_FUNCTION_URL=<the function's URL>
```

The console passes this URL to the browser, and the browser sends each turn to the function at
`<url>/turn`. The function must allow the console's origin. Without the variable, or when the
function does not answer, the Assistant tab says the agent is not set up; the rest of the
console works as before.

The function may ask for an **access key**. The Assistant then shows a box for it above the chat,
with the function's reason (no key, a key it does not know, or a key that is used up). Paste the
key you were given there. It is kept in your browser and sent with every question. A new key starts
a new chat.

**What the agent sends.** The agent function and the model provider, Anthropic, are outside your machine, so:

| What | Goes to the function | Goes on to Anthropic |
|---|---|---|
| Your question | Yes | Yes |
| The text in the query editor | Yes | Yes, up to 4,000 characters |
| The iModel's name | Yes | Yes |
| The results of the startup queries about the iModel | Yes | Yes |
| Earlier questions and answers in the chat, with some of their rows | Yes | Yes, shortened |
| The rows and errors of the queries the agent runs on your iModel | Yes | Yes, up to the limits on results |
| The iModel file itself | No | No |

Do not use the Assistant on an iModel whose contents may not be shared in that way. The rest of the console does
not send your data anywhere.

See [CONSOLE.md](./plan/commands/serve/CONSOLE.md#assistant) for more about the tab.

Install packages and build:

```bash
npm install
npm run build
```

## Example workflow

Authenticate
```bash
npm run imod auth
```

Acquire briefcase id

```bash
npm run imod hub briefcase acquire-id -- --imodel-id <iModelId>
```

> Note the briefcase id out put to console you will need it for future steps

Download briefcase locally

```bash
npm run imod hub briefcase download -- --imodel-id <iModelId> --itwin-id <iTwinId> --briefcase-id <briefcaseId>
```

Partinate iModel, this moves all geometry streams larger than 1k to geometry parts.  Threshold is configurable, see help for details.

```bash
npm run imod edit partinate -- --imodel-id <iModelId> --briefcase-id <briefcaseId>
```

> Note it logs how many geometric element 3ds it partinated

Push changes to hub

```bash
npm run imod hub briefcase push -- --imodel-id <iModelId> --briefcase-id <briefcaseId>
```

You should now see a new changeset when you check your iModel online.

Clone iModel 

```bash
npm run imod hub clone -- --imodel-id <source iModelId> --target-itwin-id <iTwinId> --name "Clone of My iModel"
```

> NOTE: If you are using partinate to improve performance you must clone the iModel after partination to see the performance benefit.