// logic/duelEffects.js — authoritative DuelSession gameplay effects.
// This is a server-side migration of the original Duel-UI duel.js behavior.
// The master card metadata remains the source for type/effect/tags.

import { config } from '../utils/config.js';
import { loadMaster } from '../utils/deckUtils.js';

const MAX_HP = () => Number(config.duel.starting_hp || 200);
const MAX_HAND = () => Number(config.duel.hand_limit || 4);
const FIELD_LIMIT = () => Math.min(3, Number(config.duel.field_limit || 3));
const now = () => new Date().toISOString();
const otherSeat = seat => seat === 'player1' ? 'player2' : 'player1';
const txt = value => String(value || '').toLowerCase();
const pad3 = value => String(value ?? '').trim().padStart(3, '0');
const event = (session, type, extra = {}) => {
  session.state.events ||= [];
  session.state.events.push({ at: now(), type, ...extra });
};

let masterIndex = null;
async function getMasterIndex() {
  if (masterIndex) return masterIndex;
  const cards = await loadMaster();
  masterIndex = new Map(cards.map(card => [pad3(card.card_id), card]));
  return masterIndex;
}

export function resetDuelMasterCacheForTests() { masterIndex = null; }
export async function prepareDuelEffects() { await getMasterIndex(); return true; }
function requireMaster() { if (!masterIndex) throw new Error('Duel effect metadata was not prepared'); return masterIndex; }

export function entryId(entry) {
  if (entry && typeof entry === 'object') return pad3(entry.cardId ?? entry.id ?? entry.card_id ?? '000');
  return pad3(entry);
}

export function normalizeFieldEntry(entry, { faceDown = false } = {}) {
  if (entry && typeof entry === 'object') {
    return {
      ...entry,
      cardId: entryId(entry),
      isFaceDown: Boolean(entry.isFaceDown ?? faceDown),
      _fired: Boolean(entry._fired ?? entry.fired ?? false),
    };
  }
  return { cardId: entryId(entry), isFaceDown: Boolean(faceDown), _fired: false };
}

function tags(meta) {
  return new Set((Array.isArray(meta?.tags) ? meta.tags : String(meta?.tags || '').split(','))
    .map(v => String(v).trim().toLowerCase()).filter(Boolean));
}
function hasTag(meta, tag) { return tags(meta).has(String(tag).toLowerCase()); }
function isType(meta, type) { return txt(meta?.type) === String(type).toLowerCase(); }
export function isTrapMeta(meta) { return isType(meta, 'trap') || hasTag(meta, 'trap'); }
function persistent(meta) {
  if (!meta) return false;
  if (isType(meta, 'defense') || isTrapMeta(meta)) return true;
  const set = tags(meta);
  return set.has('persistent') || set.has('equip') || set.has('gear') || set.has('armor');
}

function ensurePlayer(session, seat) {
  const p = session.state?.[seat];
  if (!p) throw Object.assign(new Error(`Missing duel state for ${seat}`), { status: 500 });
  p.hand = Array.isArray(p.hand) ? p.hand : [];
  p.deck = Array.isArray(p.deck) ? p.deck : [];
  p.field = Array.isArray(p.field) ? p.field.map(entry => normalizeFieldEntry(entry)) : [];
  p.discard = Array.isArray(p.discard) ? p.discard : [];
  p.buffs = p.buffs && typeof p.buffs === 'object' ? p.buffs : {};
  p.counters = p.counters && typeof p.counters === 'object' ? p.counters : {};
  return p;
}

function findMeta(index, entry) { return index.get(entryId(entry)) || null; }
function parseTimes(text) {
  const match = String(text || '').match(/(\d+)\s*[x×]\s*(\d+)/i);
  return match ? Number(match[1]) * Number(match[2]) : null;
}

function markWinner(session, reason = 'hp_zero') {
  const p1 = ensurePlayer(session, 'player1');
  const p2 = ensurePlayer(session, 'player2');
  if (p1.hp > 0 && p2.hp > 0) return false;
  session.status = 'finished';
  session.finishedAt ||= now();
  session.reason = reason;
  session.winner = p1.hp <= 0 && p2.hp <= 0 ? null : (p1.hp <= 0 ? 'player2' : 'player1');
  event(session, 'duel_finished', { winner: session.winner, reason });
  return true;
}

