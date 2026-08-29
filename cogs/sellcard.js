// cogs/sellcard.js
// /sellcard — Sell cards from your collection for coins (interactive).
//
// - Confined to #manage-cards
// - Requires Supporter/Elite role and a linked profile
// - Dropdown shows only OWNED cards (paginated, 25 per page)
// - Quantity dropdown limited to 1..owned (max 50)
// - Uses rarity-based prices (CONFIG_JSON or config.json; sane defaults)
// - Updates coin_bank.json (authoritative) and mirrors coins into linkedDecks
// - Enforces a daily sell limit (default 5 cards/day)
// - Includes a “View Collection” link with instructions
//
// Daily status and commits use the same economy service as the Collection API.

import fs from 'fs';
import path from 'path';
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
} from 'discord.js';
import { loadJSON, PATHS } from '../utils/storageClient.js';
import { getSellStatus, sellCards } from '../utils/economyService.js';
import { ensureLinkedToken, PlayerLinks } from '../utils/playerLinks.js';
import { requireSupporter } from '../utils/roleGuard.js';

/* ───────────────────────── Config helpers ───────────────────────── */
function loadConfig() {
  try { if (process.env.CONFIG_JSON) return JSON.parse(process.env.CONFIG_JSON); }
  catch (e) { console.warn('[sellcard] CONFIG_JSON parse error:', e?.message); }
  try { if (fs.existsSync('config.json')) return JSON.parse(fs.readFileSync('config.json', 'utf-8')) || {}; }
  catch {}
  return {};
}
const trim = s => String(s || '').trim().replace(/\/+$/, '');

/* ───────────────────────── Defaults ───────────────────────── */
const DEFAULT_MANAGE_CARDS_CHANNEL_ID = '1367977677658656868';
const CORE_PATH = path.resolve('./logic/CoreMasterReference.json');

const DEFAULT_SELL = { common: 0.5, uncommon: 1, rare: 2, legendary: 3 };
const DEFAULT_DAILY_LIMIT = 5; // total cards/day
const MAX_QTY_PER_SALE = 50;

// Unified coin bank file (authoritative). Fallback to data/coin_bank.json if PATHS.coinBank missing.
const COIN_BANK_FILE = (PATHS && PATHS.coinBank) ? PATHS.coinBank : 'data/coin_bank.json';

/* ───────────────────────── Core rarity map ───────────────────────── */
function loadCoreRarityMap() {
  try {
    const raw = fs.readFileSync(CORE_PATH, 'utf-8');
    const arr = JSON.parse(raw);
    const map = {};
    for (const c of arr) {
      const id = String(c.card_id ?? '').padStart(3, '0');
      if (id && id !== '000' && c.rarity) map[id] = String(c.rarity);
    }
    return map;
  } catch (e) {
    console.error('[sellcard] Failed to load CoreMasterReference:', e?.message || e);
    return {};
  }
}
const rarityMap = loadCoreRarityMap();

/* ───────────────────────── Small helpers ───────────────────────── */
const to3 = v => String(v).padStart(3, '0');
const todayUTC = () => new Date().toISOString().slice(0, 10);
const clamp = (n, a, b) => Math.min(Math.max(n, a), b);

function buildCollectionUrl(_cfg, token) {
  return PlayerLinks.collection(token);
}

