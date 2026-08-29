// Canonical SV13 TCG runtime configuration.
// Resolution order for non-secret settings: ENV -> CONFIG_JSON/config.json -> defaults.
// Secrets and private storage credentials remain ENV-only.

import fs from 'fs';

const trim = (v = '') => String(v || '').trim().replace(/\/+$/, '');
const trail = (v = '') => { const t = trim(v); return t ? `${t}/` : ''; };
const csv = (v = '') => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const num = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;
const int = (v, d) => Number.isFinite(parseInt(String(v), 10)) ? parseInt(String(v), 10) : d;
const bool = (v, d = false) => v == null || v === '' ? d : String(v).toLowerCase() === 'true';
const first = (...values) => values.find(v => v !== undefined && v !== null && v !== '');

function loadLegacyConfig() {
  try {
    if (process.env.CONFIG_JSON) return JSON.parse(process.env.CONFIG_JSON) || {};
  } catch (error) {
    console.warn('[config] CONFIG_JSON parse error:', error?.message || error);
  }
  try {
    if (fs.existsSync('config.json')) return JSON.parse(fs.readFileSync('config.json', 'utf8')) || {};
  } catch (error) {
    console.warn('[config] config.json parse error:', error?.message || error);
  }
  return {};
}
const fileConfig = loadLegacyConfig();
const fileUi = fileConfig.ui_urls || {};
const fileCoin = fileConfig.coin_system || {};
const fileTrade = fileConfig.trade_system || fileConfig.trade || {};
const fileDuel = fileConfig.duel_rules || fileConfig.duel || {};
const fileMigration = fileConfig.migration || {};

export const UI = Object.freeze({
  hub: trail(first(process.env.HUB_UI, fileUi.hub_ui, fileConfig.hub_ui, 'https://sv13tcg.com')),
  collection: trail(first(process.env.CARD_COLLECTION_UI, process.env.COLLECTION_UI, fileUi.card_collection_ui, fileConfig.collection_ui, 'https://collection.sv13tcg.com')),
  deckBuilder: trail(first(process.env.DECK_BUILDER_UI, process.env.DECK_UI, fileUi.deck_builder_ui, fileConfig.deck_builder_ui, 'https://deck.sv13tcg.com')),
  duel: trail(first(process.env.DUEL_UI, fileUi.duel_ui, fileConfig.duel_ui, 'https://duel.sv13tcg.com')),
  spectator: trail(first(process.env.SPECTATOR_VIEW_UI, process.env.SPECTATOR_UI, fileUi.spectator_view_ui, fileConfig.spectator_ui_url, 'https://spectate.sv13tcg.com')),
  duelSummary: trail(first(process.env.DUEL_SUMMARY_UI, process.env.SUMMARY_UI, fileUi.duel_summary_ui, fileConfig.duel_summary_ui, 'https://summary.sv13tcg.com')),
  stats: trail(first(process.env.PLAYER_STATS_UI, process.env.STATS_UI, fileUi.player_stats_ui, fileConfig.player_stats_ui, 'https://stats.sv13tcg.com')),
  leaderboard: trail(first(process.env.LEADERBOARD_UI, process.env.STATS_LEADERBOARD_UI, fileUi.leaderboard_ui, fileUi.stats_leaderboard_ui, fileConfig.leaderboard_ui, 'https://leaderboard.sv13tcg.com')),
  packReveal: trail(first(process.env.PACK_REVEAL_UI, fileUi.pack_reveal_ui, fileConfig.pack_reveal_ui, 'https://packs.sv13tcg.com')),
  rules: trail(first(process.env.RULEBOOK_UI, fileUi.rulebook_ui, fileConfig.rulebook_ui, 'https://rules.sv13tcg.com')),
});

export const PATH_CONFIG = Object.freeze({
  linkedDecks: 'data/linked_decks.json',
  wallet: 'data/coin_bank.json',
  playerData: 'data/player_data.json',
  trades: 'data/trades.json',
  tradeLimits: 'data/trade_limits.json',
  tradeQueue: 'data/trade_queue.json',
  sellsByDay: 'data/sells_by_day.json',
  currentDuelLog: 'data/logs/current_duel_log.json',
  summariesDir: 'data/summaries',
  // Repo #1 permits data/summaries/* and intentionally does not expose a separate duel_sessions namespace.
  duelSessionsDir: 'data/summaries/_sessions',
  packRevealsDir: 'data/pack_reveals',
  masterCardsLocal: 'logic/CoreMasterReference.json',
});

