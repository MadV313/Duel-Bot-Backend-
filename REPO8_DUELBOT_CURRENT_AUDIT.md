# SV13 Repo 8 — Duel-Bot current-build audit / combat-exhaustion repair

## Source of truth

This pass was re-based from the user-supplied current archive only:

- Archive: `Duel-Bot-main (2).zip`
- SHA-256: `1c9272fc55edbff0166a5273ad17f8a20dbb0f28df710f4d12acf56994578334`
- Audit date: 2026-08-31

The existing Repo 8 DuelSession repair in this archive was retained. No older Duel-Bot copy was used as a replacement source.

## Current architecture confirmed and retained

The current build already contains the required server-owned DuelSession model and the previous gameplay migration:

- `logic/duelSessions.js` owns unique practice/PvP sessions, token-hash seat resolution, revisions, summary finalization, and PvP stat finalization.
- `logic/duelActions.js` accepts discrete authenticated actions (`start_turn`, `play_card`, `discard`, `remove_field_card`, `end_turn`, `forfeit`) and exposes a practice-only bot turn.
- `routes/duel.js` exposes canonical session state/action endpoints and redacts concealed traps for remote players/spectators.
- `server.js` mounts `/duel` and `/api/duel`, allows `https://duel.sv13tcg.com` in CORS, and does not require legacy `player1`, `player2`, `opponentToken`, or `role` query authorization.
- `/practice` already supports the saved/random deck choice and creates a unique practice session.

Those systems were not rewritten.

## Reproduced remaining deadlock

The current server could still produce the exact late-match loop observed in live practice:

1. Both draw piles become empty.
2. Remaining hands/fields can contain harmless Loot/Defense/traps but no attack/infected/direct-damage play.
3. Face-down traps cannot fire because the current authoritative engine triggers them from attack/infected plays.
4. Both sides can therefore keep ending turns indefinitely even though HP can no longer change.

A second practice-only deadlock was also confirmed in `runBotTurn()`:

- the bot can fill all three persistent field slots with Defense/traps;
- with a full field, it cannot play the next card in hand;
- unlike a human, it had no equivalent of the manual field-removal action;
- this can prevent it from consuming the rest of its hand/deck indefinitely.

## Repair implemented

### Authoritative combat exhaustion — no discard reshuffle

`logic/duelEffects.js` now settles a duel by remaining HP when:

- both draw piles are empty; and
- neither player has current/future combat pressure available to the authoritative engine.

Combat pressure is conservatively retained when either side still has:

- an Attack or Infected card in hand;
- another non-trap card whose implemented metadata resolves direct HP pressure;
- pending DOT damage; or
- an implemented Weapon Cleaning Kit / Gun Cleaning Kit / tactical-recharge path that can recover an offensive card from discard.

Armed traps alone do **not** keep the duel alive when neither player can make an attack/infected play.

Outcome:

- higher remaining HP wins;
- equal HP produces a draw (`winner: null`);
- reason is `combat_exhaustion` (or `cards_exhausted` when both hands are also empty).

The pre-existing one-sided `no_cards` loss still applies when one player is completely empty **and the opponent still has real combat pressure**.

The exhaustion check runs after end-of-turn field cleanup so ephemeral played cards reach discard before the terminal state/summary is finalized.

### Practice bot full-field escape

When the practice bot has all three persistent field slots occupied but still has a playable hand card, it now clears one of its own field cards to discard before making its normal one-card play. Fired traps are preferred for removal when present.

This gives the bot the same basic escape path a human already has through `remove_field_card`, allowing its hand/deck to continue progressing instead of pass-looping forever.

## Files changed in this pass

Runtime:

1. `logic/duelEffects.js` — updated combat-exhaustion resolution + bot full-field progression.

Regression coverage:

2. `test/duel-session-gameplay.test.js` — added exhaustion/HP-tiebreak/recovery/full-field bot tests.

Documentation/manifest:

3. `REPO8_DUELBOT_CURRENT_AUDIT.md` — this current-source audit.
4. `PATCH_SHA256SUMS.txt` — checksums for the delivered patch files.

No changes were required in:

- `server.js`
- `routes/duel.js`
- `logic/duelActions.js`
- `logic/duelSessions.js`
- Discord cogs
- storage/economy/trade/player-link code
- environment/config files

## Validation

### Full automated suite

`npm test`:

- **22 / 22 tests passed**
- 7 previously existing DuelSession gameplay tests retained
- 5 new late-match/deadlock tests added
- all recovery/storage/economy/session tests continue to pass

New coverage verifies:

- harmless cards + armed traps + empty decks end by HP instead of infinite turns;
- equal final HP produces a draw;
- a real attack in hand prevents premature exhaustion;
- implemented weapon recovery from discard prevents premature exhaustion;
- a completely empty player still loses if the opponent has real combat pressure;
- a practice bot with a full persistent field clears a slot, plays, damages, discards cleanup cards, and returns control.

### Active production syntax scan

`npm run check:active`:

- **64 active files passed syntax validation.**

Direct `node --check` also passes the modified runtime/test files.

### Full-repository legacy scan

A deliberately broader `node --check` of every `.js` file found two pre-existing syntax-invalid legacy files:

- `scripts/config.js`
- `scripts/hubEnhancements.js`

They are not part of the active backend source set, are not mounted/served by `server.js`, and are excluded by the repository's own `check:active` production scan. They were therefore left untouched in this Repo 8 gameplay repair rather than widening scope into obsolete UI-side scripts.

## Deployment smoke test

After applying this patch and redeploying Duel-Bot, use a brand-new `/practice` session and verify:

1. normal attack damage / turn progression still works;
2. bot can progress after filling all three persistent field slots;
3. run a match until both decks are empty and neither side has an offensive/recoverable play;
4. duel automatically finalizes at end-turn;
5. higher HP player is declared winner (equal HP = draw);
6. winner overlay/summary uses the same session ID and final HP;
7. practice still does not change competitive PvP W/L.

The planned 127-card effect-by-effect certification remains a separate pass after all repositories are stabilized.