/* ───────────────────────── Command ───────────────────────── */
export default async function registerSellCard(client) {
  const CFG = loadConfig();

  const MANAGE_CARDS_CHANNEL_ID =
    String(CFG.manage_cards_channel_id || CFG.manage_cards || CFG['manage-cards'] || DEFAULT_MANAGE_CARDS_CHANNEL_ID);

  const configuredSellValues = CFG?.coin_system?.card_sell_values || {};
  const sellValues = {
    common:    Number(configuredSellValues.common    ?? configuredSellValues.Common    ?? DEFAULT_SELL.common),
    uncommon:  Number(configuredSellValues.uncommon  ?? configuredSellValues.Uncommon  ?? DEFAULT_SELL.uncommon),
    rare:      Number(configuredSellValues.rare      ?? configuredSellValues.Rare      ?? DEFAULT_SELL.rare),
    legendary: Number(configuredSellValues.legendary ?? configuredSellValues.Legendary ?? DEFAULT_SELL.legendary),
  };

  const CONFIG_LIMIT = Number(
    CFG?.trade_system?.sell_limit_per_day ??
    CFG?.coin_system?.sell_limit_per_day ??
    DEFAULT_DAILY_LIMIT
  );

  const command = new SlashCommandBuilder()
    .setName('sellcard')
    .setDescription('Sell cards from your collection for coins (daily limit applies).')
    .setDMPermission(false);

  client.slashData.push(command.toJSON());

  client.commands.set('sellcard', {
    data: command,
    async execute(interaction) {
      // Role gate
      if (!requireSupporter(interaction.member)) {
        return interaction.reply({
          ephemeral: true,
          content: '❌ You need the **Supporter** or **Elite Collector** role to use this command. Join on Ko-fi to unlock full access.'
        });
      }

      // Channel gate
      if (interaction.channelId !== MANAGE_CARDS_CHANNEL_ID) {
        return interaction.reply({
          content: `🧾 Please use this command in <#${MANAGE_CARDS_CHANNEL_ID}>.`,
          ephemeral: true
        });
      }

      // Defer (ephemeral)
      try { await interaction.deferReply({ ephemeral: true }); }
      catch { await interaction.deferReply({ ephemeral: true }); }

      const userId = interaction.user.id;
      const userName = interaction.user.username;

      // Load stores
      let linked = {};
      let bank = {};
      try { linked = await loadJSON(PATHS.linkedDecks); } catch { linked = {}; }
      try { bank = await loadJSON(COIN_BANK_FILE); } catch { bank = {}; }

      const profile = linked[userId];
      if (!profile) {
        return interaction.editReply({
          content: '❌ You are not linked yet. Run **/linkdeck** in **#manage-cards** first.',
          ephemeral: true
        });
      }

      // Keep name fresh
      if (profile.discordName !== userName) profile.discordName = userName;
      profile.collection = profile.collection || {};

      // Ensure/mint the viewer token through the CAS-protected shared helper.
      const token = await ensureLinkedToken(userId, userName);
      const collectionUrl = buildCollectionUrl(CFG, token);

      // Try to fetch *live* status from API (reflects sales made from the UI)
      const directStatus = await getSellStatus(userId);
      const live = { soldToday: directStatus.used, soldRemaining: directStatus.remaining, limit: directStatus.limit, resetAtISO: directStatus.resetsAt };
      let dailyLimitNow = Number(live?.limit ?? CONFIG_LIMIT);
      let dailyUsedNow  = Number(
        live?.soldToday ??
        ((profile.sellCountDate === todayUTC()) ? Number(profile.sellCountToday || 0) : 0)
      );
      let dailyRemainingNow = Math.max(0, dailyLimitNow - dailyUsedNow);
      const resetText = live?.resetAtISO ? ` (resets ${new Date(live.resetAtISO).toUTCString()})` : ' (resets 00:00 UTC)';

      // Build owned list (id, qty, rarity, price/card)
      const ownedPairs = Object.entries(profile.collection)
        .map(([id, qty]) => {
          const id3 = to3(id);
          const q = Number(qty || 0);
          if (!/^\d{3}$/.test(id3) || q <= 0) return null;
          const rarity = (rarityMap[id3] || 'Common').toLowerCase();
          const priceEach = Number(sellValues[rarity] ?? DEFAULT_SELL.common);
          return { id: id3, qty: q, rarity, priceEach };
        })
        .filter(Boolean)
        // Sort: highest qty first, then numeric id
        .sort((a, b) => (b.qty - a.qty) || (Number(a.id) - Number(b.id)));

      // If nothing owned, bail
      if (ownedPairs.length === 0) {
        return interaction.editReply({
          content: 'You do not have any cards in your collection to sell.',
          ephemeral: true
        });
      }

      function makeEmbed(cardChoice = null, qtyChoice = null) {
        const lines = [];
        lines.push('**How to sell from the UI (recommended):**');
        lines.push('• Open your collection → select the cards and **quantities** you want to sell.');
        lines.push('• Add them to the **Sale Queue** (bottom), then **Confirm Sale**.');
        lines.push('');
        lines.push(`🔗 **Collection:** ${collectionUrl}`);
        lines.push('');
        lines.push(`**Daily limit:** ${dailyUsedNow}/${dailyLimitNow} used today • Remaining: ${dailyRemainingNow}${resetText}`);
        if (cardChoice) {
          const r = cardChoice.rarity.charAt(0).toUpperCase() + cardChoice.rarity.slice(1);
          lines.push('');
          lines.push(`Selected: **#${cardChoice.id}** (${r}) — You own **${cardChoice.qty}** — \`${cardChoice.priceEach} coin each\``);
        }
        if (qtyChoice) {
          const est = Math.round(qtyChoice * (cardChoice?.priceEach || 0) * 100) / 100;
          lines.push(`Quantity: **${qtyChoice}**  →  Estimated coins: **${est}**`);
        }

        return new EmbedBuilder()
          .setTitle('🧾 Sell Cards')
          .setDescription(lines.join('\n'))
          .setColor(0x00ccff);
      }

      function makePageRows(p, selected = null, qtySelected = null) {
        const pageSize = 25;
        const pages = Math.ceil(ownedPairs.length / pageSize);
        const slice = ownedPairs.slice(p * pageSize, (p + 1) * pageSize);
        const options = slice.map(c => ({
          label: `#${c.id} • x${c.qty} • ${c.rarity}`,
          description: `Value: ${c.priceEach} coin each`,
          value: c.id
        }));

        const selectCards = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`sell_select_card_${p}`)
            .setPlaceholder('Select a card to sell')
            .addOptions(options)
        );

        const nav = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('sell_prev').setStyle(ButtonStyle.Secondary).setLabel('⏮ Prev').setDisabled(p === 0),
          new ButtonBuilder().setCustomId('sell_next').setStyle(ButtonStyle.Secondary).setLabel('Next ⏭').setDisabled(p === pages - 1)
        );

        const rows = [selectCards, nav];

        // If a card is selected, add Quantity dropdown + Confirm/Cancel
        if (selected) {
          const maxQty = clamp(selected.qty, 1, MAX_QTY_PER_SALE);
          const qtyOpts = Array.from({ length: maxQty }, (_, i) => ({
            label: String(i + 1),
            value: String(i + 1)
          }));
          rows.push(
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(`sell_select_qty_${selected.id}`)
                .setPlaceholder(`Choose quantity (max ${maxQty})`)
                .addOptions(qtyOpts)
            )
          );
          rows.push(
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`sell_confirm_${selected.id}`).setStyle(ButtonStyle.Success).setLabel('✅ Confirm Sale').setDisabled(!qtySelected),
              new ButtonBuilder().setCustomId('sell_cancel').setStyle(ButtonStyle.Secondary).setLabel('Cancel')
            )
          );
        }

        return rows;
      }

      // Build the interactive UI (pagination of IDs)
      let page = 0;
      const initialRows = makePageRows(page);
      const initialEmbed = makeEmbed();

      const msg = await interaction.editReply({
        embeds: [initialEmbed],
        components: initialRows,
        ephemeral: true
      });

      const collector = msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 120_000
      });

      const selectCollector = msg.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 120_000
      });

      let selectedCard = null;
      let selectedQty  = null;

      collector.on('collect', async (i) => {
        if (i.user.id !== userId) return i.reply({ content: '⚠️ Not your menu.', ephemeral: true });

        if (i.customId === 'sell_prev') page = Math.max(0, page - 1);
        if (i.customId === 'sell_next') page = Math.min(Math.ceil(ownedPairs.length / 25) - 1, page + 1);

        if (i.customId.startsWith('sell_confirm_')) {
          if (!selectedCard || !selectedQty) {
            return i.reply({ content: 'Pick a card and quantity first.', ephemeral: true });
          }

          // Reload fresh copies before committing (reduce race)
          try { linked = await loadJSON(PATHS.linkedDecks); } catch {}
          try { bank   = await loadJSON(COIN_BANK_FILE); } catch {}

          const prof = linked[userId];
          if (!prof) return i.update({ content: 'Profile disappeared. Try again.', embeds: [], components: [] });

          // Re-check live status right before sale (so we respect UI sales)
          const statusNow = await getSellStatus(userId);
          const liveNow = { soldToday: statusNow.used, soldRemaining: statusNow.remaining, limit: statusNow.limit, resetAtISO: statusNow.resetsAt };
          const limitNow = Number(liveNow?.limit ?? CONFIG_LIMIT);
          const usedNow  = Number(
            liveNow?.soldToday ??
            ((prof.sellCountDate === todayUTC()) ? Number(prof.sellCountToday || 0) : 0)
          );
          if (usedNow + selectedQty > limitNow) {
            const remain = Math.max(0, limitNow - usedNow);
            return i.reply({
              content: `⛔ Daily sell limit would be exceeded. You can sell **${remain}** more card${remain === 1 ? '' : 's'} today.`,
              ephemeral: true
            });
          }

          const ownedNow = Number(prof.collection?.[selectedCard.id] || 0);
          if (ownedNow < selectedQty) {
            return i.reply({ content: `You now only own **${ownedNow}** of #${selectedCard.id}.`, ephemeral: true });
          }

          // Commit through the same economy service used by the Collection API.
          // This keeps Discord and browser sales on one sells_by_day counter and CAS path.
          let saleResult;
          try {
            saleResult = await sellCards(userId, [{ id: selectedCard.id, qty: selectedQty }]);
          } catch (e) {
            const message = e?.message || 'Sale failed';
            return i.reply({ content: `⚠️ ${message}`, ephemeral: true });
          }
          const coinsGained = Number(saleResult.credit || 0);
          const newBalance = Number(saleResult.balance || 0);
          const rarity = (rarityMap[selectedCard.id] || 'Common').toLowerCase();
          // Update local counters used in the embed for any subsequent UI redraws
          dailyUsedNow  = usedNow + selectedQty;
          dailyLimitNow = limitNow;
          dailyRemainingNow = Math.max(0, dailyLimitNow - dailyUsedNow);

          const rNice = rarity.charAt(0).toUpperCase() + rarity.slice(1);
          const done = new EmbedBuilder()
            .setTitle('🪙 Card Sold')
            .setDescription(
              [
                `Sold **${selectedQty}×** card **#${selectedCard.id}** (${rNice}).`,
                '',
                `**Coins gained:** ${coinsGained}`,
                `**New balance:** ${newBalance}`,
                '',
                `Daily usage: ${dailyUsedNow}/${dailyLimitNow}${resetText}`,
                '',
                `🔗 **Collection:** ${collectionUrl}`
              ].join('\n')
            )
            .setColor(0x00cc66);

          try { collector.stop(); } catch {}
          try { selectCollector.stop(); } catch {}

          return i.update({ embeds: [done], components: [] });
        }

        // Page changed → rebuild (preserve current selection context)
        const rows = makePageRows(page, selectedCard, selectedQty);
        const emb  = makeEmbed(selectedCard, selectedQty);
        await i.update({ embeds: [emb], components: rows });
      });

      selectCollector.on('collect', async (i) => {
        if (i.user.id !== userId) return i.reply({ content: '⚠️ Not your menu.', ephemeral: true });

        // Card selection
        if (i.customId.startsWith('sell_select_card_')) {
          const chosenId = i.values[0];
          const found = ownedPairs.find(c => c.id === chosenId);
          selectedCard = found || null;
          selectedQty = null;

          const rows = makePageRows(page, selectedCard, selectedQty);
          const emb  = makeEmbed(selectedCard, selectedQty);
          return i.update({ embeds: [emb], components: rows });
        }

        // Quantity selection
        if (i.customId.startsWith('sell_select_qty_')) {
          selectedQty = Number(i.values[0] || '0') || 0;
          selectedQty = clamp(selectedQty, 1, Math.min(selectedCard?.qty || 1, MAX_QTY_PER_SALE));

          const rows = makePageRows(page, selectedCard, selectedQty);
          const emb  = makeEmbed(selectedCard, selectedQty);
          return i.update({ embeds: [emb], components: rows });
        }
      });

      const endAll = async () => {
        try {
          await interaction.editReply({
            content: '⏰ Sell menu expired. Run **/sellcard** again when ready.',
            embeds: [],
            components: []
          });
        } catch {}
      };
      collector.on('end', (_c, r) => { if (r === 'time') endAll(); });
      selectCollector.on('end', (_c, r) => { if (r === 'time') endAll(); });
    }
  });
}