function changeHp(session, targetSeat, delta, { sourceSeat = null, cardId = null } = {}) {
  const target = ensurePlayer(session, targetSeat);
  const n = Number(delta || 0);
  if (!n) return 0;
  if (n > 0 && Number(target.buffs.blockHealTurns || 0) > 0) {
    event(session, 'heal_blocked', { seat: targetSeat, amount: n, cardId });
    return 0;
  }
  const before = Number(target.hp ?? MAX_HP());
  const after = Math.max(0, Math.min(MAX_HP(), before + n));
  target.hp = after;
  const applied = after - before;
  if (applied < 0 && sourceSeat) {
    const src = ensurePlayer(session, sourceSeat);
    src.counters.damageDealt = Number(src.counters.damageDealt || 0) + Math.abs(applied);
  } else if (applied > 0 && sourceSeat) {
    const src = ensurePlayer(session, sourceSeat);
    src.counters.healing = Number(src.counters.healing || 0) + applied;
  }
  event(session, applied < 0 ? 'damage' : 'heal', { seat: targetSeat, amount: Math.abs(applied), sourceSeat, cardId });
  markWinner(session);
  return applied;
}

function drawRaw(session, seat) {
  const p = ensurePlayer(session, seat);
  if (p.hand.length >= MAX_HAND() || p.deck.length === 0) return null;
  const card = p.deck.shift();
  p.hand.push(entryId(card));
  event(session, 'draw', { seat });
  return entryId(card);
}

function drawFor(session, seat) {
  const p = ensurePlayer(session, seat);
  if (p.buffs.skipNextDraw) {
    p.buffs.skipNextDraw = false;
    event(session, 'draw_skipped', { seat });
    return null;
  }
  return drawRaw(session, seat);
}

function drawWhere(session, seat, index, predicate) {
  const p = ensurePlayer(session, seat);
  if (p.hand.length >= MAX_HAND()) return null;
  const idx = p.deck.findIndex(entry => predicate(findMeta(index, entry)));
  if (idx < 0) return drawFor(session, seat);
  const [entry] = p.deck.splice(idx, 1);
  const id = entryId(entry);
  p.hand.push(id);
  event(session, 'draw_specific', { seat, cardId: id });
  return id;
}

function discardRandomFromHand(session, seat, index, predicate = null) {
  const p = ensurePlayer(session, seat);
  const pool = p.hand.map((entry, i) => ({ entry, i, meta: findMeta(index, entry) }))
    .filter(row => predicate ? predicate(row.meta) : true);
  if (!pool.length) return false;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const [entry] = p.hand.splice(pick.i, 1);
  p.discard.push(entryId(entry));
  event(session, 'discard', { seat, cardId: entryId(entry), random: true });
  return true;
}

function stealOneFromHand(session, srcSeat, dstSeat, index, predicate) {
  const src = ensurePlayer(session, srcSeat);
  const dst = ensurePlayer(session, dstSeat);
  if (dst.hand.length >= MAX_HAND()) return false;
  const pool = src.hand.map((entry, i) => ({ entry, i, meta: findMeta(index, entry) })).filter(row => predicate(row.meta));
  if (!pool.length) return false;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const [entry] = src.hand.splice(pick.i, 1);
  dst.hand.push(entryId(entry));
  event(session, 'steal_card', { from: srcSeat, to: dstSeat, cardId: entryId(entry) });
  return true;
}

function discardRandomTrap(session, seat, index) {
  const p = ensurePlayer(session, seat);
  const candidates = p.field.map((entry, i) => ({ entry, i })).filter(row => isTrapMeta(findMeta(index, row.entry)));
  if (!candidates.length) return false;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const [entry] = p.field.splice(pick.i, 1);
  p.discard.push(entryId(entry));
  event(session, 'trap_destroyed', { seat, cardId: entryId(entry) });
  return true;
}

function revealRandomTrap(session, seat, index) {
  const p = ensurePlayer(session, seat);
  const candidates = p.field.filter(entry => isTrapMeta(findMeta(index, entry)) && entry.isFaceDown);
  if (!candidates.length) return false;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  chosen.isFaceDown = false;
  event(session, 'trap_revealed', { seat, cardId: entryId(chosen) });
  return true;
}

