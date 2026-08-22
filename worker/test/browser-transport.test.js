import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const start = html.indexOf('    function makeGMTransportError');
const end = html.indexOf('    function setGMTransportDiagnostics', start);
assert.ok(start > 0 && end > start, 'transport adapter source is present');

function functionSource(name) {
  const sourceStart = html.indexOf(`    function ${name}(`);
  assert.ok(sourceStart >= 0, `${name} source is present`);
  const bodyStart = html.indexOf(') {', sourceStart) + 2;
  let depth = 0;
  for (let index = bodyStart; index < html.length; index++) {
    if (html[index] === '{') depth++;
    if (html[index] === '}' && --depth === 0) return html.slice(sourceStart, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

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

test('dev panel presents Local World Builder by default and keeps AI advanced', () => {
  const panelStart = html.indexOf('<div id="dev-panel">');
  const localStart = html.indexOf('<details id="local-world-builder-section"', panelStart);
  const actionStart = html.indexOf('<summary>Action GM · gm_request_v1 / gm_outcome_v1</summary>', panelStart);
  const transportStart = html.indexOf('<summary>External AI Transport</summary>', panelStart);
  const worldStateStart = html.indexOf('<summary>World State</summary>', panelStart);
  const legacyStart = html.indexOf('<details id="legacy-gm-section"', panelStart);
  assert.ok(panelStart > 0 && localStart > panelStart);
  assert.ok(localStart < actionStart && actionStart < transportStart && transportStart < worldStateStart);

  const localEnd = html.indexOf('</details>', localStart);
  const localPanel = html.slice(localStart, localEnd);
  assert.match(html.slice(panelStart, panelStart + 80), /World Lab/);
  assert.match(localPanel, /<summary>Local World Builder<\/summary>/);
  assert.match(localPanel, /open>/);
  assert.match(localPanel, /id="llm-io"/);
  assert.match(localPanel, /id="validate-llm-json"/);
  assert.match(localPanel, /id="apply-llm-json"/);
  assert.match(localPanel, /id="undo-gm-apply"/);
  assert.match(localPanel, /id="save-world-state"/);
  assert.match(localPanel, /id="load-world-state"/);
  assert.match(localPanel, /id="insert-settlement-blueprint"/);
  assert.match(localPanel, /id="copy-gm-map"/);
  assert.match(localPanel, /id="copy-gm-context"/);
  assert.match(localPanel, /id="clear-world-builder-input"/);

  const actionDetailsStart = html.lastIndexOf('<details', actionStart);
  const actionOpenTag = html.slice(actionDetailsStart, html.indexOf('>', actionDetailsStart) + 1);
  assert.doesNotMatch(actionOpenTag, /\sopen\b/);
  const actionPanel = html.slice(actionDetailsStart, transportStart);
  assert.match(actionPanel, /id="player-action"/);
  assert.match(actionPanel, /id="search-nearby-action"/);
  assert.match(actionPanel, /id="talk-nearby-action"/);
  assert.match(actionPanel, /id="copy-action-gm-request"/);
  assert.match(actionPanel, /id="apply-action-gm-outcome"/);
  assert.match(actionPanel, /id="action-gm-io"/);

  const transportDetailsStart = html.lastIndexOf('<details', transportStart);
  const transportOpenTag = html.slice(transportDetailsStart, html.indexOf('>', transportDetailsStart) + 1);
  const transportPanel = html.slice(transportDetailsStart, worldStateStart);
  assert.doesNotMatch(transportOpenTag, /\sopen\b/);
  assert.match(transportPanel, /id="gm-endpoint"/);
  assert.match(transportPanel, /id="gm-access-token"/);
  assert.match(transportPanel, /id="resolve-action-ai"/);

  assert.match(html, /id="look-around-dev"/);
  assert.match(html, /id="world-summary"/);
  assert.match(html, /id="world-memory"/);
  assert.match(html, /id="gm-trace-count"/);
  assert.match(html.slice(legacyStart, html.indexOf('</details>', legacyStart)), /hidden/);
  assert.doesNotMatch(html, /Deprecated Legacy GM/);
  assert.match(html, /legacygm/);
});

test('local JSON parser accepts a single command object as one command', () => {
  const parserStart = html.indexOf('    function normalizeGMOp');
  const parserEnd = html.indexOf('    function validateLLMCommands', parserStart);
  assert.ok(parserStart > 0 && parserEnd > parserStart);
  const context = {};
  vm.createContext(context);
  vm.runInContext([
    html.slice(parserStart, parserEnd),
    "const parsed = parseGMCommandPayload('{\"op\":\"create_settlement\",\"id\":\"gm_settlement_test\"}');",
    'this.parsed = parsed;',
    'this.summary = summarizeGMCommands(parsed.commands);'
  ].join('\n'), context);
  assert.equal(context.parsed.ok, true);
  assert.equal(context.parsed.commands.length, 1);
  assert.equal(context.summary.total, 1);
  assert.equal(context.summary.supported, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.summary.ops)), { create_settlement: 1 });
});

test('Local World Builder accepts gm_proposal_v1 narration dialogue and commands', () => {
  const parserStart = html.indexOf('    function normalizeGMOp');
  const applyEnd = html.indexOf('    const devToggle = document.getElementById', parserStart);
  assert.ok(parserStart > 0 && applyEnd > parserStart);
  const proposal = {
    protocol: 'gm_proposal_v1',
    narration: 'Sage studies the map and nods.',
    dialogue: { speaker: 'Sage', text: 'This road leads beyond the known coast.' },
    commands: [{ op: 'add_memory', text: 'Sage identified the frontier road.' }]
  };
  const llmIO = { value: JSON.stringify(proposal) };
  const narration = { textContent: '' };
  const logs = [];
  const events = [];
  const dialogues = [];
  const memories = [];
  const context = {
    document: { getElementById: id => id === 'llm-io' ? llmIO : id === 'action-gm-narration' ? narration : null },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addLogMessage: value => logs.push(String(value)),
    recordGMEvent: (type, detail) => events.push({ type, detail }),
    showDialogueMessage: (speaker, text) => dialogues.push({ speaker, text }),
    addWorldMemoryFact: text => { memories.push(text); return true; },
    buildGMWorldSave: () => ({}),
    saveGMWorld: () => true,
    markGMResponseResolved: () => {}
  };
  vm.createContext(context);
  vm.runInContext(`${html.slice(parserStart, applyEnd)}\nthis.parsed = parseGMCommandPayload(document.getElementById('llm-io').value);\napplyLLMCommands();`, context);
  assert.equal(context.parsed.ok, true);
  assert.equal(context.parsed.payload.protocol, 'gm_proposal_v1');
  assert.equal(context.parsed.commands.length, 1);
  assert.equal(narration.textContent, proposal.narration);
  assert.deepEqual(JSON.parse(JSON.stringify(dialogues)), [proposal.dialogue]);
  assert.deepEqual(memories, ['Sage identified the frontier road.']);
  assert.equal(events.some(event => event.type === 'gm_response_started' && event.detail.protocol === 'gm_proposal_v1' && event.detail.hasDialogue === true), true);
  assert.equal(logs.some(line => line.includes('GM narration received')), true);
});

test('Local World Builder accepts gm_proposal_v1 dialogue arrays in order', () => {
  const parserStart = html.indexOf('    function normalizeGMOp');
  const applyEnd = html.indexOf('    const devToggle = document.getElementById', parserStart);
  assert.ok(parserStart > 0 && applyEnd > parserStart);
  const proposal = {
    protocol: 'gm_proposal_v1',
    dialogue: [
      { speaker: 'Sage', text: 'The tracks are fresh.' },
      'ignore this',
      { title: 'Fisherman', message: 'The tide will carry them east.' },
      { speaker: 'Silent' }
    ],
    commands: []
  };
  const llmIO = { value: JSON.stringify(proposal) };
  const dialogues = [];
  const events = [];
  const context = {
    document: { getElementById: id => id === 'llm-io' ? llmIO : id === 'action-gm-narration' ? { textContent: '' } : null },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addLogMessage: () => {},
    recordGMEvent: (type, detail) => events.push({ type, detail }),
    showDialogueMessage: (speaker, text) => dialogues.push({ speaker, text }),
    addWorldMemoryFact: () => true,
    buildGMWorldSave: () => ({}),
    saveGMWorld: () => true,
    markGMResponseResolved: () => {}
  };
  vm.createContext(context);
  vm.runInContext(`${html.slice(parserStart, applyEnd)}\napplyLLMCommands();`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(dialogues)), [
    { speaker: 'Sage', text: 'The tracks are fresh.' },
    { speaker: 'Fisherman', text: 'The tide will carry them east.' }
  ]);
  assert.equal(events.filter(event => event.type === 'gm_proposal_dialogue_shown').length, 2);
  assert.equal(events.some(event => event.type === 'gm_response_started' && event.detail.protocol === 'gm_proposal_v1' && event.detail.hasDialogue === true), true);
});

