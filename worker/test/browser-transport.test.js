import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const start = html.indexOf('    function makeGMTransportError');
const end = html.indexOf('    function setGMTransportDiagnostics', start);
assert.ok(start > 0 && end > start, 'transport adapter source is present');

function loadAdapter() {
  const context = { AbortController, setTimeout, clearTimeout, validateGMRequest: () => ({ valid: true, errors: [] }), validateGMOutcome: outcome => ({ valid: outcome.protocol === 'gm_outcome_v1', errors: ['invalid outcome'], warnings: [] }) };
  vm.createContext(context);
  vm.runInContext(`let externalGMRequestPending = false;\n${html.slice(start, end)}\nthis.requestExternalGMOutcome = requestExternalGMOutcome;`, context);
  return context.requestExternalGMOutcome;
}

function loadAdapterWithTimers(setTimeoutImpl, clearTimeoutImpl = () => {}, contextOverrides = {}) {
  const context = { AbortController, setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl, validateGMRequest: () => ({ valid: true, errors: [] }), validateGMOutcome: outcome => ({ valid: outcome.protocol === 'gm_outcome_v1', errors: ['invalid outcome'], warnings: [] }), ...contextOverrides };
  vm.createContext(context);
  vm.runInContext(`let externalGMRequestPending = false;\n${html.slice(start, end)}\nthis.requestExternalGMOutcome = requestExternalGMOutcome;`, context);
  return context.requestExternalGMOutcome;
}

const request = { action: { id: 'action-1' }, route: { mode: 'gm' } };
const outcome = { protocol: 'gm_outcome_v1', actionId: 'action-1', effects: [], memory: [] };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const config = fetchImpl => ({ endpoint: 'https://worker.example/resolve-action', accessToken: 'secret', fetchImpl, timeoutMs: 1000 });

test('browser adapter parses and validates a correlated outcome without applying it', async () => {
  let sent;
  const result = await loadAdapter()(request, config(async (_url, init) => { sent = JSON.parse(init.body); return response({ ok: true, outcome, meta: { model: 'test' } }); }));
  assert.equal(result.ok, true); assert.equal(result.outcome.actionId, request.action.id);
  assert.deepEqual(sent, { request });
  assert.doesNotMatch(html.slice(start, end), /applyGMOutcome\s*\(/);
});

test('browser adapter rejects a wrong action ID', async () => {
  const result = await loadAdapter()(request, config(async () => response({ ok: true, outcome: { ...outcome, actionId: 'wrong' } })));
  assert.equal(result.ok, false); assert.equal(result.error.code, 'action_id_mismatch');
});

test('browser adapter reports invalid response JSON', async () => {
  const result = await loadAdapter()(request, config(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })));
  assert.equal(result.ok, false); assert.equal(result.error.code, 'invalid_response_json');
});

test('browser adapter never sends a local deterministic route', async () => {
  let calls = 0;
  const result = await loadAdapter()({ ...request, route: { mode: 'local' } }, config(async () => { calls++; return response({}); }));
  assert.equal(result.ok, false); assert.equal(result.error.code, 'non_gm_route'); assert.equal(calls, 0);
});

test('browser adapter suppresses a duplicate while pending', async () => {
  let release; let calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const adapter = loadAdapter();
  const first = adapter(request, config(async () => { calls++; await pending; return response({ ok: true, outcome }); }));
  await Promise.resolve();
  const second = await adapter(request, config(async () => { calls++; return response({ ok: true, outcome }); }));
  assert.equal(second.error.code, 'request_pending'); assert.equal(calls, 1);
  release(); await first;
});

test('browser adapter defaults to 60000 ms and aborts safely without world mutation', async () => {
  let configuredDelay;
  let timeoutCallback;
  let worldMutationCount = 0;
  const adapter = loadAdapterWithTimers((callback, delay) => {
    configuredDelay = delay;
    timeoutCallback = callback;
    return 1;
  }, () => {}, { applyGMOutcome: () => { worldMutationCount++; } });
  const resultPromise = adapter(request, {
    endpoint: 'https://worker.example/resolve-action',
    accessToken: 'secret',
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })
  });
  assert.equal(configuredDelay, 60000);
  timeoutCallback();
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'timeout');
  assert.equal(worldMutationCount, 0);
  assert.doesNotMatch(html.slice(start, end), /applyGMOutcome\s*\(/);
});

test('live bridge reuses manual builder and keeps manual controls', () => {
  const bridge = html.slice(html.indexOf('async function resolveManualActionWithAI'), html.indexOf('function validateAndApplyManualActionGMOutcome'));
  assert.match(bridge, /buildManualActionGMRequest\(\)/);
  assert.match(bridge, /action-gm-io/);
  assert.doesNotMatch(bridge, /applyGMOutcome\s*\(/);
  assert.match(html, /id="copy-action-gm-request"/);
  assert.match(html, /id="apply-action-gm-outcome"/);
  assert.match(html, /route\.mode === 'local'/);
});
