import crypto from 'crypto';
import { PATHS, loadJSON, saveJSON } from './storageClient.js';

const safe = id => /^[A-Za-z0-9_-]{12,128}$/.test(String(id || ''));
export function newRevealId() { return crypto.randomBytes(18).toString('base64url'); }

export async function writePackReveal({ cards, newIds = [], source = 'purchase', metadata = {} } = {}) {
  const revealId = newRevealId();
  const record = {
    version: 1,
    revealId,
    createdAt: new Date().toISOString(),
    source,
    cards: Array.isArray(cards) ? cards : [],
    newIds: [...new Set((newIds || []).map(String))],
    // No player token or Discord user ID is persisted in public reveal payloads.
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
  };
  await saveJSON(PATHS.packRevealFor(revealId), record);
  return record;
}

export async function readPackReveal(revealId) {
  if (!safe(revealId)) return null;
  try { return await loadJSON(PATHS.packRevealFor(revealId)); }
  catch (e) { if (e?.status === 404) return null; throw e; }
}