test('Local World Builder accepts gm_proposal_v1 staging commands with dialogue array', () => {
  const parserStart = html.indexOf('    function normalizeGMOp');
  const applyEnd = html.indexOf('    const devToggle = document.getElementById', parserStart);
  assert.ok(parserStart > 0 && applyEnd > parserStart);
  const proposal = {
    protocol: 'gm_proposal_v1',
    narration: 'The festival begins as dusk settles over the road.',
    dialogue: [
      { speaker: 'Sage', text: 'Lanterns are being lit.' },
      { speaker: 'Visitor', text: 'The market is opening.' }
    ],
    commands: [
      { op: 'set_scene_time', time: 'dusk', reason: 'festival opening' },
      { op: 'spawn_visitors', id: 'mistwood_festival_visitors', count: 4, target: 'player', theme: 'festival' }
    ]
  };
  const llmIO = { value: JSON.stringify(proposal) };
  const narration = { textContent: '' };
  const dialogues = [];
  const events = [];
  const sceneTimes = [];
  const visitors = [];
  const context = {
    document: { getElementById: id => id === 'llm-io' ? llmIO : id === 'action-gm-narration' ? narration : null },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addLogMessage: () => {},
    recordGMEvent: (type, detail) => events.push({ type, detail }),
    showDialogueMessage: (speaker, text) => dialogues.push({ speaker, text }),
    addWorldMemoryFact: () => true,
    setGMSceneTime: cmd => { sceneTimes.push(cmd); return true; },
    spawnGMVisitors: cmd => { visitors.push(cmd); return true; },
    buildGMWorldSave: () => ({}),
    saveGMWorld: () => true,
    markGMResponseResolved: () => {}
  };
  vm.createContext(context);
  vm.runInContext(`${html.slice(parserStart, applyEnd)}\napplyLLMCommands();`, context);
  assert.equal(narration.textContent, proposal.narration);
  assert.deepEqual(JSON.parse(JSON.stringify(dialogues)), proposal.dialogue);
  assert.equal(sceneTimes.length, 1);
  assert.equal(sceneTimes[0].time, 'dusk');
  assert.equal(visitors.length, 1);
  assert.equal(visitors[0].theme, 'festival');
  assert.equal(visitors[0].count, 4);
  assert.equal(events.some(event => event.type === 'gm_response_started' && event.detail.protocol === 'gm_proposal_v1' && event.detail.hasDialogue === true), true);
});

