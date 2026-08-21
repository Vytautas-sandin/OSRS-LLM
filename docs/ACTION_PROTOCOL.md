# GameAction protocol

## Purpose

`GameAction` is the canonical, renderer-independent description of something an actor intends to do. It is intended to become the common interface for both deterministic UI actions (walking, opening a door, picking up an item) and improvised natural-language actions that may require an external AI GM.

This first foundation only defines, normalizes, validates, and demonstrates actions. Existing click handlers, gameplay functions, and the GM JSON protocol do not route through it yet.

## Canonical fields

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier for this action instance. |
| `source` | Input origin: `ui`, `text`, or `system`. |
| `actorId` | Stable actor identifier; defaults to `player`. |
| `verb` | Normalized action verb, such as `pickup`, `open`, or `improvise`. |
| `targetId` | Stable target identifier, or `null`. |
| `toolId` | Stable item/tool identifier, or `null`. |
| `intent` | Free-text intent, or `null`; especially useful for improvised actions. |
| `parameters` | Plain object containing structured, verb-specific details. |
| `routing.mode` | `local`, `gm`, `hybrid`, or `unknown`. Routing is descriptive only for now. |
| `routing.reason` | Optional explanation for the routing decision. |
| `createdAt` | Action creation time as a date string. |

IDs are trimmed but otherwise preserved so existing entity IDs are not silently rewritten. Sources, verbs, and routing modes are normalized to lowercase; spaces and hyphens in verbs become underscores.

## Examples

Deterministic pickup:

