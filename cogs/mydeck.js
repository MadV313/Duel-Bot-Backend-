// cogs/mydeck.js
// /mydeck — Send the invoker to their personal Deck Builder UI.
// - Restricted to #manage-cards (configurable)
// - Requires linked profile (prompts to /linkdeck if missing)
// - Ensures/mints a per-user token and persists it
// - Builds URL with ?token=... (&api=... if configured) and cache-busting &ts=...

import fs from 'fs';
import {
  SlashCommandBuilder,
  EmbedBuilder
} from 'discord.js';
import { loadJSON, PATHS } from '../utils/storageClient.js';
import { ensureLinkedToken } from '../utils/playerLinks.js';

const FALLBACK_MANAGE_CARDS_CHANNEL_ID = '1367977677658656868';

const trimBase = (u = '') => String(u).trim().replace(/\/+$/, '');

function loadConfig() {
  try {
    if (process.env.CONFIG_JSON) return JSON.parse(process.env.CONFIG_JSON);
  } catch (e) {
    console.warn(`[mydeck] CONFIG_JSON parse error: ${e?.message}`);
  }
  try {
    if (fs.existsSync('config.json')) {
      return JSON.parse(fs.readFileSync('config.json', 'utf-8')) || {};
    }
  } catch { /* ignore */ }
  return {};
}

function resolveDeckBuilderBase(cfg) {
  // Prefer dedicated Deck Builder UI; fall back to general bases if needed
  return trimBase(
    cfg.deck_builder_ui ||
    cfg.ui_urls?.deck_builder_ui ||
    cfg.frontend_url ||
    cfg.ui_base ||
    cfg.UI_BASE ||
    'https://deck.sv13tcg.com'
  );
}

export default async function registerMyDeck(client) {
  const commandData = new SlashCommandBuilder()
    .setName('mydeck')
    .setDescription('Open your personal Deck Builder UI.')
    .setDMPermission(false);

  client.slashData.push(commandData.toJSON());

  client.commands.set('mydeck', {
    data: commandData,
    async execute(interaction) {
      const CFG = loadConfig();

      const MANAGE_CARDS_CHANNEL_ID = String(
        CFG.manage_cards_channel_id ||
        CFG.manage_cards ||
        CFG['manage-cards'] ||
        FALLBACK_MANAGE_CARDS_CHANNEL_ID
      );

      // Channel guard
      if (String(interaction.channelId) !== MANAGE_CARDS_CHANNEL_ID) {
        return interaction.reply({
          content: `🧩 Please use this command in <#${MANAGE_CARDS_CHANNEL_ID}>.`,
          ephemeral: true
        });
      }

      const userId = interaction.user.id;
      const username = interaction.user.username;

      // Load linked profiles from Persistent Data server
      let linked = {};
      try { linked = await loadJSON(PATHS.linkedDecks); } catch { linked = {}; }

      const profile = linked[userId];

      // Require linked first (do not auto-create here)
      if (!profile) {
        const warn = new EmbedBuilder()
          .setTitle('⚠️ Player Not Linked')
          .setDescription(
            [
              'You are not yet linked to the Duel Bot system.',
              '',
              'Please run **`/linkdeck`** in the **#manage-cards** channel before using Duel Bot commands.',
              '',
              'Once linked, you’ll be able to build decks, earn coins, and participate in duels.'
            ].join('\n')
          )
          .setColor(0xff9900);
        return interaction.reply({ embeds: [warn], ephemeral: true });
      }

      let token;
      try { token = await ensureLinkedToken(userId, username); }
      catch (error) {
        console.warn('[mydeck] Failed to refresh player identity:', error?.message || error);
        return interaction.reply({ content: '⚠️ Could not refresh your profile. Please try again.', ephemeral: true });
      }

      const DECK_BUILDER_BASE = resolveDeckBuilderBase(CFG);
      const API_BASE = trimBase(CFG.api_base || CFG.API_BASE || process.env.API_BASE || '');
      const ts = Date.now();

      const qp = new URLSearchParams();
      qp.set('token', token);
      const passApi = String(process.env.PASS_API_QUERY ?? CFG.pass_api_query ?? 'false').toLowerCase() === 'true';
      if (passApi && API_BASE) qp.set('api', API_BASE);
      qp.set('ts', String(ts));

      const deckUrl = `${DECK_BUILDER_BASE}/?${qp.toString()}`;

      const embed = new EmbedBuilder()
        .setTitle('🧩 Deck Builder')
        .setDescription(
          [
            'Open your personal Deck Builder using the link above.',
            '',
            '**How to use the Deck Builder UI:**',
            '• Build a deck with **20–40 cards**.',
            '• Max **5 duplicates** per card.',
            '• Click cards to add amounts, then press **Save Deck**.',
            '• **View My Deck** shows your current build; **Wipe Deck** starts fresh.',
            '',
            '_Tip: Only saved decks that meet the rules are duel-eligible._'
          ].join('\n')
        )
        .setURL(deckUrl)
        .setColor(0x00ccff);

      return interaction.reply({
        content: `🔗 **Open your Deck Builder:** ${deckUrl}`,
        embeds: [embed],
        ephemeral: true
      });
    }
  });
}
