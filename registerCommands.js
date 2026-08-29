// registerCommands.js — Persistent Data Aware Command Registrar
// Loads all cog files dynamically, builds client.slashData, and registers them
// to your configured guild. Runtime diagnostics stay in logs, not player data.

import { REST, Routes } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

function log(...a) { console.log('[COMMANDS]', ...a); }
function err(...a) { console.error('[COMMANDS]', ...a); }
const now = () => new Date().toISOString();

/**
 * Dynamically loads all cogs, populates client.slashData,
 * and registers slash commands to Discord.
 */
export async function registerWithClient(client) {
  client.commands = new Map();
  client.slashData = [];

  const cogsDir = path.resolve('./cogs');
  let cogFiles = [];

  try {
    cogFiles = await fs.readdir(cogsDir);
  } catch (e) {
    err('Could not read /cogs directory', e.message);
    return;
  }

  for (const file of cogFiles) {
    if (!file.endsWith('.js')) continue;

    const cogPath = path.join(cogsDir, file);
    const cogURL = pathToFileURL(cogPath).href;

    try {
      const { default: cog } = await import(cogURL);
      if (typeof cog === 'function') {
        await cog(client);
        log(`✅ Cog loaded: ${file}`);
      } else {
        log(`⚠️ Skipped ${file} (no valid default export)`);
      }
    } catch (e) {
      err(`Failed to load cog ${file}:`, e);
    }
  }

  // ---- Discord registration logic ----
  const token = process.env.DISCORD_TOKEN;
  const guildId = process.env.GUILD_ID;
  const clientId = process.env.CLIENT_ID;

  if (!token || !guildId || !clientId) {
    err('Missing required ENV vars: DISCORD_TOKEN, CLIENT_ID, or GUILD_ID');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const commands = client.slashData || [];

  if (commands.length === 0) {
    log('⚠️ No slashData found — nothing to register.');
    return;
  }

  try {
    log(`📤 Registering ${commands.length} commands to guild ${guildId}...`);
    commands.forEach(c => log(`  /${c.name || '[Unnamed]'}`));

    const res = await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands }
    );

    const count = Array.isArray(res) ? res.length : 0;
    log(`✅ Successfully registered ${count} command(s).`);

    log(`Command sync completed at ${now()}.`);

  } catch (e) {
    const body = e?.rawError || e?.data || e?.response?.data || e;
    const friendly = typeof body === 'object' ? JSON.stringify(body, null, 2) : String(body);
    err('❌ Discord command registration failed:\n', friendly);

    err(`Command sync failure at ${now()}.`);
  }
}

// ✅ Dummy default export for Railway compatibility
export default async function () {}
