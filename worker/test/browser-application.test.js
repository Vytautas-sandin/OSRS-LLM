import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

function functionSource(name) {
  const start = html.indexOf(`    function ${name}(`);
  assert.ok(start >= 0, `${name} source is present`);
  const bodyStart = html.indexOf(') {', start) + 2;
  let depth = 0;
  for (let index = bodyStart; index < html.length; index++) {
    if (html[index] === '{') depth++;
    if (html[index] === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`${name} source is complete`);
}

const pillarA = 'base_prop:temple_pillar:0:18:20';
const pillarB = 'base_prop:temple_pillar:0:18:22';
const sage = 'sage';
const pillars = [{ id: pillarA, source: 'base_temple', state: {} }, { id: pillarB, source: 'base_temple', state: {} }];

function loadBoundary() {
  const context = {
    baseArchitecturalProps: pillars,
    inventory: [], groundItems: [], currentLevel: 0,
    normalizeGameActionId: value => typeof value === 'string' ? value : null,
    copyActionContextValue: value => structuredClone(value),
    safeMemoryText: value => typeof value === 'string' ? value.trim() : '',
    resolveLegacyDoorObject: () => null
  };
  vm.createContext(context);
  vm.runInContext([
    functionSource('resolveBaseTemplePillar'),
    functionSource('validateGMResolutionBindings'),
    functionSource('normalizeGMOutcomeMemory'),
    functionSource('translateGMOutcomeEffects'),
    'this.api = { validateGMResolutionBindings, translateGMOutcomeEffects };'
  ].join('\n'), context);
  return context.api;
}

const request = targetId => ({
  action: { id: 'action-1', targetId },
  context: { nearby: { entities: [{ id: pillarA }, { id: pillarB }, { id: sage }] }, actor: { inventory: [] }, toolCandidates: [] }
});
const outcome = (effectId, bindings, result = 'success') => ({
  protocol: 'gm_outcome_v1', actionId: 'action-1', narration: 'Resolved.', resolution: { result, reason: 'Supported.' },
  effects: effectId ? [{ op: 'damage_entity', id: effectId, damage: 'chipped' }] : [], memory: [], ...(bindings ? { bindings } : {})
});

function preflight(gmRequest, gmOutcome) {
  const api = loadBoundary();
  const binding = api.validateGMResolutionBindings(gmRequest, gmOutcome);
  if (!binding.valid) return { valid: false, errors: binding.errors };
  const translated = api.translateGMOutcomeEffects(gmRequest, gmOutcome, binding.resolved);
  return { valid: translated.errors.length === 0, ...translated };
}

test('unbound unresolved base pillar mutation is rejected before mutation', () => {
  const before = structuredClone(pillars);
  const result = preflight(request(null), outcome(pillarA));
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /requires an explicit bindings\.targetId/);
  assert.deepEqual(pillars, before);
});

test('matching late-bound base pillar mutation passes preflight', () => {
  const result = preflight(request(null), outcome(pillarA, { targetId: pillarA }));
  assert.equal(result.valid, true);
  assert.equal(result.translatedEffects[0].id, pillarA);
});

test('wrong late-bound pillar and Sage contradiction are rejected', () => {
  assert.equal(preflight(request(null), outcome(pillarB, { targetId: pillarA })).valid, false);
  const contradiction = preflight(request(null), outcome(pillarA, { targetId: sage }));
  assert.equal(contradiction.valid, false);
  assert.match(contradiction.errors[0], /does not agree with late-bound targetId sage/);
});

test('explicit base pillar target still passes without redundant binding', () => {
  assert.equal(preflight(request(pillarA), outcome(pillarA)).valid, true);
});

test('narration-only outcomes remain safe for every supported resolution result', () => {
  for (const result of ['success', 'failure', 'partial', 'blocked', 'uncertain']) {
    const checked = preflight(request(null), outcome(null, null, result));
    assert.equal(checked.valid, true);
    assert.equal(checked.translatedEffects.length, 0);
  }
});
