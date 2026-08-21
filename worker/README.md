# Action GM Cloudflare Worker

This dependency-free Worker is the narrow, stateless transport between the public browser game and Cloudflare Workers AI:

```text
Game -> gm_request_v1 -> Worker -> Cloudflare Workers AI -> gm_outcome_v1
     -> browser validation -> MANUAL Validate / Apply -> canonical world state
```

The Worker accepts `POST /resolve-action` (and CORS preflight `OPTIONS`) with `{ "request": <gm_request_v1> }`. It enforces a 64 KB body limit, a small malformed-input boundary, exact configured-origin CORS, and bearer-token access before inference through its `AI` binding. It does not store or mutate world state. Model output is returned to the browser as untrusted data.

## Configuration and deployment

Install Wrangler and authenticate without committing generated credentials:

```sh
cd worker
npx wrangler login
npx wrangler secret put GM_ACCESS_TOKEN
npx wrangler deploy
```

`wrangler.jsonc` declares the official `AI` binding and exposes it to the Worker as `env.AI`. Set `ALLOWED_ORIGIN` to the exact production GitHub Pages origin (scheme and host, with no path). Set `WORKERS_AI_MODEL` there when a different server-selected Workers AI model is required; its default is `@cf/zai-org/glm-4.7-flash`. The browser cannot choose the model or server instructions.

For local development, create an untracked `.dev.vars` containing only the prototype access token, then run `npx wrangler dev`. **Never commit `.dev.vars` or access-token values.** Run the dependency-free mocked tests with:

```sh
npm test
```

## Security boundary

- Players do not provide AI-provider API keys. Inference uses the game owner's Cloudflare Workers AI allocation.
- `GM_ACCESS_TOKEN` exists only as a Worker secret and in the user's browser session. It is temporary prototype access control for that allocation, not an AI-provider credential.
- `AI` is a Cloudflare Workers AI binding; `WORKERS_AI_MODEL` and `ALLOWED_ORIGIN` are server-controlled configuration, not browser inputs.
- CORS limits browser origins but is not authentication; the bearer token is always required.
- Browser requests and model outcomes are untrusted. Player-authored injection inside game data cannot replace the Worker's server-level contract.
- The Worker sends only the bounded `gm_request_v1`; it does not accept client model/system/API settings or send source, HTML, Three.js state, `canvasEntities.all`, or legacy `gm_payload_v0`.
- Raw Workers AI responses, internal errors, and authorization headers are neither logged nor returned.
- The browser's existing `validateGMOutcome` and application preflight remain authoritative. This milestone never applies an outcome automatically.