function destroyEnemyInfected(session, seat, index) {
  const p = ensurePlayer(session, seat);
  const idx = p.field.findIndex(entry => isType(findMeta(index, entry), 'infected'));
  if (idx < 0) return false;
  const [entry] = p.field.splice(idx, 1);
  p.discard.push(entryId(entry));
  event(session, 'field_destroyed', { seat, cardId: entryId(entry) });
  return true;
}

function moveDiscardToDeckTop(session, seat, index, predicate) {
  const p = ensurePlayer(session, seat);
  const idx = p.discard.findIndex(entry => predicate(findMeta(index, entry)));
  if (idx < 0) return false;
  const [entry] = p.discard.splice(idx, 1);
  p.deck.unshift(entryId(entry));
  event(session, 'recycle', { seat, cardId: entryId(entry) });
  return true;
}

function drawFromDiscard(session, seat, index, predicate) {
  const p = ensurePlayer(session, seat);
  if (p.hand.length >= MAX_HAND()) return false;
  const idx = p.discard.findIndex(entry => predicate(findMeta(index, entry)));
  if (idx < 0) return false;
  const [entry] = p.discard.splice(idx, 1);
  p.hand.push(entryId(entry));
  event(session, 'recover_discard', { seat, cardId: entryId(entry) });
  return true;
}

function consumeAttackBuff(session, seat, meta, baseDamage) {
  const p = ensurePlayer(session, seat);
  let damage = Number(baseDamage || 0);
  const metaTags = tags(meta);
  const restrict = Array.isArray(p.buffs.attackRestrictTags) ? p.buffs.attackRestrictTags : null;
  const allowed = !restrict || restrict.some(tag => metaTags.has(tag));
  if (Number(p.buffs.nextAttackBonus || 0) && allowed) damage += Number(p.buffs.nextAttackBonus || 0);
  if (Number(p.buffs.nextAttackMult || 0) && allowed) damage = Math.round(damage * Number(p.buffs.nextAttackMult));
  p.buffs.nextAttackBonus = 0;
  p.buffs.nextAttackMult = 0;
  p.buffs.attackRestrictTags = null;
  if (Number(p.buffs.gunFlatBonus || 0) && (hasTag(meta, 'gun') || isType(meta, 'attack'))) {
    damage += Number(p.buffs.gunFlatBonus || 0);
    p.buffs.gunFlatBonus = 0;
  }
  return damage;
}

function damageFoe(session, ownerSeat, meta, baseDamage) {
  const foe = otherSeat(ownerSeat);
  const amount = consumeAttackBuff(session, ownerSeat, meta, baseDamage);
  changeHp(session, foe, -amount, { sourceSeat: ownerSeat, cardId: pad3(meta?.card_id) });
  return amount;
}

function hasFieldCard(session, seat, id) {
  return ensurePlayer(session, seat).field.some(entry => entryId(entry) === pad3(id));
}

function isTrapImmune(session, targetSeat, trapMeta) {
  // Combat Gloves (#040): all trap effects.
  if (hasFieldCard(session, targetSeat, '040')) return true;
  // Combat Boots (#034): bear traps and tripwires specifically.
  const id = pad3(trapMeta?.card_id);
  const trapName = txt(trapMeta?.name);
  if (hasFieldCard(session, targetSeat, '034') && (id === '106' || id === '107' || /bear\s*trap|tripwire/.test(trapName) || hasTag(trapMeta, 'beartrap') || hasTag(trapMeta, 'tripwire'))) return true;
  return false;
}

