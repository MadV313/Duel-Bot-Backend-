import fs from 'fs/promises';
import path from 'path';
import { PATHS, loadJSON } from './storageClient.js';
import { config, cardDataPath } from './config.js';

export function pad3(value) {
  const n = String(value ?? '').trim();
  if (!/^\d+$/.test(n)) return n.padStart(3, '0');
  return n.padStart(3, '0').slice(-3);
}

export function normalizeRarity(value) {
  const s = String(value || 'Common').trim().toLowerCase();
  return ({ common: 'Common', uncommon: 'Uncommon', rare: 'Rare', legendary: 'Legendary', unique: 'Unique' })[s] || (s ? s[0].toUpperCase() + s.slice(1) : 'Common');
}

export async function loadLinkedDecks() {
  const data = await loadJSON(PATHS.linkedDecks);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

export async function resolveUserIdByToken(token) {
  if (!token) return null;
  const linked = await loadLinkedDecks();
  for (const [userId, profile] of Object.entries(linked)) {
    if (profile && String(profile.token || '') === String(token)) return String(userId);
  }
  return null;
}

export async function getPlayerProfileByUserId(userId) {
  const linked = await loadLinkedDecks();
  return linked[String(userId)] || null;
}

export async function getPlayerCollectionMap(userId) {
  const profile = await getPlayerProfileByUserId(userId);
  const out = {};
  if (!profile?.collection || typeof profile.collection !== 'object' || Array.isArray(profile.collection)) return out;
  for (const [rawId, rawQty] of Object.entries(profile.collection)) {
    const id = pad3(rawId);
    const qty = Math.max(0, Math.floor(Number(rawQty) || 0));
    if (/^\d{3}$/.test(id)) out[id] = qty;
  }
  return out;
}

export async function getPlayerCollection(userId) {
  const map = await getPlayerCollectionMap(userId);
  return Object.entries(map)
    .filter(([id]) => id !== '000')
    .map(([number, owned]) => ({ number, owned }))
    .sort((a, b) => Number(a.number) - Number(b.number));
}

let masterCache = null;
export async function loadMaster({ refresh = false } = {}) {
  if (masterCache && !refresh) return masterCache;
  const absolute = path.resolve(cardDataPath);
  const raw = JSON.parse(await fs.readFile(absolute, 'utf8'));
  const cards = Array.isArray(raw) ? raw : Array.isArray(raw.cards) ? raw.cards : [];
  masterCache = cards.map(card => ({
    ...card,
    card_id: pad3(card.card_id ?? card.number ?? card.id ?? ''),
    rarity: normalizeRarity(card.rarity),
    image: card.image || card.filename || '',
  }));
  return masterCache;
}

export async function getUserStats(userId) {
  const [playerData, bank, collection] = await Promise.all([
    loadJSON(PATHS.playerData).catch(() => ({})),
    loadJSON(PATHS.wallet).catch(() => ({})),
    getPlayerCollectionMap(userId),
  ]);
  const row = playerData?.[String(userId)] || {};
  const cardsCollected = Object.entries(collection).filter(([id, qty]) => id !== '000' && qty > 0).length;
  const cardsOwned = Object.entries(collection).reduce((sum, [id, qty]) => sum + (id === '000' ? 0 : qty), 0);
  return {
    discordName: (await getPlayerProfileByUserId(userId))?.discordName || '',
    wins: Number(row.wins || 0),
    losses: Number(row.losses || 0),
    coins: Number(bank?.[String(userId)] || 0),
    cardsCollected,
    cardsOwned,
    practiceWins: Number(row.practiceWins || 0),
    practiceLosses: Number(row.practiceLosses || 0),
  };
}

export function normalizeDeck(deck) {
  // Preserve the modern schema. Convert legacy arrays only as a compatibility adapter.
  const name = String(deck?.name || 'My Deck').slice(0, 80);
  let cards = [];
  if (Array.isArray(deck)) {
    const counts = new Map();
    for (const raw of deck) {
      const id = pad3(typeof raw === 'object' ? raw?.id ?? raw?.card_id : raw);
      if (/^\d{3}$/.test(id)) counts.set(id, (counts.get(id) || 0) + 1);
    }
    cards = [...counts].map(([id, qty]) => ({ id, qty }));
  } else if (Array.isArray(deck?.cards)) {
    cards = deck.cards.map(row => ({ id: pad3(row?.id ?? row?.card_id), qty: Math.max(0, Math.floor(Number(row?.qty) || 0)) }));
  }
  cards = cards.filter(row => /^\d{3}$/.test(row.id) && row.qty > 0);
  // Canonicalize duplicate rows before validation/persistence. Without this, a client
  // could split one card across several rows to bypass max-copy and ownership checks.
  const combined = new Map();
  for (const row of cards) combined.set(row.id, (combined.get(row.id) || 0) + row.qty);
  return { name, cards: [...combined].map(([id, qty]) => ({ id, qty })) };
}

export function deckCount(deck) {
  return normalizeDeck(deck).cards.reduce((sum, row) => sum + row.qty, 0);
}

export function validateDeck(deck, collection = {}) {
  const normalized = normalizeDeck(deck);
  const errors = [];
  const total = deckCount(normalized);
  if (total < config.duel.deck_min || total > config.duel.deck_max) errors.push(`Deck must contain ${config.duel.deck_min}-${config.duel.deck_max} cards.`);
  for (const row of normalized.cards) {
    if (row.id === '000') errors.push('Card 000 cannot be placed in a playable deck.');
    if (row.qty > config.duel.max_copies) errors.push(`${row.id} exceeds the ${config.duel.max_copies}-copy limit.`);
    if (row.qty > Number(collection[row.id] || 0)) errors.push(`${row.id} exceeds owned quantity.`);
  }
  return { ok: errors.length === 0, errors, deck: normalized, total };
}

export async function validateSavedDeckForUser(userId) {
  const profile = await getPlayerProfileByUserId(userId);
  if (!profile) return { ok: false, errors: ['Player is not linked.'], deck: { name: 'My Deck', cards: [] }, total: 0 };
  return validateDeck(profile.deck, profile.collection || {});
}

export function expandDeck(deck) {
  const out = [];
  for (const { id, qty } of normalizeDeck(deck).cards) for (let i = 0; i < qty; i++) out.push(id);
  return out;
}
