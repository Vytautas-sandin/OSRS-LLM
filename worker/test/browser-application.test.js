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
    functionSource('getOriginatingToolCandidate'),
    functionSource('isDiggingToolCandidate'),
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

function makeHeights(size = 41, value = 0) {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => value));
}

function loadTerrainBoundary(overrides = {}) {
  const store = new Map();
  const context = {
    GRID_SIZE: 40,
    LEVELS: { '0': { h: 0 }, '2': { h: 0 }, '-1': { h: -3 } },
    floorHeights: {},
    pathTiles: [{ x: 2, y: 2 }],
    unwalkables: { '0': [{ x: 5, y: 5 }], '2': [], '-1': [] },
    vHeights: { '0': makeHeights(), '2': makeHeights(), '-1': makeHeights() },
    BASE_V_HEIGHTS: { '0': makeHeights(), '2': makeHeights(), '-1': makeHeights() },
    currentLevel: '0',
    playerGridX: overrides.playerGridX ?? 10,
    playerGridY: overrides.playerGridY ?? 10,
    gmTerrain: [],
    gmObjects: [],
    gmMarkers: [],
    gmHotspots: [],
    gmTransitions: [],
    gmNPCs: [],
    gmWalls: [],
    gmFloors: [],
    gmRemovedWalls: [],
    groundItems: [],
    inventory: [{ id: 'base_shovel_01', name: 'Shovel' }],
    baseArchitecturalProps: [],
    baseTransitions: [],
    doors: [],
    allWalls: { '0': [], '2': [], '-1': [] },
    worldFlags: {},
    removedBaseGroundItemIds: new Set(),
    GM_SAVE_KEY: 'save',
    GM_UNDO_KEY: 'undo',
    ACTION_CONTEXT_LOCAL_TILE_RADIUS: 4,
    ACTION_CONTEXT_NEARBY_RADIUS: 8,
    ACTION_CONTEXT_NEARBY_MAX: 96,
    normalizeGMOp: value => String(value || '').trim().toLowerCase(),
    normalizeGameActionId: value => typeof value === 'string' ? value : null,
    copyActionContextValue: value => structuredClone(value),
    safeMemoryText: value => typeof value === 'string' ? value.trim() : '',
    distanceToPlayerTile: (x, y) => Math.hypot(x - context.playerGridX, y - context.playerGridY),
    directionToPlayerTile: () => 'nearby',
    getNearbyNPCs: () => [],
    getNearbyCanvasEntities: null,
    getLegacyDoorActionSnapshot: () => null,
    getBaseWallActionSnapshot: () => null,
    getGroundItemEntitySnapshots: () => [],
    resolveBaseTemplePillar: () => null,
    resolveLegacyDoorObject: () => null,
    findCanvasEntityRef: () => null,
    resolveActionEntityReference: () => null,
    isSafeGMFlag: () => true,
    preflightGMPlacement: effect => ({ x: Math.round(Number(effect.x)), y: Math.round(Number(effect.y)), level: String(effect.level ?? '0'), valid: true }),
    normalizeGMOutcomeMemory: null,
    sanitizeItemInstanceId: value => String(value || ''),
    gmItemIdExists: () => false,
    localStorage: {
      getItem: key => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: key => { store.delete(key); }
    },
    serializeWorldMemory: () => ({ summary: '', facts: [], quests: [] }),
    getBaseDoorSemanticStatesSnapshot: () => [],
    getBaseTemplePillarSemanticStatesSnapshot: () => [],
    getItemDefsSnapshot: () => [],
    getInventorySnapshot: () => [],
    getPersistentGroundItemsSnapshot: () => [],
    recordGMEvent: () => {},
    addLogMessage: () => {},
    loadGMWorld: silent => {
      const raw = context.localStorage.getItem(context.GM_SAVE_KEY);
      if (!raw) return false;
      const save = JSON.parse(raw);
      context.gmTerrain.splice(0, context.gmTerrain.length, ...(save.terrain || []));
      return true;
    }
  };
  vm.createContext(context);
  vm.runInContext([
    functionSource('isValidTile'),
    functionSource('getTileCenterHeight'),
    functionSource('getWalkableHeight'),
    functionSource('isTileProtected'),
    functionSource('canModifyVertex'),
    functionSource('isTileOccupiedByGM'),
    functionSource('isTileUnwalkable'),
    functionSource('normalizeTerrainMode'),
    functionSource('collectTerrainVertices'),
    functionSource('terrainPatchHeightAllowed'),
    functionSource('canModifyTerrainPatch'),
    functionSource('makeActionTileCandidate'),
    functionSource('getLocalActionTileCandidates'),
    functionSource('parseActionTileId'),
    functionSource('getOriginatingLocalTileCandidate'),
    functionSource('preflightGMLocalTerrainPlacement'),
    functionSource('preflightGMLocalPropPlacement'),
    functionSource('validateGMResolutionBindings'),
    functionSource('getOriginatingToolCandidate'),
    functionSource('isDiggingToolCandidate'),
    functionSource('getAuthoritativeDiggingToolCandidate'),
    functionSource('normalizeGMOutcomeMemory'),
    functionSource('translateGMOutcomeEffects'),
    functionSource('validateGMOutcomeAgainstCheck'),
    functionSource('getCanvasEntitySnapshot'),
    functionSource('getAllCanvasEntities'),
    functionSource('getNearbyCanvasEntities'),
    functionSource('toActionContextEntity'),
    functionSource('getNearbyActionContextEntities'),
    functionSource('buildGMWorldSave'),
    functionSource('storeGMUndoSnapshot'),
    functionSource('undoLastGMApply'),
    'this.api = { getLocalActionTileCandidates, translateGMOutcomeEffects, validateGMResolutionBindings, validateGMOutcomeAgainstCheck, getNearbyActionContextEntities, buildGMWorldSave, storeGMUndoSnapshot, undoLastGMApply };'
  ].join('\n'), context);
  return { api: context.api, context };
}