function resolveEffect(session, ownerSeat, meta, index, { triggeredTrap = false, depth = 0 } = {}) {
  if (!meta || session.status === 'finished' || depth > 3) return;
  const foe = otherSeat(ownerSeat);
  const owner = ensurePlayer(session, ownerSeat);
  const target = ensurePlayer(session, foe);
  const type = txt(meta.type);
  const text = `${txt(meta.effect)} ${txt(meta.logic_action)}`;
  const id = pad3(meta.card_id);
  const trapTargetSeat = triggeredTrap ? foe : null;

  // DAMAGE. Avoid double-counting explicit "both players" AOEs.
  const bothPlayers = /to\s+both\s+players/.test(text);
  const dot = text.match(/(\d+)\s*dmg\s+(?:for|over)\s+(\d+)\s*turn/);
  if (bothPlayers) {
    const m = text.match(/deal[s]?\s+(\d+)\s*dmg/);
    const amount = m ? Number(m[1]) : 0;
    if (amount > 0) {
      changeHp(session, ownerSeat, -amount, { sourceSeat: ownerSeat, cardId: id });
      changeHp(session, foe, -amount, { sourceSeat: ownerSeat, cardId: id });
    }
  } else if (dot) {
    const amount = Number(dot[1]);
    const turns = Number(dot[2]);
    changeHp(session, foe, -amount, { sourceSeat: ownerSeat, cardId: id });
    target.buffs.dot = { amount, turns: Math.max(0, turns - 1), sourceSeat: ownerSeat, cardId: id };
  } else {
    const pair = parseTimes(text);
    if (pair) damageFoe(session, ownerSeat, meta, pair);
    else {
      const m = text.match(/deal[s]?\s+(\d+)\s*dmg/);
      if (m) damageFoe(session, ownerSeat, meta, Number(m[1]));
    }
  }

  if (session.status === 'finished') return;

  // HEAL.
  const heal = text.match(/(?:restore|heal)\s+(\d+)\s*hp/);
  if (heal) changeHp(session, ownerSeat, Number(heal[1]), { sourceSeat: ownerSeat, cardId: id });

  // DRAWS.
  const genericDraw = text.match(/draw\s+(a|\d+)\s+card/);
  if (genericDraw && !/draw\s+1\s+(trap|defense|tactical|loot|attack|random\s+loot)\s+card/.test(text)) {
    const count = genericDraw[1] === 'a' ? 1 : Number(genericDraw[1]);
    for (let i = 0; i < count; i++) drawFor(session, ownerSeat);
  }
  if (/draw\s+1\s+trap\s+card/.test(text)) drawWhere(session, ownerSeat, index, m => isTrapMeta(m));
  if (/draw\s+1\s+defense\s+card/.test(text) || hasTag(meta, 'defense_draw')) drawWhere(session, ownerSeat, index, m => isType(m, 'defense'));
  if (/draw\s+1\s+tactical\s+card/.test(text)) drawWhere(session, ownerSeat, index, m => isType(m, 'tactical'));
  if (/draw\s+1\s+(?:random\s+)?loot\s+card/.test(text) && !/from\s+your\s+discard/.test(text)) drawWhere(session, ownerSeat, index, m => isType(m, 'loot'));
  if (/draw\s+1\s+attack\s+card/.test(text)) drawWhere(session, ownerSeat, index, m => isType(m, 'attack'));

  // DISCARD / STEAL. Triggered traps target the attacker for ambiguous "discard 1" wording.
  if (/discard\s+1\s+card(?!\s+after)/.test(text)) discardRandomFromHand(session, triggeredTrap ? foe : ownerSeat, index);
  if (/force\s+opponent\s+to\s+discard\s+1\s+attack\s+card/.test(text)) discardRandomFromHand(session, foe, index, m => isType(m, 'attack'));
  if (/steal\s+1\s+loot\s+card/.test(text)) stealOneFromHand(session, foe, ownerSeat, index, m => isType(m, 'loot'));

  // SKIPS / STUNS.
  if (/skip\s+next\s+draw/.test(text)) (triggeredTrap ? target : owner).buffs.skipNextDraw = true;
  if (/lose\s+next\s+draw|draw\s+phase|draws?\s+1\s+less\s+card/.test(text)) target.buffs.skipNextDraw = true;
  if (/skip\s+your\s+next\s+turn|you\s+skip\s+your\s+next\s+turn/.test(text)) owner.buffs.skipNextTurn = true;
  if (/skip\s+their\s+next\s+turn|opponent\s+skips\s+(?:their\s+)?next\s+turn|cannot\s+play.*next\s+round/.test(text)) target.buffs.skipNextTurn = true;
  if (triggeredTrap && (/skip\s+next\s+turn|\bstun\b|immobilize/.test(text) || hasTag(meta, 'stun') || hasTag(meta, 'immobilize') || hasTag(meta, 'skip'))) target.buffs.skipNextTurn = true;

  const blockHeal = text.match(/block\s+healing\s+for\s+(\d+)\s*turn/);
  if (blockHeal) target.buffs.blockHealTurns = Number(blockHeal[1]);

  // FIELD INTERACTIONS.
  if (/destroy\s+1\s+enemy\s+(?:field\s+)?card|remove\s+1\s+enemy\s+field\s+card/.test(text)) {
    if (target.field.length) {
      const i = /random/.test(text) ? Math.floor(Math.random() * target.field.length) : 0;
      const [destroyed] = target.field.splice(i, 1);
      target.discard.push(entryId(destroyed));
      event(session, 'field_destroyed', { seat: foe, cardId: entryId(destroyed), sourceSeat: ownerSeat });
    }
  }
  if (/(?:destroy|kill|remove)\s+(?:1\s+)?infected/.test(text)) destroyEnemyInfected(session, foe, index);
  if (/(?:disarm|disable|destroy)\s+(?:an?\s+)?trap/.test(text)) discardRandomTrap(session, foe, index);
  if (/(?:reveal|expose)\s+(?:an?\s+)?trap/.test(text)) revealRandomTrap(session, foe, index);
  if (/steal[s]?\s+1\s+defense\s+card/.test(text)) {
    if (!stealOneFromHand(session, foe, ownerSeat, index, m => isType(m, 'defense'))) {
      const idx = target.field.findIndex(entry => isType(findMeta(index, entry), 'defense'));
      if (idx >= 0 && owner.hand.length < MAX_HAND()) {
        const [entry] = target.field.splice(idx, 1);
        owner.hand.push(entryId(entry));
      }
    }
  }

  // NEXT ATTACK BUFFS.
  if (hasTag(meta, 'ammo_buff') || /buff.*next.*gun.*\+?10/.test(text)) owner.buffs.gunFlatBonus = 10;
  if (/double\s+the\s+damage\s+of\s+your\s+next\s+(sniper|scoped_pistol|hunting_rifle|silenced_rifle)/.test(text)) {
    owner.buffs.nextAttackMult = 2;
    owner.buffs.attackRestrictTags = ['sniper', 'scoped_pistol', 'hunting_rifle', 'silenced_rifle'];
  } else if (/next\s+attack.*double\s+damage/.test(text)) {
    owner.buffs.nextAttackMult = 2;
    owner.buffs.attackRestrictTags = null;
  }

  // SPECIAL LOOT EFFECTS.
  if (/select\s+1\s+loot\s+card.*destroy.*heal\s+15/.test(text)) {
    const idx = owner.hand.findIndex(entry => isType(findMeta(index, entry), 'loot'));
    if (idx >= 0) {
      const [entry] = owner.hand.splice(idx, 1);
      owner.discard.push(entryId(entry));
      changeHp(session, ownerSeat, 15, { sourceSeat: ownerSeat, cardId: id });
    }
  }
  if (/return.*gun.*discard.*draw\s+pile|refresh.*weapon.*discard/.test(text)) moveDiscardToDeckTop(session, ownerSeat, index, m => hasTag(m, 'gun') || isType(m, 'attack'));
  if (/recharge.*tactical.*discard/.test(text)) moveDiscardToDeckTop(session, ownerSeat, index, m => isType(m, 'tactical'));
  if (/draw\s+1\s+random\s+loot\s+card\s+from\s+your\s+discard/.test(text)) drawFromDiscard(session, ownerSeat, index, m => isType(m, 'loot'));

  // INFECTED-SPECIFIC migration.
  if (type === 'infected') {
    if (/drain|siphon/.test(text) || /you\s+lose\s+(\d+)\s*hp.*enemy\s+gains\s+(\d+)/.test(text)) {
      changeHp(session, ownerSeat, -10, { sourceSeat: ownerSeat, cardId: id });
      changeHp(session, foe, 5, { sourceSeat: foe, cardId: id });
    }
    if (/spawn.*another.*infected|backup/.test(text)) {
      const sources = [owner.hand, owner.deck, owner.discard];
      for (const source of sources) {
        const idx = source.findIndex(entry => isType(findMeta(index, entry), 'infected'));
        if (idx < 0) continue;
        const [spawned] = source.splice(idx, 1);
        const spawnedMeta = findMeta(index, spawned);
        event(session, 'infected_spawn', { seat: ownerSeat, cardId: entryId(spawned) });
        resolveEffect(session, ownerSeat, spawnedMeta, index, { depth: depth + 1 });
        break;
      }
    }
    if (/destroy.*(?:gear|armor).*card/.test(text)) {
      const idx = target.field.findIndex(entry => isType(findMeta(index, entry), 'defense'));
      if (idx >= 0) {
        const [entry] = target.field.splice(idx, 1);
        target.discard.push(entryId(entry));
      }
    }
  }

  event(session, 'effect_resolved', { seat: ownerSeat, cardId: id, triggeredTrap });
}

