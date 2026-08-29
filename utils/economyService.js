import { config } from './config.js';
import { PATHS, loadJSON, updateJSONAtomic } from './storageClient.js';
import { loadMaster, normalizeRarity, pad3 } from './deckUtils.js';
import { writePackReveal } from './packRevealStore.js';

const locks = new Map();
async function withUserLock(userId, fn) {
  const key = String(userId);
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  await previous;
  try { return await fn(); }
  finally { release(); if (locks.get(key) === tail) locks.delete(key); }
}

export function utcDay(date = new Date()) { return date.toISOString().slice(0, 10); }
export function nextUtcMidnight(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
}
export function sellValueForRarity(rarity) { return Number(config.coin_system.card_sell_values[normalizeRarity(rarity)] || 0); }
export function rarityWeight(rarity) { return Number(config.coin_system.rarity_weights[normalizeRarity(rarity)] || 0); }
const round2 = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

async function getProfile(userId) {
  const linked = await loadJSON(PATHS.linkedDecks);
  return linked?.[String(userId)] || null;
}

export async function getSellStatus(userId, now = new Date()) {
  const ledger = await loadJSON(PATHS.sellsByDay).catch(() => ({}));
  const used = Number(ledger?.[String(userId)]?.[utcDay(now)] || 0);
  return { used, limit: config.coin_system.sell_limit_per_day, remaining: Math.max(0, config.coin_system.sell_limit_per_day - used), resetsAt: nextUtcMidnight(now) };
}

function normalizeSaleItems(items) {
  const counts = new Map();
  for (const raw of Array.isArray(items) ? items : []) {
    const id = pad3(raw?.id ?? raw?.card_id ?? raw?.number ?? raw);
    const qty = Math.max(0, Math.floor(Number(raw?.qty ?? raw?.quantity ?? 1) || 0));
    if (/^\d{3}$/.test(id) && id !== '000' && qty > 0) counts.set(id, (counts.get(id) || 0) + qty);
  }
  return [...counts].map(([id, qty]) => ({ id, qty }));
}

export async function previewSell(userId, items) {
  const profile = await getProfile(userId);
  if (!profile) throw Object.assign(new Error('Invalid player'), { status: 404 });
  const sale = normalizeSaleItems(items);
  const qty = sale.reduce((sum, row) => sum + row.qty, 0);
  if (!qty) throw Object.assign(new Error('No cards selected'), { status: 400 });
  const status = await getSellStatus(userId);
  if (qty > status.remaining) throw Object.assign(new Error(`Daily sell limit exceeded. ${status.remaining} remaining.`), { status: 429 });
  const master = await loadMaster();
  const byId = new Map(master.map(card => [card.card_id, card]));
  let credit = 0;
  const details = [];
  for (const row of sale) {
    const owned = Number(profile.collection?.[row.id] || 0);
    if (row.qty > owned) throw Object.assign(new Error(`Not enough copies of ${row.id}.`), { status: 400 });
    const card = byId.get(row.id);
    if (!card) throw Object.assign(new Error(`Unknown card ${row.id}.`), { status: 400 });
    const unit = sellValueForRarity(card.rarity);
    if (!unit) throw Object.assign(new Error(`Card ${row.id} cannot be sold.`), { status: 400 });
    credit += unit * row.qty;
    details.push({ id: row.id, qty: row.qty, name: card.name, rarity: normalizeRarity(card.rarity), unitValue: unit, subtotal: round2(unit * row.qty) });
  }
  return { items: details, quantity: qty, credit: round2(credit), ...status };
}

