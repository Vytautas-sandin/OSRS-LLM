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
    functionSource('isSearchInvestigateAction'),
    functionSource('isSearchInvestigateGMRequest'),
    functionSource('isNPCDialogueAction'),
    functionSource('isItemToNPCAction'),
    functionSource('getOriginatingActionEntityCandidate'),
    functionSource('isNPCDialogueGMRequest'),
    functionSource('isItemToNPCGMRequest'),
    functionSource('isItemTransferAction'),
    functionSource('getResolvedNPCInteractionTarget'),
    functionSource('getResolvedDialogueNPCTarget'),
    functionSource('getSelectedInventoryInteractionItem'),
    `const GM_DIALOGUE_NPC_STATE_KEYS = new Set(['mood', 'attitude', 'topic', 'suspicion', 'trust', 'lastHeard']);`,
    functionSource('isSafeNPCDialogueState'),
    functionSource('validateGMResolutionBindings'),
    functionSource('getOriginatingToolCandidate'),
    functionSource('isDiggingToolCandidate'),
    functionSource('normalizeGMOutcomeMemory'),
    functionSource('getGMSearchPhysicalRevealEffects'),
    functionSource('getGMSearchPhysicalDiscoveryClaim'),
    functionSource('validateGMSearchOutcomeDiscoveryConsistency'),
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

function makeSceneNode() {
  return {
    children: [],
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    rotation: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    userData: {},
    visible: true,
    add(child) { this.children.push(child); },
    remove(child) { this.children = this.children.filter(entry => entry !== child); },
    clone() { return makeSceneNode(); }
  };
}