function triggerOneTrap(session, trapOwnerSeat, index) {
  const owner = ensurePlayer(session, trapOwnerSeat);
  const attackerSeat = otherSeat(trapOwnerSeat);
  const trap = owner.field.find(entry => entry.isFaceDown && !entry._fired && isTrapMeta(findMeta(index, entry)));
  if (!trap) return false;
  trap.isFaceDown = false;
  trap._fired = true;
  const meta = findMeta(index, trap);
  owner.counters.traps = Number(owner.counters.traps || 0) + 1;
  event(session, 'trap_triggered', { seat: trapOwnerSeat, targetSeat: attackerSeat, cardId: entryId(trap) });
  if (isTrapImmune(session, attackerSeat, meta)) {
    event(session, 'trap_immune', { seat: attackerSeat, sourceSeat: trapOwnerSeat, cardId: entryId(trap) });
    return true;
  }
  resolveEffect(session, trapOwnerSeat, meta, index, { triggeredTrap: true });
  return true;
}

function cleanupField(session, seat, index) {
  const p = ensurePlayer(session, seat);
  const keep = [];
  const toss = [];
  for (const entry of p.field) {
    const meta = findMeta(index, entry);
    if (isTrapMeta(meta)) (entry._fired ? toss : keep).push(entry);
    else (persistent(meta) ? keep : toss).push(entry);
  }
  if (toss.length) {
    p.discard.push(...toss.map(entryId));
    event(session, 'field_cleanup', { seat, cards: toss.map(entryId) });
  }
  p.field = keep;
}

