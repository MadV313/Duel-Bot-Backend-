// cogs/duelcard.js — Admin-only card give/take command
// Updates:
//  • Ensures the target player has a token (mint if missing) for Collection UI deep-linking
//  • Normalizes collection keys to 3-digit IDs (001, 002, ...)
//  • Adds a tokenized "View Collection" link in the confirmation (uses CONFIG.api_base + collection_ui)
//  • Uses the selected card's actual image filename (image/filename from master), with absolute-URL support
//  • Defaults image base to Card-Collection-UI/images/cards (front-end) and keeps messages NON-EPHEMERAL
//  • NEW: Add &new=<cardId3>&ts=<now> to the collection link on GIVE
//  • NEW: DM the target user with the same embed+link; notify admins if DM fails
//  • PERSISTENCE: linked_decks.json is loaded/saved REMOTELY via storageClient with [STORAGE] logs + adminAlert

import fs from 'fs/promises';
import fsSync from 'fs';              // kept for local CoreMasterReference read
import path from 'path';
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder
} from 'discord.js';

import { loadJSON, updateJSONAtomic, PATHS } from '../utils/storageClient.js';
import { ensureLinkedToken } from '../utils/playerLinks.js';
import { config } from '../utils/config.js';
import { adminAlert } from '../utils/adminAlert.js';
import { L } from '../utils/logs.js';

const ADMIN_ROLE_ID = '1173049392371085392';
const ADMIN_CHANNEL_ID = '1368023977519222895';

const cardListPath = path.resolve('./logic/CoreMasterReference.json');

/* ---------------- Config helpers ---------------- */
function loadConfig() {
  try {
    const raw = process.env.CONFIG_JSON;
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn(`[duelcard] CONFIG_JSON parse error: ${e?.message}`);
  }
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    return JSON.parse(fsSync.readFileSync('config.json', 'utf-8')) || {};
  } catch {
    return {};
  }
}
function trimBase(u = '') { return String(u).trim().replace(/\/+$/, ''); }
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
function resolveApiBase(cfg) {
  return trimBase(cfg.api_base || cfg.API_BASE || process.env.API_BASE || '');
}
function resolveImageBase(cfg) {
  // Default to the front-end repo where images live; override with CONFIG.image_base if you like
  return trimBase(cfg.image_base || cfg.IMAGE_BASE || 'https://sv13tcg.com/assets/cards');
}

/* ---------------- Utility helpers ---------------- */
function pad3(n) {
  return String(n).padStart(3, '0');
}
function sanitize(s = '') {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '');
}
function makeFilename(id3, name, type) {
  return `${pad3(id3)}_${sanitize(name || 'Card')}_${sanitize(type || 'Unknown')}.png`;
}
function normalizeCollectionMap(collection = {}) {
  const out = {};
  for (const [k, v] of Object.entries(collection)) {
    const id3 = pad3(k);
    const qty = Number(v) || 0;
    if (qty > 0) out[id3] = qty;
  }
  return out;
}
function isAbsoluteUrl(u) {
  return /^https?:\/\//i.test(String(u || ''));
}

