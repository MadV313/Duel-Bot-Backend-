// cogs/duelcoin.js
// Admin-only coin adjuster with full debug logging.
// - Treats coin_bank as authoritative and mirrors the balance into linked_decks for compatibility
// - Ensures the target has a token to build a collection deep link
// - DMs the target their new balance (graceful on failure)

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
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { adminAlert } from '../utils/adminAlert.js';
import { L } from '../utils/logs.js';
import { loadJSON, updateJSONAtomic, PATHS } from '../utils/storageClient.js';
import { ensureLinkedToken } from '../utils/playerLinks.js';

/* ───────────────────────────── Config helpers ───────────────────────────── */

function readOptionalConfig() {
  try {
    if (fs.existsSync('config.json')) {
      return JSON.parse(fs.readFileSync('config.json', 'utf-8')) || {};
    }
  } catch { /* noop */ }
  return {};
}

const CFG = readOptionalConfig();

const trimBase = (u = '') => String(u).trim().replace(/\/+$/, '');

function resolveCollectionBase(cfg = {}) {
  return trimBase(
    cfg.collection_ui ||
      cfg.ui_urls?.card_collection_ui ||
      cfg.frontend_url ||
      cfg.ui_base ||
      process.env.COLLECTION_UI ||
      'https://collection.sv13tcg.com'
  );
}
function resolveApiBase(cfg = {}) {
  return trimBase(cfg.api_base || process.env.API_BASE || '');
}

const COLLECTION_BASE = resolveCollectionBase(CFG);
const API_BASE = resolveApiBase(CFG);
const PASS_API_QUERY = String(process.env.PASS_API_QUERY ?? CFG.pass_api_query ?? 'false').toLowerCase() === 'true';
const apiQP = PASS_API_QUERY && API_BASE ? `&api=${encodeURIComponent(API_BASE)}` : '';

/* ───────────────────────────── Admin / Channel gates ───────────────────────────── */

const ADMIN_ROLE_ID =
  process.env.ADMIN_ROLE_ID ||
  (Array.isArray(CFG.admin_role_ids) ? CFG.admin_role_ids[0] : '1173049392371085392');

const ADMIN_CHANNEL_ID =
  process.env.ADMIN_TOOLS_CHANNEL_ID ||
  CFG.admin_tools_channel_id ||
  '1368023977519222895';

/* ───────────────────────────── Small utils ───────────────────────────── */

async function loadLinkedSafe() {
  try {
    return await loadJSON(PATHS.linkedDecks);
  } catch (e) {
    L.storage(`load fail ${PATHS.linkedDecks}: ${e.message}`);
    throw e;
  }
}
/* ───────────────────────────── Command ───────────────────────────── */

