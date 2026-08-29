import crypto from 'crypto';
import { UI, config } from './config.js';
import { PATHS, updateJSONAtomic } from './storageClient.js';

export function validToken(token) { return typeof token === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(token); }
export function mintToken(bytes = 24) { return crypto.randomBytes(bytes).toString('base64url'); }

export async function ensureLinkedToken(userId, discordName = '') {
  let token = null;
  await updateJSONAtomic(PATHS.linkedDecks, linked => {
    const profile = linked?.[String(userId)];
    if (!profile) throw new Error('Player is not linked. Run /linkdeck first.');
    if (!validToken(profile.token)) profile.token = mintToken();
    if (discordName) profile.discordName = discordName;
    profile.lastSeenAt = new Date().toISOString();
    linked[String(userId)] = profile;
    token = profile.token;
    return linked;
  }, { defaultValue: {} });
  return token;
}

function baseUrl(base, params = {}) {
  const u = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') u.searchParams.set(key, String(value));
  if (config.pass_api_query) u.searchParams.set('api', config.api_base);
  return u.toString();
}

export const PlayerLinks = Object.freeze({
  hub: token => baseUrl(UI.hub, token ? { token } : {}),
  collection: token => baseUrl(UI.collection, { token }),
  deck: token => baseUrl(UI.deckBuilder, { token }),
  stats: token => baseUrl(UI.stats, { token }),
  leaderboard: token => baseUrl(UI.leaderboard, token ? { token } : {}),
  duel: (session, token) => baseUrl(UI.duel, { session, token }),
  spectator: (session, token = '') => baseUrl(UI.spectator, { session, ...(token ? { token } : {}) }),
  packReveal: (reveal, token = '') => baseUrl(UI.packReveal, { reveal, ...(token ? { token } : {}) }),
  summary: duelId => baseUrl(UI.duelSummary, { duelId }),
  rules: () => baseUrl(UI.rules),
});
