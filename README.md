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