function terrainRequest(api, context, tileId = `tile:${context.currentLevel}:${context.playerGridX}:${context.playerGridY}`) {
  const candidates = api.getLocalActionTileCandidates();
  const tile = candidates.find(candidate => candidate.id === tileId);
  return {
    action: { id: 'dig-1', targetId: null, toolId: null },
    context: {
      actor: { inventory: [{ id: 'base_shovel_01', name: 'Shovel' }] },
      toolCandidates: [{ id: 'base_shovel_01', name: 'Shovel', type: 'tool', tags: ['tool', 'dig'] }],
      localTiles: { radius: 4, candidates },
      nearby: { entities: [] }
    },
    route: { mode: 'gm' },
    tile
  };
}

function terrainOutcome(tile, overrides = {}) {
  return {
    protocol: 'gm_outcome_v1',
    actionId: 'dig-1',
    narration: 'You dig into the ground.',
    resolution: { result: 'success', reason: 'The shovel bites into workable soil.' },
    effects: [{ op: 'set_terrain', id: 'terrain_patch_alpha', name: 'Disturbed Ground', tileId: tile.id, mode: 'dig', radius: 0, delta: 0.45, ...overrides.effect }],
    memory: [],
    ...(overrides.bindings ? { bindings: overrides.bindings } : {})
  };
}

test('local tile candidates are bounded and deterministic', () => {
  const { api } = loadTerrainBoundary();
  const first = api.getLocalActionTileCandidates();
  const second = api.getLocalActionTileCandidates();
  assert.equal(first.length <= 81, true);
  assert.deepEqual(first.map(tile => tile.id), second.map(tile => tile.id));
  assert.deepEqual(first[0], { id: 'tile:0:10:10', level: '0', x: 10, y: 10, distance: 0, terrain: 'ground', height: 0, walkable: true, occupied: false, protected: false, canDig: true });
});

test('ordinary ActionContext validation can pass without localTiles', () => {
  const context = {
    ACTION_CONTEXT_PROTOCOL: 'action_context_v1',
    ACTION_CONTEXT_NEARBY_MAX: 96,
    ACTION_CONTEXT_TOOL_MAX: 28,
    GAME_ACTION_SOURCES: new Set(['ui', 'text', 'system']),
    GAME_ACTION_ROUTING_MODES: new Set(['local', 'gm', 'hybrid', 'unknown'])
  };
  vm.createContext(context);
  vm.runInContext([
    functionSource('normalizeGameActionId'),
    functionSource('normalizeGameAction'),
    functionSource('validateGameAction'),
    functionSource('validateActionContext'),
    'this.validate = validateActionContext;'
  ].join('\n'), context);
  const action = {
    id: 'action-ordinary',
    source: 'text',
    actorId: 'player',
    verb: 'improvise',
    targetId: null,
    toolId: null,
    intent: 'I wave hello.',
    parameters: {},
    routing: { mode: 'unknown', reason: 'Late GM target resolution.' },
    createdAt: '2026-08-22T12:00:00.000Z'
  };
  const result = context.validate({
    protocol: 'action_context_v1',
    action,
    actor: { id: 'player' },
    target: null,
    tool: null,
    toolCandidates: [],
    nearby: { entities: [] },
    relevantState: {},
    anchors: []
  });
  assert.equal(result.valid, true);
});