test('Search Nearby button fills action text without resolving or applying', () => {
  const fillStart = html.indexOf('    function fillSearchNearbyAction()');
  const fillEnd = html.indexOf('    function copyManualActionGMRequest', fillStart);
  assert.ok(fillStart > 0 && fillEnd > fillStart);
  const input = { value: '', focused: false, focus() { this.focused = true; } };
  const diagnostics = [];
  const context = {
    document: { getElementById: id => id === 'player-action' ? input : null },
    setActionGMDiagnostics: value => diagnostics.push(value),
    resolveManualActionWithAI: () => { throw new Error('should not resolve'); },
    applyGMOutcome: () => { throw new Error('should not apply'); }
  };
  vm.createContext(context);
  vm.runInContext(`${html.slice(fillStart, fillEnd)}\nthis.result = fillSearchNearbyAction();`, context);
  assert.equal(context.result, true);
  assert.equal(input.value, 'I search the nearby ground for anything unusual.');
  assert.equal(input.focused, true);
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostics)), [{
    intent: 'I search the nearby ground for anything unusual.',
    route: 'not built',
    outcomeValidation: 'not checked',
    application: 'not applied'
  }]);
});

test('Talk Nearby button fills dialogue text without resolving or applying', () => {
  const fillStart = html.indexOf('    function fillTalkNearbyAction()');
  const fillEnd = html.indexOf('    function copyManualActionGMRequest', fillStart);
  assert.ok(fillStart > 0 && fillEnd > fillStart);
  const input = { value: '', focused: false, focus() { this.focused = true; } };
  const diagnostics = [];
  const context = {
    document: { getElementById: id => id === 'player-action' ? input : null },
    setActionGMDiagnostics: value => diagnostics.push(value),
    resolveManualActionWithAI: () => { throw new Error('should not resolve'); },
    applyGMOutcome: () => { throw new Error('should not apply'); }
  };
  vm.createContext(context);
  vm.runInContext(`${html.slice(fillStart, fillEnd)}\nthis.result = fillTalkNearbyAction();`, context);
  assert.equal(context.result, true);
  assert.equal(input.value, 'I ask Sage about the odd shell.');
  assert.equal(input.focused, true);
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostics)), [{
    intent: 'I ask Sage about the odd shell.',
    route: 'not built',
    outcomeValidation: 'not checked',
    application: 'not applied'
  }]);
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

