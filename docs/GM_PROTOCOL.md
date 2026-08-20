# Action-scoped GM protocol

## Purpose

`GMRequest` and `GMOutcome` form the renderer-independent boundary for actions routed as `needs_gm`:

```text
needs_gm -> buildGMRequest -> external model -> validateGMOutcome -> applyGMOutcome
```

There is still no model connection. A caller must explicitly pass a correlated request and outcome to `applyGMOutcome(...)`; validation or pasting JSON into the legacy tools does not implicitly invoke this path.

## Manual browser workflow

The Dev panel now exposes this boundary without connecting an API:

1. Enter the intended action in **Player action / question for the GM**.
2. Select an in-world target and, when relevant, choose an inventory item with **Use**.
3. Press **Copy Action GM Request**. The browser reads the textarea at that moment, creates a text-sourced `GameAction` with verb `improvise`, builds its bounded `ActionContext`, routes it, and copies the exact `gm_request_v1` into the shared JSON area and clipboard.
4. Give that request to an external GM manually, then replace the shared JSON text with its correlated `gm_outcome_v1`.
5. Press **Validate / Apply GM Outcome**. The browser validates correlation and the outcome, preflights the entire application, then calls `applyGMOutcome(...)`. Narration is presented separately from physical effects.

The panel reports the Action ID, intent, target/tool IDs, route, ActionContext and GMRequest character sizes, and outcome/application status. If a supplied action is already deterministic, the builder reports the local resolver and does not create a GM request.

This path never calls `buildGMPayload()`, never adds `canvasEntities.all`, and never embeds the legacy scene-building command schema. The existing Legacy GM buttons remain available alongside it for broad world-building and development tasks.

### Late target resolution

The selected/last target is an optional high-confidence hint, not a prerequisite for an improvised request. With no explicit selection, the manual bridge leaves `GameAction.targetId` null and preserves the player's text verbatim in `intent`. It never guesses a target by parsing or string-matching that text.

The GM instead receives bounded nearby candidate entities from ActionContext. Stable dynamic entities are included alongside deterministic compatibility snapshots for relevant base doors, walls, temple pillars, and transitions. Ground items, NPCs, hotspots, and other GM-created entities continue to use their existing stable snapshots. Thus phrases such as “the pillar,” “the door,” or “that crate” can be resolved by the external GM against local evidence, while distant objects and whole-world entity lists remain excluded. When the player explicitly selects a target, that target remains the request's resolved target.

## GMRequest v1

`gm_request_v1` contains the normalized `GameAction`, its bounded `ActionContext`, the derived GM route, a short resolution task, minimal narration/world-change rules, and a conservative allowed-effect vocabulary.

It deliberately excludes source code, DOM or Three.js objects, and `canvasEntities.all`. Ordinary GM request size is therefore determined by action relevance rather than total world size:

> World size should not determine ordinary GM action-request size.

`buildGMRequest(...)` returns `{ ok, request, errors }` and refuses non-GM routes. `validateGMRequest(...)` independently checks the action, context, route, protocol, policy shape, allowed effects, plain JSON values, and serialization.

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

The current application subset supports all listed v1 effects subject to conservative target constraints. Dynamic entity transforms require a resolvable legacy canvas entity; base doors only accept semantic `set_entity_state`; NPC movement is limited to GM-created NPCs; creation effects require unused IDs and valid tiles. Unsafe or unrepresentable requests reject the complete batch rather than inventing a duplicate entity.

## Conservative effect subset

Effects reuse existing legacy GM command operation names rather than defining a second mutation language:

- Existing entity changes: `update_entity`, `transform_entity`, `set_entity_state`.
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
- External transport for the manual Action GM request/outcome workflow.
