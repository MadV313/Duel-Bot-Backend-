// /spectate — list active per-session duels and open the dedicated Spectator UI.
// Public spectator links remain token-free, but /spectate itself returns a personalized
// ephemeral link for the invoking linked player so spectator chat can resolve Discord identity.
// Spectator authorization is session-based on the server; role= is never used.

import { SlashCommandBuilder } from 'discord.js';
import { config } from '../utils/config.js';
import { listSessions } from '../logic/duelSessions.js';
import { getPlayerProfileByUserId } from '../utils/deckUtils.js';
import { ensureLinkedToken, PlayerLinks, validToken } from '../utils/playerLinks.js';

export default async function registerSpectate(client) {
  const data = new SlashCommandBuilder()
    .setName('spectate')
    .setDescription('View live SV13 TCG duels and spectator links.')
    .setDMPermission(false);

  client.slashData.push(data.toJSON());
  client.commands.set('spectate', {
    data,
    async execute(interaction) {
      if (config.battlefield_channel_id && String(interaction.channelId) !== String(config.battlefield_channel_id)) {
        return interaction.reply({
          content: `⚠️ This command can only be used in <#${config.battlefield_channel_id}>.`,
          ephemeral: true,
        });
      }

      try {
        const userId = String(interaction.user.id);
        const username = interaction.user.username;

        // /spectate is the authenticated Discord entry point. Do not silently downgrade a
        // linked player to an anonymous spectator link, because that loses their chat identity.
        const profile = await getPlayerProfileByUserId(userId);
        if (!profile) {
          return interaction.reply({
            content: '❌ You need a linked SV13 TCG profile before using **/spectate**. Run **/linkdeck** in #manage-cards first.',
            ephemeral: true,
          });
        }

        // Prefer an already-valid persisted token immediately. This keeps /spectate usable even
        // if the harmless identity-refresh write is temporarily contending with another profile
        // update. If the token is missing/invalid, minting it must succeed or we fail explicitly.
        let viewerToken = validToken(profile.token) ? profile.token : '';
        try {
          viewerToken = await ensureLinkedToken(userId, username);
        } catch (error) {
          if (!viewerToken) throw error;
          console.warn('[spectate] Could not refresh linked spectator identity; using existing valid token:', error?.message || error);
        }

        if (!validToken(viewerToken)) {
          throw new Error('Could not resolve a valid spectator identity token. Run /linkdeck again and retry.');
        }

        const active = (await listSessions({ activeOnly: true }))
          .filter(session => session?.id && session.status === 'live')
          .slice(0, 10);

        if (!active.length) {
          return interaction.reply({ content: '🕊 No live duels right now.', ephemeral: true });
        }

        const lines = active.map(session => {
          const players = Array.isArray(session.players) ? session.players : [];
          const names = players.map(player => player.displayName || 'Survivor').join(' vs ');
          return `• **${names || session.id}** (${session.mode || 'duel'}) — ${PlayerLinks.spectator(session.id, viewerToken)}`;
        });

        return interaction.reply({
          content: ['🎥 **Live Duels**', 'Your links are personalized so spectator chat can show your Discord name.', ...lines].join('\n'),
          ephemeral: true,
        });
      } catch (error) {
        console.error('[spectate] Failed to create personalized spectator link:', error);
        return interaction.reply({
          content: `❌ Could not create your personalized spectator link: ${error?.message || error}`,
          ephemeral: true,
        });
      }
    },
  });
}