const fileSell = fileCoin.card_sell_values || {};
const sellValues = Object.freeze({
  Common: num(first(process.env.SELL_VALUE_COMMON, fileSell.Common, fileSell.common), 0.5),
  Uncommon: num(first(process.env.SELL_VALUE_UNCOMMON, fileSell.Uncommon, fileSell.uncommon), 1),
  Rare: num(first(process.env.SELL_VALUE_RARE, fileSell.Rare, fileSell.rare), 2),
  Legendary: num(first(process.env.SELL_VALUE_LEGENDARY, fileSell.Legendary, fileSell.legendary), 3),
});
const fileWeights = fileCoin.rarity_weights || {};
const rarityWeightsMap = Object.freeze({
  Common: int(first(process.env.WEIGHT_COMMON, fileWeights.Common, fileWeights.common), 5),
  Uncommon: int(first(process.env.WEIGHT_UNCOMMON, fileWeights.Uncommon, fileWeights.uncommon), 3),
  Rare: int(first(process.env.WEIGHT_RARE, fileWeights.Rare, fileWeights.rare), 2),
  Legendary: int(first(process.env.WEIGHT_LEGENDARY, fileWeights.Legendary, fileWeights.legendary), 1),
});

const configuredAdminRoles = process.env.ADMIN_ROLE_IDS
  ? csv(process.env.ADMIN_ROLE_IDS)
  : (Array.isArray(fileConfig.admin_role_ids) ? fileConfig.admin_role_ids.map(String) : []);

