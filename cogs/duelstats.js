// cogs/duelstats.js
// Launches the Stats/Leaderboard UI with a personalized (tokenized) link.
// - Must be used in Battlefield channel
// - Requires the user to be linked
// - Ensures the user has a token (mints + persists if missing)

import fs from 'fs';
import {
  SlashCommandBuilder,
  EmbedBuilder,
} from 'discord.js';

import { loadJSON, PATHS } from '../utils/storageClient.js';
import { ensureLinkedToken } from '../utils/playerLinks.js';

/* ───────────────────────────── Config helpers ───────────────────────────── */
function readOptionalConfig() {
  try {
    if (fs.existsSync('config.json')) {
      return JSON.parse(fs.readFileSync('config.json', 'utf-8')) || {};
    }
  } catch { /* noop */ }
  try {
    if (process.env.CONFIG_JSON) {
      return JSON.parse(process.env.CONFIG_JSON);
    }
  } catch { /* noop */ }
  return {};
}
const CFG = readOptionalConfig();

const trimBase = (u = '') => String(u).trim().replace(/\/+$/, '');
const pickBase = (...vals) => trimBase(vals.find(Boolean) || '');

// Prefer the new Stats-Leaderboard base if provided; otherwise fall back to your
// actual repo ("Leaderboard-UI"). The old "Stats-Leaderboard-UI" URL caused 404s.
function resolveLeaderboardBase(cfg = {}) {
  return pickBase(
    process.env.STATS_LEADERBOARD_UI,
    cfg.stats_leaderboard_ui,
    cfg.ui_urls?.stats_leaderboard_ui,
    cfg.leaderboard_ui,                  // legacy key
    cfg.ui_urls?.leaderboard_ui,         // legacy key
    cfg.frontend_url,
    cfg.ui_base,
    // ✅ Correct fallback that exists:
    'https://leaderboard.sv13tcg.com'
  );
}

function resolveApiBase(cfg = {}) {
  return pickBase(
    process.env.API_BASE,
    cfg.api_base,
  );
}

const LEADERBOARD_BASE = resolveLeaderboardBase(CFG);
const API_BASE = resolveApiBase(CFG);
const PASS_API_QUERY = String(process.env.PASS_API_QUERY ?? CFG.pass_api_query ?? 'false').toLowerCase() === 'true';
const apiQP = PASS_API_QUERY && API_BASE ? `&api=${encodeURIComponent(API_BASE)}` : '';

if (!LEADERBOARD_BASE) {
  console.warn('[duelstats] No LEADERBOARD_BASE resolved — set STATS_LEADERBOARD_UI or config.stats_leaderboard_ui.');
} else {
  console.log('[duelstats] Leaderboard base =>', LEADERBOARD_BASE);
}
if (!API_BASE) {
  console.warn('[duelstats] No API_BASE resolved — UI will use its defaults unless provided via query param.');
} else {
  console.log('[duelstats] API base =>', API_BASE);
}

const BATTLEFIELD_CHANNEL_ID = String(
  process.env.BATTLEFIELD_CHANNEL_ID ||
  CFG.battlefield_channel_id ||
  '1367986446232719484'
);

/* ───────────────────────────── Small utils ───────────────────────────── */
/* ───────────────────────────── Command ───────────────────────────── */
export default async function registerDuelStats(client) {
  const data = new SlashCommandBuilder()
    .setName('duelstats')
    .setDescription('Open the SV13 Leaderboards (personalized link).')
    .setDMPermission(false);

  client.slashData.push(data.toJSON());

  client.commands.set('duelstats', {
    data,
    async execute(interaction) {
      // Channel guard
      if (String(interaction.channelId) !== BATTLEFIELD_CHANNEL_ID) {
        return interaction.reply({
          content: `🏆 Please use this command in <#${BATTLEFIELD_CHANNEL_ID}>.`,
          ephemeral: true,
        });
      }

      if (!LEADERBOARD_BASE) {
        return interaction.reply({
          content:
            '⚠️ Leaderboard UI base URL is not configured.\n' +
            'Set **LEADERBOARD_UI** (or `leaderboard_ui` in config.json) to your leaderboard root, e.g.:\n' +
            '`https://leaderboard.sv13tcg.com`',
          ephemeral: true,
        });
      }

      const userId = interaction.user.id;
      const username = interaction.user.username;

      // Load linked profiles
      let linked;
      try {
        linked = await loadJSON(PATHS.linkedDecks);
      } catch (e) {
        console.error('[duelstats] Failed to load linked_decks:', e?.message || e);
        return interaction.reply({
          content: '⚠️ Could not load your profile. Please try again later.',
          ephemeral: true,
        });
      }

      const profile = linked[userId];
      if (!profile) {
        return interaction.reply({
          content:
            '❌ You are not linked yet.\n' +
            'Please run **/linkdeck** in **#manage-cards** before using Duel Bot commands.',
          ephemeral: true,
        });
      }

      let token;
      try { token = await ensureLinkedToken(userId, username); }
      catch (error) {
        console.warn('[duelstats] Failed to refresh player identity:', error?.message || error);
        return interaction.reply({ content: '⚠️ Could not refresh your profile. Please try again.', ephemeral: true });
      }
      const ts = Date.now();
      // Leaderboard is global; viewer token is carried only for optional personalization/navigation.
      const url = `${LEADERBOARD_BASE}/?token=${encodeURIComponent(token)}${apiQP}&ts=${ts}`;

      const embed = new EmbedBuilder()
        .setTitle('🏆 SV13 Leaderboards')
        .setDescription(
          [
            'Open the global **Leaderboards** to compare duel performance.',
            'Your link is tokenized so you can hop to other UIs without re-linking.',
          ].join('\n')
        )
        .setURL(url)
        .addFields(
          { name: 'Player', value: username, inline: true },
          { name: 'Link security', value: 'Tokenized per-player URL', inline: true },
        )
        .setColor(0x00ccff);

      return interaction.reply({
        content: `🔗 **Open Leaderboards:** ${url}`,
        embeds: [embed],
        ephemeral: true,
      });
    },
  });
}
