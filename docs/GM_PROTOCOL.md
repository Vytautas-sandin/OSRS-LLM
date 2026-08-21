# Action-scoped GM protocol

## Purpose

`GMRequest` and `GMOutcome` form the renderer-independent boundary for actions routed as `needs_gm`:

```text
needs_gm -> buildGMRequest -> external model -> validateGMOutcome -> applyGMOutcome
```

There is still no model connection. A caller must explicitly pass a correlated request and outcome to `applyGMOutcome(...)`; validation or pasting JSON into the legacy tools does not implicitly invoke this path.

## Manual browser bridge

The Dev panel has a separately labelled **Action-scoped GM** workflow. **Copy Action GM Request** reads the Player action textarea at click time, creates a text-source `improvise` action, preserves an explicitly selected target/tool ID, builds the bounded `ActionContext`, routes it, and copies `gm_request_v1` only when the route needs a GM. An unselected target remains `null`; nearby stable candidates provide late target resolution context.

Paste the correlated `gm_outcome_v1` into the Action-GM textarea and choose **Validate / Apply GM Outcome**. The bridge correlates against only its most recently generated request, validates the outcome, and delegates all preflight and mutation to `applyGMOutcome(...)`. Narration is displayed separately from the physical effects and application diagnostics. Invalid JSON, invalid outcomes, and mismatched action IDs never reach the mutation boundary.

## Late resolution bindings

An outcome may resolve an ambiguous request with optional, explicit bindings:

```json
"bindings": {
  "targetId": "base_prop:temple_pillar:0:18:20",
  "toolId": "base_shovel_01"
}
```

Each bound target must occur as the resolved target or in the originating bounded nearby set, and each bound tool must occur in the originating inventory `toolCandidates`. Arbitrary, distant, or non-inventory IDs are rejected. A binding may fill a `null` action reference but may not contradict an explicit `GameAction.targetId` or `GameAction.toolId`. The application result exposes the effective IDs as `resolved.targetId` and `resolved.toolId` without mutating the original action.

## Outcome semantics

- **Narration-only success:** `effects: []` and `memory: []` is valid and performs no mutation or undo capture.
- **Mutating outcome:** every binding and effect is completely preflighted before the first mutation; an invalid later effect rejects the whole batch.
- **Failed or impossible action:** `failure` or `blocked` with narration and no effects is valid. A persistent flag or memory fact should be returned only when the failed attempt itself creates a lasting fact.

This bridge does not call `buildGMPayload()`, emit `gm_payload_v0`, include `canvasEntities.all`, embed the legacy command schema, or invoke the legacy Apply JSON controls. Those controls remain available under the clearly marked **Legacy GM / world-building controls** section.

## GMRequest v1

`gm_request_v1` contains the normalized `GameAction`, its bounded `ActionContext`, the derived GM route, a short resolution task, minimal narration/world-change rules, and a conservative allowed-effect vocabulary.

It deliberately excludes source code, DOM or Three.js objects, and `canvasEntities.all`. Ordinary GM request size is therefore determined by action relevance rather than total world size:

> World size should not determine ordinary GM action-request size.

`buildGMRequest(...)` returns `{ ok, request, errors }` and refuses non-GM routes. `validateGMRequest(...)` independently checks the action, context, route, protocol, policy shape, allowed effects, plain JSON values, and serialization.

Target resolution for unselected improvised actions happens late, at the GM boundary. In that case `action.targetId` remains `null`, the original intent is unchanged, and the request carries the bounded nearby candidate list described in the Action protocol. The client does not select a candidate by matching words in the intent. Explicit selected/last-target IDs remain direct targets and take precedence over candidate interpretation.

## GMOutcome v1

`gm_outcome_v1` contains:

- `actionId`: correlation with the originating action.
- `narration`: dialogue, interpretation, uncertainty, pushback, and fictional description.
- `resolution`: `success`, `failure`, `partial`, `blocked`, or `uncertain`, plus a reason.
- `effects`: zero to six persistent or physical consequences.
- `memory`: zero to six persistent narrative facts.

Narration is separate from mutation. A failed, blocked, conversational, or playful action may validly return narration with `effects: []`.

`validateGMOutcome(...)` checks correlation, protocol/result values, effect and memory limits, required effect fields, stable string IDs, plain JSON values, and serialization. It never applies an effect.

## Application boundary

The local application sequence is:

```text
GMOutcome -> validate -> preflight/translate -> undo snapshot -> apply -> persist/history
```

`validateGMOutcomeApplication(...)` validates the originating `gm_request_v1`, action correlation, the complete outcome, every authoritative target, item identity, placement, and application support before mutation. `translateGMOutcomeEffects(...)` converts the conservative effect subset to existing legacy commands or one narrow base-door semantic-state operation. `applyGMOutcome(...)` then captures one legacy GM undo snapshot, runs the trusted mutation helpers, saves once, and records one history entry. It returns a plain `gm_outcome_application_v1` result with `applied`, `rejected`, or `failed` status.