export const config = Object.freeze({
  token_env: first(process.env.TOKEN_ENV, fileConfig.token_env, 'DISCORD_TOKEN'),
  api_base: trim(first(process.env.API_BASE, process.env.BACKEND_URL, fileConfig.api_base, 'https://api.sv13tcg.com')),

  // Private storage contract: ENV only. Never source the storage key from committed config.
  persistent_data_url: trim(process.env.PERSISTENT_DATA_URL || ''),
  storage_key: String(process.env.STORAGE_KEY || ''),
  bot_api_key: String(process.env.BOT_API_KEY || process.env.X_BOT_KEY || process.env.BOT_KEY || ''),
  debug_key: String(process.env.DEBUG_KEY || ''),
  internal_backend_url: trim(process.env.INTERNAL_BACKEND_URL || ''),

  admin_api_key: process.env.ADMIN_API_KEY || '',
  admin_payout_channel_id: first(process.env.ADMIN_PAYOUT_CHANNEL_ID, fileConfig.admin_payout_channel_id, ''),
  admin_role_ids: configuredAdminRoles,
  adminIds: process.env.ADMIN_IDS ? csv(process.env.ADMIN_IDS) : (Array.isArray(fileConfig.adminIds) ? fileConfig.adminIds.map(String) : []),
  battlefield_channel_id: first(process.env.BATTLEFIELD_CHANNEL_ID, fileConfig.battlefield_channel_id, ''),
  economy_channel_id: first(process.env.ECONOMY_CHANNEL_ID, fileConfig.economy_channel_id, ''),
  founder_role_id: first(process.env.FOUNDER_ROLE_ID, fileConfig.founder_role_id, ''),
  manage_cards_channel_id: first(process.env.MANAGE_CARDS_CHANNEL_ID, fileConfig.manage_cards_channel_id, ''),
  manage_deck_channel_id: first(process.env.MANAGE_DECK_CHANNEL_ID, fileConfig.manage_deck_channel_id, ''),

  linked_decks_file: './data/linked_decks.json',
  duel_summary_file: './data/summaries',
  files: Object.freeze({
    linked_decks: PATH_CONFIG.linkedDecks,
    wallet: PATH_CONFIG.wallet,
    player_data: PATH_CONFIG.playerData,
    trade_queue: PATH_CONFIG.tradeQueue,
    duel_summaries_dir: `${PATH_CONFIG.summariesDir}/`,
    trades: PATH_CONFIG.trades,
    trade_limits: PATH_CONFIG.tradeLimits,
    master_cards: PATH_CONFIG.masterCardsLocal,
    reveal_dir: `${PATH_CONFIG.packRevealsDir}/`,
  }),

  ui_urls: Object.freeze({
    hub_ui: UI.hub,
    card_collection_ui: UI.collection,
    pack_reveal_ui: UI.packReveal,
    deck_builder_ui: UI.deckBuilder,
    stats_leaderboard_ui: UI.leaderboard,
    player_stats_ui: UI.stats,
    leaderboard_ui: UI.leaderboard,
    duel_summary_ui: UI.duelSummary,
    spectator_view_ui: UI.spectator,
    duel_ui: UI.duel,
    rulebook_ui: UI.rules,
  }),

  image_base: trim(first(process.env.IMAGE_BASE, fileConfig.image_base, 'https://sv13tcg.com/assets/cards')),
  image_base_fallbacks: process.env.IMAGE_BASE_FALLBACKS
    ? csv(process.env.IMAGE_BASE_FALLBACKS)
    : (Array.isArray(fileConfig.image_base_fallbacks) ? fileConfig.image_base_fallbacks.map(trim).filter(Boolean) : []),
  card_back_filename: first(process.env.CARD_BACK_FILENAME, fileConfig.card_back_filename, '000_CardBack_Unique.png'),

  coin_system: Object.freeze({
    card_pack_cost: num(first(process.env.CARD_PACK_COST, fileCoin.card_pack_cost), 3),
    cards_per_pack: int(first(process.env.CARDS_PER_PACK, fileCoin.cards_per_pack), 3),
    buy_limit_per_day: int(first(process.env.BUY_LIMIT_PER_DAY, fileCoin.buy_limit_per_day), 5),
    sell_limit_per_day: int(first(process.env.SELL_LIMIT_PER_DAY, fileCoin.sell_limit_per_day), 5),
    max_card_collection_size: int(first(process.env.MAX_COLLECTION_SIZE, fileCoin.max_card_collection_size), 250),
    card_sell_values: sellValues,
    card_sell_values_legacy: Object.freeze({ common: sellValues.Common, uncommon: sellValues.Uncommon, rare: sellValues.Rare, legendary: sellValues.Legendary }),
    rarity_weights: rarityWeightsMap,
    buycard_message: first(process.env.BUYCARD_MESSAGE, fileCoin.buycard_message, 'Your new card pack is ready!'),
  }),

  trade: Object.freeze({
    daily_initiation_limit: int(first(process.env.TRADE_LIMIT_PER_DAY, fileTrade.daily_initiation_limit, fileTrade.trade_limit_per_day), 3),
    ttl_hours: int(first(process.env.TRADE_TTL_HOURS, fileTrade.ttl_hours, fileTrade.session_ttl_hours), 24),
    max_cards_per_side: int(first(process.env.TRADE_MAX_CARDS_PER_SIDE, fileTrade.max_cards_per_side), 3),
  }),
  trade_system: Object.freeze({
    daily_initiation_limit: int(first(process.env.TRADE_LIMIT_PER_DAY, fileTrade.daily_initiation_limit, fileTrade.trade_limit_per_day), 3),
    trade_limit_per_day: int(first(process.env.TRADE_LIMIT_PER_DAY, fileTrade.daily_initiation_limit, fileTrade.trade_limit_per_day), 3),
    sell_limit_per_day: int(first(process.env.SELL_LIMIT_PER_DAY, fileCoin.sell_limit_per_day), 5),
    ttl_hours: int(first(process.env.TRADE_TTL_HOURS, fileTrade.ttl_hours, fileTrade.session_ttl_hours), 24),
    max_cards_per_side: int(first(process.env.TRADE_MAX_CARDS_PER_SIDE, fileTrade.max_cards_per_side), 3),
  }),

  duel: Object.freeze({
    starting_hp: int(first(process.env.DUEL_STARTING_HP, fileDuel.starting_hp), 200),
    deck_min: int(first(process.env.DECK_MIN_SIZE, fileConfig.deck_rules?.min_cards), 20),
    deck_max: int(first(process.env.DECK_MAX_SIZE, fileConfig.deck_rules?.max_cards), 40),
    max_copies: int(first(process.env.DECK_MAX_COPIES, fileConfig.deck_rules?.max_copies), 5),
    opening_hand: int(first(process.env.DUEL_OPENING_HAND, fileDuel.opening_hand), 3),
    hand_limit: int(first(process.env.DUEL_HAND_LIMIT, fileDuel.hand_limit), 4),
    field_limit: int(first(process.env.DUEL_FIELD_LIMIT, fileDuel.field_limit), 4),
    practice_counts_competitive: bool(first(process.env.PRACTICE_COUNTS_COMPETITIVE, fileDuel.practice_counts_competitive), false),
  }),

  pass_api_query: bool(first(process.env.PASS_API_QUERY, fileConfig.pass_api_query, fileMigration.pass_api_query), false),
  cors_allow_legacy_github: bool(first(process.env.CORS_ALLOW_LEGACY_GITHUB, fileMigration.legacy_github_cors_temporary), true),
  cors_extra_origins: csv(process.env.CORS_EXTRA_ORIGINS || ''),
  debug_mode: bool(process.env.DEBUG_MODE, false),

  storage_read_timeout_ms: int(process.env.STORAGE_TIMEOUT_MS, 12000),
});

export const cardDataPath = first(process.env.CARD_DATA_PATH, PATH_CONFIG.masterCardsLocal);
export const rarityWeights = rarityWeightsMap;
export const api_base = config.api_base;
export const image_base = config.image_base;
export const image_base_fallbacks = config.image_base_fallbacks;
export const card_back_filename = config.card_back_filename;

export function storageReadUrl(relPath) {
  if (!config.persistent_data_url) return '';
  return `${config.persistent_data_url}/${String(relPath || '').replace(/^\/+/, '')}`;
}
