// utils/config.js
//
// Backward-compatible config with persistent storage + helper getters.
// - Retains ALL existing fields
// - Adds storage + api_base knobs used across routes/utils
// - Provides normalized getters so other modules don’t re-implement parsing
//

function toNum(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function toInt(v, d) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : d;
}
function trimTrailingSlash(u = '') {
  return String(u).trim().replace(/\/+$/, '');
}
function ensureTrailingSlash(u = '') {
  const t = trimTrailingSlash(u);
  return t ? `${t}/` : '';
}
function splitCsv(v = '') {
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

export const config = {
  // ───────────────────────────────
  // existing fields (unchanged)
  // ───────────────────────────────
  token_env: process.env.TOKEN_ENV || 'DISCORD_TOKEN',

  // 🔐 Sensitive env-only fields
  admin_api_key: process.env.ADMIN_API_KEY,
  admin_payout_channel_id: process.env.ADMIN_PAYOUT_CHANNEL_ID,
  admin_role_ids: splitCsv(process.env.ADMIN_ROLE_IDS || ''),
  battlefield_channel_id: process.env.BATTLEFIELD_CHANNEL_ID,
  economy_channel_id: process.env.ECONOMY_CHANNEL_ID,
  founder_role_id: process.env.FOUNDER_ROLE_ID,
  manage_cards_channel_id: process.env.MANAGE_CARDS_CHANNEL_ID,
  manage_deck_channel_id: process.env.MANAGE_DECK_CHANNEL_ID,

  // 🔗 External data files (legacy local paths; kept for fallback)
  linked_decks_file: './data/linked_decks.json',
  duel_summary_file: './public/data/duel_summary.json',

  // 🌐 UI URLs (kept)
  ui_urls: {
    hub_ui: process.env.HUB_UI || 'https://madv313.github.io/HUB-UI/',
    card_collection_ui: process.env.CARD_COLLECTION_UI || 'https://madv313.github.io/Card-Collection-UI/',
    pack_reveal_ui: process.env.PACK_REVEAL_UI || 'https://madv313.github.io/Pack-Reveal-UI/',
    deck_builder_ui: process.env.DECK_BUILDER_UI || 'https://madv313.github.io/Deck-Builder-UI/',
    stats_leaderboard_ui: process.env.STATS_LEADERBOARD_UI || 'https://madv313.github.io/Stats-Leaderboard-UI/',
    duel_summary_ui: process.env.DUEL_SUMMARY_UI || 'https://madv313.github.io/Duel-Summary-UI/',
    spectator_view_ui: process.env.SPECTATOR_VIEW_UI || 'https://madv313.github.io/Spectator-View-UI/',
    duel_ui: process.env.DUEL_UI || 'https://madv313.github.io/Duel-UI/',
  },

  // 💰 Coin system logic (kept)
  coin_system: {
    card_pack_cost: toNum(process.env.CARD_PACK_COST, 3),
    card_sell_values: {
      common: toNum(process.env.SELL_VALUE_COMMON, 0.5),
      uncommon: toNum(process.env.SELL_VALUE_UNCOMMON, 1),
      rare: toNum(process.env.SELL_VALUE_RARE, 2),
      legendary: toNum(process.env.SELL_VALUE_LEGENDARY, 3),
    },
    buy_limit_per_day: toInt(process.env.BUY_LIMIT_PER_DAY, 5),
    sell_limit_per_day: toInt(process.env.SELL_LIMIT_PER_DAY, 5),
    max_card_collection_size: toInt(process.env.MAX_COLLECTION_SIZE, 250),
    rarity_weights: {
      common: toInt(process.env.WEIGHT_COMMON, 5),
      uncommon: toInt(process.env.WEIGHT_UNCOMMON, 3),
      rare: toInt(process.env.WEIGHT_RARE, 2),
      legendary: toInt(process.env.WEIGHT_LEGENDARY, 1),
    },
    buycard_message:
      process.env.BUYCARD_MESSAGE ||
      'Your new card pack is ready! View it here: https://madv313.github.io/Pack-Reveal-UI/',
  },

  // ───────────────────────────────
  // NEW: persistent storage + API base
  // ───────────────────────────────

  // If you are using a remote persistent repo or object store, set these:
  // e.g. STORAGE_BASE=https://raw.githubusercontent.com/org/persistent-data/main/
  storage_base: ensureTrailingSlash(process.env.STORAGE_BASE || process.env.PERSISTENT_BASE || ''), // remote read root
  storage_write_api: trimTrailingSlash(process.env.STORAGE_WRITE_API || process.env.PERSISTENT_WRITE_API || ''), // write endpoint (if any)
  storage_bucket: process.env.STORAGE_BUCKET || '',       // optional provider bucket/id
  storage_prefix: ensureTrailingSlash(process.env.STORAGE_PREFIX || ''), // e.g., "sv13/"
  storage_read_timeout_ms: toInt(process.env.STORAGE_READ_TIMEOUT_MS, 8000),

  // Common file keys used by storageClient:
  files: {
    linked_decks: process.env.FILE_LINKED_DECKS || 'data/linked_decks.json',
    wallet: process.env.FILE_WALLET || 'data/coin_bank.json',
    player_data: process.env.FILE_PLAYER_DATA || 'data/player_data.json',
    trade_queue: process.env.FILE_TRADE_QUEUE || 'data/tradeQueue.json',
    duel_stats: process.env.FILE_DUEL_STATS || 'data/duelStats.json',
    duel_summaries_dir: process.env.FILE_DUEL_SUMMARIES_DIR || 'data/summaries/',
    trades: process.env.FILE_TRADES || 'data/trades.json',
    trade_limits: process.env.FILE_TRADE_LIMITS || 'data/trade_limits.json',
    master_cards: process.env.FILE_MASTER_CARDS || 'logic/CoreMasterReference.json',
    reveal_dir: process.env.FILE_REVEAL_DIR || 'public/data/', // where reveal_<token>.json lives
  },

  // For routes/utilities that need a backend base (trade, etc.)
  api_base: trimTrailingSlash(
    process.env.API_BASE ||
    process.env.api_base ||
    process.env.BACKEND_URL ||
    ''
  ),

  // 👉 NEW: base for /me/:token/* endpoints (persistent-data service)
  // Set ME_BASE (or me_base / PERSISTENT_DATA_BASE) to e.g.:
  //   https://sv13-tcg-data-production.up.railway.app
  me_base: trimTrailingSlash(
    process.env.ME_BASE ||
    process.env.me_base ||
    process.env.PERSISTENT_DATA_BASE ||
    ''
  ),

  // Optional absolute base for card images (front-end CDN/public)
  image_base:
    trimTrailingSlash(process.env.IMAGE_BASE || process.env.image_base || 'https://madv313.github.io/Card-Collection-UI/images/cards'),

  // 👉 NEW (non-breaking): optional fallbacks for image hosting
  image_base_fallbacks: [
    trimTrailingSlash(process.env.IMAGE_BASE_FALLBACK_1 || 'https://raw.githubusercontent.com/MadV313/Duel-Bot/main/images/cards'),
    trimTrailingSlash(process.env.IMAGE_BASE_FALLBACK_2 || '')
  ].filter(Boolean),

  // 👉 NEW (non-breaking): standard card back filename (used by UIs/DMs if desired)
  card_back_filename: process.env.CARD_BACK_FILENAME || '000_CardBack_Unique.png',

  // Convenience flags
  debug_mode: String(process.env.DEBUG_MODE || 'false').toLowerCase() === 'true',
};

// ───────────────────────────────
// Helper getters (non-breaking)
// ───────────────────────────────

/** Absolute URL for reading from persistent storage (if configured) */
export function storageReadUrl(relPath) {
  if (!config.storage_base) return '';
  const clean = String(relPath || '').replace(/^\/+/, '');
  return config.storage_base + (config.storage_prefix ? config.storage_prefix : '') + clean;
}

/** A canonical path to CoreMasterReference for loaders that accept local or remote. */
export const cardDataPath =
  process.env.CARD_DATA_PATH ||
  config.files.master_cards ||
  './logic/CoreMasterReference.json';

/** Normalized rarity weight map in TitleCase keys for internal logic. */
export const rarityWeights = {
  Common: config.coin_system.rarity_weights.common,
  Uncommon: config.coin_system.rarity_weights.uncommon,
  Rare: config.coin_system.rarity_weights.rare,
  Legendary: config.coin_system.rarity_weights.legendary,
};

/** Convenience passthroughs used around the codebase (stays stable). */
export const api_base = config.api_base;
export const me_base = config.me_base;              // ← NEW export
export const image_base = config.image_base;
export const image_base_fallbacks = config.image_base_fallbacks;
export const card_back_filename = config.card_back_filename;

/** UI helpers (returns trimmed, with trailing slash) */
export const UI = {
  hub: ensureTrailingSlash(config.ui_urls.hub_ui),
  collection: ensureTrailingSlash(config.ui_urls.card_collection_ui),
  packReveal: ensureTrailingSlash(config.ui_urls.pack_reveal_ui),
  deckBuilder: ensureTrailingSlash(config.ui_urls.deck_builder_ui),
  stats: ensureTrailingSlash(config.ui_urls.stats_leaderboard_ui),
  duelSummary: ensureTrailingSlash(config.ui_urls.duel_summary_ui),
  spectator: ensureTrailingSlash(config.ui_urls.spectator_view_ui),
  duel: ensureTrailingSlash(config.ui_urls.duel_ui),
};