function loadTerrainBoundary(overrides = {}) {
  const store = new Map();
  const context = {
    GRID_SIZE: 40,
    TILE_SIZE: 1,
    LEVELS: { '0': { h: 0 }, '2': { h: 0 }, '-1': { h: -3 } },
    WORLD_ANCHORS: {},
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
    levelGroups: { '-1': makeSceneNode(), '0': makeSceneNode(), '2': makeSceneNode() },
    walkables: { '-1': [], '0': [], '2': [] },
    interactables: [],
    gmNPCs: [],
    npcs: [],
    gmWalls: [],
    gmFloors: [],
    gmRemovedWalls: [],
    groundItems: [],
    inventory: [{ id: 'base_shovel_01', name: 'Shovel' }],
    player: { position: { y: 0 }, lookAt: () => {} },
    targetMovePos: { copy: () => {} },
    baseArchitecturalProps: [],
    baseTransitions: [],
    doors: [],
    allWalls: { '0': [], '2': [], '-1': [] },
    scene: { background: null },
    ambientLight: { intensity: 0, color: { value: null, set(value) { this.value = value; } } },
    dirLight: { intensity: 0, color: { value: null, set(value) { this.value = value; } } },
    worldFlags: {},
    worldMemory: { summary: '', facts: [], quests: {} },
    gmEvents: [{ type: 'memory_fact_added', level: '0', playerTile: { x: 10, y: 10 }, detail: { text: 'Sage noticed the shell.' } }],
    GM_MEMORY_LIMIT: 40,
    GM_OUTCOME_APPLICATION_PROTOCOL: 'gm_outcome_application_v1',
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
    getItemSnapshot: value => value ? { id: value.id, type: value.type || value.baseType || 'shovel', baseType: value.baseType || value.type || 'shovel', name: value.name || value.id, tags: value.tags || [] } : null,
    distanceToPlayerTile: (x, y) => Math.hypot(x - context.playerGridX, y - context.playerGridY),
    directionToPlayerTile: () => 'nearby',
    getNearbyNPCs: (radius = 6) => context.npcs
      .filter(npc => npc.level === context.currentLevel && Math.max(Math.abs(npc.gridX - context.playerGridX), Math.abs(npc.gridY - context.playerGridY)) <= radius)
      .map(npc => ({ id: npc.id, name: npc.name || npc.id, type: npc.type, x: npc.gridX, y: npc.gridY, note: npc.note || '', gmCreated: !!npc.gmCreated, state: npc.state || {} })),
    getNearbyCanvasEntities: null,
    getLegacyDoorActionSnapshot: () => null,
    getBaseWallActionSnapshot: () => null,
    getGroundItemEntitySnapshots: () => [],
    resolveBaseTemplePillar: () => null,
    resolveLegacyDoorObject: () => null,
    findCanvasEntityRef: () => null,
    resolveActionEntityReference: () => null,
    isSafeGMFlag: () => true,
    validateGMRequest: () => ({ valid: true, errors: [], warnings: [] }),
    validateGMOutcome: () => ({ valid: true, errors: [], warnings: [] }),
    preflightGMPlacement: effect => ({ x: Math.round(Number(effect.x)), y: Math.round(Number(effect.y)), level: String(effect.level ?? '0'), valid: true }),
    normalizeGMOutcomeMemory: null,
    sanitizeItemInstanceId: value => String(value || ''),
    gmItemIdExists: id => context.inventory.some(item => item?.id === id) || context.groundItems.some(item => item?.hitBox?.userData?.item?.id === id),
    localStorage: {
      getItem: key => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: key => { store.delete(key); }
    },
    serializeWorldMemory: () => ({ summary: '', facts: [], quests: [] }),
    getBaseDoorSemanticStatesSnapshot: () => [],
    getBaseTemplePillarSemanticStatesSnapshot: () => [],
    getBaseNPCSemanticStatesSnapshot: () => [],
    getItemDefsSnapshot: () => [],
    getInventorySnapshot: () => [],
    getPersistentGroundItemsSnapshot: () => [],
    getEventsSinceLastGM: () => context.gmEvents,
    recordGMEvent: () => {},
    addLogMessage: () => {},
    renderWorldMemoryUI: () => {},
    saveGMWorld: () => true,
    restoreBaseTerrainHeights: () => true,
    rebuildTerrainMesh: () => true,
    getGridWorldPos: (x, y, level = '0') => ({ x, y: context.LEVELS[String(level)]?.h || 0, z: y }),
    buildWall: (wall, level, height) => {
      const mesh = makeSceneNode();
      mesh.userData = { wall, sourceLevel: level, height };
      wall.mesh = mesh;
      context.levelGroups[level].add(mesh);
      return mesh;
    },
    spawnNPC: (id, name, x, y, level, type, options = {}) => {
      const npc = {
        id,
        name,
        type,
        gridX: x,
        gridY: y,
        level,
        gmCreated: !!options.gmCreated,
        note: options.note || '',
        state: options.state || {},
        mesh: makeSceneNode(),
        hitbox: makeSceneNode(),
        pathQueue: [],
        isMoving: false
      };
      npc.hitbox.userData = { npcId: id, sourceLevel: level, interactX: x, interactY: y };
      context.npcs.push(npc);
      context.levelGroups[level].add(npc.mesh);
      context.interactables.push(npc.hitbox);
      return npc;
    },
    DIALOGUES: {},
    recordGMCommandHistory: () => {},
    hasGMUndoSnapshot: () => true,
    getGMOutcomeApplicationDiagnostics: () => ({}),
    loadGMWorld: silent => {
      const raw = context.localStorage.getItem(context.GM_SAVE_KEY);
      if (!raw) return false;
      const save = JSON.parse(raw);
      Object.keys(context.worldFlags).forEach(key => delete context.worldFlags[key]);
      if (save.flags && typeof save.flags === 'object') Object.assign(context.worldFlags, save.flags);
      if (context.worldFlags.scene_time && typeof context.applyGMSceneTimeVisuals === 'function') context.applyGMSceneTimeVisuals(context.worldFlags.scene_time);
      else if (typeof context.resetGMSceneTimeVisuals === 'function') context.resetGMSceneTimeVisuals();
      context.gmTerrain.splice(0, context.gmTerrain.length, ...(save.terrain || []));
      context.gmObjects.splice(0, context.gmObjects.length, ...(save.objects || []));
      context.gmWalls.splice(0, context.gmWalls.length, ...(save.walls || []));
      context.gmFloors.splice(0, context.gmFloors.length, ...(save.floors || []));
      context.gmNPCs.splice(0, context.gmNPCs.length, ...(save.npcs || []));
      context.npcs.splice(0, context.npcs.length, ...(save.npcs || []).map(npc => ({ ...npc, gridX: npc.x, gridY: npc.y, gmCreated: true, state: npc.state || {} })));
      context.worldMemory.facts.splice(0, context.worldMemory.facts.length, ...((save.memory && save.memory.facts) || []));
      return true;
    },
    THREE: {
      Group: function Group() { return makeSceneNode(); },
      Mesh: function Mesh() { return makeSceneNode(); },
      MeshLambertMaterial: function MeshLambertMaterial(options = {}) { return { ...options, clone() { return { ...this, clone: this.clone }; } }; },
      MeshBasicMaterial: function MeshBasicMaterial(options = {}) { return { ...options, clone() { return { ...this, clone: this.clone }; } }; },
      BoxGeometry: function BoxGeometry() { return {}; },
      CylinderGeometry: function CylinderGeometry() { return {}; },
      ConeGeometry: function ConeGeometry() { return {}; },
      TorusGeometry: function TorusGeometry() { return {}; },
      CircleGeometry: function CircleGeometry() { return {}; },
      PlaneGeometry: function PlaneGeometry() { return {}; },
      DodecahedronGeometry: function DodecahedronGeometry() { return {}; },
      SphereGeometry: function SphereGeometry() { return {}; },
      Color: function Color(value) { return { value }; },
      DoubleSide: 'DoubleSide'
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
    functionSource('addUnwalkableTile'),
    functionSource('removeUnwalkableTile'),
    functionSource('setGMObjectBlocking'),
    functionSource('isTilePlaceableForGM'),
    functionSource('findNearbyFreeTileFrom'),
    functionSource('normalizeAnchorId'),
    functionSource('resolveGMPlacement'),
    functionSource('normalizeTerrainMode'),
    functionSource('collectTerrainVertices'),
    functionSource('terrainPatchHeightAllowed'),
    functionSource('canModifyTerrainPatch'),
    functionSource('clampTerrainHeight'),
    functionSource('applyTerrainPatchToHeights'),
    functionSource('rebuildGMTerrainForLevel'),
    functionSource('createGMTerrainPatch'),
    functionSource('removeGMTerrainPatch'),
    functionSource('makeActionTileCandidate'),
    functionSource('getLocalActionTileCandidates'),
    functionSource('normalizeMemoryFacts'),
    functionSource('serializeWorldMemory'),
    `const ACTION_CONTEXT_MEMORY_FACT_LIMIT = 8;`,
    `const ACTION_CONTEXT_MEMORY_QUEST_LIMIT = 4;`,
    `const ACTION_CONTEXT_MEMORY_SUMMARY_LIMIT = 800;`,
    `const ACTION_CONTEXT_MEMORY_STOP_WORDS = new Set(['about', 'after', 'again', 'anything', 'around', 'because', 'before', 'being', 'close', 'could', 'found', 'from', 'ground', 'have', 'here', 'into', 'nearby', 'player', 'same', 'search', 'should', 'something', 'tell', 'that', 'their', 'there', 'thing', 'this', 'with', 'would']);`,
    functionSource('getActionMemoryTerms'),
    functionSource('memoryTextMatchesTerms'),
    functionSource('getRelevantActionMemory'),
    functionSource('addWorldMemoryFact'),
    functionSource('isSearchInvestigateAction'),
    functionSource('isNPCDialogueAction'),
    functionSource('isItemToNPCAction'),
    functionSource('parseActionTileId'),
    functionSource('getOriginatingLocalTileCandidate'),
    functionSource('preflightGMLocalTerrainPlacement'),
    functionSource('preflightGMLocalPropPlacement'),
    functionSource('preflightGMLocalItemPlacement'),
    functionSource('preflightGMLocalTransitionPlacement'),
    functionSource('preflightGMRawSearchTransitionPlacement'),
    functionSource('isSearchInvestigateGMRequest'),
    functionSource('isStableGMTransitionId'),
    functionSource('normalizeGMSearchPassageShape'),
    functionSource('getGMSearchPhysicalRevealEffects'),
    functionSource('getGMSearchPhysicalDiscoveryClaim'),
    functionSource('validateGMSearchOutcomeDiscoveryConsistency'),
    functionSource('preflightGMSearchDiscoveryPlacement'),
    functionSource('getOriginatingActionEntityCandidate'),
    functionSource('isNPCDialogueGMRequest'),
    functionSource('isItemToNPCGMRequest'),
    functionSource('isItemTransferAction'),
    functionSource('getResolvedNPCInteractionTarget'),
    functionSource('getResolvedDialogueNPCTarget'),
    functionSource('getSelectedInventoryInteractionItem'),
    `const GM_DIALOGUE_NPC_STATE_KEYS = new Set(['mood', 'attitude', 'topic', 'suspicion', 'trust', 'lastHeard']);`,
    functionSource('isSafeNPCDialogueState'),
    functionSource('setDialogueNPCState'),
    functionSource('validateGMResolutionBindings'),
    functionSource('getOriginatingToolCandidate'),
    functionSource('isDiggingToolCandidate'),
    functionSource('getAuthoritativeDiggingToolCandidate'),
    functionSource('getInventorySnapshot'),
    functionSource('normalizeGMOutcomeMemory'),
    functionSource('translateGMOutcomeEffects'),
    functionSource('validateGMOutcomeApplication'),
    functionSource('applyTranslatedGMOutcomeEffect'),
    'let lastGMOutcomeApplicationDiagnostic = null;',
    functionSource('applyGMOutcome'),
    functionSource('normalizeMarkerColor'),
    functionSource('parseMarkerColor'),
    functionSource('buildGMObjectVisual'),
    functionSource('addGMObjectHighlight'),
    functionSource('createGMObject'),
    functionSource('normalizeWallDir'),
    functionSource('createGMWall'),
    functionSource('createGMFloor'),
    functionSource('normalizeStructureId'),
    functionSource('hashGMSettlementSeed'),
    functionSource('clampSettlementSize'),
    functionSource('normalizeGMSettlementPlacementMode'),
    functionSource('normalizeGMSettlementFitMode'),
    functionSource('normalizeGMSettlementDirection'),
    functionSource('getGMSettlementFootprintCandidates'),
    functionSource('normalizeSettlementFeature'),
    functionSource('getGMSettlementBlockedTileSets'),
    functionSource('getGMSettlementKnownWorldBounds'),
    functionSource('getGMSettlementTileBlockReason'),
    functionSource('isGMSettlementSourceTileSafe'),
    functionSource('evaluateGMSettlementParcel'),
    functionSource('findGMSettlementParcel'),
    functionSource('getGMSettlementDirectionOrder'),
    functionSource('makeGMSettlementFrontierCandidates'),
    functionSource('findGMSettlementFrontierParcel'),
    functionSource('createGMSettlement'),
    `const GM_SCENE_TIME_PROFILES = {
        day: { bg: 0x87ceeb, ambient: 0xffffff, ambientIntensity: 0.65, directional: 0xffffff, directionalIntensity: 0.6 },
        dawn: { bg: 0xd8b07a, ambient: 0xffdfba, ambientIntensity: 0.48, directional: 0xffc27a, directionalIntensity: 0.45 },
        dusk: { bg: 0x6d587d, ambient: 0xb89ac9, ambientIntensity: 0.38, directional: 0xff9a66, directionalIntensity: 0.32 },
        night: { bg: 0x141a33, ambient: 0x8390c8, ambientIntensity: 0.22, directional: 0x8fa8ff, directionalIntensity: 0.18 }
    };`,
    functionSource('normalizeGMSceneTime'),
    functionSource('setLightColor'),
    functionSource('applyGMSceneTimeVisuals'),
    functionSource('resetGMSceneTimeVisuals'),
    functionSource('setGMSceneTime'),
    functionSource('normalizeGMVisitorTheme'),
    functionSource('resolveGMVisitorTarget'),
    functionSource('isGMVisitorTileSafe'),
    functionSource('findGMVisitorTiles'),
    functionSource('getGMVisitorName'),
    functionSource('getGMVisitorRole'),
    functionSource('spawnGMVisitors'),
    functionSource('buildGMTransitionVisual'),
    functionSource('createGMTransition'),
    functionSource('createGMNPC'),
    functionSource('normalizeGameAction'),
    functionSource('createGameAction'),
    functionSource('createTerrainAction'),
    functionSource('createGameActionExecutionResult'),
    functionSource('terrainActionMode'),
    functionSource('canonicalTerrainPatchId'),
    functionSource('findTerrainPatchAt'),
    functionSource('isInventoryDiggingTool'),
    functionSource('inventoryHasDiggingTool'),
    functionSource('validateLocalTerrainAction'),
    functionSource('resolveLocalTerrainAction'),
    functionSource('getTerrainExecutionDiagnostic'),
    functionSource('getShovelGroundActionDescriptors'),
    functionSource('validateGMOutcomeAgainstCheck'),
    functionSource('getCanvasEntitySnapshot'),
    functionSource('getAllCanvasEntities'),
    functionSource('getNearbyCanvasEntities'),
    functionSource('getGMMapNPCGlyphs'),
    functionSource('makeGMMapExportTileKey'),
    functionSource('setGMMapGlyph'),
    functionSource('getGMGeneratedSettlementSummaries'),
    functionSource('buildGMMapExport'),
    functionSource('copyGMMapExport'),
    functionSource('compactGMWorldContextEntity'),
    functionSource('buildGMWorldContextExport'),
    functionSource('copyGMWorldContextExport'),
    `const ACTION_CONTEXT_NPC_STATE_KEYS = new Set(['mood', 'attitude', 'topic', 'suspicion', 'trust', 'lastHeard']);`,
    functionSource('compactNPCDialogueState'),
    functionSource('toActionContextEntity'),
    functionSource('getNearbyActionContextEntities'),
    functionSource('buildGMWorldSave'),
    functionSource('storeGMUndoSnapshot'),
    functionSource('undoLastGMApply'),
    'this.api = { getLocalActionTileCandidates, translateGMOutcomeEffects, validateGMResolutionBindings, validateGMOutcomeApplication, applyGMOutcome, createTerrainAction, resolveLocalTerrainAction, validateLocalTerrainAction, getShovelGroundActionDescriptors, canonicalTerrainPatchId, findTerrainPatchAt, validateGMOutcomeAgainstCheck, getNearbyActionContextEntities, getRelevantActionMemory, buildGMWorldSave, storeGMUndoSnapshot, undoLastGMApply, addWorldMemoryFact, createGMTransition, createGMSettlement, setGMSceneTime, spawnGMVisitors, buildGMMapExport, copyGMMapExport, buildGMWorldContextExport, copyGMWorldContextExport };'
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

function searchRequest(api, context, tileId = `tile:${context.currentLevel}:${context.playerGridX}:${context.playerGridY}`) {
  const candidates = api.getLocalActionTileCandidates();
  const tile = candidates.find(candidate => candidate.id === tileId);
  return {
    action: { id: 'search-1', targetId: null, toolId: null, verb: 'improvise', intent: 'I search the nearby ground for anything unusual.' },
    context: {
      actor: { level: context.currentLevel, tile: { x: context.playerGridX, y: context.playerGridY }, inventory: [] },
      toolCandidates: [],
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

function searchOutcome(overrides = {}) {
  return {
    protocol: 'gm_outcome_v1',
    actionId: 'search-1',
    narration: 'You search the nearby ground carefully.',
    resolution: { result: 'success', reason: 'The area can be inspected safely.' },
    effects: [],
    memory: [],
    ...overrides
  };
}

function searchTransitionEffect(tile, overrides = {}) {
  return {
    op: 'create_transition',
    id: 'gm_transition_hidden_cellar_01',
    name: 'Hidden Cellar Entrance',
    shape: 'trapdoor',
    tileId: tile.id,
    targetLevel: '-1',
    spawnX: 10,
    spawnY: 8,
    ...overrides
  };
}

function dialogueRequest(overrides = {}) {
  const entities = overrides.entities || [
    { id: 'sage', kind: 'npc', name: 'Sage', level: '0', tile: { x: 11, y: 10 }, distance: 1 },
    { id: 'base_prop:old_stone:0:10:11', kind: 'prop', name: 'Old Stone', level: '0', tile: { x: 10, y: 11 }, distance: 1 }
  ];
  const target = overrides.targetId ? entities.find(entity => entity.id === overrides.targetId) || null : null;
  return {
    action: {
      id: 'dialogue-1',
      targetId: overrides.targetId ?? null,
      toolId: null,
      verb: 'improvise',
      intent: overrides.intent || 'I ask Sage about the odd shell.'
    },
    context: {
      actor: { level: '0', tile: { x: 10, y: 10 }, inventory: [] },
      target,
      toolCandidates: [],
      nearby: { entities },
      relevantState: { memory: { summary: 'Sage watches the temple.', facts: ['The player found an odd shell.'], quests: [] } }
    },
    route: { mode: 'gm' }
  };
}

function dialogueOutcome(overrides = {}) {
  return {
    protocol: 'gm_outcome_v1',
    actionId: 'dialogue-1',
    narration: 'Sage studies the shell and answers carefully.',
    resolution: { result: 'success', reason: 'The question is clear and Sage is nearby.' },
    effects: [],
    memory: [],
    ...overrides
  };
}

function itemNPCRequest(overrides = {}) {
  const item = overrides.item || { id: 'base_shell_01', name: 'Odd Shell', type: 'shell', baseType: 'shell', tags: ['shell', 'clue'] };
  const entities = overrides.entities || [
    { id: 'sage', kind: 'npc', name: 'Sage', level: '0', tile: { x: 11, y: 10 }, distance: 1 },
    { id: 'base_prop:old_stone:0:10:11', kind: 'prop', name: 'Old Stone', level: '0', tile: { x: 10, y: 11 }, distance: 1 }
  ];
  const target = overrides.targetId ? entities.find(entity => entity.id === overrides.targetId) || null : null;
  return {
    action: {
      id: 'item-npc-1',
      targetId: overrides.targetId ?? null,
      toolId: item.id,
      verb: overrides.verb || 'show',
      intent: overrides.intent || 'I show Odd Shell to Sage.'
    },
    context: {
      actor: { level: '0', tile: { x: 10, y: 10 }, inventory: [item] },
      target,
      tool: { id: item.id, name: item.name, type: item.type, metadata: { location: 'inventory', itemId: item.id, tags: item.tags || [] } },
      toolCandidates: [{ id: item.id, name: item.name, type: item.type, tags: item.tags || [] }],
      nearby: { entities },
      relevantState: { memory: { summary: '', facts: ['The player found an odd shell.'], quests: [] } }
    },
    route: { mode: 'gm' }
  };
}

function itemNPCOutcome(overrides = {}) {
  return {
    protocol: 'gm_outcome_v1',
    actionId: 'item-npc-1',
    narration: 'Sage studies the shell and responds.',
    resolution: { result: 'success', reason: 'The item and NPC are both present.' },
    effects: [],
    memory: [],
    ...overrides
  };
}

function settlementBlueprint(overrides = {}) {
  return {
    op: 'create_settlement',
    id: 'gm_settlement_riverside',
    name: 'Riverside Hamlet',
    near: 'player',
    level: '0',
    width: 16,
    depth: 16,
    style: 'osrs_town',
    buildings: [
      { id: 'inn', name: 'The Copper Kettle', size: 'small', floors: 2, role: 'inn' },
      { id: 'shop', name: 'River Shop', size: 'medium', floors: 1, role: 'shop' }
    ],
    npcs: [
      { id: 'john', name: 'John', role: 'mayor', nearBuilding: 'inn' }
    ],
    features: ['well', 'notice_board', 'market_stalls'],
    ...overrides
  };
}

function settlementPrimitiveSnapshot(context) {
  return {
    floors: context.gmFloors.map(entry => ({ id: entry.id, x: entry.x, y: entry.y, level: entry.level, color: entry.color })).sort((a, b) => a.id.localeCompare(b.id)),
    walls: context.gmWalls.map(entry => ({ id: entry.id, x: entry.x, y: entry.y, level: entry.level, dir: entry.dir, height: entry.height })).sort((a, b) => a.id.localeCompare(b.id)),
    objects: context.gmObjects.map(entry => ({ id: entry.id, x: entry.x, y: entry.y, level: entry.level, shape: entry.shape, name: entry.name })).sort((a, b) => a.id.localeCompare(b.id)),
    npcs: context.gmNPCs.map(entry => ({ id: entry.id, x: entry.gridX, y: entry.gridY, level: entry.level, name: entry.name, role: entry.state?.role })).sort((a, b) => a.id.localeCompare(b.id))
  };
}

function loadActionRequestBoundary(overrides = {}) {
  const effectDefinitions = [
    { op: 'update_entity', required: ['id'] },
    { op: 'transform_entity', required: ['id'] },
    { op: 'set_entity_state', required: ['id', 'state'] },
    { op: 'damage_entity', required: ['id'] },
    { op: 'move_npc', required: ['id'] },
    { op: 'move_prop', required: ['id'] },
    { op: 'create_prop', required: ['id', 'name'] },
    { op: 'remove_prop', required: ['id'] },
    { op: 'give_item', required: ['item'] },
    { op: 'remove_item', required: ['id'] },
    { op: 'consume_item', required: ['id'] },
    { op: 'spawn_item', required: ['item'] },
    { op: 'remove_ground_item', required: ['id'] },
    { op: 'set_flag', required: ['key', 'value'] },
    { op: 'add_memory', required: ['text'] },
    { op: 'create_transition', required: ['id', 'name', 'targetLevel'] },
    { op: 'remove_transition', required: ['id'] },
    { op: 'set_terrain', required: ['id', 'mode'] }
  ];
  const context = {
    ACTION_CONTEXT_PROTOCOL: 'action_context_v1',
    ACTION_CONTEXT_NEARBY_MAX: 96,
    ACTION_CONTEXT_TOOL_MAX: 28,
    ACTION_CONTEXT_LOCAL_TILE_RADIUS: 4,
    ACTION_CONTEXT_EVENT_LIMIT: 12,
    GAME_ACTION_SOURCES: new Set(['ui', 'text', 'system']),
    GAME_ACTION_ROUTING_MODES: new Set(['local', 'gm', 'hybrid', 'unknown']),
    ACTION_ROUTE_MODES: new Set(['local', 'gm', 'hybrid', 'reject']),
    ACTION_ROUTE_RESOLVERS: new Set(['movement', 'door', 'pickup', 'drop', 'fishing', 'terrain', 'transition']),
    DETERMINISTIC_ACTION_CAPABILITIES: [
      { verb: 'dig', targetKinds: [], resolver: 'terrain', requiresTile: true, requiredItemTypes: ['shovel', 'digging'] },
      { verb: 'raise', targetKinds: [], resolver: 'terrain', requiresTile: true, requiredItemTypes: ['shovel', 'digging'] },
      { verb: 'pile', targetKinds: [], resolver: 'terrain', requiresTile: true, requiredItemTypes: ['shovel', 'digging'] },
      { verb: 'fill', targetKinds: [], resolver: 'terrain', requiresTile: true, requiredItemTypes: ['shovel', 'digging'] },
      { verb: 'flatten', targetKinds: [], resolver: 'terrain', requiresTile: true, requiredItemTypes: ['shovel', 'digging'] }
    ],
    GM_REQUEST_PROTOCOL: 'gm_request_v1',
    GM_OUTCOME_MAX_EFFECTS: 6,
    GM_ACTION_EFFECT_DEFINITIONS: effectDefinitions,
    GM_ACTION_EFFECT_OPS: new Set(effectDefinitions.map(effect => effect.op)),
    currentLevel: '0',
    playerGridX: 10,
    playerGridY: 10,
    activeTool: 'walk',
    copyActionContextValue: value => structuredClone(value),
    safeMemoryText: value => typeof value === 'string' ? value.trim() : '',
    resolveActionEntityReference: id => (overrides.resolvedEntities || []).find(entity => entity.id === id) || null,
    resolveActionToolReference: id => {
      const item = (overrides.inventory || []).find(candidate => candidate.id === id || candidate.type === id || candidate.baseType === id);
      return item ? { id: item.id, name: item.name || item.id, type: item.type || item.baseType || 'item', state: item.state || {}, metadata: { location: 'inventory', itemId: item.id, tags: item.tags || [], description: item.description || '' } } : null;
    },
    getActionToolCandidates: explicitToolId => {
      const source = overrides.inventory || [];
      if (explicitToolId) {
        const item = source.find(candidate => candidate.id === explicitToolId);
        return item ? [{ id: item.id, name: item.name || item.id, type: item.type || item.baseType || 'item', tags: item.tags || [] }] : [];
      }
      return source.filter(item => item.category === 'tool' || (item.tags || []).includes('tool')).map(item => ({ id: item.id, name: item.name || item.id, type: item.type || item.baseType || 'item', tags: item.tags || [] }));
    },
    serializeWorldMemory: () => overrides.memory || { summary: '', facts: [], quests: [] },
    getInventoryCompactSnapshot: () => overrides.inventory || [],
    getSelectedUseItemSnapshot: () => null,
    getNearbyActionContextEntities: () => overrides.nearbyEntities || [{ id: 'base_prop:old_stone:0:10:11', kind: 'prop', name: 'Old Stone', level: '0', tile: { x: 10, y: 11 }, distance: 1 }],
    getLocalActionTileCandidates: () => [{ id: 'tile:0:10:10', level: '0', x: 10, y: 10, distance: 0, terrain: 'ground', walkable: true, occupied: false, protected: false }],
    getEventsSinceLastGM: () => [],
    getRelevantActionAnchors: () => [],
    isValidTile: (x, y, level) => level === '0' && Number.isInteger(Number(x)) && Number.isInteger(Number(y)),
    worldFlags: {}
  };
  vm.createContext(context);
  vm.runInContext([
    `const GM_ACTION_EFFECT_DEFINITIONS = Object.freeze(${JSON.stringify(effectDefinitions)});`,
    'const GM_ACTION_EFFECT_OPS = new Set(GM_ACTION_EFFECT_DEFINITIONS.map(effect => effect.op));',
    'function copyActionContextValue(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }',
    functionSource('normalizeGameActionId'),
    functionSource('normalizeGameAction'),
    functionSource('createGameAction'),
    functionSource('validateGameAction'),
    `const ACTION_CONTEXT_MEMORY_FACT_LIMIT = 8;`,
    `const ACTION_CONTEXT_MEMORY_QUEST_LIMIT = 4;`,
    `const ACTION_CONTEXT_MEMORY_SUMMARY_LIMIT = 800;`,
    `const ACTION_CONTEXT_MEMORY_STOP_WORDS = new Set(['about', 'after', 'again', 'anything', 'around', 'because', 'before', 'being', 'close', 'could', 'found', 'from', 'ground', 'have', 'here', 'into', 'nearby', 'player', 'same', 'search', 'should', 'something', 'tell', 'that', 'their', 'there', 'thing', 'this', 'with', 'would']);`,
    functionSource('getActionMemoryTerms'),
    functionSource('memoryTextMatchesTerms'),
    functionSource('getRelevantActionMemory'),
    functionSource('isSearchInvestigateAction'),
    functionSource('isNPCDialogueAction'),
    functionSource('isItemToNPCAction'),
    functionSource('actionNeedsLocalTileCandidates'),
    functionSource('buildActionContext'),
    functionSource('validateActionContext'),
    functionSource('normalizeActionRouteIntent'),
    functionSource('actionHasTileParameter'),
    functionSource('actionContextHasInventoryType'),
    functionSource('addActionRouteHintWarning'),
    functionSource('createActionRouteDecision'),
    functionSource('routeGameAction'),
    functionSource('validateActionRoute'),
    functionSource('validatePlainProtocolValue'),
    functionSource('getSerializedProtocolSize'),
    functionSource('buildGMRequest'),
    functionSource('validateGMRequest'),
    'this.api = { createGameAction, buildActionContext, routeGameAction, buildGMRequest, validateGMRequest };'
  ].join('\n'), context);
  return context.api;
}

test('local tile candidates are bounded and deterministic', () => {
  const { api } = loadTerrainBoundary();
  const first = api.getLocalActionTileCandidates();
  const second = api.getLocalActionTileCandidates();
  assert.equal(first.length <= 81, true);
  assert.deepEqual(first.map(tile => tile.id), second.map(tile => tile.id));
  assert.deepEqual(first[0], { id: 'tile:0:10:10', level: '0', x: 10, y: 10, distance: 0, terrain: 'ground', height: 0, walkable: true, occupied: false, protected: false, canDig: true });
});

test('search ActionContext includes localTiles and builds a bounded GM request', () => {
  const api = loadActionRequestBoundary();
  const search = api.createGameAction({
    id: 'search-nearby-1',
    source: 'text',
    actorId: 'player',
    verb: 'improvise',
    intent: 'I search the nearby ground for anything unusual.',
    routing: { mode: 'unknown', reason: null }
  }, '2026-08-22T12:00:00.000Z');
  const context = api.buildActionContext(search);
  const route = api.routeGameAction(search, context);
  const built = api.buildGMRequest(search, context, route);
  assert.equal(route.mode, 'gm');
  assert.equal(built.ok, true, built.errors.join(' | '));
  assert.equal(built.request.protocol, 'gm_request_v1');
  assert.equal(built.request.route.mode, 'gm');
  assert.equal(Array.isArray(built.request.context.localTiles.candidates), true);
  assert.equal(built.request.context.localTiles.candidates.length, 1);
  assert.equal(built.request.context.nearby.entities.length, 1);
  assert.equal(built.request.context.canvasEntities, undefined);
  assert.equal(built.request.context.nearby.all, undefined);
  assert.equal(api.validateGMRequest(built.request).valid, true);

  const ordinary = api.createGameAction({
    id: 'ordinary-1',
    source: 'text',
    actorId: 'player',
    verb: 'improvise',
    intent: 'I wave hello.',
    routing: { mode: 'unknown', reason: null }
  }, '2026-08-22T12:00:00.000Z');
  assert.equal('localTiles' in api.buildActionContext(ordinary), false);
});

test('search for temple cellar entrance routes to GM with localTiles', () => {
  const api = loadActionRequestBoundary();
  const search = api.createGameAction({
    id: 'search-cellar-1',
    source: 'text',
    actorId: 'player',
    verb: 'improvise',
    intent: 'I search for the temple cellar entrance.',
    routing: { mode: 'unknown', reason: null }
  }, '2026-08-22T12:00:00.000Z');
  const context = api.buildActionContext(search);
  const route = api.routeGameAction(search, context);
  const built = api.buildGMRequest(search, context, route);
  assert.equal(route.mode, 'gm');
  assert.equal(built.ok, true, built.errors.join(' | '));
  assert.equal(Array.isArray(built.request.context.localTiles.candidates), true);
  assert.equal(built.request.context.localTiles.candidates.length, 1);
  assert.equal(built.request.context.canvasEntities, undefined);
});

test('NPC dialogue routes to GM with bounded nearby NPC candidates', () => {
  const sageEntity = { id: 'sage', kind: 'npc', name: 'Sage', level: '0', tile: { x: 11, y: 10 }, distance: 1, state: { mood: 'watchful' } };
  const guardEntity = { id: 'guard', kind: 'npc', name: 'Guard', level: '0', tile: { x: 12, y: 10 }, distance: 2 };
  const api = loadActionRequestBoundary({ nearbyEntities: [sageEntity, guardEntity, { id: 'base_prop:old_stone:0:10:11', kind: 'prop', name: 'Old Stone', level: '0', tile: { x: 10, y: 11 }, distance: 1 }] });
  const action = api.createGameAction({
    id: 'dialogue-route-1',
    source: 'text',
    actorId: 'player',
    verb: 'improvise',
    intent: 'I ask Sage about the tide.',
    routing: { mode: 'unknown', reason: null }
  }, '2026-08-22T12:00:00.000Z');
  const context = api.buildActionContext(action);
  const route = api.routeGameAction(action, context);
  const built = api.buildGMRequest(action, context, route);
  assert.equal(route.mode, 'gm');
  assert.equal(built.ok, true, built.errors.join(' | '));
  assert.equal(built.request.protocol, 'gm_request_v1');
  assert.deepEqual(JSON.parse(JSON.stringify(built.request.context.nearby.entities.filter(entity => entity.kind === 'npc').map(entity => entity.id))), ['sage', 'guard']);
  assert.equal(built.request.context.canvasEntities, undefined);
  assert.equal(built.request.context.nearby.all, undefined);
  assert.equal(api.validateGMRequest(built.request).valid, true);
});

test('explicit selected NPC target is preserved in dialogue context', () => {
  const sageEntity = { id: 'sage', kind: 'npc', name: 'Sage', level: '0', tile: { x: 11, y: 10 }, distance: 1 };
  const api = loadActionRequestBoundary({ nearbyEntities: [sageEntity], resolvedEntities: [sageEntity] });
  const action = api.createGameAction({
    id: 'dialogue-target-1',
    source: 'text',
    actorId: 'player',
    verb: 'improvise',
    targetId: 'sage',
    intent: 'I tell Sage I found an odd shell.',
    routing: { mode: 'unknown', reason: null }
  }, '2026-08-22T12:00:00.000Z');
  const context = api.buildActionContext(action);
  assert.equal(context.target.id, 'sage');
  assert.equal(context.target.kind, 'npc');
  assert.equal(api.routeGameAction(action, context).mode, 'gm');
});

test('selected inventory item and NPC target route to Action GM with explicit bindings', () => {
  const shell = { id: 'base_shell_01', name: 'Odd Shell', type: 'shell', baseType: 'shell', category: 'misc', tags: ['shell', 'clue'], description: 'A strange shell.' };
  const sageEntity = { id: 'sage', kind: 'npc', name: 'Sage', level: '0', tile: { x: 11, y: 10 }, distance: 1, state: { mood: 'curious' } };
  const api = loadActionRequestBoundary({ inventory: [shell], nearbyEntities: [sageEntity], resolvedEntities: [sageEntity] });
  const action = api.createGameAction({
    id: 'item-npc-route-1',
    source: 'text',
    actorId: 'player',
    verb: 'show',
    targetId: 'sage',
    toolId: 'base_shell_01',
    intent: 'I show Odd Shell to Sage.',
    routing: { mode: 'unknown', reason: null }
  }, '2026-08-22T12:00:00.000Z');
  const context = api.buildActionContext(action);
  const route = api.routeGameAction(action, context);
  const built = api.buildGMRequest(action, context, route);
  assert.equal(route.mode, 'gm');
  assert.equal(context.target.id, 'sage');
  assert.equal(context.target.kind, 'npc');
  assert.equal(context.tool.id, 'base_shell_01');
  assert.equal(context.tool.metadata.location, 'inventory');
  assert.deepEqual(JSON.parse(JSON.stringify(context.toolCandidates)), [{ id: 'base_shell_01', name: 'Odd Shell', type: 'shell', tags: ['shell', 'clue'] }]);
  assert.equal(built.ok, true, built.errors.join(' | '));
  assert.equal(built.request.action.targetId, 'sage');
  assert.equal(built.request.action.toolId, 'base_shell_01');
  assert.equal(built.request.context.nearby.entities.filter(entity => entity.kind === 'npc').length, 1);
  assert.equal(built.request.context.canvasEntities, undefined);
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

test('shovel-selected ground context exposes deterministic actions as appropriate', () => {
  const { api, context } = loadTerrainBoundary();
  assert.deepEqual(JSON.parse(JSON.stringify(api.getShovelGroundActionDescriptors(10, 10, '0').map(action => action.label))), ['Dig', 'Pile']);
  context.gmTerrain.push({ id: 'terrain:0:10:10', name: 'Dug Ground', x: 10, y: 10, level: '0', mode: 'dig', radius: 0, delta: 0.45, state: { source: 'deterministic_shovel' } });
  assert.deepEqual(JSON.parse(JSON.stringify(api.getShovelGroundActionDescriptors(10, 10, '0').map(action => action.label))), ['Fill', 'Flatten']);
  context.inventory.length = 0;
  assert.deepEqual(JSON.parse(JSON.stringify(api.getShovelGroundActionDescriptors(10, 10, '0'))), []);
});

test('deterministic shovel terrain actions route locally instead of to Action GM', () => {
  const api = loadActionRequestBoundary({
    inventory: [{ id: 'base_shovel_01', name: 'Shovel', type: 'shovel', baseType: 'shovel', tags: ['tool', 'dig'] }]
  });
  const action = api.createGameAction({
    id: 'deterministic-dig-route',
    source: 'ui',
    actorId: 'player',
    verb: 'dig',
    parameters: { tile: { x: 10, y: 10, level: '0' } },
    routing: { mode: 'unknown', reason: null }
  }, '2026-08-22T12:00:00.000Z');
  const context = api.buildActionContext(action);
  const route = api.routeGameAction(action, context);
  assert.equal(route.mode, 'local');
  assert.equal(route.resolver, 'terrain');
  assert.doesNotMatch(route.reason, /GM|interpretation/i);
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

test('deterministic dig creates a canonical terrain patch without marker entities', () => {
  const { api, context } = loadTerrainBoundary();
  const action = api.createTerrainAction('dig', { x: 10, y: 10, level: '0' });
  const outcome = api.resolveLocalTerrainAction(action, { actor: { level: '0', tile: { x: 10, y: 10 } } }, { mode: 'local', resolver: 'terrain' });
  assert.equal(outcome.status, 'executed', outcome.diagnostics.join(' | '));
  assert.equal(context.gmTerrain.length, 1);
  assert.equal(context.gmTerrain[0].id, 'terrain:0:10:10');
  assert.equal(context.gmTerrain[0].mode, 'dig');
  assert.deepEqual(JSON.parse(JSON.stringify(context.gmTerrain[0].state)), { source: 'deterministic_shovel', action: 'dig' });
  assert.equal(context.gmObjects.length, 0);
  assert.equal(context.gmMarkers.length, 0);
  assert.equal(context.gmHotspots.length, 0);
});

test('deterministic pile creates raised canonical terrain state', () => {
  const { api, context } = loadTerrainBoundary();
  const action = api.createTerrainAction('pile', { x: 10, y: 10, level: '0' });
  const outcome = api.resolveLocalTerrainAction(action, { actor: { level: '0', tile: { x: 10, y: 10 } } }, { mode: 'local', resolver: 'terrain' });
  assert.equal(outcome.status, 'executed', outcome.diagnostics.join(' | '));
  assert.equal(context.gmTerrain[0].id, 'terrain:0:10:10');
  assert.equal(context.gmTerrain[0].mode, 'raise');
  assert.equal(context.gmTerrain[0].delta, 0.35);
});

test('deterministic fill and flatten restore existing modified ground', () => {
  const { api, context } = loadTerrainBoundary();
  let action = api.createTerrainAction('dig', { x: 10, y: 10, level: '0' });
  assert.equal(api.resolveLocalTerrainAction(action, { actor: { level: '0', tile: { x: 10, y: 10 } } }, { mode: 'local', resolver: 'terrain' }).status, 'executed');
  action = api.createTerrainAction('fill', { x: 10, y: 10, level: '0' });
  assert.equal(api.resolveLocalTerrainAction(action, { actor: { level: '0', tile: { x: 10, y: 10 } } }, { mode: 'local', resolver: 'terrain' }).status, 'executed');
  assert.equal(context.gmTerrain.length, 0);

  action = api.createTerrainAction('pile', { x: 10, y: 10, level: '0' });
  assert.equal(api.resolveLocalTerrainAction(action, { actor: { level: '0', tile: { x: 10, y: 10 } } }, { mode: 'local', resolver: 'terrain' }).status, 'executed');
  action = api.createTerrainAction('flatten', { x: 10, y: 10, level: '0' });
  assert.equal(api.resolveLocalTerrainAction(action, { actor: { level: '0', tile: { x: 10, y: 10 } } }, { mode: 'local', resolver: 'terrain' }).status, 'executed');
  assert.equal(context.gmTerrain.length, 0);
});

test('deterministic shovel terrain actions reject missing tools and unsafe tiles', () => {
  const { api, context } = loadTerrainBoundary();
  const localContext = { actor: { level: '0', tile: { x: 10, y: 10 } } };
  context.inventory.length = 0;
  let action = api.createTerrainAction('dig', { x: 10, y: 10, level: '0' });
  let outcome = api.resolveLocalTerrainAction(action, localContext, { mode: 'local', resolver: 'terrain' });
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.diagnostics.join(' | '), /shovel|digging tool/i);

  context.inventory.push({ id: 'base_shovel_01', name: 'Shovel' });
  action = api.createTerrainAction('dig', { x: 13, y: 10, level: '0' });
  outcome = api.resolveLocalTerrainAction(action, localContext, { mode: 'local', resolver: 'terrain' });
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.diagnostics.join(' | '), /nearby/);

  action = api.createTerrainAction('dig', { x: 99, y: 10, level: '0' });
  outcome = api.resolveLocalTerrainAction(action, localContext, { mode: 'local', resolver: 'terrain' });
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.diagnostics.join(' | '), /valid ground tile|safely/);

  action = api.createTerrainAction('dig', { x: 5, y: 5, level: '0' });
  outcome = api.resolveLocalTerrainAction(action, { actor: { level: '0', tile: { x: 5, y: 5 } } }, { mode: 'local', resolver: 'terrain' });
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.diagnostics.join(' | '), /blocked|protected|safely/);

  context.gmObjects.push({ id: 'gm_blocking_crate', x: 10, y: 10, level: '0' });
  action = api.createTerrainAction('dig', { x: 10, y: 10, level: '0' });
  outcome = api.resolveLocalTerrainAction(action, localContext, { mode: 'local', resolver: 'terrain' });
  assert.equal(outcome.status, 'rejected');
  assert.match(outcome.diagnostics.join(' | '), /occupied|blocked|protected/);
});

test('deterministic shovel actions do not call Action GM or live transport builders', () => {
  const deterministicSource = [
    functionSource('runDeterministicShovelGroundAction'),
    functionSource('resolveLocalTerrainAction'),
    functionSource('createTerrainAction')
  ].join('\n');
  assert.doesNotMatch(deterministicSource, /buildManualActionGMRequest|buildGMRequest|requestExternalGMOutcome|resolveManualActionWithAI|applyGMOutcome/);
});

function extractGMMapGrid(text) {
  const lines = text.split('\n');
  const legend = lines.findIndex(line => line.startsWith('Legend:'));
  const npcs = lines.findIndex(line => line === 'NPCs:');
  return lines.slice(legend + 2, npcs - 1);
}

test('GM map export includes player marker, nearby semantics, inventory, and memory compactly', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 10, playerGridY: 10 });
  context.npcs.push({ id: 'sage', name: 'Sage', type: 'human', level: '0', gridX: 11, gridY: 10, state: { role: 'sage' } });
  context.gmObjects.push({ id: 'odd_stone', name: 'Odd Stone', shape: 'stone', x: 9, y: 10, level: '0', state: {} });
  context.gmTransitions.push({ id: 'cellar_stairs', name: 'Cellar Stairs', shape: 'stairs', x: 10, y: 11, level: '0', targetLevel: '-1', spawnX: 10, spawnY: 10, state: {} });
  context.worldMemory.summary = 'The village has old temple rumors.';
  context.worldMemory.facts = ['Sage noticed the odd shell.', 'A cellar may be hidden nearby.'];
  context.worldFlags.temple_hint_seen = true;

  const text = api.buildGMMapExport({ radius: 4 });
  const grid = extractGMMapGrid(text);
  assert.equal(grid.length, 9);
  assert.equal(grid.every(line => line.length === 9), true);
  assert.match(grid.join('\n'), /@/);
  assert.match(grid.join('\n'), /S/);
  assert.match(grid.join('\n'), /p/);
  assert.match(grid.join('\n'), />/);
  assert.match(text, /S sage "Sage" role=sage @ \(11, 10, level 0\)/);
  assert.match(text, /prop odd_stone "Odd Stone" @ \(9, 10, level 0\) shape=stone/);
  assert.match(text, /transition cellar_stairs "Cellar Stairs" @ \(10, 11, level 0\) shape=stairs -> level -1/);
  assert.match(text, /base_shovel_01 "Shovel"/);
  assert.match(text, /summary: The village has old temple rumors\./);
  assert.match(text, /fact: Sage noticed the odd shell\./);
  assert.match(text, /temple_hint_seen=true/);
  assert.doesNotMatch(text, /token|endpoint|secret|gm-access-token|gm-endpoint/i);
});

test('GM map export respects current level', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 20, playerGridY: 20 });
  context.currentLevel = '2';
  context.npcs.push({ id: 'surface_sage', name: 'Surface Sage', type: 'human', level: '0', gridX: 20, gridY: 20, state: { role: 'sage' } });
  context.npcs.push({ id: 'island_sage', name: 'Island Sage', type: 'human', level: '2', gridX: 21, gridY: 20, state: { role: 'sage' } });
  context.gmObjects.push({ id: 'surface_marker', name: 'Surface Marker', shape: 'sign', x: 20, y: 19, level: '0', state: {} });
  context.gmObjects.push({ id: 'island_marker', name: 'Island Marker', shape: 'sign', x: 20, y: 19, level: '2', state: {} });

  const text = api.buildGMMapExport({ radius: 3 });
  assert.match(text, /level: 2/);
  assert.match(text, /island_sage "Island Sage"/);
  assert.match(text, /island_marker "Island Marker"/);
  assert.doesNotMatch(text, /surface_sage|Surface Sage|surface_marker|Surface Marker/);
});

