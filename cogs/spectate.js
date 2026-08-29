// /spectate — list active per-session duels and open the dedicated Spectator UI.
// Spectator authorization is session-based on the server; role= is never used.

import { SlashCommandBuilder } from 'discord.js';
import { config } from '../utils/config.js';
import { listSessions } from '../logic/duelSessions.js';
import { ensureLinkedToken, PlayerLinks } from '../utils/playerLinks.js';

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
        // A token is optional for viewing public duel state, but when the spectator is
        // linked it gives the Spectator UI a server-resolvable identity for chat/navigation.
        let viewerToken = '';
        try { viewerToken = await ensureLinkedToken(interaction.user.id, interaction.user.username); }
        catch { /* unlinked users may still browse public spectator state */ }

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
          content: ['🎥 **Live Duels**', ...lines].join('\n'),
          ephemeral: true,
        });
      } catch (error) {
        return interaction.reply({ content: `❌ ${error?.message || error}`, ephemeral: true });
      }
    },
  });
}