No intentional partial application is allowed. If any preflight fails, no effect runs. If a trusted helper unexpectedly fails after mutation starts, the application boundary attempts to restore its pre-application GM-world save and reports rollback status.

Narration remains presentation data: it is returned in the application result and is not converted into a log, dialogue command, or canvas mutation. Narration-only outcomes are valid successful no-ops and do not overwrite the current undo snapshot.

## Compatibility references

Action compatibility IDs are resolved before legacy mutation. In particular, `door:<level>:<x>:<y>:<direction>` resolves to the authoritative base-door object. `set_entity_state` merges plain semantic state onto that door without creating a prop, toggling `isOpen`, or rotating its mesh. Base-door semantic state is included in ActionContext and the GM save/undo snapshot. Other transform operations against base doors are rejected because the legacy base-door representation cannot safely express them.

GM-created canvas entities retain their normal legacy IDs and are passed to existing entity, prop, NPC, transition, and terrain helpers. Base NPC movement is deliberately rejected at this boundary; only GM-created NPC movement is currently rollback-safe.

## Memory policy

Top-level `memory` is canonical. During preflight, `add_memory` effects are normalized into that channel, trimmed, and deduplicated case-insensitively against both the outcome and existing world memory. Each logical fact is applied at most once. `set_flag` writes to existing persistent world flags, but only accepts a flat safe key and a JSON scalar value; object-path and prototype keys are rejected.

## Items and transactions

`give_item` and `spawn_item` require a stable item instance ID, reject duplicate live IDs, and use the existing item instance, inventory, ground-item, rendering, and save helpers. Items therefore interoperate with the migrated drop/pickup pipeline. Remove/consume operations require the exact authoritative stable ID at preflight.

The current application subset supports all listed v1 effects subject to conservative target constraints. Dynamic entity transforms require a resolvable legacy canvas entity; base doors only accept semantic `set_entity_state`; authored base temple pillars accept context-bound semantic state and damage updates without a duplicate GM prop; NPC movement is limited to GM-created NPCs; creation effects require unused IDs and valid tiles. Unsafe or unrepresentable requests reject the complete batch rather than inventing a duplicate entity.

## Conservative effect subset

Effects reuse existing legacy GM command operation names rather than defining a second mutation language:

- Existing entity changes: `update_entity`, `transform_entity`, `set_entity_state`, `damage_entity`.
- Movement: `move_npc`, `move_prop`.
- Small props: `create_prop`, `remove_prop`.
- Inventory: `give_item`, `remove_item`, `consume_item`.
- Ground items: `spawn_item`, `remove_ground_item`.
- Persistent narrative state: `set_flag`, `add_memory`.
- Passages: `create_transition`, `remove_transition`.
- Limited terrain: `set_terrain`.

New item effects require a stable `item.id`, and modifying existing stable entity IDs is preferred over creating replacements. The subset intentionally omits broad scene-construction, inventory replacement, player teleportation, dialogue UI, debug logging, and other dev-oriented operations.

## Relationship to the legacy GM system

The existing `buildGMPayload()`, `buildGMInstructions()`, Copy Prompt/Payload UI, JSON extraction/application, command history, undo, saves, and full scene-generation vocabulary remain unchanged.

The new protocol reuses the legacy system's strongest policies:

- narration belongs outside world commands;
- commands represent only visible or persistent changes;
- existing stable IDs should be updated before creating duplicates;
- normal action resolution should use small bounded deltas;
- outcomes must be validated before mutation.

In the future, action-scoped requests can supersede the large generic payload for ordinary improvised actions. The legacy workflow may remain valuable for manual development, adventure seeding, imports/exports, and large scene changes.

## Current implementation boundary

Implemented now:

- GM request construction/refusal and validation.
- GM outcome validation.
- Request/context/legacy-payload size diagnostics.
- Valid examples for shovel/door improvisation, persuading Bob, and narration-only dancing.
- Rejection tests for wrong action IDs, unsupported effects, excessive effects, and malformed targets.

Implemented application boundary:

- Complete request/outcome correlation, validation, translation, and preflight.
- Atomic-as-practical application through existing legacy mutation helpers.
- One undo snapshot, save, and history entry per mutating outcome.
- Base-door semantic state compatibility and persistence.
- Canonical memory deduplication and stable item interoperability.
- `applyManualGMOutcomeForAction(...)` for explicit console-driven experiments.

Not implemented:

- External model/API calls.
- Automatic prompt submission.
- Any call from `executeGameAction()` into the legacy GM command application engine.
- Automatic outcome application.