test('GM world context export is bounded, stable, semantic, and secret-free', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 10, playerGridY: 10 });
  context.npcs.push({ id: 'sage', name: 'Sage', type: 'human', level: '0', gridX: 11, gridY: 10, state: { role: 'sage', trust: 'cautious' } });
  context.npcs.push({ id: 'distant_npc', name: 'Distant NPC', type: 'human', level: '0', gridX: 30, gridY: 30, state: { role: 'traveler' } });
  context.gmObjects.push({ id: 'odd_stone', name: 'Odd Stone', shape: 'stone', x: 9, y: 10, level: '0', state: { clue: true }, note: 'A marked stone.' });
  context.gmObjects.push({ id: 'distant_prop', name: 'Distant Prop', shape: 'crate', x: 30, y: 30, level: '0', state: {} });
  context.gmTransitions.push({ id: 'cellar_stairs', name: 'Cellar Stairs', shape: 'stairs', x: 10, y: 11, level: '0', targetLevel: '-1', spawnX: 10, spawnY: 10, state: {} });
  context.worldMemory.summary = 'The village has old temple rumors.';
  context.worldMemory.facts = ['Sage noticed the odd shell.', 'A cellar may be hidden nearby.'];
  context.worldFlags.temple_hint_seen = true;
  context.gmFloors.push({ id: 'gm_settlement_riverside_road_0', name: 'Riverside road', x: 8, y: 8, level: '0', state: { settlementId: 'gm_settlement_riverside', kind: 'road' } });

  const exported = api.buildGMWorldContextExport(4);
  const text = JSON.stringify(exported);
  assert.equal(exported.protocol, 'gm_world_context_v1');
  assert.deepEqual(exported.player.tile, { x: 10, y: 10 });
  assert.equal(exported.scope.radius, 4);
  assert.equal(exported.nearby.npcs.some(npc => npc.id === 'sage' && npc.x === 11 && npc.y === 10 && npc.state.trust === 'cautious'), true);
  assert.equal(exported.nearby.npcs.some(npc => npc.id === 'distant_npc'), false);
  assert.equal(exported.nearby.entities.some(entity => entity.id === 'odd_stone' && entity.x === 9 && entity.y === 10 && entity.state.clue === true), true);
  assert.equal(exported.nearby.entities.some(entity => entity.id === 'distant_prop'), false);
  assert.equal(exported.inventory.some(item => item.id === 'base_shovel_01' && item.name === 'Shovel'), true);
  assert.equal(exported.memory.facts.includes('Sage noticed the odd shell.'), true);
  assert.equal(exported.flags.temple_hint_seen, true);
  assert.equal(exported.recentEvents.length, 1);
  assert.equal(exported.generatedRegions.some(region => region.id === 'gm_settlement_riverside'), true);
  assert.match(exported.acceptedProposalProtocol.shape.dialogue, /array/);
  assert.doesNotMatch(text, /endpoint|token|secret|gm-access-token|gm-endpoint/i);
});

