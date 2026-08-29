# SV13 TCG — Repo #2 Duel Bot Recovery Report

Generated: 2026-08-29
Package type: NEW/UPDATED FILES ONLY
Source baseline: Duel-Bot-main(3).zip (byte-identical to the immediately preceding Duel-Bot-main upload)

## Recovery status
Repo #1 (sv13-tcg-data): repaired previously; production private-auth cutover remains coordinated with Repo #2.
Repo #2 (Duel-Bot-main): recovery implementation completed in this patch package.
Next repository after the coordinated Repo #1 + #2 deployment gate: Card-Collection-UI-main.

## Key fixes implemented
- Added STORAGE_KEY support and X-Storage-Key on private storage requests.
- Aligned storage health to /_health; added authenticated DELETE; preserved ETag / If-Match conditional writes and CAS retries.
- Canonicalized runtime storage paths; duel sessions persist beneath data/summaries/_sessions to stay inside Repo #1's approved storage namespace.
- Repaired canonical /me/:token routes and removed doubled /me/me/:token behavior.
- Removed browser-facing ME_BASE/me= propagation from active backend link generation; PERSISTENT_DATA_URL is server-side only.
- Migrated production defaults to sv13tcg.com / api.sv13tcg.com and the approved UI subdomains while retaining explicit dev/migration overrides.
- Added authoritative secret-free .env.template and canonical ENV -> legacy CONFIG_JSON/config.json -> defaults config resolution for non-secret settings; secrets remain environment-only.
- Normalized rarity before selling and pack weighting (Common/Uncommon/Rare/Legendary).
- Unified Discord/API selling through one 5-sells-per-day ledger with canonical sell values.
- Replaced stale one-pack-per-rolling-24h behavior with 5 packs/day, 3 coins/pack, 3 cards/pack and 250-card collection capacity checks.
- Added immutable opaque pack reveal IDs persisted under data/pack_reveals/<revealId>.json.
- Preserved modern profile.deck {name,cards:[{id,qty}]} schema; validates 20-40 cards, max 5 copies, actual ownership, excludes 000, and closes duplicate-row quantity bypasses.
- Replaced global duel/practice state with persistent per-session DuelSession records and unique practice sessions.
- Added challenge decision lifecycle, token-to-seat resolution, per-player links that expose only the viewer's token, and no role= authorization trust.
- Added authenticated/validated duel action entry point, server-owned finish/finalization path, revisioned state, reconnect-safe session retrieval, and idempotent PvP stat updates/summaries.
- Added explicit spectator-safe serialization (no hand identities, future deck order, or private effect state).
- Reconciled spectator chat around /spectator-chat and session rooms with server-side session validation/presence handling.
- Added canonical public GET /leaderboard and GET /summary/:sessionId contracts.
- Preserved the known-good trade swap flow while adding CAS/concurrency handling, canonical daily initiation accounting, ownership revalidation at acceptance, and no double-apply.
- Hardened debug/admin endpoints and API CORS defaults while preserving temporary legacy GitHub compatibility behind a flag.
- Added recovery regression tests and an active-source syntax checker.

## Modified files (34)
- .env.template
- cogs/buycard.js
- cogs/cardpack.js
- cogs/challenge.js
- cogs/duelcard.js
- cogs/duelcoin.js
- cogs/duelstats.js
- cogs/linkdeck.js
- cogs/mycards.js
- cogs/mycoins.js
- cogs/mydeck.js
- cogs/mystats.js
- cogs/practice.js
- cogs/sellcard.js
- cogs/spectate.js
- cogs/tradecard.js
- cogs/unlinkdeck.js
- cogs/viewlinked.js
- config.template.json
- package.json
- registerCommands.js
- routes/chatHistory.js
- routes/duel.js
- routes/duelSummary.js
- routes/leaderboard.js
- routes/meToken.js
- routes/packReveal.js
- routes/trade.js
- routes/user.js
- routes/userStats.js
- server.js
- utils/config.js
- utils/deckUtils.js
- utils/storageClient.js

## New files (9)
- logic/duelActions.js
- logic/duelSessions.js
- scripts/check-active.mjs
- test/recovery-contracts.test.js
- utils/economyService.js
- utils/packRevealStore.js
- utils/playerLinks.js
- utils/tradeCore.js
- utils/tradeLimits.js

## Preserved / intentionally not rewritten
- logic/CoreMasterReference.json is byte-identical to the uploaded baseline.
- Existing runtime seed/data JSON files are byte-identical to the uploaded baseline.
- Card images were treated as intentionally omitted from transfer, not missing assets.
- Known stale/dead scripts/config.js and scripts/hubEnhancements.js were not rehabilitated; active server code does not depend on them.
- Existing card-effect/gameplay work was preserved rather than stylistically rewritten.

## Deferred by the master recovery plan
- The 127-card gameplay/effect certification matrix remains a later QA phase after the networking/session architecture and Duel UI integration are complete.
- Old GitHub/Railway compatibility endpoints should not be retired until the new domains pass end-to-end migration tests.
- Do not proceed to production UI cutover until the coordinated Repo #1 + Repo #2 gate passes.

## Required Railway / environment changes
Set Duel Bot:
- PERSISTENT_DATA_URL = Railway private/internal URL for sv13-tcg-data when available
- STORAGE_KEY = the exact same secret configured on sv13-tcg-data
- API_BASE = https://api.sv13tcg.com
- UI bases from .env.template as the custom domains are connected
- BOT_API_KEY, DEBUG_KEY and Discord/channel/role IDs as appropriate

During migration, CORS_ALLOW_LEGACY_GITHUB may remain true. Set it false after all UIs are proven on the SV13 domains.

## Coordinated Repo #1 + Repo #2 deployment gate
1. Back up current production runtime JSON before destructive/cutover work.
2. Deploy this Duel Bot version with PERSISTENT_DATA_URL and STORAGE_KEY support configured.
3. Configure the same STORAGE_KEY on sv13-tcg-data and switch Repo #1 to its private/authenticated production mode.
4. Use Railway private networking for Duel Bot -> storage where possible.
5. Verify Duel Bot storage read/write/CAS/DELETE.
6. Verify the browser cannot fetch raw storage JSON.
7. Verify api.sv13tcg.com HTTPS and canonical /me/:token endpoints.
8. Verify persistent volume data survives restart/redeploy.
9. Only then continue to Repo #3 / UI production work.

## Validation completed
- npm test: 10/10 tests PASS.
- npm run check:active: PASS, 64 active JavaScript files syntax-checked.
- package.json: valid JSON.
- config.template.json: valid JSON.
- CoreMasterReference + supplied runtime data JSON: unchanged from baseline.

## Local verification commands
```bash
npm install
npm test
npm run check:active
npm start
```

After npm start, perform live integration smoke tests against the actual Railway sv13-tcg-data service before enforcing the coordinated production cutover.
