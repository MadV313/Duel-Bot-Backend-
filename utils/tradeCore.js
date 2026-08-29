// Pure trade exchange helper. The route owns session lifecycle/DMs; this helper owns
// final ownership revalidation and the one-for-one collection swap so it can be tested
// independently of Express/Discord.

const to3 = value => String(value ?? '').replace(/^#/, '').padStart(3, '0');

export function normalizeTradeSelection(cards = [], max = 3) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(cards) ? cards : []) {
    const id = to3(raw);
    if (!/^\d{3}$/.test(id) || id === '000' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

export function applyCardExchange(linked, trade, { maxCards = 3 } = {}) {
  if (!linked || typeof linked !== 'object') throw Object.assign(new Error('Linked profile store unavailable.'), { status: 500 });
  const initiatorId = String(trade?.initiator?.userId || '');
  const partnerId = String(trade?.partner?.userId || '');
  if (!initiatorId || !partnerId || initiatorId === partnerId) throw Object.assign(new Error('Invalid trade participants.'), { status: 400 });

  const A = linked[initiatorId];
  const B = linked[partnerId];
  if (!A?.collection || !B?.collection) throw Object.assign(new Error('Profiles unavailable.'), { status: 409 });

  const giveA = normalizeTradeSelection(trade?.initiator?.selection, maxCards);
  const giveB = normalizeTradeSelection(trade?.partner?.selection, maxCards);

  // Revalidate CURRENT ownership at commit time. A card selected earlier may have
  // been sold, traded, or removed while the trade was awaiting acceptance.
  for (const id of giveA) {
    if (Number(A.collection[id] || 0) <= 0) throw Object.assign(new Error(`Initiator no longer owns #${id}`), { status: 409 });
  }
  for (const id of giveB) {
    if (Number(B.collection[id] || 0) <= 0) throw Object.assign(new Error(`Partner no longer owns #${id}`), { status: 409 });
  }

  for (const id of giveA) {
    A.collection[id] = Number(A.collection[id] || 0) - 1;
    if (A.collection[id] <= 0) delete A.collection[id];
    B.collection[id] = Number(B.collection[id] || 0) + 1;
  }
  for (const id of giveB) {
    B.collection[id] = Number(B.collection[id] || 0) - 1;
    if (B.collection[id] <= 0) delete B.collection[id];
    A.collection[id] = Number(A.collection[id] || 0) + 1;
  }

  linked[initiatorId] = A;
  linked[partnerId] = B;
  return { linked, giveA, giveB };
}