test('set_scene_time accepts valid values, rejects invalid values, persists, and records', () => {
  const { api, context } = loadTerrainBoundary();
  const logs = [];
  const events = [];
  context.addLogMessage = value => logs.push(String(value));
  context.recordGMEvent = (type, detail) => events.push({ type, detail });
  assert.equal(api.setGMSceneTime({ time: 'dusk', reason: 'Festival begins.' }), true);
  assert.equal(context.worldFlags.scene_time, 'dusk');
  assert.equal(context.worldFlags.scene_time_note, 'Festival begins.');
  assert.equal(context.scene.background.value, 0x6d587d);
  assert.equal(context.ambientLight.intensity, 0.38);
  assert.equal(events.some(event => event.type === 'scene_time_set' && event.detail.time === 'dusk'), true);
  assert.equal(logs.some(line => /Scene time set to dusk/.test(line)), true);
  const save = api.buildGMWorldSave();
  assert.equal(save.flags.scene_time, 'dusk');

  context.worldFlags.scene_time = 'day';
  context.localStorage.setItem(context.GM_SAVE_KEY, JSON.stringify(save));
  assert.equal(context.loadGMWorld(true), true);
  assert.equal(context.worldFlags.scene_time, 'dusk');
  assert.equal(context.scene.background.value, 0x6d587d);

  assert.equal(api.setGMSceneTime({ time: 'midmorning' }), false);
  assert.equal(context.worldFlags.scene_time, 'dusk');
});

