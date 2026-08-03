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

Partinate iModel, this moves all geometry streams larger than 4k to geometry parts.  Threshold is configurable, see help for details.

```bash
npm run imod hub edit partinate -- --imodel-id <iModelId> --briefcase-id <briefcaseId>
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