test('prepared item-on-NPC action preserves selected item and NPC target bindings', () => {
  const selectionStart = html.indexOf('    function getManualActionGMSelection()');
  const selectionEnd = html.indexOf('    function setActionGMDiagnostics', selectionStart);
  const builderStart = html.indexOf('    function buildManualActionGMRequest()');
  const builderEnd = html.indexOf('    function copyManualActionGMRequest', builderStart);
  assert.ok(selectionStart > 0 && selectionEnd > selectionStart && builderStart > selectionEnd && builderEnd > builderStart);

  const context = {
    document: { getElementById: id => id === 'player-action' ? { value: 'I give Odd Shell to Sage.' } : null },
    getLastInteractionTarget: () => ({
      kind: 'npc',
      id: 'sage',
      name: 'Sage',
      usedItem: 'base_shell_01',
      usedItemName: 'Odd Shell',
      proposedAction: 'I show Odd Shell to Sage.'
    }),
    getSelectedUseItemSnapshot: () => null,
    normalizeGameActionId: value => typeof value === 'string' && value ? value : null,
    createGameAction: action => ({ ...action, targetId: action.targetId ?? null, toolId: action.toolId ?? null }),
    buildActionContext: action => ({ action, target: { id: action.targetId, kind: 'npc' }, tool: { id: action.toolId }, toolCandidates: [{ id: action.toolId }] }),
    routeGameAction: () => ({ mode: 'gm' }),
    buildGMRequest: (action, actionContext, route) => ({ ok: true, request: { action, context: actionContext, route }, errors: [] })
  };
  vm.createContext(context);
  vm.runInContext(`${html.slice(selectionStart, selectionEnd)}\n${html.slice(builderStart, builderEnd)}\nthis.generated = buildManualActionGMRequest();`, context);
  const action = JSON.parse(JSON.stringify(context.generated.action));
  assert.equal(action.verb, 'give');
  assert.equal(action.targetId, 'sage');
  assert.equal(action.toolId, 'base_shell_01');
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