export async function sellCards(userId, items) {
  return withUserLock(userId, async () => {
    const preview = await previewSell(userId, items);
    const day = utcDay();
    const uid = String(userId);

    // Reserve the daily quota first; if later work fails we compensate below.
    await updateJSONAtomic(PATHS.sellsByDay, ledger => {
      ledger[uid] ||= {};
      const used = Number(ledger[uid][day] || 0);
      if (used + preview.quantity > config.coin_system.sell_limit_per_day) throw Object.assign(new Error('Daily sell limit reached.'), { status: 429 });
      ledger[uid][day] = used + preview.quantity;
      return ledger;
    }, { defaultValue: {} });

    let collectionChanged = false;
    let walletCredited = false;
    try {
      await updateJSONAtomic(PATHS.linkedDecks, linked => {
        const profile = linked?.[uid];
        if (!profile) throw Object.assign(new Error('Invalid player'), { status: 404 });
        profile.collection ||= {};
        for (const row of preview.items) {
          const owned = Number(profile.collection[row.id] || 0);
          if (owned < row.qty) throw Object.assign(new Error(`Not enough copies of ${row.id}.`), { status: 409 });
        }
        for (const row of preview.items) profile.collection[row.id] = Number(profile.collection[row.id] || 0) - row.qty;
        linked[uid] = profile;
        return linked;
      }, { defaultValue: {} });
      collectionChanged = true;

      let balance = 0;
      await updateJSONAtomic(PATHS.wallet, bank => {
        balance = round2(Number(bank[uid] || 0) + preview.credit);
        bank[uid] = balance;
        return bank;
      }, { defaultValue: {} });
      walletCredited = true;

      // Mirror for older consumers; coin_bank remains authoritative.
      await updateJSONAtomic(PATHS.linkedDecks, linked => {
        if (linked?.[uid]) linked[uid].coins = balance;
        return linked;
      }, { defaultValue: {} }).catch(() => {});

      return { ok: true, sold: preview.items, quantity: preview.quantity, credit: preview.credit, balance, status: await getSellStatus(uid) };
    } catch (error) {
      // Best-effort compensation. Every compensation is itself CAS-protected.
      if (collectionChanged) {
        await updateJSONAtomic(PATHS.linkedDecks, linked => {
          const profile = linked?.[uid];
          if (profile) {
            profile.collection ||= {};
            for (const row of preview.items) profile.collection[row.id] = Number(profile.collection[row.id] || 0) + row.qty;
          }
          return linked;
        }, { defaultValue: {} }).catch(() => {});
      }
      if (walletCredited) {
        let restoredBalance = null;
        await updateJSONAtomic(PATHS.wallet, bank => {
          restoredBalance = round2(Number(bank[uid] || 0) - preview.credit);
          bank[uid] = restoredBalance;
          return bank;
        }, { defaultValue: {} }).catch(() => {});
        if (restoredBalance != null) {
          await updateJSONAtomic(PATHS.linkedDecks, linked => {
            if (linked?.[uid]) linked[uid].coins = restoredBalance;
            return linked;
          }, { defaultValue: {} }).catch(() => {});
        }
      }
      await updateJSONAtomic(PATHS.sellsByDay, ledger => {
        if (ledger?.[uid]?.[day] != null) ledger[uid][day] = Math.max(0, Number(ledger[uid][day]) - preview.quantity);
        return ledger;
      }, { defaultValue: {} }).catch(() => {});
      throw error;
    }
  });
}

// Preserve the original pack algorithm: each CARD carries its rarity weight.
// The repair normalizes rarity first so lowercase #020-#059 no longer fall through
// to the old default weight of 1.
export function pickWeighted(cards, random = Math.random) {
  const eligible = (Array.isArray(cards) ? cards : []).filter(card =>
    card?.card_id !== '000' && rarityWeight(card?.rarity) > 0);
  if (!eligible.length) throw Object.assign(new Error('No collectible cards are eligible for pack selection.'), { status: 500 });
  const total = eligible.reduce((sum, card) => sum + rarityWeight(card.rarity), 0);
  let roll = random() * total;
  for (const card of eligible) {
    roll -= rarityWeight(card.rarity);
    if (roll < 0) return card;
  }
  return eligible.at(-1);
}

export function drawPack(master, count = config.coin_system.cards_per_pack, random = Math.random) {
  return Array.from({ length: count }, () => pickWeighted(master, random));
}

async function applyCardsToCollection(userId, cards, { consumeDailyPurchase = false } = {}) {
  const uid = String(userId);
  const day = utcDay();
  const newIds = [];
  let boughtToday = 0;
  await updateJSONAtomic(PATHS.linkedDecks, linked => {
    const profile = linked?.[uid];
    if (!profile) throw Object.assign(new Error('Player is not linked.'), { status: 404 });
    profile.collection ||= {};
    const ownedTotal = Object.entries(profile.collection).reduce((sum, [id, qty]) => sum + (id === '000' ? 0 : Math.max(0, Number(qty) || 0)), 0);
    if (ownedTotal + cards.length > config.coin_system.max_card_collection_size) throw Object.assign(new Error(`Collection capacity is ${config.coin_system.max_card_collection_size} cards.`), { status: 409 });
    if (consumeDailyPurchase) {
      profile.packPurchasesByDay ||= {};
      const used = Number(profile.packPurchasesByDay[day] || 0);
      if (used >= config.coin_system.buy_limit_per_day) throw Object.assign(new Error(`Daily pack limit reached (${config.coin_system.buy_limit_per_day}/day).`), { status: 429 });
      profile.packPurchasesByDay[day] = used + 1;
      boughtToday = used + 1;
    }
    for (const card of cards) {
      const id = card.card_id;
      if (Number(profile.collection[id] || 0) <= 0) newIds.push(id);
      profile.collection[id] = Number(profile.collection[id] || 0) + 1;
    }
    linked[uid] = profile;
    return linked;
  }, { defaultValue: {} });
  return { newIds: [...new Set(newIds)], boughtToday };
}

