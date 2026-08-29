// cogs/viewlinked.js
// Admin only: View all linked users, inspect a profile, and open a tokenized collection link.
//
// Uses Persistent Data API via utils/storageClient.js:
//  - loadJSON(PATHS.linkedDecks)  // { [userId]: {discordName, token, deck, collection, coins?, ...} }
//  - loadJSON(PATHS.wallet)       // authoritative coin_bank { [userId]: number }
//  - loadJSON(PATHS.playerData)   // { [userId]: {wins, losses} }
//  - PATHS.coinBank               // compatibility alias for PATHS.wallet
//  - updateJSONAtomic(PATHS.linkedDecks, mutator)
//
// Config resolution order: ENV.CONFIG_JSON → config.json → defaults

import fs from 'fs';
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
} from 'discord.js';
import { loadJSON, updateJSONAtomic, PATHS } from '../utils/storageClient.js';
import { ensureLinkedToken } from '../utils/playerLinks.js';

/* ───────────────────────── Config helpers ───────────────────────── */
function loadConfig() {
  try { if (process.env.CONFIG_JSON) return JSON.parse(process.env.CONFIG_JSON); }
  catch (e) { console.warn('[viewlinked] CONFIG_JSON parse error:', e?.message); }
  try { if (fs.existsSync('config.json')) return JSON.parse(fs.readFileSync('config.json', 'utf-8')) || {}; }
  catch { /* ignore */ }
  return {};
}
const CFG = loadConfig();

const FALLBACK_ADMIN_ROLE  = '1173049392371085392';
const FALLBACK_ADMIN_CHAN  = '1368023977519222895';

const ADMIN_ROLE_IDS   = Array.isArray(CFG.admin_role_ids) && CFG.admin_role_ids.length
  ? CFG.admin_role_ids
  : [FALLBACK_ADMIN_ROLE];

const ADMIN_CHANNEL_ID = String(CFG.admin_payout_channel_id || FALLBACK_ADMIN_CHAN);

const COLLECTION_BASE = (CFG.collection_ui
  || CFG.ui_urls?.card_collection_ui
  || CFG.frontend_url
  || CFG.ui_base
  || 'https://collection.sv13tcg.com').replace(/\/+$/,'');

const API_BASE = (CFG.api_base || CFG.API_BASE || process.env.API_BASE || '').replace(/\/+$/,'');

/* Authoritative coin file (fallback path if PATHS.coinBank is undefined) */
const COIN_BANK_FILE = (PATHS && PATHS.coinBank) ? PATHS.coinBank : 'data/coin_bank.json';

/* ───────────────────────── Small helpers ───────────────────────── */
function hasAnyAdminRole(member) {
  const cache = member?.roles?.cache;
  if (!cache) return false;
  return ADMIN_ROLE_IDS.some(rid => cache.has(rid));
}
function asObject(x, fallback = {}) {
  if (!x) return fallback;
  if (typeof x === 'string') {
    try { return JSON.parse(x); } catch { return fallback; }
  }
  if (typeof x === 'object') return x;
  return fallback;
}

/** Count total cards from a deck object like { cards: [{ id, qty }, ...] }. */
function countDeckCards(deckMaybe) {
  try {
    const deck = deckMaybe || {};
    const cards = Array.isArray(deck.cards) ? deck.cards : [];
    return cards.reduce((sum, c) => sum + (Number(c?.qty) || 0), 0);
  } catch { return 0; }
}

/** Pick the best deck object across a few common keys. */
function pickDeckObject(profile) {
  if (!profile) return null;
  if (profile.deck && typeof profile.deck === 'object') return profile.deck;
  if (profile.savedDeck && typeof profile.savedDeck === 'object') return profile.savedDeck;
  if (profile.currentDeck && typeof profile.currentDeck === 'object') return profile.currentDeck;
  return null;
}