export default async function registerDuelCoin(client) {
  const data = new SlashCommandBuilder()
    .setName('duelcoin')
    .setDescription('Admin only: Give or take coins from a player.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  client.slashData.push(data.toJSON());

  client.commands.set('duelcoin', {
    data,
    async execute(interaction) {
      const t0 = new Date().toISOString();
      const executor = `${interaction.user.username} (${interaction.user.id})`;

      // Admin gate: either has Administrator perm or specific Admin role ID
      const hasAdminPerm =
        interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
        interaction.member?.roles?.cache?.has(ADMIN_ROLE_ID);

      if (!hasAdminPerm) {
        console.warn(`[${t0}] 🚫 /duelcoin unauthorized by ${executor}`);
        return interaction.reply({
          content: '🚫 You do not have permission to use this command.',
          ephemeral: true,
        });
      }

      // Channel lock
      if (String(interaction.channelId) !== String(ADMIN_CHANNEL_ID)) {
        console.warn(`[${t0}] ❌ /duelcoin wrong channel by ${executor} in ${interaction.channelId}`);
        return interaction.reply({
          content: '❌ This command must be used in the **Admin Tools** channel.',
          ephemeral: true,
        });
      }

      // Mode chooser
      const modeRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('duelcoin_mode')
          .setPlaceholder('🔻 Choose action')
          .addOptions([
            { label: 'Give Coins', value: 'give' },
            { label: 'Take Coins', value: 'take' },
          ])
      );

      const modeMsg = await interaction.reply({
        content: '🪙 Select whether to give or take coins:',
        components: [modeRow],
        ephemeral: true,
        fetchReply: true,
      });

      // Await the first select (scoped to user)
      const modeSelect = await modeMsg
        .awaitMessageComponent({
          componentType: ComponentType.StringSelect,
          time: 30_000,
          filter: (i) => i.user.id === interaction.user.id,
        })
        .catch(() => null);

      if (!modeSelect) {
        return interaction.editReply({
          content: '⏰ Timed out waiting for a selection.',
          components: [],
        });
      }

      const actionMode = modeSelect.values[0]; // 'give' | 'take'

      // Load linked users
      const linked = await loadLinkedSafe();
      const entries = Object.entries(linked);
      if (!entries.length) {
        return modeSelect.reply({ content: '⚠️ No linked profiles found.', ephemeral: true });
      }

      // Pagination plumbing
      const pageSize = 25;
      let page = 0;
      const pages = Math.ceil(entries.length / pageSize);

      const makePage = (p) => {
        const slice = entries.slice(p * pageSize, (p + 1) * pageSize);
        const select = new StringSelectMenuBuilder()
          .setCustomId(`duelcoin_user_${p}`)
          .setPlaceholder('Select a player')
          .addOptions(
            slice.map(([id, prof]) => ({
              label: prof.discordName || id,
              value: id,
            }))
          );

        const nav = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('prev').setStyle(ButtonStyle.Secondary).setLabel('⏮ Prev').setDisabled(p === 0),
          new ButtonBuilder()
            .setCustomId('next')
            .setStyle(ButtonStyle.Secondary)
            .setLabel('Next ⏭')
            .setDisabled(p === pages - 1)
        );

        const row = new ActionRowBuilder().addComponents(select);
        const embed = new EmbedBuilder()
          .setTitle('👤 Select User')
          .setDescription(`Page ${p + 1} of ${pages} — ${entries.length} linked users total`);

        return { row, nav, embed };
      };

      const first = makePage(page);
      const listMsg = await modeSelect.reply({
        embeds: [first.embed],
        components: [first.row, first.nav],
        ephemeral: true,
        fetchReply: true,
      });

      // Button paging
      const btnCollector = listMsg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60_000,
        filter: (i) => i.user.id === interaction.user.id,
      });

      btnCollector.on('collect', async (i) => {
        if (i.customId === 'prev') page = Math.max(0, page - 1);
        if (i.customId === 'next') page = Math.min(pages - 1, page + 1);
        const built = makePage(page);
        await i.update({ embeds: [built.embed], components: [built.row, built.nav] });
      });

      // Dropdown select → open modal for amount
      const ddCollector = listMsg.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60_000,
        filter: (i) => i.user.id === interaction.user.id,
      });

      ddCollector.on('collect', async (i) => {
        const targetId = i.values[0];
        const targetName = linked[targetId]?.discordName || 'Player';

        const modal = new ModalBuilder()
          .setCustomId(`duelcoin:amount:${targetId}:${actionMode}`)
          .setTitle(`${actionMode === 'give' ? 'Give' : 'Take'} Coins — ${targetName}`);

        const input = new TextInputBuilder()
          .setCustomId('coin_amount')
          .setLabel('Enter amount')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g., 10')
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await i.showModal(modal);
      });

      // Modal submit (scoped)
      const modalListener = async (modalInteraction) => {
        if (!modalInteraction.isModalSubmit()) return;
        if (modalInteraction.user.id !== interaction.user.id) return;
        if (!modalInteraction.customId.startsWith('duelcoin:amount:')) return;

        const [, , userId, mode] = modalInteraction.customId.split(':'); // duelcoin:amount:<id>:<mode>
        const raw = modalInteraction.fields.getTextInputValue('coin_amount');
        const amount = parseInt(raw, 10);

        if (!Number.isFinite(amount) || amount < 1) {
          return modalInteraction.reply({ content: '⚠️ Invalid amount.', ephemeral: true });
        }

        // Refresh the target identity first. The selected user came from linked_decks, so
        // this must never create an unrelated profile.
        const linkedNow = await loadLinkedSafe();
        const discordName =
          (await modalInteraction.client.users
            .fetch(userId)
            .then((u) => u.username)
            .catch(() => linkedNow[userId]?.discordName || 'Player')) || 'Player';
        const token = await ensureLinkedToken(userId, discordName);

        // coin_bank is authoritative. CAS makes simultaneous admin adjustments additive
        // rather than allowing a stale whole-file write to erase another adjustment.
        let newBalance = 0;
        await updateJSONAtomic(PATHS.wallet, bank => {
          const fallback = Number(linkedNow[userId]?.coins ?? 0) || 0;
          const current = Object.prototype.hasOwnProperty.call(bank, userId)
            ? (Number(bank[userId]) || 0)
            : fallback;
          newBalance = mode === 'give' ? current + amount : Math.max(0, current - amount);
          bank[userId] = newBalance;
          return bank;
        }, { defaultValue: {} });

        // Mirror into the profile for legacy consumers. Failure here does not roll back
        // the authoritative bank or invite a duplicate adjustment; alert the admin instead.
        try {
          await updateJSONAtomic(PATHS.linkedDecks, current => {
            if (!current?.[userId]) throw Object.assign(new Error('Linked profile disappeared'), { status: 409 });
            current[userId].coins = newBalance;
            current[userId].coinsUpdatedAt = new Date().toISOString();
            return current;
          }, { defaultValue: {} });
        } catch (error) {
          await adminAlert(
            client,
            process.env.ADMIN_PAYOUT_CHANNEL_ID || process.env.PAYOUTS_CHANNEL_ID || ADMIN_CHANNEL_ID,
            `Coin bank updated for ${userId}, but linked profile mirror failed: ${error?.message || error}`
          ).catch(() => {});
        }

        // Build collection URL
        const ts = Date.now();
        const collectionUrl = `${COLLECTION_BASE}/?token=${encodeURIComponent(token)}${apiQP}&ts=${ts}`;

        // Confirm in channel (non-ephemeral for audit)
        await modalInteraction.reply({
          content: `✅ <@${interaction.user.id}> ${mode === 'give' ? 'gave' : 'took'} **${amount}** coin${
            amount === 1 ? '' : 's'
          } ${mode === 'give' ? 'to' : 'from'} <@${userId}>.\nNew balance: **${newBalance}**\n📒 Collection: ${collectionUrl}`,
          ephemeral: false,
        });

        // DM the target (best-effort)
        try {
          const u = await modalInteraction.client.users.fetch(userId);
          const emb = new EmbedBuilder()
            .setTitle('🪙 Coin Balance Updated')
            .setDescription(`Your new balance is **${newBalance}** coins.`)
            .setColor(0x00ccff);
          await u.send({ embeds: [emb], content: `View your collection: ${collectionUrl}` });
        } catch (e) {
          console.warn(`[duelcoin] DM to ${userId} failed:`, e?.message || e);
          try {
            await modalInteraction.followUp({
              content: `⚠️ Could not DM <@${userId}> (they may have DMs disabled).`,
              ephemeral: true,
            });
          } catch {}
        }

        // Stop collectors after success
        try { btnCollector.stop(); } catch {}
        try { ddCollector.stop(); } catch {}
        client.off('interactionCreate', modalListener);
      };

      client.on('interactionCreate', modalListener);

      // Cleanup on timeout
      const endAll = async () => {
        try {
          await listMsg.edit({
            content: '⏰ Selection expired. Run **/duelcoin** again to restart.',
            components: [],
            embeds: [],
          });
        } catch {}
        client.off('interactionCreate', modalListener);
      };
      btnCollector.on('end', (_c, r) => { if (r === 'time') endAll(); });
      ddCollector.on('end', (_c, r) => { if (r === 'time') endAll(); });
    },
  });
}