test('spawn_visitors creates deterministic prefixed NPCs, clamps count, avoids occupied/protected tiles, and does not duplicate', () => {
  const first = loadTerrainBoundary({ playerGridX: 10, playerGridY: 10 });
  const second = loadTerrainBoundary({ playerGridX: 10, playerGridY: 10 });
  first.context.npcs.push({ id: 'sage', name: 'Sage', type: 'human', level: '0', gridX: 10, gridY: 10, state: {} });
  second.context.npcs.push({ id: 'sage', name: 'Sage', type: 'human', level: '0', gridX: 10, gridY: 10, state: {} });
  first.context.gmObjects.push({ id: 'occupied_crate', name: 'Crate', shape: 'crate', x: 11, y: 10, level: '0', state: {} });
  second.context.gmObjects.push({ id: 'occupied_crate', name: 'Crate', shape: 'crate', x: 11, y: 10, level: '0', state: {} });
  first.context.pathTiles.push({ x: 10, y: 11 });
  second.context.pathTiles.push({ x: 10, y: 11 });
  const command = { id: 'mistwood_festival_visitors', count: 99, target: 'player', theme: 'festival' };
  assert.equal(first.api.spawnGMVisitors(command), true);
  assert.equal(second.api.spawnGMVisitors(command), true);
  assert.equal(first.context.gmNPCs.length, 12);
  assert.equal(first.context.gmNPCs.every(npc => npc.id.startsWith('mistwood_festival_visitors_')), true);
  assert.equal(first.context.gmNPCs.some(npc => npc.gridX === 10 && npc.gridY === 10), false);
  assert.equal(first.context.gmNPCs.some(npc => npc.gridX === 11 && npc.gridY === 10), false);
  assert.equal(first.context.gmNPCs.some(npc => npc.gridX === 10 && npc.gridY === 11), false);
  assert.deepEqual(settlementPrimitiveSnapshot(first.context).npcs, settlementPrimitiveSnapshot(second.context).npcs);
  assert.equal(first.api.spawnGMVisitors(command), false);
  assert.equal(first.context.gmNPCs.length, 12);
});

test('staging commands are undoable through GM undo', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 10, playerGridY: 10 });
  assert.equal(api.storeGMUndoSnapshot('before_staging'), true);
  assert.equal(api.setGMSceneTime({ time: 'night', silent: true }), true);
  assert.equal(api.spawnGMVisitors({ id: 'night_market_visitors', count: 3, theme: 'market', target: { x: 10, y: 10, level: '0' }, silent: true }), true);
  assert.equal(context.worldFlags.scene_time, 'night');
  assert.equal(context.gmNPCs.length, 3);
  assert.equal(api.undoLastGMApply(), true);
  assert.equal(context.worldFlags.scene_time, undefined);
  assert.equal(context.gmNPCs.length, 0);
});

test('local staging commands do not call Action GM transport', () => {
  const stagingSource = [
    functionSource('setGMSceneTime'),
    functionSource('spawnGMVisitors'),
    functionSource('applyLLMCommands')
  ].join('\n');
  assert.doesNotMatch(stagingSource, /requestExternalGMOutcome|resolveManualActionWithAI|buildGMRequest|buildManualActionGMRequest|Workers AI|applyGMOutcome/);
});

test('create_settlement creates prefixed floors walls props and NPCs', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 20, playerGridY: 20 });
  const created = api.createGMSettlement(settlementBlueprint());
  assert.equal(created, true);
  assert.equal(context.gmFloors.length > 0, true);
  assert.equal(context.gmWalls.length > 0, true);
  assert.equal(context.gmObjects.length > 0, true);
  assert.equal(context.gmNPCs.length, 1);
  const allIds = [...context.gmFloors, ...context.gmWalls, ...context.gmObjects, ...context.gmNPCs].map(entry => entry.id);
  assert.equal(allIds.every(id => id.startsWith('gm_settlement_riverside_')), true);
  assert.equal(context.worldMemory.facts.some(fact => /Riverside Hamlet is a generated local settlement/i.test(fact)), true);
});

test('create_settlement placement is deterministic for the same blueprint', () => {
  const first = loadTerrainBoundary({ playerGridX: 20, playerGridY: 20 });
  const second = loadTerrainBoundary({ playerGridX: 20, playerGridY: 20 });
  assert.equal(first.api.createGMSettlement(settlementBlueprint()), true);
  assert.equal(second.api.createGMSettlement(settlementBlueprint()), true);
  assert.deepEqual(settlementPrimitiveSnapshot(first.context), settlementPrimitiveSnapshot(second.context));
});

test('create_settlement near player chooses a clean parcel away from occupied village area', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 20, playerGridY: 20 });
  for (let x = 16; x <= 24; x++) {
    for (let y = 16; y <= 24; y++) context.floorHeights[`0,${x},${y}`] = 0.05;
  }
  context.pathTiles.push({ x: 20, y: 20 }, { x: 21, y: 20 });
  context.allWalls['0'].push({ x: 19, y: 19, dir: 'N', type: 'white' });
  assert.equal(api.createGMSettlement(settlementBlueprint({ placement: 'infill', width: 8, depth: 8, buildings: [{ id: 'hall', name: 'Clean Parcel Hall', size: 'small', floors: 1, role: 'hall' }], npcs: [], features: [] })), true);
  const generated = [...context.gmFloors, ...context.gmWalls, ...context.gmObjects, ...context.gmNPCs.map(entry => ({ ...entry, x: entry.gridX, y: entry.gridY }))];
  assert.equal(generated.some(entry => entry.x >= 16 && entry.x <= 24 && entry.y >= 16 && entry.y <= 24), false);
});

test('create_settlement defaults to frontier placement outside existing world bounds', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 18, playerGridY: 18 });
  for (let x = 12; x <= 24; x++) {
    for (let y = 12; y <= 24; y++) context.floorHeights[`0,${x},${y}`] = 0.05;
  }
  assert.equal(api.createGMSettlement(settlementBlueprint({ width: 8, depth: 8, buildings: [{ id: 'hall', name: 'Frontier Hall', size: 'small', floors: 1, role: 'hall' }], npcs: [], features: [] })), true);
  const settlementParts = [...context.gmFloors, ...context.gmWalls, ...context.gmObjects.filter(entry => !entry.id.endsWith('_direction_sign'))];
  assert.equal(settlementParts.every(entry => entry.x < 12 || entry.x > 24 || entry.y < 12 || entry.y > 24), true);
});

test('create_settlement direction east places east of current bounds', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 18, playerGridY: 18 });
  for (let x = 12; x <= 24; x++) {
    for (let y = 12; y <= 24; y++) context.floorHeights[`0,${x},${y}`] = 0.05;
  }
  assert.equal(api.createGMSettlement(settlementBlueprint({ direction: 'east', width: 8, depth: 8, buildings: [{ id: 'hall', name: 'East Hall', size: 'small', floors: 1, role: 'hall' }], npcs: [], features: [] })), true);
  const xs = context.gmFloors.map(entry => entry.x);
  assert.equal(Math.min(...xs) > 24, true);
});

test('create_settlement near a crowded player succeeds by choosing a farther safe parcel', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 20, playerGridY: 20 });
  for (let x = 6; x <= 30; x++) {
    for (let y = 6; y <= 30; y++) context.floorHeights[`0,${x},${y}`] = 0.05;
  }
  delete context.floorHeights['0,20,14'];
  assert.equal(api.createGMSettlement(settlementBlueprint({ direction: 'east', width: 8, depth: 8, buildings: [{ id: 'hall', name: 'Far Hall', size: 'small', floors: 1, role: 'hall' }], npcs: [], features: [] })), true);
  const generated = [...context.gmFloors, ...context.gmWalls, ...context.gmObjects.filter(entry => !entry.id.endsWith('_direction_sign'))];
  assert.equal(generated.some(entry => entry.x >= 6 && entry.x <= 30 && entry.y >= 6 && entry.y <= 30), false);
  assert.equal(context.gmObjects.some(entry => entry.id === 'gm_settlement_riverside_direction_sign' && entry.state?.kind === 'settlement_direction_sign'), true);
});

test('create_settlement oversized footprint falls back to a smaller actual parcel', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 20, playerGridY: 20 });
  for (let x = 4; x < context.GRID_SIZE; x++) {
    for (let y = 0; y < context.GRID_SIZE; y++) context.floorHeights[`0,${x},${y}`] = 0.05;
  }
  for (let x = 30; x <= 37; x++) {
    for (let y = 30; y <= 37; y++) delete context.floorHeights[`0,${x},${y}`];
  }
  assert.equal(api.createGMSettlement(settlementBlueprint({ placement: 'infill', width: 24, depth: 24, buildings: [{ id: 'hall', name: 'Compact Hall', size: 'medium', floors: 1, role: 'hall' }], npcs: [], features: [] })), true);
  const xs = context.gmFloors.map(entry => entry.x);
  const ys = context.gmFloors.map(entry => entry.y);
  assert.equal(Math.max(...xs) - Math.min(...xs) + 1 <= 8, true);
  assert.equal(Math.max(...ys) - Math.min(...ys) + 1 <= 8, true);
  assert.equal(context.worldMemory.facts.some(fact => /footprint 8x8/i.test(fact)), true);
});

