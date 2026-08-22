import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const start = html.indexOf('    function makeGMTransportError');
const end = html.indexOf('    function setGMTransportDiagnostics', start);
assert.ok(start > 0 && end > start, 'transport adapter source is present');

function loadAdapter() {
  const context = { AbortController, setTimeout, clearTimeout, validateGMRequest: () => ({ valid: true, errors: [] }), validateGMOutcome: outcome => ({ valid: outcome.protocol === 'gm_outcome_v1', errors: ['invalid outcome'], warnings: [] }), validateGMOutcomeAgainstCheck: () => ({ valid: true, errors: [] }) };
  vm.createContext(context);
  vm.runInContext(`let externalGMRequestPending = false;\n${html.slice(start, end)}\nthis.requestExternalGMOutcome = requestExternalGMOutcome;`, context);
  return context.requestExternalGMOutcome;
}

function loadAdapterWithTimers(setTimeoutImpl, clearTimeoutImpl = () => {}, contextOverrides = {}) {
  const context = { AbortController, setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl, validateGMRequest: () => ({ valid: true, errors: [] }), validateGMOutcome: outcome => ({ valid: outcome.protocol === 'gm_outcome_v1', errors: ['invalid outcome'], warnings: [] }), validateGMOutcomeAgainstCheck: () => ({ valid: true, errors: [] }), ...contextOverrides };
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

test('dev panel presents Action GM as the normal AI-facing workflow', () => {
  const panelStart = html.indexOf('<div id="dev-panel">');
  const legacyStart = html.indexOf('<details id="legacy-gm-section"', panelStart);
  const legacyEnd = html.indexOf('</details>', legacyStart);
  assert.ok(panelStart > 0 && legacyStart > panelStart && legacyEnd > legacyStart);

  const normalPanel = html.slice(panelStart, legacyStart);
  const legacyPanel = html.slice(legacyStart, legacyEnd);
  assert.match(normalPanel, /Action GM Panel/);
  assert.match(normalPanel, /<summary>Action GM · gm_request_v1 \/ gm_outcome_v1<\/summary>/);
  assert.match(normalPanel, /<summary>Live Transport<\/summary>/);
  assert.match(normalPanel, /id="player-action"/);
  assert.match(normalPanel, /id="copy-action-gm-request"/);
  assert.match(normalPanel, /id="resolve-action-ai"/);
  assert.match(normalPanel, /id="apply-action-gm-outcome"/);
  assert.match(normalPanel, /id="action-gm-io"/);
  assert.match(normalPanel, /id="save-world-state"/);
  assert.match(normalPanel, /id="load-world-state"/);
  assert.match(normalPanel, /id="undo-gm-apply"/);
  assert.match(normalPanel, /id="look-around-dev"/);
  assert.match(normalPanel, /id="world-summary"/);
  assert.match(normalPanel, /id="world-memory"/);
  assert.match(normalPanel, /id="gm-trace-count"/);
  assert.doesNotMatch(normalPanel, /id="copy-gm-payload"|id="copy-gm-prompt"|id="copy-adventure-seed"|id="apply-llm-json"|id="validate-llm-json"|id="llm-io"/);

  assert.match(legacyPanel, /hidden/);
  assert.match(legacyPanel, /Deprecated Legacy GM/);
  assert.match(legacyPanel, /id="copy-gm-payload"/);
  assert.match(legacyPanel, /id="copy-gm-prompt"/);
  assert.match(legacyPanel, /id="copy-adventure-seed"/);
  assert.match(legacyPanel, /id="apply-llm-json"/);
  assert.match(legacyPanel, /id="validate-llm-json"/);
  assert.match(legacyPanel, /id="llm-io"/);
  assert.match(html, /legacygm/);
});

test('fresh manual prose ignores stale interaction target but preserves active use-item selection', () => {
  const selectionStart = html.indexOf('    function getManualActionGMSelection()');
  const selectionEnd = html.indexOf('    function setActionGMDiagnostics', selectionStart);
  const builderStart = html.indexOf('    function buildManualActionGMRequest()');
  const builderEnd = html.indexOf('    function copyManualActionGMRequest', builderStart);
  assert.ok(selectionStart > 0 && selectionEnd > selectionStart && builderStart > selectionEnd && builderEnd > builderStart);

  const build = selectedUseItem => {
    const context = {
      document: { getElementById: id => id === 'player-action' ? { value: 'I chip the pillar with my shovel.' } : null },
      getLastInteractionTarget: () => ({ id: 'sage', name: 'Sage' }),
      getSelectedUseItemSnapshot: () => selectedUseItem,
      normalizeGameActionId: value => typeof value === 'string' && value ? value : null,
      createGameAction: action => ({ ...action, targetId: action.targetId ?? null, toolId: action.toolId ?? null }),
      buildActionContext: action => ({ action }),
      routeGameAction: () => ({ mode: 'gm' }),
      buildGMRequest: (action, actionContext, route) => ({ ok: true, request: { action, context: actionContext, route }, errors: [] })
    };
    vm.createContext(context);
    vm.runInContext(`${html.slice(selectionStart, selectionEnd)}\n${html.slice(builderStart, builderEnd)}\nthis.generated = buildManualActionGMRequest();`, context);
    return JSON.parse(JSON.stringify(context.generated.action));
  };

  assert.deepEqual({ ...build(null) }, {
    source: 'text', actorId: 'player', verb: 'improvise', intent: 'I chip the pillar with my shovel.',
    targetId: null, toolId: null, routing: { mode: 'unknown', reason: null }
  });
  assert.equal(build({ id: 'base_shovel_01', name: 'Shovel' }).toolId, 'base_shovel_01');
});

test('transport supports adjudication then authoritative checked resolution with one action ID', async () => {
  const calls = [];
  const adapter = loadAdapterWithTimers(setTimeout, clearTimeout, {
    validateGMAdjudication: value => ({ valid: value.actionId === 'action-1', errors: [] }),
    validateGMOutcomeAgainstCheck: (value, check) => ({ valid: value.resolution?.result === check.result, errors: [] })
  });
  const adjudication = { protocol: 'gm_adjudication_v1', actionId: 'action-1', mode: 'check', reason: 'Uncertain.', check: { label: 'athletics', difficulty: 'moderate' } };
  const checkResult = { protocol: 'gm_check_result_v1', actionId: 'action-1', label: 'athletics', difficulty: 'moderate', dc: 15, roll: 15, modifier: 0, total: 15, result: 'success' };
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return calls.length === 1 ? response({ ok: true, adjudication }) : response({ ok: true, outcome: { ...outcome, resolution: { result: 'success' } } }); };
  const adjudicated = await adapter(request, { ...config(fetchImpl), adjudicate: true });
  assert.equal(adjudicated.ok, true);
  const resolved = await adapter(request, { ...config(fetchImpl), adjudication, checkResult });
  assert.equal(resolved.ok, true); assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/adjudicate-action$/); assert.deepEqual(calls[0].body, { request });
  assert.deepEqual(calls[1].body, { request, adjudication, checkResult });
});