function applyStartOfTurnBuffs(session, seat, index) {
  const p = ensurePlayer(session, seat);
  if (hasFieldCard(session, seat, '054')) drawRaw(session, seat);
  if (hasFieldCard(session, seat, '056')) drawWhere(session, seat, index, meta => isType(meta, 'loot'));

  const dot = p.buffs.dot;
  if (dot && Number(dot.turns || 0) > 0 && session.status === 'live') {
    changeHp(session, seat, -Number(dot.amount || 0), { sourceSeat: dot.sourceSeat || otherSeat(seat), cardId: dot.cardId || null });
    dot.turns = Number(dot.turns || 0) - 1;
    if (dot.turns <= 0) delete p.buffs.dot;
  }
  if (Number(p.buffs.blockHealTurns || 0) > 0) p.buffs.blockHealTurns = Number(p.buffs.blockHealTurns) - 1;
}

function effectText(meta) {
  return `${txt(meta?.effect)} ${txt(meta?.logic_action)}`;
}

function canDirectlyPressureHp(meta) {
  if (!meta) return false;
  // Traps are reactive in the current authoritative engine. They do not create
  // pressure by themselves when neither side can make an attack/infected play.
  if (isTrapMeta(meta)) return false;
  if (isType(meta, 'attack') || isType(meta, 'infected')) return true;
  const text = effectText(meta);
  if (/deal[s]?\s+\d+\s*dmg/.test(text)) return true;
  if (/\d+\s*dmg\s+(?:for|over)\s+\d+\s*turn/.test(text)) return true;
  if (/\b(?:drain|siphon)\b/.test(text)) return true;
  if (/you\s+lose\s+\d+\s*hp.*enemy\s+gains\s+\d+/.test(text)) return true;
  return false;
}

function canRecoverPressure(session, seat, index) {
  const p = ensurePlayer(session, seat);
  if (!p.discard.length || !p.hand.length) return false;

  for (const handEntry of p.hand) {
    const meta = findMeta(index, handEntry);
    if (!meta) continue;
    const text = effectText(meta);

    if (/return.*gun.*discard.*draw\s+pile|refresh.*weapon.*discard/.test(text)) {
      if (p.discard.some(entry => {
        const discarded = findMeta(index, entry);
        return discarded && (hasTag(discarded, 'gun') || isType(discarded, 'attack')) && canDirectlyPressureHp(discarded);
      })) return true;
    }

    if (/recharge.*tactical.*discard/.test(text)) {
      if (p.discard.some(entry => {
        const discarded = findMeta(index, entry);
        return discarded && isType(discarded, 'tactical') && canDirectlyPressureHp(discarded);
      })) return true;
    }
  }
  return false;
}