test('create_settlement fit expand preserves requested footprint before shrinking', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 18, playerGridY: 18 });
  for (let x = 10; x <= 20; x++) {
    for (let y = 10; y <= 20; y++) context.floorHeights[`0,${x},${y}`] = 0.05;
  }
  assert.equal(api.createGMSettlement(settlementBlueprint({ direction: 'east', fit: 'expand', width: 16, depth: 16, buildings: [{ id: 'hall', name: 'Full Hall', size: 'medium', floors: 1, role: 'hall' }], npcs: [], features: [] })), true);
  assert.equal(context.worldMemory.facts.some(fact => /footprint 16x16/i.test(fact)), true);
});

test('create_settlement fit strict fails instead of shrinking', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 20, playerGridY: 20 });
  for (let x = 6; x <= 30; x++) {
    for (let y = 6; y <= 30; y++) context.floorHeights[`0,${x},${y}`] = 0.05;
  }
  assert.equal(api.createGMSettlement(settlementBlueprint({ direction: 'east', fit: 'strict', width: 24, depth: 24, buildings: [{ id: 'hall', name: 'Strict Hall', size: 'medium', floors: 1, role: 'hall' }], npcs: [], features: [] })), false);
  assert.equal(context.gmFloors.length + context.gmWalls.length + context.gmObjects.length + context.gmNPCs.length, 0);
});

test('create_settlement explicit unsafe coordinates fail only when adjustment is disabled', () => {
  const blocked = loadTerrainBoundary({ playerGridX: 20, playerGridY: 20 });
  for (let x = 16; x <= 24; x++) {
    for (let y = 16; y <= 24; y++) blocked.context.floorHeights[`0,${x},${y}`] = 0.05;
  }
  assert.equal(blocked.api.createGMSettlement(settlementBlueprint({ x: 20, y: 20, width: 8, depth: 8, buildings: [], npcs: [], features: [], adjust: false })), false);
  assert.equal(blocked.context.gmFloors.length + blocked.context.gmWalls.length + blocked.context.gmObjects.length + blocked.context.gmNPCs.length, 0);

  const adjustable = loadTerrainBoundary({ playerGridX: 20, playerGridY: 20 });
  for (let x = 16; x <= 24; x++) {
    for (let y = 16; y <= 24; y++) adjustable.context.floorHeights[`0,${x},${y}`] = 0.05;
  }
  assert.equal(adjustable.api.createGMSettlement(settlementBlueprint({ x: 20, y: 20, width: 8, depth: 8, buildings: [], npcs: [], features: [] })), true);
  assert.equal(adjustable.context.gmFloors.some(entry => entry.x >= 16 && entry.x <= 24 && entry.y >= 16 && entry.y <= 24), false);
});

test('create_settlement success requires at least one generated building', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 20, playerGridY: 20 });
  const originalCreateGMFloor = context.createGMFloor;
  context.createGMFloor = command => command?.state?.kind === 'building_floor' ? false : originalCreateGMFloor(command);
  assert.equal(api.createGMSettlement(settlementBlueprint({ width: 8, depth: 8, buildings: [{ id: 'hall', name: 'Failed Hall', size: 'small', floors: 1, role: 'hall' }], npcs: [], features: [] })), false);
  assert.equal(context.gmFloors.length, 0);
  assert.equal(context.gmWalls.length, 0);
  assert.equal(context.gmObjects.length, 0);
  assert.equal(context.gmNPCs.length, 0);
});

test('create_settlement clamps width and depth to bounded ranges', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 20, playerGridY: 20 });
  assert.equal(api.createGMSettlement(settlementBlueprint({ width: 99, depth: 2, buildings: [], npcs: [], features: [] })), true);
  const xs = context.gmFloors.map(entry => entry.x);
  const ys = context.gmFloors.map(entry => entry.y);
  assert.equal(Math.max(...xs) - Math.min(...xs) + 1 <= 24, true);
  assert.equal(Math.max(...ys) - Math.min(...ys) + 1 <= 8, true);
});

test('create_settlement skips protected occupied and blocked tiles safely', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 6, playerGridY: 6 });
  context.gmObjects.push({ id: 'existing_crate', x: 6, y: 6, level: '0' });
  assert.equal(api.createGMSettlement(settlementBlueprint({ x: 6, y: 6, width: 12, depth: 12 })), true);
  const generated = [...context.gmFloors, ...context.gmWalls, ...context.gmObjects.filter(entry => entry.id !== 'existing_crate'), ...context.gmNPCs.map(entry => ({ ...entry, x: entry.gridX, y: entry.gridY }))];
  assert.equal(generated.some(entry => entry.x < 4), false);
  assert.equal(generated.some(entry => entry.x === 5 && entry.y === 5 && entry.level === '0'), false);
  assert.equal(generated.some(entry => entry.x === 6 && entry.y === 6 && entry.level === '0'), false);
});

test('create_settlement creates nothing when no viable parcel exists', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 20, playerGridY: 20 });
  for (let x = 0; x < context.GRID_SIZE; x++) {
    for (let y = 0; y < context.GRID_SIZE; y++) context.floorHeights[`0,${x},${y}`] = 0.05;
  }
  assert.equal(api.createGMSettlement(settlementBlueprint({ width: 8, depth: 8, buildings: [], npcs: [], features: [] })), false);
  assert.equal(context.gmFloors.length, 0);
  assert.equal(context.gmWalls.length, 0);
  assert.equal(context.gmObjects.length, 0);
  assert.equal(context.gmNPCs.length, 0);
});

test('undo restores the world before a generated settlement', () => {
  const { api, context } = loadTerrainBoundary({ playerGridX: 20, playerGridY: 20 });
  assert.equal(api.storeGMUndoSnapshot('before_settlement'), true);
  assert.equal(api.createGMSettlement(settlementBlueprint()), true);
  assert.equal(context.gmFloors.length > 0 || context.gmWalls.length > 0 || context.gmObjects.length > 0 || context.gmNPCs.length > 0, true);
  assert.equal(api.undoLastGMApply(), true);
  assert.equal(context.gmFloors.length, 0);
  assert.equal(context.gmWalls.length, 0);
  assert.equal(context.gmObjects.length, 0);
  assert.equal(context.gmNPCs.length, 0);
  assert.equal(context.worldMemory.facts.length, 0);
});

test('settlement compiler is local and does not call Action GM transport', () => {
  const source = [
    functionSource('createGMSettlement'),
    functionSource('applyLLMCommands')
  ].join('\n');
  assert.match(source, /create_settlement/);
  assert.doesNotMatch(source, /requestExternalGMOutcome|resolveManualActionWithAI|buildGMRequest|buildManualActionGMRequest|applyGMOutcome/);
});

test('search narration-only outcome validates through preflight as a no-op', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = searchRequest(api, context);
  const binding = api.validateGMResolutionBindings(requestData, searchOutcome());
  assert.equal(binding.valid, true);
  const translated = api.translateGMOutcomeEffects(requestData, searchOutcome(), binding.resolved);
  assert.equal(translated.valid, true);
  assert.equal(translated.translatedEffects.length, 0);
});

test('search can reveal one local spawned item through preflight', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = searchRequest(api, context);
  const outcome = searchOutcome({
    effects: [{
      op: 'spawn_item',
      item: { id: 'gm_clue_shell_01', name: 'Odd Shell', type: 'clue', tags: ['clue'], color: '#d8c0a0' },
      tileId: requestData.tile.id
    }]
  });
  const translated = api.translateGMOutcomeEffects(requestData, outcome, { targetId: null, toolId: null });
  assert.equal(translated.valid, true);
  assert.equal(translated.translatedEffects[0].op, 'spawn_item');
  assert.equal(translated.translatedEffects[0].item.id, 'gm_clue_shell_01');
  assert.equal(translated.translatedEffects[0].x, requestData.tile.x);
  assert.equal(translated.translatedEffects[0].y, requestData.tile.y);
});

test('search can reveal one local clue prop through preflight', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = searchRequest(api, context);
  const outcome = searchOutcome({
    effects: [{
      op: 'create_prop',
      id: 'gm_clue_scratches_01',
      name: 'Strange Scratches',
      shape: 'sign',
      note: 'Faint marks in the packed dirt.',
      tileId: requestData.tile.id
    }]
  });
  const translated = api.translateGMOutcomeEffects(requestData, outcome, { targetId: null, toolId: null });
  assert.equal(translated.valid, true);
  assert.equal(translated.translatedEffects[0].op, 'create_prop');
  assert.equal(translated.translatedEffects[0].id, 'gm_clue_scratches_01');
  assert.equal(translated.translatedEffects[0].x, requestData.tile.x);
  assert.equal(translated.translatedEffects[0].y, requestData.tile.y);
});

test('search can reveal one local transition to an existing target level', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = searchRequest(api, context);
  const outcome = searchOutcome({ narration: 'You discover a hidden trapdoor in the dust.', effects: [searchTransitionEffect(requestData.tile)] });
  const translated = api.translateGMOutcomeEffects(requestData, outcome, { targetId: null, toolId: null });
  assert.equal(translated.valid, true, translated.errors.join(' | '));
  assert.deepEqual(JSON.parse(JSON.stringify(translated.translatedEffects[0])), {
    op: 'create_transition',
    id: 'gm_transition_hidden_cellar_01',
    name: 'Hidden Cellar Entrance',
    shape: 'trapdoor',
    tileId: 'tile:0:10:10',
    targetLevel: '-1',
    spawnX: 10,
    spawnY: 8,
    x: 10,
    y: 10,
    level: '0',
    valid: true
  });

  const applied = api.applyGMOutcome(requestData, outcome);
  assert.equal(applied.status, 'applied', applied.diagnostics.join(' | '));
  assert.equal(context.gmTransitions.length, 1);
  assert.equal(context.gmTransitions[0].id, 'gm_transition_hidden_cellar_01');
  assert.equal(context.gmTransitions[0].shape, 'trapdoor');
  assert.equal(api.buildGMWorldSave().transitions[0].id, 'gm_transition_hidden_cellar_01');
  const later = api.getNearbyActionContextEntities().find(entity => entity.id === 'gm_transition_hidden_cellar_01');
  assert.equal(later.kind, 'transition');
  assert.equal(later.metadata.targetLevel, '-1');
  assert.equal(later.metadata.spawnX, 10);
  assert.equal(later.metadata.spawnY, 8);
});

test('search rejects physical discovery narration without a reveal effect', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = searchRequest(api, context);
  const entrance = api.translateGMOutcomeEffects(requestData, searchOutcome({
    narration: 'You find a hidden entrance beneath the temple dust.',
    resolution: { result: 'success', reason: 'Your search reveals the entrance clearly.' },
    effects: []
  }), { targetId: null, toolId: null });
  assert.equal(entrance.valid, false);
  assert.match(entrance.errors[0], /claims a persistent physical passage discovery/);

  const shell = api.translateGMOutcomeEffects(requestData, searchOutcome({
    narration: 'You find an odd shell tucked between the stones.',
    effects: []
  }), { targetId: null, toolId: null });
  assert.equal(shell.valid, false);
  assert.match(shell.errors[0], /claims a persistent physical item discovery/);
});

test('search accepts negative no-discovery narration without a reveal effect', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = searchRequest(api, context);
  const cases = [
    'You do not find a hidden entrance.',
    "You don't find a trapdoor.",
    'You fail to find a trapdoor.',
    'You cannot find an entrance here.',
    'You find no item between the stones.',
    'No entrance is found beneath the dust.'
  ];
  for (const narration of cases) {
    const translated = api.translateGMOutcomeEffects(requestData, searchOutcome({
      narration,
      resolution: { result: 'success', reason: narration },
      effects: []
    }), { targetId: null, toolId: null });
    assert.equal(translated.valid, true, narration);
    assert.equal(translated.translatedEffects.length, 0);
  }
});

test('search discovery consistency is enforced only for success and partial results', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = searchRequest(api, context);
  for (const result of ['failure', 'blocked', 'uncertain']) {
    const translated = api.translateGMOutcomeEffects(requestData, searchOutcome({
      narration: 'You find a hidden entrance beneath the temple dust.',
      resolution: { result, reason: 'The search does not produce a canonical reveal.' },
      effects: []
    }), { targetId: null, toolId: null });
    assert.equal(translated.valid, true, result);
    assert.equal(translated.translatedEffects.length, 0);
  }
});

