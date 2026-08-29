// cogs/mycoin.js
// /mycoin — show your current coin balance and a tokenized link to your Collection UI.
// - Requires player to be linked (prompts to /linkdeck if not)
// - Ensures/mints a per-user token if missing and persists it
// - Builds a link with ?token=... and optional &api=..., plus &ts= cache-buster
// - Uses unified coin bank (data/coin_bank.json) as source of truth, mirrors to linked_decks

import fs from 'fs';
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { loadJSON, updateJSONAtomic, PATHS } from '../utils/storageClient.js';
import { ensureLinkedToken } from '../utils/playerLinks.js';

// -------- helpers --------
const trimBase = (u = '') => String(u).trim().replace(/\/+$/, '');

function loadConfig() {
  try {
    if (process.env.CONFIG_JSON) return JSON.parse(process.env.CONFIG_JSON);
  } catch (e) {
    console.warn(`[mycoin] CONFIG_JSON parse error: ${e?.message}`);
  }
  try {
    if (fs.existsSync('config.json')) {
      return JSON.parse(fs.readFileSync('config.json', 'utf-8')) || {};
    }
  } catch {}
  return {};
}

function buildCollectionUrl(cfg, token) {
  const base =
    cfg.collection_ui ||
    cfg.ui_urls?.card_collection_ui ||
    'https://collection.sv13tcg.com';
  const API_BASE = trimBase(cfg.api_base || cfg.API_BASE || process.env.API_BASE || '');
  const ts = Date.now();

  const qp = new URLSearchParams();
  qp.set('token', token);
  const passApi = String(process.env.PASS_API_QUERY ?? cfg.pass_api_query ?? 'false').toLowerCase() === 'true';
  if (passApi && API_BASE) qp.set('api', API_BASE);
  qp.set('ts', String(ts));

  return `${trimBase(base)}/index.html?${qp.toString()}`;
}

// Unified coin bank file (authoritative). Fallback if PATHS.coinBank missing.
const COIN_BANK_FILE = (PATHS && PATHS.coinBank) ? PATHS.coinBank : 'data/coin_bank.json';

// -------- command --------
export default async function registerMyCoin(client) {
  const commandData = new SlashCommandBuilder()
    .setName('mycoin')
    .setDescription('Show your coin balance and a personal link to your Collection.')
    .setDMPermission(false);

  client.slashData.push(commandData.toJSON());

  client.commands.set('mycoin', {
    data: commandData,
    async execute(interaction) {
      const userId = interaction.user.id;
      const userName = interaction.user.username;
      const CFG = loadConfig();

      // Load linked profiles and unified coin bank
      let linked = {};
      let bank = {};
      try { linked = await loadJSON(PATHS.linkedDecks); } catch { linked = {}; }
      try { bank   = await loadJSON(COIN_BANK_FILE); } catch { bank = {}; }

      const profile = linked[userId];

      // Must be linked first
      if (!profile) {
        return interaction.reply({
          content:
            '❌ You are not linked yet.\n' +
            'Please run **/linkdeck** in **#manage-cards** to create your profile.',
          ephemeral: true,
        });
      }

      let token;
      try { token = await ensureLinkedToken(userId, userName); }
      catch (error) {
        return interaction.reply({ content: '⚠️ Could not refresh your player profile. Please try again.', ephemeral: true });
      }

      // coin_bank is authoritative; the profile mirror exists for legacy UI compatibility only.
      const coins = Number(bank[userId] ?? profile.coins ?? 0) || 0;
      if (Number(profile.coins ?? 0) !== coins) {
        await updateJSONAtomic(PATHS.linkedDecks, current => {
          if (current?.[userId]) {
            current[userId].coins = coins;
            current[userId].coinsUpdatedAt = new Date().toISOString();
          }
          return current;
        }, { defaultValue: {} }).catch(() => {});
      }

      const collectionUrl = buildCollectionUrl(CFG, token);

      const embed = new EmbedBuilder()
        .setTitle('🪙 Your Coin Balance')
        .addFields(
          { name: 'Player', value: userName, inline: true },
          { name: 'Coins', value: `${coins}`, inline: true },
        )
        .setDescription('Open your collection with your personal tokenized link below.')
        .setURL(collectionUrl)
        .setColor(0x00ccff);

      return interaction.reply({
        content: `🔗 **Open Collection:** ${collectionUrl}`,
        embeds: [embed],
        ephemeral: true,
      });
    },
  });
}
