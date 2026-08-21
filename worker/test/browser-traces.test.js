import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const start = html.indexOf("    const GM_TRACE_PROTOCOL = 'gm_trace_v1'");
const end = html.indexOf('    function makeGMTransportError', start);
assert.ok(start > 0 && end > start, 'trace recorder source is present');

function loadRecorder() {
  const storage = new Map(); const count = { textContent: '' };
  const context = { Date, JSON, Number, Blob,
    document: { getElementById: id => id === 'gm-trace-count' ? count : null },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    getSerializedProtocolSize: value => { const source = JSON.stringify(value); return { characters: source.length, bytes: Buffer.byteLength(source), error: null }; }
  };
  vm.createContext(context);
  vm.runInContext(`${html.slice(start, end)}\nthis.api = { startGMTrace, recordGMTraceTransport, recordGMTraceApplication, buildGMTraceExport, clearGMTraces, getTraces: () => copyGMTraceValue(gmTraces), storageKey: GM_TRACE_STORAGE_KEY };`, context);
  return { api: context.api, storage, count };
}
const request = id => ({ protocol: 'gm_request_v1', action: { id, intent: 'Use the shovel.', targetId: null, toolId: 'shovel-1' }, route: { mode: 'gm' }, context: { actor: { level: 0, tile: { x: 4, y: 5 } }, nearby: { entities: [{ id: 'door-1', kind: 'door', name: 'Door', distance: 2, mesh: { runtime: true } }] }, toolCandidates: [{ id: 'shovel-1', name: 'Shovel', type: 'tool', tags: ['tool', 'dig'], mesh: { runtime: true } }] }, allowedEffects: [{ op: 'set_flag' }, { op: 'damage_entity' }] });
const outcome = id => ({ protocol: 'gm_outcome_v1', actionId: id, narration: 'Done.', resolution: { result: 'success', reason: 'Fair.' }, effects: [{ op: 'set_flag', key: 'done', value: true }], memory: [] });

test('one live action is updated through transport and apply without duplicate traces', () => {
  const { api } = loadRecorder(); api.startGMTrace(request('a1'));
  api.recordGMTraceTransport('a1', { ok: true, outcome: outcome('a1'), meta: { model: 'model' }, httpStatus: 200, outcomeValidation: { valid: true, errors: [], warnings: [] } }, 25);
  api.recordGMTraceApplication('a1', { status: 'applied', preflight: true, resolved: { targetId: 'door-1', toolId: 'shovel-1' }, diagnostics: [], appliedEffects: [{ op: 'set_flag' }], appliedMemory: ['fact'], rollback: { attempted: false, succeeded: null } });
  assert.equal(api.getTraces().length, 1); assert.equal(api.getTraces()[0].transport.status, 'received'); assert.equal(api.getTraces()[0].application.status, 'applied');
});

test('recorder retains the newest 30 traces and discards the oldest', () => {
  const { api } = loadRecorder(); for (let index = 0; index < 31; index++) api.startGMTrace(request(`a${index}`));
  assert.equal(api.getTraces().length, 30); assert.equal(api.getTraces()[0].actionId, 'a1');
});

test('transport failures, timeouts, and invalid outcomes remain representable', () => {
  const { api } = loadRecorder();
  api.startGMTrace(request('failure')); api.recordGMTraceTransport('failure', { ok: false, error: { code: 'unauthorized', message: 'Denied.' }, httpStatus: 401 }, 10);
  api.startGMTrace(request('timeout')); api.recordGMTraceTransport('timeout', { ok: false, error: { code: 'timeout', message: 'Timed out.' } }, 60000);
  api.startGMTrace(request('invalid')); api.recordGMTraceTransport('invalid', { ok: false, outcome: { protocol: 'bad' }, error: { code: 'invalid_gm_outcome', message: 'Invalid.' }, outcomeValidation: { valid: false, errors: ['bad protocol'], warnings: [] } }, 30);
  const traces = api.getTraces(); assert.deepEqual(traces.map(trace => trace.transport.errorCode), ['unauthorized', 'timeout', 'invalid_gm_outcome']); assert.equal(traces[2].validation.valid, false); assert.equal(traces[2].outcome.protocol, 'bad');
});

test('candidate and inventory tool snapshots are compact protocol data', () => {
  const { api } = loadRecorder(); api.startGMTrace(request('compact')); const snapshot = api.getTraces()[0].context;
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.nearbyCandidates[0])), { id: 'door-1', kind: 'door', name: 'Door', distance: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.toolCandidates[0])), { id: 'shovel-1', name: 'Shovel', type: 'tool', tags: ['tool', 'dig'] }); assert.doesNotMatch(JSON.stringify(snapshot), /runtime|mesh/);
});

test('export protocol and deterministic summary count outcomes, applications, effects, and errors', () => {
  const { api } = loadRecorder(); api.startGMTrace(request('ok')); api.recordGMTraceTransport('ok', { ok: true, outcome: outcome('ok'), httpStatus: 200, outcomeValidation: { valid: true, errors: [], warnings: [] } }, 20); api.recordGMTraceApplication('ok', { status: 'applied', preflight: true, appliedEffects: [], appliedMemory: [] });
  api.startGMTrace(request('bad')); api.recordGMTraceTransport('bad', { ok: false, error: { code: 'timeout', message: 'Timed out.' } }, 40); api.recordGMTraceApplication('bad', { status: 'rejected', preflight: false, diagnostics: ['no'] });
  const exported = JSON.parse(JSON.stringify(api.buildGMTraceExport('2026-01-01T00:00:00.000Z'))); assert.equal(exported.protocol, 'gm_trace_export_v1'); assert.deepEqual(exported.summary, { traceCount: 2, receivedCount: 1, errorCount: 1, validOutcomeCount: 1, appliedCount: 1, rejectedCount: 1, averageLatencyMs: 30, effectOpCounts: { set_flag: 1 }, errorCodeCounts: { timeout: 1 } });
});

test('tokens and endpoints are never sourced into traces or exports, and clear is isolated', () => {
  const { api, storage, count } = loadRecorder(); const world = { state: 'unchanged', memory: ['fact'], undo: 'snapshot', endpoint: 'https://worker.example', token: 'TOP-SECRET-TOKEN' };
  api.startGMTrace(request('private')); api.recordGMTraceTransport('private', { ok: false, error: { code: 'unauthorized', message: 'A valid token is required.' }, httpStatus: 401 }, 5);
  assert.doesNotMatch(JSON.stringify(api.buildGMTraceExport()), /TOP-SECRET-TOKEN|worker\.example|Authorization|Bearer TOP/); assert.ok(storage.has(api.storageKey)); api.clearGMTraces();
  assert.equal(api.getTraces().length, 0); assert.equal(storage.has(api.storageKey), false); assert.equal(count.textContent, 'GM traces: 0 / 30'); assert.deepEqual(world, { state: 'unchanged', memory: ['fact'], undo: 'snapshot', endpoint: 'https://worker.example', token: 'TOP-SECRET-TOKEN' });
});