test('search accepts uncertain observation narration without a reveal effect', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = searchRequest(api, context);
  const translated = api.translateGMOutcomeEffects(requestData, searchOutcome({
    narration: 'You notice scrape marks in the dust and suspect something may be hidden here.',
    resolution: { result: 'success', reason: 'The ground looks disturbed, but nothing physical is revealed yet.' },
    effects: []
  }), { targetId: null, toolId: null });
  assert.equal(translated.valid, true, translated.errors.join(' | '));
  assert.equal(translated.translatedEffects.length, 0);
});

test('search can reveal one transition using safe raw local source coordinates', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = searchRequest(api, context);
  const { tileId, ...effect } = searchTransitionEffect(requestData.tile, {
    id: 'gm_transition_raw_cellar_01',
    x: 11,
    y: 10,
    level: '0'
  });
  const translated = api.translateGMOutcomeEffects(requestData, searchOutcome({ effects: [effect] }), { targetId: null, toolId: null });
  assert.equal(translated.valid, true, translated.errors.join(' | '));
  assert.equal(translated.translatedEffects[0].id, 'gm_transition_raw_cellar_01');
  assert.equal(translated.translatedEffects[0].x, 11);
  assert.equal(translated.translatedEffects[0].y, 10);
  assert.equal(translated.translatedEffects[0].level, '0');
  assert.equal('tileId' in translated.translatedEffects[0], false);
});

test('search raw transition source coordinates reject blocked occupied protected and invalid tiles', () => {
  const blockedBoundary = loadTerrainBoundary({ playerGridX: 5, playerGridY: 5 });
  let requestData = searchRequest(blockedBoundary.api, blockedBoundary.context, 'tile:0:5:5');
  let { tileId, ...effect } = searchTransitionEffect(requestData.tile, {
    id: 'gm_transition_blocked_source_01',
    x: 5,
    y: 5,
    level: '0'
  });
  let translated = blockedBoundary.api.translateGMOutcomeEffects(requestData, searchOutcome({ effects: [effect] }), { targetId: null, toolId: null });
  assert.equal(translated.valid, false);
  assert.match(translated.errors[0], /protected|occupied|blocked|invalid/);

  const occupiedBoundary = loadTerrainBoundary();
  occupiedBoundary.context.gmObjects.push({ id: 'gm_blocking_crate', x: 10, y: 10, level: '0' });
  requestData = searchRequest(occupiedBoundary.api, occupiedBoundary.context);
  ({ tileId, ...effect } = searchTransitionEffect(requestData.tile, {
    id: 'gm_transition_occupied_source_01',
    x: 10,
    y: 10,
    level: '0'
  }));
  translated = occupiedBoundary.api.translateGMOutcomeEffects(requestData, searchOutcome({ effects: [effect] }), { targetId: null, toolId: null });
  assert.equal(translated.valid, false);
  assert.match(translated.errors[0], /protected|occupied|blocked|invalid/);

  const protectedBoundary = loadTerrainBoundary({ playerGridX: 2, playerGridY: 2 });
  requestData = searchRequest(protectedBoundary.api, protectedBoundary.context, 'tile:0:2:2');
  ({ tileId, ...effect } = searchTransitionEffect(requestData.tile, {
    id: 'gm_transition_protected_source_01',
    x: 2,
    y: 2,
    level: '0'
  }));
  translated = protectedBoundary.api.translateGMOutcomeEffects(requestData, searchOutcome({ effects: [effect] }), { targetId: null, toolId: null });
  assert.equal(translated.valid, false);
  assert.match(translated.errors[0], /protected|occupied|blocked|invalid/);

  const invalidBoundary = loadTerrainBoundary({ playerGridX: 0, playerGridY: 0 });
  requestData = searchRequest(invalidBoundary.api, invalidBoundary.context, 'tile:0:0:0');
  ({ tileId, ...effect } = searchTransitionEffect(requestData.tile, {
    id: 'gm_transition_invalid_source_01',
    x: -1,
    y: 0,
    level: '0'
  }));
  translated = invalidBoundary.api.translateGMOutcomeEffects(requestData, searchOutcome({ effects: [effect] }), { targetId: null, toolId: null });
  assert.equal(translated.valid, false);
  assert.match(translated.errors[0], /placement is invalid|local|protected|occupied|blocked|invalid/);
});

test('search rejects more than one local physical reveal', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = searchRequest(api, context);
  const outcome = searchOutcome({
    effects: [
      {
        op: 'spawn_item',
        item: { id: 'gm_clue_shell_01', name: 'Odd Shell', type: 'clue', tags: ['clue'] },
        tileId: requestData.tile.id
      },
      { op: 'set_flag', key: 'found_odd_shell', value: true },
      { op: 'add_memory', text: 'The player found an odd shell while searching nearby.' },
      {
        op: 'create_prop',
        id: 'gm_clue_scratches_01',
        name: 'Strange Scratches',
        shape: 'sign',
        tileId: requestData.tile.id
      }
    ]
  });
  const translated = api.translateGMOutcomeEffects(requestData, outcome, { targetId: null, toolId: null });
  assert.equal(translated.valid, false);
  assert.match(translated.errors[0], /at most one local physical clue or item/);
});

test('search rejects transition plus another physical reveal', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = searchRequest(api, context);
  const outcome = searchOutcome({
    effects: [
      searchTransitionEffect(requestData.tile),
      { op: 'set_flag', key: 'found_cellar_entrance', value: true },
      { op: 'add_memory', text: 'The player found a hidden cellar entrance.' },
      { op: 'create_prop', id: 'gm_cellar_scratches_01', name: 'Scratches by the Trapdoor', tileId: requestData.tile.id }
    ]
  });
  const translated = api.translateGMOutcomeEffects(requestData, outcome, { targetId: null, toolId: null });
  assert.equal(translated.valid, false);
  assert.match(translated.errors[0], /at most one local physical/);
});

test('search rejects duplicate item ids and non-originating tile discoveries', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = searchRequest(api, context);
  context.inventory.push({ id: 'gm_clue_shell_01', name: 'Odd Shell' });
  const duplicate = api.translateGMOutcomeEffects(requestData, searchOutcome({
    effects: [{
      op: 'spawn_item',
      item: { id: 'gm_clue_shell_01', name: 'Odd Shell', type: 'clue' },
      tileId: requestData.tile.id
    }]
  }), { targetId: null, toolId: null });
  assert.equal(duplicate.valid, false);
  assert.match(duplicate.errors[0], /duplicated|invalid/);

  const distantItem = api.translateGMOutcomeEffects(requestData, searchOutcome({
    effects: [{
      op: 'spawn_item',
      item: { id: 'gm_clue_shell_02', name: 'Odd Shell', type: 'clue' },
      tileId: 'tile:0:30:30'
    }]
  }), { targetId: null, toolId: null });
  assert.equal(distantItem.valid, false);
  assert.match(distantItem.errors[0], /originating local tile candidate/);

  const distantProp = api.translateGMOutcomeEffects(requestData, searchOutcome({
    effects: [{ op: 'create_prop', id: 'gm_clue_scratches_far', name: 'Far Scratches', tileId: 'tile:0:30:30' }]
  }), { targetId: null, toolId: null });
  assert.equal(distantProp.valid, false);
  assert.match(distantProp.errors[0], /originating local tile candidate/);
});

test('search prop discoveries without tileId still cannot be distant', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = searchRequest(api, context);
  const outcome = searchOutcome({
    effects: [{ op: 'create_prop', id: 'gm_clue_far_01', name: 'Far Clue', x: 30, y: 30, level: '0', shape: 'sign' }]
  });
  const translated = api.translateGMOutcomeEffects(requestData, outcome, { targetId: null, toolId: null });
  assert.equal(translated.valid, false);
  assert.match(translated.errors[0], /local to the originating search context/);
});

test('search transition discoveries reject distant, invalid target, and unsafe shape', () => {
  const { api, context } = loadTerrainBoundary();
  const requestData = searchRequest(api, context);
  const distant = api.translateGMOutcomeEffects(requestData, searchOutcome({
    effects: [searchTransitionEffect(requestData.tile, { id: 'gm_transition_far_cellar_01', tileId: 'tile:0:30:30', x: 30, y: 30 })]
  }), { targetId: null, toolId: null });
  assert.equal(distant.valid, false);
  assert.match(distant.errors[0], /originating local tile candidate/);

  const missingLevel = api.translateGMOutcomeEffects(requestData, searchOutcome({
    effects: [searchTransitionEffect(requestData.tile, { id: 'gm_transition_missing_level_01', targetLevel: '99' })]
  }), { targetId: null, toolId: null });
  assert.equal(missingLevel.valid, false);
  assert.match(missingLevel.errors[0], /spawn tile|target level/);

  const malformedShape = api.translateGMOutcomeEffects(requestData, searchOutcome({
    effects: [searchTransitionEffect(requestData.tile, { id: 'gm_transition_castle_01', shape: 'castle' })]
  }), { targetId: null, toolId: null });
  assert.equal(malformedShape.valid, false);
  assert.match(malformedShape.errors[0], /shape is unsupported/);

  const blockedSpawn = api.translateGMOutcomeEffects(requestData, searchOutcome({
    effects: [searchTransitionEffect(requestData.tile, { id: 'gm_transition_blocked_spawn_01', spawnX: 5, spawnY: 5 })]
  }), { targetId: null, toolId: null });
  assert.equal(blockedSpawn.valid, false);
  assert.match(blockedSpawn.errors[0], /spawn tile is invalid or blocked/);
});

test('NPC dialogue allows narration-only responses and supporting memory or flags', () => {
  const { api } = loadTerrainBoundary();
  const requestData = dialogueRequest();
  const narrationOnlyBinding = api.validateGMResolutionBindings(requestData, dialogueOutcome());
  assert.equal(narrationOnlyBinding.valid, true);
  const narrationOnly = api.translateGMOutcomeEffects(requestData, dialogueOutcome(), narrationOnlyBinding.resolved);
  assert.equal(narrationOnly.valid, true);
  assert.equal(narrationOnly.translatedEffects.length, 0);

  const outcome = dialogueOutcome({
    effects: [
      { op: 'set_flag', key: 'sage_heard_about_shell', value: true },
      { op: 'add_memory', text: 'Sage heard that the player found an odd shell.' }
    ]
  });
  const binding = api.validateGMResolutionBindings(requestData, outcome);
  assert.equal(binding.valid, true);
  const translated = api.translateGMOutcomeEffects(requestData, outcome, binding.resolved);
  assert.equal(translated.valid, true);
  assert.deepEqual(JSON.parse(JSON.stringify(translated.translatedEffects.map(effect => effect.op))), ['set_flag']);
  assert.deepEqual(JSON.parse(JSON.stringify(translated.memory.facts)), ['Sage heard that the player found an odd shell.']);
});

test('NPC dialogue can update only the resolved target NPC semantic state', () => {
  const { api } = loadTerrainBoundary();
  const requestData = dialogueRequest();
  const outcome = dialogueOutcome({
    bindings: { targetId: 'sage' },
    effects: [{ op: 'set_entity_state', id: 'sage', state: { mood: 'curious', lastHeard: 'odd shell', trust: 1 } }]
  });
  const binding = api.validateGMResolutionBindings(requestData, outcome);
  assert.equal(binding.valid, true);
  const translated = api.translateGMOutcomeEffects(requestData, outcome, binding.resolved);
  assert.equal(translated.valid, true);
  assert.deepEqual(JSON.parse(JSON.stringify(translated.translatedEffects)), [{ op: 'set_dialogue_npc_state', id: 'sage', state: { mood: 'curious', lastHeard: 'odd shell', trust: 1 } }]);

  const otherNpc = api.translateGMOutcomeEffects(requestData, dialogueOutcome({
    bindings: { targetId: 'sage' },
    effects: [{ op: 'set_entity_state', id: 'guard', state: { mood: 'suspicious' } }]
  }), { targetId: 'sage', toolId: null });
  assert.equal(otherNpc.valid, false);
  assert.match(otherNpc.errors[0], /must target resolved NPC sage/);

  const unsafeState = api.translateGMOutcomeEffects(requestData, dialogueOutcome({
    bindings: { targetId: 'sage' },
    effects: [{ op: 'set_entity_state', id: 'sage', state: { inventory: ['shell'] } }]
  }), { targetId: 'sage', toolId: null });
  assert.equal(unsafeState.valid, false);
  assert.match(unsafeState.errors[0], /unsupported or too broad/);
});

