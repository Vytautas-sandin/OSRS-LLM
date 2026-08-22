import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const start = html.indexOf('    const GM_DIFFICULTY_DCS');
const end = html.indexOf('    function validateGMOutcome(outcome', start);
assert.ok(start > 0 && end > start);
const context = { Math, Object, Number, Error };
vm.createContext(context);
vm.runInContext(`${html.slice(start, end)}\nthis.api = { GM_DIFFICULTY_DCS, validateGMAdjudication, createGMCheckResult, validateGMOutcomeAgainstCheck };`, context);
const api = context.api;
const checked = { protocol: 'gm_adjudication_v1', actionId: 'a1', mode: 'check', reason: 'Uncertain.', check: { label: 'climbing', difficulty: 'moderate' } };

test('browser owns the exact DC table and injectable deterministic d20', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(api.GM_DIFFICULTY_DCS)), { easy: 10, moderate: 15, hard: 20, extreme: 25 });
  const success = api.createGMCheckResult(checked, () => 0.70); // floor(14)+1 = 15
  const failure = api.createGMCheckResult(checked, () => 0.65); // floor(13)+1 = 14
  assert.deepEqual(JSON.parse(JSON.stringify(success)), { protocol: 'gm_check_result_v1', actionId: 'a1', label: 'climbing', difficulty: 'moderate', dc: 15, roll: 15, modifier: 0, total: 15, result: 'success' });
  assert.equal(failure.roll, 14); assert.equal(failure.result, 'failure');
  for (const value of [0, 0.049, 0.5, 0.999999]) assert.ok(Number.isInteger(api.createGMCheckResult(checked, () => value).roll));
});

test('direct adjudication creates no roll and validates without check', () => {
  const direct = { protocol: 'gm_adjudication_v1', actionId: 'a1', mode: 'direct', reason: 'Routine.' };
  assert.equal(api.validateGMAdjudication(direct, 'a1').valid, true);
  assert.throws(() => api.createGMCheckResult(direct, () => 0.5), /check adjudication/i);
});

test('browser contradiction helper accepts matching and rejects reversed outcomes', () => {
  const check = api.createGMCheckResult(checked, () => 0.70);
  assert.equal(api.validateGMOutcomeAgainstCheck({ actionId: 'a1', resolution: { result: 'success' } }, check).valid, true);
  assert.equal(api.validateGMOutcomeAgainstCheck({ actionId: 'a1', resolution: { result: 'failure' } }, check).valid, false);
  assert.equal(api.validateGMOutcomeAgainstCheck({ actionId: 'wrong', resolution: { result: 'success' } }, check).valid, false);
});