function hasPendingDamage(session, seat) {
  const p = ensurePlayer(session, seat);
  return Number(p.buffs?.dot?.turns || 0) > 0 && Number(p.buffs?.dot?.amount || 0) > 0;
}

function hasCombatPressure(session, seat, index) {
  const p = ensurePlayer(session, seat);
  if (hasPendingDamage(session, seat)) return true;
  if (p.hand.some(entry => canDirectlyPressureHp(findMeta(index, entry)))) return true;
  if (canRecoverPressure(session, seat, index)) return true;
  return false;
}

function finishByHpComparison(session, reason) {
  if (session.status !== 'live') return false;
  const p1 = ensurePlayer(session, 'player1');
  const p2 = ensurePlayer(session, 'player2');
  const hp1 = Number(p1.hp || 0);
  const hp2 = Number(p2.hp || 0);
  session.status = 'finished';
  session.finishedAt ||= now();
  session.reason = reason;
  session.winner = hp1 === hp2 ? null : (hp1 > hp2 ? 'player1' : 'player2');
  event(session, 'duel_finished', { winner: session.winner, reason, finalHp: { player1: hp1, player2: hp2 } });
  return true;
}

/**
 * End a duel that can no longer make meaningful combat progress.
 *
 * We deliberately do NOT reshuffle discards. Once both draw piles are empty,
 * the duel ends by remaining HP when neither player has an offensive card in
 * hand (or a currently-implemented way to recover one from discard). Armed
 * traps by themselves do not keep the duel alive because this engine only
 * triggers them from attack/infected plays.
 */
export function resolveCombatExhaustion(session) {
  if (!session || session.status !== 'live' || !session.state) return false;
  const index = requireMaster();
  const p1 = ensurePlayer(session, 'player1');
  const p2 = ensurePlayer(session, 'player2');

  if (p1.deck.length > 0 || p2.deck.length > 0) return false;
  if (hasCombatPressure(session, 'player1', index) || hasCombatPressure(session, 'player2', index)) return false;

  const completelyEmpty = p1.hand.length === 0 && p2.hand.length === 0;
  return finishByHpComparison(session, completelyEmpty ? 'cards_exhausted' : 'combat_exhaustion');
}

export async function redactConcealedField(field) {
  const index = await getMasterIndex();
  return (Array.isArray(field) ? field : []).map(raw => {
    const entry = normalizeFieldEntry(raw);
    const meta = findMeta(index, entry);
    const concealed = isTrapMeta(meta) && entry.isFaceDown && !entry._fired;
    return concealed ? { cardId: '000', isFaceDown: true, concealed: true } : entry;
  });
}

function startMarker(session, seat) { return `${Number(session.state.turn || 0)}:${seat}`; }
export function startTurn(session, seat) {
  const index = requireMaster();
  const p = ensurePlayer(session, seat);
  const marker = startMarker(session, seat);
  if (session.state.turnStarted === marker) return false;

  // If neither side can create further combat pressure, settle the match by HP
  // instead of letting harmless cards / armed traps bounce turns forever.
  if (resolveCombatExhaustion(session)) {
    session.state.turnStarted = marker;
    return true;
  }

  // A single player who is completely out of cards still loses if the opponent
  // retains real combat pressure. If both sides are exhausted, the HP tiebreak
  // above wins instead of arbitrarily punishing whoever happened to be active.
  if (p.hand.length === 0 && p.deck.length === 0) {
    session.status = 'finished'; session.finishedAt = now(); session.winner = otherSeat(seat); session.reason = 'no_cards';
    event(session, 'duel_finished', { winner: session.winner, reason: session.reason });
    session.state.turnStarted = marker;
    return true;
  }

  drawFor(session, seat);
  applyStartOfTurnBuffs(session, seat, index);
  session.state.turnStarted = marker;
  event(session, 'turn_started', { seat, turn: Number(session.state.turn || 0) });
  return true;
}

