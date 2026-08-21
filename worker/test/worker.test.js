import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, validateRequestBoundary } from '../src/index.js';

const origin = 'https://game.example';
const env = { GM_ACCESS_TOKEN: 'prototype-token', OPENAI_API_KEY: 'test-only-key', OPENAI_MODEL: 'test-model', ALLOWED_ORIGIN: origin };
const validRequest = () => ({ protocol: 'gm_request_v1', action: { id: 'action-1' }, context: {}, route: { mode: 'gm' }, task: { type: 'resolve_action' }, allowedEffects: [], rules: { maxEffects: 6 } });
const browserRequest = (body, options = {}) => new Request('https://worker.example/resolve-action', { method: options.method || 'POST', headers: { Origin: origin, Authorization: `Bearer ${options.token ?? env.GM_ACCESS_TOKEN}`, 'Content-Type': 'application/json', ...(options.headers || {}) }, body: options.method === 'OPTIONS' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
const modelFetch = async (_url, init) => {
  const sent = JSON.parse(init.body);
  assert.equal(sent.model, 'test-model');
  assert.equal(JSON.parse(sent.input).action.id, 'action-1');
  return new Response(JSON.stringify({ id: 'resp-1', model: 'test-model', output_text: JSON.stringify({ protocol: 'gm_outcome_v1', actionId: 'action-1', narration: 'Done.', resolution: { result: 'success', reason: 'Possible.' }, effects: [], memory: [] }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

test('valid boundary and model outcome succeed', async () => {
  assert.equal(validateRequestBoundary(validRequest()), null);
  const response = await handleRequest(browserRequest({ request: validRequest() }), env, modelFetch);
  const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.ok, true); assert.equal(body.outcome.actionId, 'action-1');
});

test('non-GM and malformed requests are rejected before OpenAI', async () => {
  let calls = 0; const fetchMock = async () => { calls++; return new Response(); };
  for (const request of [{ ...validRequest(), route: { mode: 'local' } }, { protocol: 'gm_request_v1' }]) {
    const response = await handleRequest(browserRequest({ request }), env, fetchMock);
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test('missing or incorrect access token is rejected', async () => {
  for (const token of ['', 'wrong']) {
    const response = await handleRequest(browserRequest({ request: validRequest() }, { token }), env, modelFetch);
    assert.equal(response.status, 401); assert.equal((await response.json()).error.code, 'unauthorized');
  }
});

test('oversized requests are rejected', async () => {
  const body = JSON.stringify({ request: validRequest(), padding: 'x'.repeat(65536) });
  const response = await handleRequest(browserRequest(body), env, modelFetch);
  assert.equal(response.status, 413);
});

test('OPTIONS returns configured CORS policy', async () => {
  const response = await handleRequest(browserRequest(null, { method: 'OPTIONS' }), env, modelFetch);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});

test('invalid browser JSON and invalid model JSON have stable errors', async () => {
  const malformed = await handleRequest(browserRequest('{'), env, modelFetch);
  assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error.code, 'invalid_json');
  const badModel = async () => new Response(JSON.stringify({ output_text: 'not-json' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const invalidOutcome = await handleRequest(browserRequest({ request: validRequest() }), env, badModel);
  assert.equal(invalidOutcome.status, 502); assert.equal((await invalidOutcome.json()).error.code, 'invalid_model_json');
});