test('terrain preflight accepts only originating safe local tile candidates', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = terrainRequest(api, context);
  const valid = api.translateGMOutcomeEffects(requestData, terrainOutcome(requestData.tile), { targetId: null, toolId: null });
  assert.equal(valid.valid, true);
  assert.equal(valid.translatedEffects[0].id, 'terrain_patch_alpha');
  assert.equal('state' in valid.translatedEffects[0], false);

  const distant = api.translateGMOutcomeEffects(requestData, terrainOutcome(requestData.tile, { effect: { tileId: 'tile:0:20:20', x: 20, y: 20 } }), { targetId: null, toolId: null });
  assert.equal(distant.valid, false);
  assert.match(distant.errors[0], /originating local tile candidate/);

  const protectedTile = { id: 'tile:0:5:5', level: '0', x: 5, y: 5, distance: 0, protected: true, occupied: false, canDig: false };
  const protectedRequest = { ...requestData, context: { ...requestData.context, localTiles: { radius: 4, candidates: [protectedTile] } } };
  const protectedResult = api.translateGMOutcomeEffects(protectedRequest, terrainOutcome(protectedTile), { targetId: null, toolId: null });
  assert.equal(protectedResult.valid, false);
  assert.match(protectedResult.errors[0], /protected|unsafe/);
});

test('digging terrain shape uses tileId without entity target binding or special id format', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 16, playerGridY: 10 });
  const requestData = terrainRequest(api, context, 'tile:0:16:10');
  const outcome = terrainOutcome(requestData.tile, { effect: { id: 'terrain_scuffed_ground_16_10' } });
  assert.equal('bindings' in outcome, false);

  const binding = api.validateGMResolutionBindings(requestData, outcome);
  assert.equal(binding.valid, true);
  assert.deepEqual(JSON.parse(JSON.stringify(binding.resolved)), { targetId: null, toolId: null });

  const translated = api.translateGMOutcomeEffects(requestData, outcome, binding.resolved);
  assert.equal(translated.valid, true);
  assert.equal(translated.translatedEffects.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(translated.translatedEffects[0])), {
    op: 'set_terrain',
    id: 'terrain_scuffed_ground_16_10',
    name: 'Disturbed Ground',
    tileId: 'tile:0:16:10',
    mode: 'dig',
    radius: 0,
    delta: 0.45,
    x: 16,
    y: 10,
    level: '0',
    valid: true
  });
});

test('tile ids remain invalid as entity target bindings', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 16, playerGridY: 10 });
  const requestData = terrainRequest(api, context, 'tile:0:16:10');
  const invalid = api.validateGMResolutionBindings(requestData, terrainOutcome(requestData.tile, { bindings: { targetId: 'tile:0:16:10' } }));
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors[0], /Binding targetId is not an originating target candidate/);
});

test('duplicate terrain patch ids and occupied terrain tiles are rejected', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = terrainRequest(api, context);
  context.gmTerrain.push({ id: 'terrain_patch_alpha', name: 'Disturbed Ground', x: 9, y: 9, level: '0', mode: 'dig' });
  const duplicateId = api.translateGMOutcomeEffects(requestData, terrainOutcome(requestData.tile), { targetId: null, toolId: null });
  assert.equal(duplicateId.valid, false);
  assert.match(duplicateId.errors[0], /terrain id already exists/);

  context.gmTerrain.splice(0, context.gmTerrain.length, { id: 'terrain_other', name: 'Existing Patch', x: 10, y: 10, level: '0', mode: 'dig' });
  const occupiedTile = api.translateGMOutcomeEffects(requestData, terrainOutcome(requestData.tile, { effect: { id: 'terrain_new_patch' } }), { targetId: null, toolId: null });
  assert.equal(occupiedTile.valid, false);
  assert.match(occupiedTile.errors[0], /terrain already exists/);
});

test('terrain patches persist, appear in later context, and undo restores prior terrain', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = terrainRequest(api, context);
  const translated = api.translateGMOutcomeEffects(requestData, terrainOutcome(requestData.tile, { effect: { state: { depth: 'shallow' } } }), { targetId: null, toolId: null });
  const patch = translated.translatedEffects[0];
  context.gmTerrain.push(patch);
  const save = api.buildGMWorldSave();
  assert.equal(save.terrain[0].id, 'terrain_patch_alpha');
  assert.deepEqual(save.terrain[0].state, { depth: 'shallow' });

  const nearby = api.getNearbyActionContextEntities();
  const terrain = nearby.find(entity => entity.id === 'terrain_patch_alpha');
  assert.equal(terrain.kind, 'terrain');
  assert.deepEqual(terrain.state, { depth: 'shallow' });

  context.gmTerrain.length = 0;
  assert.equal(api.storeGMUndoSnapshot('before_terrain'), true);
  context.gmTerrain.push(patch);
  assert.equal(api.undoLastGMApply(), true);
  assert.deepEqual(context.gmTerrain, []);
});