/* ---------------- Remote storage wrappers ---------------- */
async function _loadJSONSafe(name) {
  try { return await loadJSON(name); }
  catch (e) { L.storage(`load fail ${name}: ${e.message}`); throw e; }
}
export default async function registerDuelCard(client) {
  const CFG = loadConfig();
  const COLLECTION_BASE = resolveCollectionBase(CFG);
  const API_BASE = resolveApiBase(CFG);
  const IMAGE_BASE = resolveImageBase(CFG);
  const passApi = String(process.env.PASS_API_QUERY ?? CFG.pass_api_query ?? 'false').toLowerCase() === 'true';
  const apiQP = passApi && API_BASE ? `&api=${encodeURIComponent(API_BASE)}` : '';

  const commandData = new SlashCommandBuilder()
    .setName('duelcard')
    .setDescription('Admin only: Give or take cards from a player.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  client.slashData.push(commandData.toJSON());

  client.commands.set('duelcard', {
    data: commandData,
    async execute(interaction) {
      const timestamp = new Date().toISOString();
      const executor = `${interaction.user.username} (${interaction.user.id})`;

      try {
        console.log(`[${timestamp}] 🔸 /duelcard triggered by ${executor}`);

        const isAdmin = interaction.member?.roles?.cache?.has(ADMIN_ROLE_ID);
        if (!isAdmin) {
          return interaction.reply({ content: '🚫 You do not have permission to use this command.', ephemeral: true });
        }

        if (interaction.channelId !== ADMIN_CHANNEL_ID) {
          return interaction.reply({
            content: '❌ This command MUST be used in the SV13 TCG - admin tools channel.',
            ephemeral: true
          });
        }

        const modeRow = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('duelcard_mode')
            .setPlaceholder('🃏 Choose action')
            .addOptions([
              { label: 'Give Card', value: 'give' },
              { label: 'Take Card', value: 'take' }
            ])
        );

        await interaction.reply({
          content: '🃏 Select whether to give or take a card:',
          components: [modeRow],
          ephemeral: true
        });

        const modeSelect = await interaction.channel.awaitMessageComponent({
          componentType: ComponentType.StringSelect,
          time: 30_000
        });

        try {
          await modeSelect.deferUpdate();
        } catch (err) {
          console.warn('⚠️ Mode select interaction expired or failed:', err);
          return;
        }

        const actionMode = modeSelect.values[0];
        await interaction.editReply({ content: '✅ Mode selected. Loading players...', components: [] });

        // REMOTE read linked profiles
        let linkedData = {};
        try {
          linkedData = await _loadJSONSafe(PATHS.linkedDecks);
        } catch {
          return interaction.editReply({ content: '⚠️ Could not load linked users.' });
        }

        const entries = Object.entries(linkedData);
        if (entries.length === 0) {
          return interaction.editReply({ content: '⚠️ No linked profiles found.' });
        }

        const pageSize = 25;
        let userPage = 0;
        const userPages = Math.ceil(entries.length / pageSize);

        const generateUserPage = (page) => {
          const slice = entries.slice(page * pageSize, (page + 1) * pageSize);
          const options = slice.map(([id, data]) => ({ label: data.discordName, value: id }));

          const embed = new EmbedBuilder()
            .setTitle(`👤 Select Target Player`)
            .setDescription(`Page ${page + 1} of ${userPages}`);

          const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('prev_user_page').setLabel('⏮ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder().setCustomId('next_user_page').setLabel('Next ⏭').setStyle(ButtonStyle.Secondary).setDisabled(page === userPages - 1)
          );

          const dropdown = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('duelcard_user_select')
              .setPlaceholder('Select a player')
              .addOptions(options)
          );

          return { embed, buttons, dropdown };
        };

        const updateUserPage = async () => {
          const { embed, buttons, dropdown } = generateUserPage(userPage);
          await interaction.editReply({ embeds: [embed], components: [dropdown, buttons] });
        };

        await updateUserPage();

        const userCollector = interaction.channel.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60_000 });
        const userSelectCollector = interaction.channel.createMessageComponentCollector({
          componentType: ComponentType.StringSelect,
          time: 60_000
        });

        userCollector.on('collect', async i => {
          if (i.user.id !== interaction.user.id) return;
          await i.deferUpdate();
          if (i.customId === 'prev_user_page') userPage--;
          if (i.customId === 'next_user_page') userPage++;
          await updateUserPage();
        });

        userSelectCollector.on('collect', async select => {
          if (select.user.id !== interaction.user.id || !select.customId.includes('duelcard_user_select')) return;
          userCollector.stop();
          userSelectCollector.stop();

          await select.deferUpdate();

          const targetId = select.values[0];
          let playerProfile = linkedData[targetId];
          let targetName = playerProfile?.discordName || 'Unknown';

          console.log(`[${timestamp}] 🎯 ${executor} selected ${targetName} (${targetId})`);

          // The menu is built from linked profiles. If one was removed while the menu was
          // open, do not silently recreate it with a partial schema.
          if (!playerProfile) {
            return interaction.editReply({ content: '⚠️ That linked profile changed while this menu was open. Run **/duelcard** again.' });
          }

          let token;
          try { token = await ensureLinkedToken(targetId, playerProfile.discordName || targetName); }
          catch (error) {
            console.warn('[duelcard] Failed to refresh player token:', error?.message || error);
            return interaction.editReply({ content: '⚠️ Failed to refresh the player profile.' });
          }

          // Load card data (LOCAL read OK)
          let cardData = [];
          try {
            const raw = await fs.readFile(cardListPath, 'utf-8');
            const parsed = JSON.parse(raw);
            cardData = Array.isArray(parsed) ? parsed : (parsed.cards || []);
          } catch {
            return interaction.editReply({ content: '⚠️ Could not load card data.' });
          }

          // Normalize and filter out #000
          let filteredCards = cardData
            .map(c => ({ ...c, card_id: pad3(c.card_id) }))
            .filter(card => card.card_id !== '000');

          if (actionMode === 'take') {
            // normalize existing keys too (safety)
            playerProfile.collection = normalizeCollectionMap(playerProfile.collection || {});
            const owned = playerProfile.collection;
            filteredCards = filteredCards.filter(card => Number(owned[pad3(card.card_id)]) > 0);
          }

          const cardOptions = filteredCards.map(card => ({
            label: `${card.card_id} ${card.name}`.slice(0, 100),
            value: String(card.card_id)
          }));

          if (actionMode === 'give') {
            cardOptions.unshift({ label: '🎲 Random Card', value: 'RANDOM_CARD' });
          }

          const cardPageSize = 25;
          let cardPage = 0;
          const cardPages = Math.ceil(cardOptions.length / cardPageSize);

          const generateCardPage = (page) => {
            const pageSlice = cardOptions.slice(page * cardPageSize, (page + 1) * cardPageSize);
            const embed = new EmbedBuilder()
              .setTitle(`${actionMode === 'give' ? '🟢 GIVE' : '🔴 TAKE'} a Card`)
              .setDescription(`Select a card for **${targetName}**\nPage ${page + 1} of ${cardPages}`);

            const buttons = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('prev_card_page').setLabel('⏮ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
              new ButtonBuilder().setCustomId('next_card_page').setLabel('Next ⏭').setStyle(ButtonStyle.Secondary).setDisabled(page === cardPages - 1)
            );

            const dropdown = new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId('duelcard_card_select')
                .setPlaceholder('Select a card')
                .addOptions(pageSlice)
            );

            return { embed, buttons, dropdown };
          };

          const firstRender = generateCardPage(cardPage);
          const cardMsg = await interaction.editReply({
            embeds: [firstRender.embed],
            components: [firstRender.dropdown, firstRender.buttons],
            fetchReply: true
          });

          const cardCollector = cardMsg.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60_000,
            filter: i => i.message.id === cardMsg.id && i.user.id === interaction.user.id
          });

          cardCollector.on('collect', async btn => {
            if (btn.customId === 'prev_card_page') cardPage--;
            if (btn.customId === 'next_card_page') cardPage++;

            const update = generateCardPage(cardPage);
            try {
              await btn.update({ embeds: [update.embed], components: [update.dropdown, update.buttons] });
            } catch (err) {
              console.warn('⚠️ Failed to update card page:', err);
              try {
                await cardMsg.edit({ embeds: [update.embed], components: [update.dropdown, update.buttons] });
              } catch (editErr) {
                console.error('❌ Could not fallback-edit cardMsg:', editErr);
              }
            }
          });

          const selectCollector = cardMsg.createMessageComponentCollector({
            componentType: ComponentType.StringSelect,
            time: 60_000,
            filter: i => i.message.id === cardMsg.id && i.user.id === interaction.user.id
          });

          selectCollector.on('collect', async cardSelect => {
            let selectedId = cardSelect.values[0];

            if (selectedId === 'RANDOM_CARD') {
              const random = filteredCards[Math.floor(Math.random() * filteredCards.length)];
              selectedId = random.card_id;
            }

            const cardId3 = pad3(selectedId);
            const selectedCard = filteredCards.find(c => c.card_id === cardId3) ||
                                 cardData.find(c => pad3(c.card_id) === cardId3) || {};

            // Apply only this player's collection delta with CAS. The old whole-file save
            // could erase a simultaneous pack, sell, trade, or deck update.
            try {
              await updateJSONAtomic(PATHS.linkedDecks, current => {
                const player = current?.[targetId];
                if (!player) throw Object.assign(new Error('Linked profile no longer exists.'), { status: 404 });
                const collection = normalizeCollectionMap(player.collection || {});
                if (actionMode === 'give') {
                  const total = Object.entries(collection).reduce((sum, [id, qty]) =>
                    sum + (id === '000' ? 0 : Math.max(0, Number(qty) || 0)), 0);
                  if (total >= config.coin_system.max_card_collection_size) {
                    throw Object.assign(new Error(`Collection capacity is ${config.coin_system.max_card_collection_size} cards.`), { status: 409 });
                  }
                  collection[cardId3] = Number(collection[cardId3] || 0) + 1;
                } else {
                  if (Number(collection[cardId3] || 0) <= 0) {
                    throw Object.assign(new Error('That player no longer owns this card.'), { status: 409 });
                  }
                  collection[cardId3] = Number(collection[cardId3] || 0) - 1;
                  if (collection[cardId3] <= 0) delete collection[cardId3];
                }
                player.collection = collection;
                current[targetId] = player;
                return current;
              }, { defaultValue: {} });
            } catch (error) {
              return cardSelect.reply({ content: `⚠️ ${error?.message || 'Failed to persist linked profile update.'}`, ephemeral: true });
            }

            const verb = actionMode === 'give' ? 'given to' : 'taken from';
            const adminTag = `<@${interaction.user.id}>`;
            const targetTag = `<@${targetId}>`;

            // Build the correct image URL for the selected card
            const fileFromMaster = selectedCard?.image || selectedCard?.filename;
            const file = fileFromMaster || makeFilename(cardId3, selectedCard?.name, selectedCard?.type);
            const imageUrl = isAbsoluteUrl(file) ? file : `${IMAGE_BASE}/${file}`;

            const embed = new EmbedBuilder()
              .setTitle(`✅ Card ${verb}`)
              .setDescription(`Card **${cardId3} ${selectedCard?.name || ''}** ${verb} ${targetTag} by ${adminTag}.`)
              .setImage(imageUrl)
              .setColor(actionMode === 'give' ? 0x00cc66 : 0xcc0000);

            // Build collection link (always ts param; add &new=... only on GIVE)
            const ts = Date.now();
            const baseLink = `${COLLECTION_BASE}/?token=${encodeURIComponent(token)}${apiQP}`;
            const collectionUrl = actionMode === 'give'
              ? `${baseLink}&new=${encodeURIComponent(cardId3)}&ts=${ts}`
              : `${baseLink}&ts=${ts}`;

            // Final confirmation to admins is NON-EPHEMERAL
            await interaction.followUp({
              embeds: [embed],
              content: `📒 **View ${targetName}'s Collection:** ${collectionUrl}`,
              ephemeral: false
            });

            // DM the user on GIVE with the same embed + link; catch errors and notify admins
            if (actionMode === 'give') {
              try {
                const user = await client.users.fetch(targetId);
                await user.send({
                  embeds: [embed],
                  content: `🎁 You were just gifted a card!\nView your collection: ${collectionUrl}`
                });
              } catch (dmErr) {
                console.warn(`[duelcard] Failed to DM user ${targetId}:`, dmErr?.message || dmErr);
                await interaction.followUp({
                  content: `⚠️ Could not DM ${targetTag} about the gifted card. They may have DMs disabled.`,
                  ephemeral: false
                });
              }
            }
          });
        });
      } catch (err) {
        console.error(`❌ Fatal error in /duelcard:`, err);
        if (!interaction.replied) {
          return interaction.reply({ content: '❌ Something went wrong in /duelcard.', ephemeral: true });
        }
        return interaction.editReply({ content: '❌ Something went wrong after interaction started.', ephemeral: true });
      }
    }
  });
}
