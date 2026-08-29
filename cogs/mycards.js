// cogs/mycards.js
// /mycards — EPHEMERAL link to the player's personal Card Collection UI.
// - Restricted to #manage-cards
// - Requires linked profile (prompts to /linkdeck if missing)
// - Ensures/mints per-user token and persists it
// - Builds URL with the viewer token; api= remains an opt-in migration override; no browser-facing me=

import fs from 'fs';
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { loadJSON, PATHS } from '../utils/storageClient.js';
import { ensureLinkedToken } from '../utils/playerLinks.js';

const FALLBACK_MANAGE_CARDS_CHANNEL_ID = '1367977677658656868';

const trimBase = (u = '') => String(u).trim().replace(/\/+$/, '');
function loadConfig() {
  try {
    if (process.env.CONFIG_JSON) return JSON.parse(process.env.CONFIG_JSON);
  } catch (e) {
    console.warn(`[mycards] CONFIG_JSON parse error: ${e?.message}`);
  }
  try {
    if (fs.existsSync('config.json')) {
      return JSON.parse(fs.readFileSync('config.json', 'utf-8')) || {};
    }
  } catch { /* ignore */ }
  return {};
}

function resolveCollectionBase(cfg) {
  return trimBase(
    cfg.collection_ui ||
    cfg.ui_urls?.card_collection_ui ||
    cfg.frontend_url ||
    cfg.ui_base ||
    cfg.UI_BASE ||
    'https://collection.sv13tcg.com'
  );
}


export default async function registerMyCards(client) {
  const commandData = new SlashCommandBuilder()
    .setName('mycards')
    .setDescription('Get your personal (tokenized) link to view your card collection.')
    .setDMPermission(false);

  client.slashData.push(commandData.toJSON());

  client.commands.set('mycards', {
    data: commandData,
    async execute(interaction) {
      const CFG = loadConfig();

      const MANAGE_CARDS_CHANNEL_ID = String(
        CFG.manage_cards_channel_id ||
        CFG.manage_cards ||
        CFG['manage-cards'] ||
        FALLBACK_MANAGE_CARDS_CHANNEL_ID
      );

      // Channel restriction
      if (String(interaction.channelId) !== MANAGE_CARDS_CHANNEL_ID) {
        return interaction.reply({
          content: `⚠️ This command can only be used in <#${MANAGE_CARDS_CHANNEL_ID}>.`,
          ephemeral: true
        });
      }

      const userId = interaction.user.id;
      const userName = interaction.user.username;

      // Load linked profiles from Persistent Data (PATHS.linkedDecks should point there)
      let linked = {};
      try { linked = await loadJSON(PATHS.linkedDecks); } catch { linked = {}; }

      const profile = linked[userId];

      if (!profile) {
        return interaction.reply({
          content: '❌ You don’t have a linked profile yet. Use **/linkdeck** first to create your SV13 TCG profile.',
          ephemeral: true
        });
      }

      // Keep identity/token updates on the same CAS-protected linked profile contract
      // used by the rest of the repaired bot. This avoids overwriting concurrent pack,
      // sell, trade, or deck updates with a stale whole-file snapshot.
      let token;
      try {
        token = await ensureLinkedToken(userId, userName);
      } catch (error) {
        console.warn('[mycards] Failed to refresh profile identity:', error?.message || error);
        return interaction.reply({
          content: '❌ Your profile could not be refreshed right now. Please try again.',
          ephemeral: true
        });
      }

      const BASE       = resolveCollectionBase(CFG);
      const page       = /\.(html?)$/i.test(BASE) ? BASE : `${BASE}/index.html`;
      const API_BASE   = trimBase(CFG.api_base   || CFG.API_BASE   || process.env.API_BASE   || '');
      const IMAGE_BASE = trimBase(CFG.image_base || CFG.IMAGE_BASE || 'https://sv13tcg.com/assets/cards');

      const ts = Date.now();

      const qp = new URLSearchParams();
      qp.set('token', token);
      if (String(process.env.PASS_API_QUERY || '').toLowerCase() === 'true' && API_BASE) qp.set('api', API_BASE);
      if (IMAGE_BASE) qp.set('imgbase', IMAGE_BASE);
      qp.set('ts', String(ts));

      const url = `${page}?${qp.toString()}`;

      const embed = new EmbedBuilder()
        .setTitle('🃏 Your Card Collection')
        .setDescription('This private link lets **you** view your collection only. Do not share it.')
        .setURL(url)
        .addFields(
          { name: 'Player', value: userName, inline: true },
          { name: 'Security', value: 'Tokenized link (per-player)', inline: true }
        )
        .setColor(0x00ccff);

      return interaction.reply({
        content: `🔗 **Open your collection:** ${url}`,
        embeds: [embed],
        ephemeral: true
      });
    }
  });
}