test('failed authoritative d20 cannot be paired with successful hole outcome', () => {
  const { api } = loadTerrainBoundary();
  const outcome = { actionId: 'dig-1', resolution: { result: 'success' } };
  const failedCheck = { actionId: 'dig-1', result: 'failure' };
  const validation = api.validateGMOutcomeAgainstCheck(outcome, failedCheck);
  assert.equal(validation.valid, false);
  assert.match(validation.errors[0], /authoritative check result/);
});

test('tool bindings must use an originating inventory tool candidate', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = terrainRequest(api, context);
  assert.equal(api.validateGMResolutionBindings(requestData, terrainOutcome(requestData.tile, { bindings: { toolId: 'base_shovel_01' } })).valid, true);
  const invalid = api.validateGMResolutionBindings(requestData, terrainOutcome(requestData.tile, { bindings: { toolId: 'ground_shovel' } }));
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors[0], /originating inventory tool candidate/);
});

test('dig terrain application accepts an unambiguous inventory digging tool without binding', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = terrainRequest(api, context);
  const unbound = api.translateGMOutcomeEffects(requestData, terrainOutcome(requestData.tile), { targetId: null, toolId: null });
  assert.equal(unbound.valid, true);
});

test('dig terrain application rejects missing, ambiguous, or unsuitable digging tools', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = terrainRequest(api, context);
  const wrongToolRequest = {
    ...requestData,
    context: {
      ...requestData.context,
      actor: { inventory: [{ id: 'base_shell_01', name: 'Shell' }] },
      toolCandidates: [{ id: 'base_shell_01', name: 'Shell', type: 'shell', tags: ['shell'] }]
    }
  };
  const wrongTool = api.translateGMOutcomeEffects(wrongToolRequest, terrainOutcome(requestData.tile, { bindings: { toolId: 'base_shell_01' } }), { targetId: null, toolId: 'base_shell_01' });
  assert.equal(wrongTool.valid, false);
  assert.match(wrongTool.errors[0], /digging tool/);

  const noToolRequest = {
    ...requestData,
    context: { ...requestData.context, actor: { inventory: [] }, toolCandidates: [] }
  };
  const noTool = api.translateGMOutcomeEffects(noToolRequest, terrainOutcome(requestData.tile), { targetId: null, toolId: null });
  assert.equal(noTool.valid, false);
  assert.match(noTool.errors[0], /digging tool/);

  const nonInventoryToolRequest = {
    ...requestData,
    action: { ...requestData.action, toolId: 'ground_shovel' },
    context: {
      ...requestData.context,
      actor: { inventory: [] },
      toolCandidates: [{ id: 'ground_shovel', name: 'Ground Shovel', type: 'tool', tags: ['tool', 'dig'] }]
    }
  };
  const nonInventory = api.translateGMOutcomeEffects(nonInventoryToolRequest, terrainOutcome(requestData.tile), { targetId: null, toolId: 'ground_shovel' });
  assert.equal(nonInventory.valid, false);
  assert.match(nonInventory.errors[0], /digging tool/);

  const ambiguousToolRequest = {
    ...requestData,
    context: {
      ...requestData.context,
      actor: { inventory: [{ id: 'base_shovel_01', name: 'Shovel' }, { id: 'base_spade_01', name: 'Spade' }] },
      toolCandidates: [
        { id: 'base_shovel_01', name: 'Shovel', type: 'tool', tags: ['tool', 'dig'] },
        { id: 'base_spade_01', name: 'Spade', type: 'tool', tags: ['tool', 'dig'] }
      ]
    }
  };
  const ambiguous = api.translateGMOutcomeEffects(ambiguousToolRequest, terrainOutcome(requestData.tile), { targetId: null, toolId: null });
  assert.equal(ambiguous.valid, false);
  assert.match(ambiguous.errors[0], /digging tool/);
});

test('create_prop without tileId uses general placement instead of local tile candidates', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = terrainRequest(api, context);
  delete requestData.context.localTiles;
  const outcome = {
    protocol: 'gm_outcome_v1',
    actionId: 'dig-1',
    narration: 'A small sign is placed nearby.',
    resolution: { result: 'success', reason: 'The placement is simple.' },
    effects: [{ op: 'create_prop', id: 'gm_prop_sign_01', name: 'Small Sign', x: 12, y: 10, level: '0', shape: 'sign' }],
    memory: []
  };
  const translated = api.translateGMOutcomeEffects(requestData, outcome, { targetId: null, toolId: null });
  assert.equal(translated.valid, true);
  assert.equal(translated.translatedEffects[0].id, 'gm_prop_sign_01');
  assert.equal(translated.translatedEffects[0].x, 12);
});