export function playCardEffect(session, seat, rawCardId) {
  const index = requireMaster();
  const p = ensurePlayer(session, seat);
  const id = pad3(rawCardId);
  const handIndex = p.hand.findIndex(entry => entryId(entry) === id);
  if (handIndex < 0) throw Object.assign(new Error('Card is not in your hand'), { status: 400 });
  if (p.field.length >= FIELD_LIMIT()) throw Object.assign(new Error('Your field is full'), { status: 409 });
  const meta = index.get(id);
  if (!meta) throw Object.assign(new Error(`Unknown card ${id}`), { status: 400 });

  p.hand.splice(handIndex, 1);
  const trap = isTrapMeta(meta);
  p.field.push({ cardId: id, isFaceDown: trap, _fired: false });
  p.counters.cardsPlayed = Number(p.counters.cardsPlayed || 0) + 1;
  event(session, 'play_card', { seat, cardId: id, faceDown: trap });

  if (!trap) {
    resolveEffect(session, seat, meta, index);
    if (session.status === 'live' && (isType(meta, 'attack') || isType(meta, 'infected'))) triggerOneTrap(session, otherSeat(seat), index);
  }
  markWinner(session);
  return id;
}

export function drawCardAction(session, seat) {
  return drawFor(session, seat);
}

export function discardHandCard(session, seat, rawCardId) {
  const p = ensurePlayer(session, seat);
  const id = pad3(rawCardId);
  const idx = p.hand.findIndex(entry => entryId(entry) === id);
  if (idx < 0) throw Object.assign(new Error('Card is not in your hand'), { status: 400 });
  const [entry] = p.hand.splice(idx, 1);
  p.discard.push(entryId(entry));
  event(session, 'discard', { seat, cardId: id });
}

export function removeFieldCard(session, seat, rawCardId) {
  const p = ensurePlayer(session, seat);
  const id = pad3(rawCardId);
  const idx = p.field.findIndex(entry => entryId(entry) === id);
  if (idx < 0) throw Object.assign(new Error('Card is not on your field'), { status: 400 });
  const [entry] = p.field.splice(idx, 1);
  p.discard.push(entryId(entry));
  event(session, 'field_removed', { seat, cardId: id });
}

export function endTurnAndAdvance(session, endingSeat) {
  const index = requireMaster();
  cleanupField(session, endingSeat, index);
  if (session.status === 'finished') return;

  // Run exhaustion after ephemeral cards have moved to discard so the terminal
  // board is visually clean and the summary reflects the real end-of-turn state.
  if (resolveCombatExhaustion(session)) return;

  let next = otherSeat(endingSeat);
  session.state.turn = Number(session.state.turn || 0) + 1;
  session.state.currentPlayer = next;
  delete session.state.turnStarted;
  event(session, 'end_turn', { seat: endingSeat, next, turn: session.state.turn });

  const nextPlayer = ensurePlayer(session, next);
  if (nextPlayer.buffs.skipNextTurn) {
    nextPlayer.buffs.skipNextTurn = false;
    event(session, 'turn_skipped', { seat: next });
    next = otherSeat(next);
    session.state.turn = Number(session.state.turn || 0) + 1;
    session.state.currentPlayer = next;
    delete session.state.turnStarted;
  }
  startTurn(session, next);
}

export function runBotTurn(session, botSeat) {
  const index = requireMaster();
  startTurn(session, botSeat);
  if (session.status === 'finished') return;
  const p = ensurePlayer(session, botSeat);

  // A practice bot can otherwise deadlock itself by filling all three persistent
  // slots with Defense/traps while its hand/deck still contains cards. Humans can
  // manually clear their field; give the bot the same escape hatch.
  if (p.field.length >= FIELD_LIMIT() && p.hand.some(id => index.has(entryId(id)))) {
    const firedIndex = p.field.findIndex(entry => Boolean(entry?._fired));
    const removeIndex = firedIndex >= 0 ? firedIndex : 0;
    const removedId = entryId(p.field[removeIndex]);
    removeFieldCard(session, botSeat, removedId);
    event(session, 'bot_field_cleared', { seat: botSeat, cardId: removedId });
  }

  // Original practice behavior: play one available card, then pass the turn.
  // Prefer a non-trap so a bot turn visibly resolves; traps are still legal fallback plays.
  const eligible = p.hand.filter(id => p.field.length < FIELD_LIMIT() && index.has(entryId(id)));
  const pick = eligible.find(id => !isTrapMeta(findMeta(index, id))) || eligible[0] || null;
  if (pick) playCardEffect(session, botSeat, entryId(pick));
  if (session.status === 'live') endTurnAndAdvance(session, botSeat);
}

export function turnAlreadyStarted(session, seat) {
  return session?.state?.turnStarted === startMarker(session, seat);
}
