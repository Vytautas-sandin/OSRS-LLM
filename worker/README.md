# Action GM Cloudflare Worker

This dependency-free Worker is the narrow, stateless transport between the public browser game and the OpenAI Responses API:

```text
Game -> gm_request_v1 -> Worker -> Responses API -> gm_outcome_v1
     -> browser validation -> MANUAL Validate / Apply -> canonical world state
```

The Worker accepts `POST /resolve-action` (and CORS preflight `OPTIONS`) with `{ "request": <gm_request_v1> }`. It enforces a 64 KB body limit, a small malformed-input boundary, exact configured-origin CORS, and bearer-token access before contacting OpenAI. It does not store or mutate world state. Model output is returned to the browser as untrusted data.

## Configuration and deployment

Install Wrangler and authenticate without committing generated credentials:

```sh
cd worker
npx wrangler login
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GM_ACCESS_TOKEN
npx wrangler deploy
```

Set `ALLOWED_ORIGIN` in `wrangler.jsonc` to the exact production GitHub Pages origin (scheme and host, with no path). Set `OPENAI_MODEL` there when a different server-selected model is required; its default is `gpt-5.6-terra`. The browser cannot choose the model, API URL, or server instructions.

For local development, create an untracked `.dev.vars` containing the required secrets, then run `npx wrangler dev`. **Never commit `.dev.vars`, API keys, or access-token values.** Run the dependency-free mocked tests with:

```sh
npm test
```

## Security boundary

- `OPENAI_API_KEY` exists only as a Worker secret.
- `GM_ACCESS_TOKEN` exists only as a Worker secret and in the user's browser session. It is separate from the OpenAI key.
- CORS limits browser origins but is not authentication; the bearer token is always required.
- Browser requests and model outcomes are untrusted. Player-authored injection inside game data cannot replace the Worker's server-level contract.
- The Worker sends only the bounded `gm_request_v1`; it does not accept client model/system/API settings or send source, HTML, Three.js state, `canvasEntities.all`, or legacy `gm_payload_v0`.
- Raw OpenAI responses, credentials, and authorization headers are neither logged nor returned.
- The browser's existing `validateGMOutcome` and application preflight remain authoritative. This milestone never applies an outcome automatically.

