# Action GM Cloudflare Worker

This dependency-free Worker is the narrow, stateless transport between the public browser game and Cloudflare Workers AI:

```text
Game -> gm_request_v1 -> Worker -> Cloudflare Workers AI -> gm_outcome_v1
     -> browser validation -> MANUAL Validate / Apply -> canonical world state
```

The Worker accepts `POST /resolve-action` (and CORS preflight `OPTIONS`) with `{ "request": <gm_request_v1> }`. It enforces a 64 KB body limit, a small malformed-input boundary, exact configured-origin CORS, and bearer-token access before invoking Workers AI. It does not store or mutate world state. Model output is returned to the browser as untrusted data.

## Configuration and deployment

Install Wrangler and authenticate without committing generated credentials:

```sh
cd worker
npx wrangler login
npx wrangler secret put GM_ACCESS_TOKEN
npx wrangler deploy
```

Deployment requires the `AI` Workers AI binding declared in `wrangler.jsonc`, `GM_ACCESS_TOKEN` as a Worker secret, and the server configuration variables `WORKERS_AI_MODEL` and `ALLOWED_ORIGIN`. Set `ALLOWED_ORIGIN` to the exact production GitHub Pages origin (scheme and host, with no path). `WORKERS_AI_MODEL` defaults to `@cf/meta/llama-3.1-8b-instruct-fast`. The browser cannot choose the model or server instructions.

For local development, create an untracked `.dev.vars` containing the required access token, then run `npx wrangler dev`. **Never commit `.dev.vars` or access-token values.** Players do not provide AI-provider API keys: inference uses the Worker's Cloudflare account through the `AI` binding. Run the dependency-free mocked tests with:

```sh
npm test
```

## Security boundary

- `GM_ACCESS_TOKEN` exists only as a Worker secret and in the user's browser session. It protects the game's Workers AI allocation; it is not an AI-provider credential.
- CORS limits browser origins but is not authentication; the bearer token is always required.
- Browser requests and model outcomes are untrusted. Player-authored injection inside game data cannot replace the Worker's server-level contract.
- The Worker sends only the bounded `gm_request_v1`; it does not accept client model/system/API settings or send source, HTML, Three.js state, `canvasEntities.all`, or legacy `gm_payload_v0`.
- Raw model responses, access tokens, and authorization headers are neither logged nor returned.
- The browser's existing `validateGMOutcome` and application preflight remain authoritative. This milestone never applies an outcome automatically.

