# SV13 Repo 8 — Duel-Bot current-build audit and repair

## Source of truth
This pass was re-based from the user-supplied current archive only:

- Archive: `Duel-Bot-main (1).zip`
- SHA-256: `becdf017aeaedbd391bf71a995c71dd8fa5b646f2908eb1dca5e4faee56003cc`

The previous Duel-Bot patch was treated only as a candidate implementation. Every runtime change below was checked against this uploaded build before inclusion.

## Current-build findings

### Canonical session architecture is already present and should be retained
The uploaded build already has the correct persistent per-session foundation in:

- `logic/duelSessions.js`
- `routes/duel.js`
- `utils/playerLinks.js`
- `utils/storageClient.js`
- `server.js`

The canonical browser identity remains `session + token`; seat resolution stays server-side. `server.js` mounts `routes/duel.js` at `/duel` and `/api/duel`. These files/contracts were preserved rather than replacing the session model.

### Confirmed gameplay regression
The current `logic/duelActions.js` is transport/state-movement only:

- `play_card` removes an ID from hand and places it on field, but applies no card effect or HP change.
- `applyBotTurn()` draws/places a card and changes turns, but applies no card effect or HP change.
- `end_turn` only swaps players/increments turn; it does not perform the original Duel UI field cleanup or start-of-turn draw.
- `start_turn` and `remove_field_card` are not implemented even though the repaired Duel UI uses those discrete actions.

That exactly explains the observed test: the bot card appeared and its SFX played in the browser, but HP did not change and the turn loop became incomplete.

### Existing legacy effect modules cannot safely be wired into DuelSession
The upload still contains older global-state modules such as:

- `logic/cardEffectHandler.js`
- `logic/botHandler.js`
- `logic/drawCard.js`
- `logic/resolveComboEffects.js`
- `logic/duelState.js`
- legacy/unmounted duel route files

They are based on the old global `duelState` model. `cardEffectHandler.js` also expects `logicActions[]`, while the current canonical `CoreMasterReference.json` uses `effect`, `logic_action`, `tags`, and `type`. Reconnecting those old modules would reintroduce the architecture Repo 8 is removing. They are therefore left untouched and unmounted.

## Repair strategy

A new `logic/duelEffects.js` adapts the original Duel UI gameplay semantics to the existing current DuelSession state instead of resurrecting global browser authority.

The session server now owns:

- one-time/idempotent start-of-turn draw;
- 3-card field limit matching the original UI;
- hand discard;
- local field-card removal to discard;
- ephemeral field cleanup at end turn;
- persistent Defense/trap retention;
- fired-trap cleanup;
- immediate damage/heal/draw/discard/steal families used by the original Duel UI resolver;
- attack buffs and the original supported special effect families;
- start-turn DOT/basic status ticks;
- practice bot play + effect resolution + turn handoff;
- winner detection and canonical finalization;
- Combat Boots #034 Bear Trap/tripwire immunity;
- concealed trap redaction for opponent/spectator payloads using the current canonical master, not a hard-coded public card ID leak.

The browser still sends discrete actions only. The server remains authoritative.

## Runtime files changed

1. `logic/duelEffects.js` — **NEW**
2. `logic/duelActions.js` — **UPDATED**
3. `routes/duel.js` — **UPDATED**

No changes were made to `server.js`, `logic/duelSessions.js`, storage, economy, trading, linking, pack purchase, collection, stats, environment variables, or persistence paths.

## Validation performed against the uploaded current build

### Full test suite
`npm test` against the patched copy of the uploaded current repo:

- **17/17 tests passed**
- Includes all 10 existing recovery/contracts tests plus 7 new DuelSession gameplay tests.

New gameplay coverage verifies:

- Derringer #028 actually applies 20 HP damage.
- Field remains capped at 3.
- Field removal moves the card to discard.
- End turn clears ephemeral field cards, preserves Defense, advances turn, and auto-draws once.
- `start_turn` is idempotent/reconnect-safe.
- Practice bot card effects change HP and return control.
- Combat Boots #034 blocks Bear Trap/tripwire trap damage.
- Face-down trap IDs are redacted from remote/spectator state.

### Active-source syntax scan
`npm run check:active`:

- **64 active files passed syntax checks.**

### Direct syntax checks
The three runtime repair files and new gameplay test pass `node --check`.

## Files deliberately NOT included

The delivery ZIP contains new/updated files only. It does **not** contain:

- `.env` or any secrets;
- persistent player/economy/trade data;
- `server.js`;
- `logic/duelSessions.js`;
- current config/storage files;
- legacy global duel modules;
- unrelated cogs/routes.

## Deployment/test note
Apply the Duel-Bot files first, redeploy successfully, then test with a **brand-new `/practice` session**. Do not use the already-mutated practice session from the broken UI test as validation state.

This repair restores the original supported gameplay-loop/effect families under server authority. It is not a substitute for the planned separate 127-card effect-by-effect certification pass.