test('NPC dialogue rejects physical, movement, terrain, and damage effects', () => {
  const { api } = loadTerrainBoundary();
  const requestData = dialogueRequest();
  const blockedEffects = [
    { op: 'spawn_item', item: { id: 'gm_shell_dialogue', name: 'Shell' }, x: 10, y: 10, level: '0' },
    { op: 'give_item', item: { id: 'gm_shell_gift', name: 'Shell' } },
    { op: 'remove_item', id: 'base_shell_01' },
    { op: 'create_prop', id: 'gm_dialogue_prop', name: 'Sudden Sign', x: 10, y: 10, level: '0' },
    { op: 'move_prop', id: 'gm_dialogue_prop', x: 11, y: 10, level: '0' },
    { op: 'remove_prop', id: 'gm_dialogue_prop' },
    { op: 'set_terrain', id: 'gm_dialogue_terrain', tileId: 'tile:0:10:10', mode: 'dig' },
    { op: 'move_npc', id: 'sage', x: 11, y: 10, level: '0' },
    { op: 'damage_entity', id: 'sage', damage: true }
  ];

  for (const effect of blockedEffects) {
    const translated = api.translateGMOutcomeEffects(requestData, dialogueOutcome({ bindings: { targetId: 'sage' }, effects: [effect] }), { targetId: 'sage', toolId: null });
    assert.equal(translated.valid, false, `${effect.op} should be rejected`);
    assert.match(translated.errors[0], /not supported for NPC dialogue/);
  }
});

test('NPC dialogue late binding rejects non-originating, non-NPC, and player targets', () => {
  const { api } = loadTerrainBoundary();
  const requestData = dialogueRequest();
  const missing = api.validateGMResolutionBindings(requestData, dialogueOutcome({ bindings: { targetId: 'missing_npc' } }));
  assert.equal(missing.valid, false);
  assert.match(missing.errors[0], /not an originating target candidate/);

  const prop = api.validateGMResolutionBindings(requestData, dialogueOutcome({ bindings: { targetId: 'base_prop:old_stone:0:10:11' } }));
  assert.equal(prop.valid, false);
  assert.match(prop.errors.join(' | '), /nearby NPC candidate/);

  const player = api.validateGMResolutionBindings(requestData, dialogueOutcome({ bindings: { targetId: 'player' } }));
  assert.equal(player.valid, false);
  assert.match(player.errors[0], /not an originating target candidate/);
});

test('item-to-NPC narration and safe NPC memory or state validate', () => {
  const { api, context } = loadTerrainBoundary();
  context.inventory.splice(0, context.inventory.length, { id: 'base_shell_01', name: 'Odd Shell', type: 'shell', tags: ['shell', 'clue'] });
  const requestData = itemNPCRequest({ targetId: 'sage' });
  const narrationBinding = api.validateGMResolutionBindings(requestData, itemNPCOutcome());
  assert.equal(narrationBinding.valid, true, narrationBinding.errors.join(' | '));
  const narrationOnly = api.translateGMOutcomeEffects(requestData, itemNPCOutcome(), narrationBinding.resolved);
  assert.equal(narrationOnly.valid, true);
  assert.equal(narrationOnly.translatedEffects.length, 0);

  const outcome = itemNPCOutcome({
    effects: [
      { op: 'set_flag', key: 'sage_saw_odd_shell', value: true },
      { op: 'add_memory', text: 'Sage saw the odd shell the player found.' },
      { op: 'set_entity_state', id: 'sage', state: { topic: 'odd shell', mood: 'curious' } }
    ]
  });
  const binding = api.validateGMResolutionBindings(requestData, outcome);
  assert.equal(binding.valid, true, binding.errors.join(' | '));
  const translated = api.translateGMOutcomeEffects(requestData, outcome, binding.resolved);
  assert.equal(translated.valid, true, translated.errors.join(' | '));
  assert.deepEqual(JSON.parse(JSON.stringify(translated.translatedEffects.map(effect => effect.op))), ['set_flag', 'set_dialogue_npc_state']);
  assert.deepEqual(JSON.parse(JSON.stringify(translated.memory.facts)), ['Sage saw the odd shell the player found.']);
});

test('item-to-NPC give can remove exactly the selected inventory item', () => {
  const { api, context } = loadTerrainBoundary();
  context.inventory.splice(0, context.inventory.length,
    { id: 'base_shell_01', name: 'Odd Shell', type: 'shell', tags: ['shell', 'clue'] },
    { id: 'base_rod_01', name: 'Fishing Rod', type: 'rod', tags: ['tool'] }
  );
  const requestData = itemNPCRequest({ targetId: 'sage', verb: 'give', intent: 'I give Odd Shell to Sage.' });
  const validGive = api.translateGMOutcomeEffects(requestData, itemNPCOutcome({
    effects: [{ op: 'remove_item', id: 'base_shell_01' }]
  }), { targetId: 'sage', toolId: null });
  assert.equal(validGive.valid, true, validGive.errors.join(' | '));
  assert.deepEqual(JSON.parse(JSON.stringify(validGive.translatedEffects)), [{ op: 'remove_item', id: 'base_shell_01', count: 1 }]);

  const wrongItem = api.translateGMOutcomeEffects(requestData, itemNPCOutcome({
    effects: [{ op: 'remove_item', id: 'base_rod_01' }]
  }), { targetId: 'sage', toolId: null });
  assert.equal(wrongItem.valid, false);
  assert.match(wrongItem.errors[0], /only the selected inventory item/);

  const showCannotRemove = api.translateGMOutcomeEffects(itemNPCRequest({ targetId: 'sage', verb: 'show', intent: 'I show Odd Shell to Sage.' }), itemNPCOutcome({
    effects: [{ op: 'remove_item', id: 'base_shell_01' }]
  }), { targetId: 'sage', toolId: null });
  assert.equal(showCannotRemove.valid, false);
  assert.match(showCannotRemove.errors[0], /showing or asking about an item cannot remove/);
});

test('item-to-NPC rejects unsupported item, world, terrain, movement, and damage effects', () => {
  const { api, context } = loadTerrainBoundary();
  context.inventory.splice(0, context.inventory.length, { id: 'base_shell_01', name: 'Odd Shell', type: 'shell', tags: ['shell', 'clue'] });
  const requestData = itemNPCRequest({ targetId: 'sage' });
  const blockedEffects = [
    { op: 'give_item', item: { id: 'gm_new_reward', name: 'Reward' } },
    { op: 'spawn_item', item: { id: 'gm_spawned_shell', name: 'Shell' }, x: 10, y: 10, level: '0' },
    { op: 'create_prop', id: 'gm_item_npc_prop', name: 'Sudden Prop', x: 10, y: 10, level: '0' },
    { op: 'remove_prop', id: 'gm_item_npc_prop' },
    { op: 'set_terrain', id: 'gm_item_npc_terrain', tileId: 'tile:0:10:10', mode: 'dig' },
    { op: 'move_npc', id: 'sage', x: 11, y: 10, level: '0' },
    { op: 'damage_entity', id: 'sage', damage: true },
    { op: 'set_entity_state', id: 'guard', state: { mood: 'curious' } }
  ];
  for (const effect of blockedEffects) {
    const translated = api.translateGMOutcomeEffects(requestData, itemNPCOutcome({ effects: [effect] }), { targetId: 'sage', toolId: null });
    assert.equal(translated.valid, false, `${effect.op} should be rejected`);
    assert.match(translated.errors[0], /not supported|must target resolved NPC sage/);
  }
});

test('item-to-NPC late binding rejects non-originating, non-NPC, player, and missing selected item', () => {
  const { api, context } = loadTerrainBoundary();
  context.inventory.splice(0, context.inventory.length, { id: 'base_shell_01', name: 'Odd Shell', type: 'shell', tags: ['shell', 'clue'] });
  let requestData = itemNPCRequest();
  assert.equal(api.validateGMResolutionBindings(requestData, itemNPCOutcome({ bindings: { targetId: 'sage' } })).valid, true);

  let invalid = api.validateGMResolutionBindings(requestData, itemNPCOutcome({ bindings: { targetId: 'missing_npc' } }));
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(' | '), /originating|NPC/);

  invalid = api.validateGMResolutionBindings(requestData, itemNPCOutcome({ bindings: { targetId: 'base_prop:old_stone:0:10:11' } }));
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(' | '), /NPC/);

  invalid = api.validateGMResolutionBindings(requestData, itemNPCOutcome({ bindings: { targetId: 'player' } }));
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(' | '), /originating|NPC/);

  requestData = itemNPCRequest({ targetId: 'sage' });
  requestData.context.actor.inventory = [];
  invalid = api.validateGMResolutionBindings(requestData, itemNPCOutcome());
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(' | '), /originating inventory item/);
});

test('nearby NPC dialogue state is compact and limited to safe semantic fields', () => {
  const { api, context } = loadTerrainBoundary();
  context.npcs.push({
    id: 'sage',
    name: 'Sage',
    type: 'human',
    gridX: 11,
    gridY: 10,
    level: '0',
    state: {
      mood: 'curious',
      attitude: 'guarded',
      lastHeard: 'odd shell',
      secretInventory: ['coins'],
      unboundedNotes: 'x'.repeat(500)
    }
  });
  const sageCandidate = api.getNearbyActionContextEntities().find(entity => entity.id === 'sage');
  assert.deepEqual(JSON.parse(JSON.stringify(sageCandidate.state)), {
    mood: 'curious',
    attitude: 'guarded',
    lastHeard: 'odd shell'
  });
  assert.equal(sageCandidate.state.secretInventory, undefined);
  assert.equal(sageCandidate.state.unboundedNotes, undefined);
});

test('Search to Tell NPC loop persists canonical memory and state into later relevant ActionContext', () => {
  const { api, context } = loadTerrainBoundary();
  context.worldMemory.facts = Array.from({ length: 20 }, (_, index) => `Unrelated harbor rumor ${index}.`);
  context.worldMemory.summary = 'A broad unrelated history of distant places.';
  context.npcs.push({
    id: 'sage',
    name: 'Sage',
    type: 'human',
    gridX: 11,
    gridY: 10,
    level: '0',
    state: { privateNotes: 'not for ActionContext' }
  });

  const searchRequestData = searchRequest(api, context);
  const searchResult = api.applyGMOutcome(searchRequestData, searchOutcome({
    effects: [
      { op: 'add_memory', text: 'The player found an odd shell while searching nearby.' },
      { op: 'set_flag', key: 'found_odd_shell', value: true }
    ]
  }));
  assert.equal(searchResult.status, 'applied', searchResult.diagnostics.join(' | '));
  assert.equal(context.worldFlags.found_odd_shell, true);
  assert.equal(context.worldMemory.facts.includes('The player found an odd shell while searching nearby.'), true);

  const dialogueEntities = api.getNearbyActionContextEntities();
  const tellRequest = dialogueRequest({
    entities: dialogueEntities,
    intent: 'I tell Sage I found an odd shell.'
  });
  const tellResult = api.applyGMOutcome(tellRequest, dialogueOutcome({
    bindings: { targetId: 'sage' },
    effects: [
      { op: 'add_memory', text: 'Sage was told about the odd shell the player found.' },
      { op: 'set_flag', key: 'sage_heard_about_odd_shell', value: true },
      { op: 'set_entity_state', id: 'sage', state: { topic: 'odd shell', mood: 'curious', lastHeard: 'The player found an odd shell.' } }
    ]
  }));
  assert.equal(tellResult.status, 'applied', tellResult.diagnostics.join(' | '));
  assert.equal(context.worldFlags.sage_heard_about_odd_shell, true);
  assert.equal(context.npcs.find(npc => npc.id === 'sage').state.lastHeard, 'The player found an odd shell.');

  const laterEntities = api.getNearbyActionContextEntities();
  const laterSage = laterEntities.find(entity => entity.id === 'sage');
  const laterAction = { id: 'dialogue-later', verb: 'improvise', intent: 'I ask Sage about the odd shell again.' };
  const laterMemory = api.getRelevantActionMemory(laterAction, laterSage, laterEntities);
  const laterRequest = {
    protocol: 'gm_request_v1',
    action: laterAction,
    context: {
      nearby: { entities: laterEntities },
      relevantState: { memory: laterMemory }
    }
  };

  assert.deepEqual(JSON.parse(JSON.stringify(laterSage.state)), {
    mood: 'curious',
    topic: 'odd shell',
    lastHeard: 'The player found an odd shell.'
  });
  assert.equal(laterSage.state.privateNotes, undefined);
  assert.equal(laterRequest.context.relevantState.memory.facts.length <= 8, true);
  assert.equal(laterRequest.context.relevantState.memory.facts.some(fact => /odd shell/i.test(fact)), true);
  assert.equal(laterRequest.context.relevantState.memory.facts.some(fact => /Unrelated harbor rumor/i.test(fact)), false);
  assert.equal(laterRequest.context.relevantState.memory.summary, '');
  assert.equal(laterRequest.context.nearby.all, undefined);
  assert.equal(laterRequest.context.canvasEntities, undefined);
});