async function removeCardsFromCollection(userId, cards, { releaseDailyPurchase = false } = {}) {
  const uid = String(userId), day = utcDay();
  await updateJSONAtomic(PATHS.linkedDecks, linked => {
    const p = linked?.[uid];
    if (!p) return linked;
    p.collection ||= {};
    for (const card of cards) p.collection[card.card_id] = Math.max(0, Number(p.collection[card.card_id] || 0) - 1);
    if (releaseDailyPurchase && p.packPurchasesByDay?.[day]) p.packPurchasesByDay[day] = Math.max(0, Number(p.packPurchasesByDay[day]) - 1);
    return linked;
  }, { defaultValue: {} });
}

export async function buyPack(userId) {
  return withUserLock(userId, async () => {
    const uid = String(userId);
    const profile = await getProfile(uid);
    if (!profile) throw Object.assign(new Error('Player is not linked.'), { status: 404 });
    const balanceBefore = Number((await loadJSON(PATHS.wallet).catch(() => ({})))?.[uid] || 0);
    const cost = config.coin_system.card_pack_cost;
    if (balanceBefore < cost) throw Object.assign(new Error(`A pack costs ${cost} coins.`), { status: 402 });

    const master = await loadMaster();
    const cards = drawPack(master);
    const applied = await applyCardsToCollection(uid, cards, { consumeDailyPurchase: true });
    let debited = false;
    try {
      let balance = 0;
      await updateJSONAtomic(PATHS.wallet, bank => {
        const current = Number(bank[uid] || 0);
        if (current < cost) throw Object.assign(new Error('Insufficient coins.'), { status: 409 });
        balance = round2(current - cost);
        bank[uid] = balance;
        return bank;
      }, { defaultValue: {} });
      debited = true;
      // coin_bank is authoritative; mirror the new balance for legacy profile consumers.
      await updateJSONAtomic(PATHS.linkedDecks, linked => {
        if (linked?.[uid]) linked[uid].coins = balance;
        return linked;
      }, { defaultValue: {} }).catch(() => {});
      const reveal = await writePackReveal({ cards: cards.map(card => ({ id: card.card_id, card_id: card.card_id, name: card.name, rarity: normalizeRarity(card.rarity), type: card.type, image: card.image, isNew: applied.newIds.includes(card.card_id) })), newIds: applied.newIds, source: 'purchase' });
      return { ok: true, revealId: reveal.revealId, cards: reveal.cards, newIds: reveal.newIds, cost, balance, boughtToday: applied.boughtToday, dailyLimit: config.coin_system.buy_limit_per_day };
    } catch (error) {
      await removeCardsFromCollection(uid, cards, { releaseDailyPurchase: true }).catch(() => {});
      if (debited) {
        let restoredBalance = null;
        await updateJSONAtomic(PATHS.wallet, bank => {
          restoredBalance = round2(Number(bank[uid] || 0) + cost);
          bank[uid] = restoredBalance;
          return bank;
        }, { defaultValue: {} }).catch(() => {});
        if (restoredBalance != null) {
          await updateJSONAtomic(PATHS.linkedDecks, linked => {
            if (linked?.[uid]) linked[uid].coins = restoredBalance;
            return linked;
          }, { defaultValue: {} }).catch(() => {});
        }
      }
      throw error;
    }
  });
}

export async function grantPack(userId, { source = 'admin-cardpack' } = {}) {
  return withUserLock(userId, async () => {
    const master = await loadMaster();
    const cards = drawPack(master);
    const applied = await applyCardsToCollection(userId, cards, { consumeDailyPurchase: false });
    try {
      const reveal = await writePackReveal({ cards: cards.map(card => ({ id: card.card_id, card_id: card.card_id, name: card.name, rarity: normalizeRarity(card.rarity), type: card.type, image: card.image, isNew: applied.newIds.includes(card.card_id) })), newIds: applied.newIds, source });
      return { ok: true, revealId: reveal.revealId, cards: reveal.cards, newIds: reveal.newIds };
    } catch (error) {
      await removeCardsFromCollection(userId, cards).catch(() => {});
      throw error;
    }
  });
}