/* ───────────────────────── Command ───────────────────────── */
export default async function registerViewLinked(client) {
  const data = new SlashCommandBuilder()
    .setName('viewlinked')
    .setDescription('Admin only: View linked users and inspect a profile.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  client.slashData.push(data.toJSON());

  client.commands.set('viewlinked', {
    data,
    async execute(interaction) {
      // Role & channel guard
      if (!hasAnyAdminRole(interaction.member)) {
        return interaction.reply({ content: '🚫 You do not have permission to use this command.', ephemeral: true });
      }
      if (String(interaction.channelId) !== String(ADMIN_CHANNEL_ID)) {
        return interaction.reply({
          content: '❌ This command must be used in the SV13 TCG admin tools channel.',
          ephemeral: true
        });
      }

      // Load linked users
      let linkedData = asObject(await loadJSON(PATHS.linkedDecks), {});
      const entries = Object.entries(linkedData);
      if (!entries.length) {
        return interaction.reply({ content: '⚠️ No linked profiles found.', ephemeral: true });
      }

      // Pagination
      const pageSize = 25;
      let page = 0;
      const pages = Math.ceil(entries.length / pageSize);

      const makePage = (p) => {
        const slice = entries.slice(p * pageSize, (p + 1) * pageSize);
        const options = slice.map(([id, prof]) => ({
          label: prof?.discordName || id,
          value: id,
        }));

        const dropdown = new StringSelectMenuBuilder()
          .setCustomId(`viewlinked_select_${p}`)
          .setPlaceholder('🔻 View user profile')
          .addOptions(options);

        const rowSelect = new ActionRowBuilder().addComponents(dropdown);
        const rowNav = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('prev').setStyle(ButtonStyle.Secondary).setLabel('⏮ Prev').setDisabled(p === 0),
          new ButtonBuilder().setCustomId('next').setStyle(ButtonStyle.Secondary).setLabel('Next ⏭').setDisabled(p === pages - 1),
        );

        const embed = new EmbedBuilder()
          .setTitle('🔗 Linked Users')
          .setDescription(`Page ${p + 1} of ${pages} — ${entries.length} total users`)
          .setColor(0x00ccff);

        return { embed, rowSelect, rowNav };
      };

      const first = makePage(page);
      const msg = await interaction.reply({
        embeds: [first.embed],
        components: [first.rowSelect, first.rowNav],
        ephemeral: true,
        fetchReply: true
      });

      // Buttons for pagination
      const btnCollector = msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 120_000
      });

      btnCollector.on('collect', async i => {
        if (i.user.id !== interaction.user.id) {
          return i.reply({ content: '⚠️ You can’t interact with this menu.', ephemeral: true });
        }
        if (i.customId === 'prev') page = Math.max(0, page - 1);
        if (i.customId === 'next') page = Math.min(pages - 1, page + 1);
        const built = makePage(page);
        await i.update({ embeds: [built.embed], components: [built.rowSelect, built.rowNav] });
      });

      // Dropdown for viewing a profile
      const ddCollector = msg.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 120_000
      });

      ddCollector.on('collect', async i => {
        if (i.user.id !== interaction.user.id) {
          return i.reply({ content: '⚠️ You can’t interact with this dropdown.', ephemeral: true });
        }
        await i.deferUpdate();

        const userId = i.values[0];

        // Re-read latest snapshots to minimize race conditions
        let linkedNow   = asObject(await loadJSON(PATHS.linkedDecks), {});
        let coinBankNow = asObject(await loadJSON(COIN_BANK_FILE).catch(() => ({})), {});
        let walletNow   = asObject(await loadJSON(PATHS.wallet).catch(() => ({})), {}); // legacy fallback
        let playerStats = asObject(await loadJSON(PATHS.playerData).catch(() => ({})), {});

        // Ensure profile presence (should exist because it was listed)
        const prof = linkedNow[userId] || { discordName: userId, deck: [], collection: {}, createdAt: new Date().toISOString() };

        // Token/name refresh is CAS-protected so admin inspection cannot overwrite
        // concurrent collection/deck/economy changes.
        let token;
        try { token = await ensureLinkedToken(userId, prof.discordName || userId); }
        catch (e) {
          console.warn('[viewlinked] Failed to refresh linked token:', e?.message || e);
          return interaction.followUp({ content: '⚠️ Could not refresh that profile.', ephemeral: true });
        }

        // Coins: prefer COIN BANK → profile → legacy wallet
        let coins = Number(coinBankNow[userId]);
        if (!Number.isFinite(coins)) coins = Number(prof.coins ?? 0);
        if (!Number.isFinite(coins)) coins = Number(walletNow[userId] ?? 0);
        if (!Number.isFinite(coins)) coins = 0;

        // Mirror bank balance without replacing the entire linked-decks snapshot.
        if (Number(prof.coins ?? 0) !== coins) {
          await updateJSONAtomic(PATHS.linkedDecks, current => {
            if (current?.[userId]) {
              current[userId].coins = coins;
              current[userId].coinsUpdatedAt = new Date().toISOString();
            }
            return current;
          }, { defaultValue: {} }).catch(e => console.warn('[viewlinked] Failed to mirror coins:', e?.message || e));
        }

        // Wins/losses
        const wins   = Number(playerStats[userId]?.wins   ?? 0) || 0;
        const losses = Number(playerStats[userId]?.losses ?? 0) || 0;

        // Collection stats
        const coll = prof.collection || {};
        const totalOwned = Object.values(coll).reduce((a, b) => a + Number(b || 0), 0);
        const uniqueUnlocked = Object.keys(coll).filter(id => {
          const n = parseInt(id, 10);
          return n >= 1 && n <= 127; // current base set window
        }).length;

        // 🔧 Deck stats (fixed): count quantities from deck.cards
        const deckObj   = pickDeckObject(prof);
        const deckCount = countDeckCards(deckObj);
        const DECK_TARGET = 40; // adjust if format changes

        // Build tokenized collection link
        const ts = Date.now();
        const qp = new URLSearchParams();
        qp.set('token', token);
        const passApi = String(process.env.PASS_API_QUERY ?? CFG.pass_api_query ?? 'false').toLowerCase() === 'true';
        if (passApi && API_BASE) qp.set('api', API_BASE);
        qp.set('ts', String(ts));

        const collectionUrl = `${COLLECTION_BASE}/?${qp.toString()}`;

        const embed = new EmbedBuilder()
          .setTitle(`🧑‍🚀 Profile: ${prof.discordName || userId}`)
          .addFields(
            { name: 'Deck Size', value: `${deckCount} / ${DECK_TARGET}`, inline: true },
            { name: 'Collection Cards', value: `${totalOwned}`, inline: true },
            { name: 'Unique Unlocked (001–127)', value: `${uniqueUnlocked} / 127`, inline: true },
            { name: 'Coins', value: `${coins}`, inline: true },
            { name: 'Wins / Losses', value: `${wins} / ${losses}`, inline: true },
          )
          .setFooter({ text: `Discord ID: ${userId}` })
          .setColor(0x00ccff);

        const linkRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setURL(collectionUrl)
            .setLabel('📒 View Cards')
        );

        await interaction.followUp({
          embeds: [embed],
          components: [linkRow],
          ephemeral: true
        });
      });

      const endAll = async () => {
        try {
          await interaction.editReply({
            content: '⏰ No selection made. Command expired.',
            embeds: [],
            components: []
          });
        } catch {}
      };
      btnCollector.on('end', (_c, r) => { if (r === 'time') endAll(); });
      ddCollector.on('end', (_c, r) => { if (r === 'time') endAll(); });
    }
  });
}