```json
{
  "id": "example_pickup_shell",
  "source": "ui",
  "actorId": "player",
  "verb": "pickup",
  "targetId": "base_shell_01",
  "toolId": null,
  "intent": null,
  "parameters": {},
  "routing": { "mode": "local", "reason": "Existing deterministic pickup." },
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

Deterministic door interaction:

```json
{
  "id": "example_open_door",
  "source": "ui",
  "actorId": "player",
  "verb": "open",
  "targetId": "door:0:11:10:S",
  "toolId": null,
  "intent": null,
  "parameters": {},
  "routing": { "mode": "local", "reason": "Existing deterministic door interaction." },
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

Improvised action:

```json
{
  "id": "example_improvise_door",
  "source": "text",
  "actorId": "player",
  "verb": "improvise",
  "targetId": "door:0:11:10:S",
  "toolId": "base_shovel_01",
  "intent": "I wedge the shovel into the crack and try to lever the door open.",
  "parameters": {},
  "routing": { "mode": "gm", "reason": "Improvised physical action requires GM resolution." },
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

The developer console can call `runGameActionProtocolSelfTest()` to obtain validation results for these three non-executing examples. Once the world has initialized, `runActionContextSelfTest()` builds and validates an `ActionContext` for each example without routing or executing it.

## ActionContext v1

`ActionContext` is the compact, renderer-independent packet needed to resolve one valid normalized `GameAction`. It exists so a future local or GM resolver receives action-relevant state rather than a generic dump of the whole world.

The v1 context contains:

- The normalized action.
- The actor's current level, tile, compact inventory, active tool mode, and selected use item.
- A resolved target and tool when their stable references can be found.
- Nearby action-relevant entity snapshots within the existing eight-tile canvas interaction radius.
- The recent GM event delta, capped at 20 events.
- World flags and serialized world memory.
- Semantic anchors on the actor/target level, plus an explicitly requested anchor when present.

It deliberately excludes Three.js meshes, groups, materials, geometry, hitboxes, DOM nodes, functions, circular runtime data, source code, and the legacy GM payload's global canvas-entity list. Context values pass through a serializable-value copier, and `validateActionContext(...)` verifies that the resulting packet can be passed to `JSON.stringify(...)`.

### Legacy identity compatibility

Dynamic entities and ground items retain their existing stable IDs. Base NPCs retain their current NPC IDs. Base doors do not currently have native entity IDs, so ActionContext v1 uses deterministic compatibility IDs in this form:

```text
door:<level>:<x>:<y>:<direction>
```

For example, `door:0:11:10:S` resolves the south-facing base door at ground-level tile `(11, 10)`. This adapter does not mutate or redesign the legacy door object. It is a temporary compatibility layer that can disappear when canonical world state supplies native identity for every entity.

### Bounded selection

> World size should not determine AI context size. Action relevance should.

ActionContext includes the direct target/tool even when they require specific lookup, but nearby context is radius-bounded and no global entity dump is added automatically. This keeps future resolver input tied to the action rather than allowing it to grow linearly with the entire world.

## Late GM target resolution

Improvised text does not need a previously clicked target. `createImprovisedGameAction(...)` preserves the player's natural-language intent and leaves `targetId` as `null` when neither an explicit selected target nor a last target is supplied. It never extracts or guesses an entity from the text. An explicit selected target takes precedence over the optional last-target fallback.

The GM instead receives the nearby candidates in `ActionContext.nearby.entities`. Candidate collection uses the player's current level, an 8-tile Chebyshev radius, deterministic distance/kind/id ordering, stable-ID deduplication, and a defensive maximum of 96 entries. Similar entities are not collapsed, so ambiguity is available to the GM. The bounded set includes base doors, explicitly authored temple pillars, structural base walls, placement-derived base transitions, ground items, NPCs, and nearby GM-created entities (including props, hotspots, walls, and transitions). It does not inspect Three.js meshes to invent semantic objects and does not add a whole-world entity dump.

Base features without canonical IDs use deterministic compatibility IDs:

```text
base_prop:temple_pillar:<level>:<x>:<y>
base_wall:<level>:<x>:<y>:<direction>
base_transition:<level>:<x>:<y>:<targetLevel>:<spawnX>:<spawnY>
```

`runLateGMTargetResolutionSelfTest()` is a side-effect-free browser-console regression covering unselected pillar and door references, explicit target precedence, range/level bounding, ambiguity, the 96-candidate/no-world-dump guard, and `GMRequest` serialization.

`getActionContextDiagnostics(context)` reports serialized character and UTF-8 byte size, nearby entity count, target/tool resolution, and validation results. It is developer instrumentation only and adds no visible UI.

## Action router v1

The router answers one question:

> Can the deterministic game engine resolve the intended action faithfully?

It does **not** ask whether the action was typed or clicked. A text-sourced action with the already-normalized verb `open` and an ordinary door target routes locally. An unusual shovel-and-door manipulation routes to the GM even though doors and shovels both have deterministic mechanics individually.

The router validates the supplied `GameAction` and `ActionContext`, derives a serializable decision, and never executes a handler or mutates the world. `GameAction.routing` is only a hint. When a non-`unknown` hint disagrees with the derived mode, the derived route wins and the route records a warning.

### Initial deterministic capability registry

The renderer-independent `DETERMINISTIC_ACTION_CAPABILITIES` table describes only mechanics already present in the prototype:

| Verbs | Required semantics | Future resolver |
| --- | --- | --- |
| `walk`, `move` | Destination in `parameters.tile` | `movement` |
| `open`, `close` | Resolved ordinary `door` | `door` |
| `pickup` | Resolved ground `item` | `pickup` |
| `drop` | Resolved inventory `item` | `drop` |
| `fish`, `fishing` | Resolved compatibility `water` target; rod prerequisite is enforced by the resolver | `fishing` |
| `dig`, `raise` | `parameters.tile` and a shovel/digging tool in inventory | `terrain` |
| `use_transition` | Resolved `transition` | `transition` |

These resolver names describe capability boundaries. The migration status below records which capabilities now have live resolvers and which still use legacy handlers.

### Route outcomes

- **Deterministic and sufficiently specified** actions route to `local` with a named resolver.
- **Valid, meaningful, but unsupported or interpretive** actions route to `gm` without a local resolver.
- **Invalid or unresolvable** actions route to `reject` without executing anything.
- `hybrid` is reserved for a future action that genuinely combines deterministic mechanics with GM interpretation. Router v1 does not manufacture a hybrid case.

`runActionRouterSelfTest()` constructs, contextualizes, routes, validates, and JSON-serializes the documented cases. `getActionRouteDiagnosticRows()` returns a compact report, while `printActionRouteDiagnostics()` displays it with `console.table(...)` in the developer console.

## Live migration status

Ordinary base-door interaction is the first mechanic that runs through the real Action pipeline:

```text
door click -> GameAction -> ActionContext -> router -> door resolver -> world mutation
```

The door input adapter creates `open` for a closed door or `close` for an open door and addresses the target through its deterministic compatibility ID. `executeGameAction(...)` validates the action and context, derives and validates the route, then dispatches only `local + door` to `resolveLocalDoorAction(...)`. The resolver owns the existing `doorObj.isOpen` mutation, Three.js rotation, player log message, and GM event.

Capabilities not listed as migrated may already be recognized by the router, but they continue using their legacy handlers. A `local` route therefore does not yet guarantee that its resolver has been migrated: `executeGameAction(...)` returns `not_migrated` for other local resolvers. GM routes return `needs_gm`, and invalid/unresolvable routes return `rejected`; none of those results execute a legacy fallback.

Pickup, drop, and ordinary fishing are now also migrated through the executor. Movement, transitions, terraforming, and other interactions continue using their unchanged legacy paths.

- **Migrated:** ordinary base doors, ground-item pickup, inventory-item drop, and ordinary fishing.
- **Recognized but not migrated:** movement, terraforming, and transitions.

`getLastDoorActionExecutionDiagnostic()` reports the latest live door Action ID, compatibility target ID, route, resolver, execution status, resulting open state, and diagnostics. `runDoorActionExecutionSelfTest()` uses detached door fixtures for open/close mutations and also covers GM, rejection, and not-yet-migrated outcomes.

### Item-location principle

Pickup and drop are modeled as movement of one item instance between locations:

```text
ground <-> inventory
```

The live pipelines are:

```text
item interaction -> GameAction -> ActionContext -> router -> pickup resolver -> inventory/world mutation
inventory interaction -> GameAction -> ActionContext -> router -> drop resolver -> inventory/world mutation
```

The item instance's `id` remains stable through pickup, drop, and later pickup. A separate `groundItemId` identifies the world container/hitbox. GM-created items already carry stable instance IDs. Base starter items now receive their deterministic `base_*` ID as their item-instance ID when spawned; after a base item is first dropped, its world container uses `ground_<item-id>` while the contained item retains the original base ID. This is a compatibility distinction, not a new item model.

`getLastItemTransferExecutionDiagnostic()` reports the latest action, item identity, source/destination location, relevant inventory slot, route/resolver, status, and whether identity was preserved.

### Delayed deterministic actions and water compatibility

Fishing is the first migrated deterministic action whose world result completes asynchronously:

```text
water interaction -> GameAction -> ActionContext -> router -> fishing resolver -> pending -> delayed world mutation
```

Routing determines that the engine understands ordinary fishing. Action acceptance validates the water target and rod prerequisite and returns a serializable `pending` result. After the existing delay, the resolver performs the existing random roll, checks capacity at reward time, records the final feedback/event, and stores a completed diagnostic. A pending result therefore means accepted, not already rewarded.

Base water has no native world-entity ID. The compatibility adapter uses deterministic references in this form:

```text
water:<level>:<x>:<y>
```

For example, `water:0:3:15` identifies a clicked shoreline tile on ground-level water. The adapter also checks that the current walkable surface does not sit above the existing water height. ActionContext resolves this to a plain `water` snapshot and never includes the Three.js water plane, geometry, or material. This compatibility layer can disappear when canonical world state gives water regions native identity.

The preserved legacy rules are a 2,000 ms delay, a Fishing Rod prerequisite, success when `Math.random() > 0.4` (60% probability), one fresh Raw Fish item on successful capacity, and the original cast/success/failure/full messages and GM events. The legacy mechanic did not explicitly save immediately after a catch, so migration does not add a new save call. It also did not cancel or re-check the rod/level after casting; the resolver preserves that behavior and only re-checks the inventory slot when applying a successful reward.

`getLastFishingExecutionDiagnostic()` reports the Action and water IDs, route/resolver, pending or completed phase, prerequisite snapshots, final success/result, reward item ID, and timing information.

## Planned pipeline

```text
input -> GameAction -> context builder -> router -> local resolver OR GM resolver -> validated outcome -> canonical world state
```

Actions routed to the GM now have a construction and validation boundary using `GMRequest v1` and `GMOutcome v1`. See [`GM_PROTOCOL.md`](GM_PROTOCOL.md). Outcome application and external model integration are not implemented.

### Exists now

- `createGameAction(...)`
- `normalizeGameAction(...)`
- `validateGameAction(...)`
- A side-effect-free diagnostic containing deterministic and improvised examples
- `buildActionContext(...)`
- `resolveActionEntityReference(...)` and the legacy door compatibility adapter
- `validateActionContext(...)`
- Bounded nearby/state/anchor selection and serialization diagnostics
- `runActionContextSelfTest()` for the three documented actions
- The deterministic capability registry and `routeGameAction(...)`
- `validateActionRoute(...)`
- Router self-tests and compact developer diagnostics
- The live `createDoorInteractionAction(...) -> executeGameAction(...) -> resolveLocalDoorAction(...)` base-door slice
- Live pickup/drop adapters and local item-transfer resolvers
- Live fishing adapter and delayed local fishing resolver
- Action-scoped GMRequest construction and GMOutcome validation (without application)
- Structured `pending`, `executed`, `needs_gm`, `rejected`, and `not_migrated` execution results
- Existing deterministic gameplay and existing GM payload/JSON systems, still operating independently

### Planned, not implemented here

- Adapters from UI and text input into `GameAction`
- Additional local action resolvers and a GM resolver behind the shared interface
- Validated canonical outcomes
- Canonical world-state application
- Migration of existing click handlers or GM commands to the pipeline
