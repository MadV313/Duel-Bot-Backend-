import crypto from 'crypto';
import { PATHS, loadJSON, saveJSON, updateJSONAtomic } from '../utils/storageClient.js';
import { config } from '../utils/config.js';
import { expandDeck, getPlayerProfileByUserId, loadMaster, validateSavedDeckForUser } from '../utils/deckUtils.js';

const SESSION_RE = /^[A-Za-z0-9_-]{12,128}$/;
const sha = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const now = () => new Date().toISOString();
const randomId = () => crypto.randomBytes(18).toString('base64url');
const shuffle = input => { const a = [...input]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function safeSessionId(id) {
  if (!SESSION_RE.test(String(id || ''))) throw Object.assign(new Error('Invalid session ID'), { status: 400 });
  return String(id);
}

async function randomDeck() {
  const master = (await loadMaster()).filter(card => card.card_id !== '000');
  return shuffle(master.map(card => card.card_id)).slice(0, config.duel.deck_min);
}

async function deckForUser(userId, mode) {
  if (mode === 'saved') {
    const result = await validateSavedDeckForUser(userId);
    if (!result.ok) throw Object.assign(new Error(result.errors.join(' ')), { status: 400 });
    return { name: result.deck.name, cards: shuffle(expandDeck(result.deck)) };
  }
  return { name: 'Random Deck', cards: await randomDeck() };
}

function openingState(player1Deck, player2Deck) {
  const p1Deck = [...player1Deck.cards], p2Deck = [...player2Deck.cards];
  const p1Hand = p1Deck.splice(0, config.duel.opening_hand);
  const p2Hand = p2Deck.splice(0, config.duel.opening_hand);
  const currentPlayer = Math.random() < 0.5 ? 'player1' : 'player2';
  return {
    turn: 1,
    currentPlayer,
    player1: { hp: config.duel.starting_hp, hand: p1Hand, deck: p1Deck, field: [], discard: [], deckName: player1Deck.name, counters: {} },
    player2: { hp: config.duel.starting_hp, hand: p2Hand, deck: p2Deck, field: [], discard: [], deckName: player2Deck.name, counters: {} },
    events: [{ at: now(), type: 'coin_flip', currentPlayer }],
  };
}

function playerRecord({ userId, displayName, token, controller = 'human' }) {
  return { userId: String(userId), displayName: String(displayName || userId), tokenHash: sha(token), controller };
}

async function addToIndex(session) {
  await updateJSONAtomic(PATHS.duelSessionIndex, index => {
    index[session.id] = {
      id: session.id, mode: session.mode, status: session.status, revision: session.revision,
      createdAt: session.createdAt, updatedAt: session.updatedAt, finishedAt: session.finishedAt || null,
      players: [
        { userId: session.player1.userId, displayName: session.player1.displayName, controller: session.player1.controller },
        { userId: session.player2.userId, displayName: session.player2.displayName, controller: session.player2.controller },
      ],
    };
    return index;
  }, { defaultValue: {} });
}

async function refreshIndex(session) { await addToIndex(session); }

export async function getSession(sessionId) {
  const id = safeSessionId(sessionId);
  try { return await loadJSON(PATHS.duelSessionFor(id)); }
  catch (e) { if (e?.status === 404) return null; throw e; }
}

export async function listSessions({ activeOnly = true } = {}) {
  const index = await loadJSON(PATHS.duelSessionIndex).catch(() => ({}));
  const terminal = new Set(['finished', 'denied', 'expired', 'cancelled', 'forfeited', 'abandoned']);
  return Object.values(index || {}).filter(row => !activeOnly || !terminal.has(row.status)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function createPracticeSession({ userId, token, displayName, deckMode = 'random' }) {
  if (!token) throw Object.assign(new Error('Player token required'), { status: 400 });
  const profile = await getPlayerProfileByUserId(userId);
  if (!profile || String(profile.token || '') !== String(token)) throw Object.assign(new Error('Invalid player token'), { status: 401 });
  const p1Deck = await deckForUser(userId, deckMode === 'saved' ? 'saved' : 'random');
  const botDeck = { name: 'Practice Bot', cards: await randomDeck() };
  const id = randomId(), createdAt = now();
  const session = {
    version: 1, id, mode: 'practice', status: 'live', revision: 1, createdAt, updatedAt: createdAt, finishedAt: null,
    player1: playerRecord({ userId, displayName: displayName || profile.discordName, token, controller: 'human' }),
    player2: { userId: `bot:${id}`, displayName: 'Practice Bot', tokenHash: '', controller: 'bot' },
    state: openingState(p1Deck, botDeck), winner: null, reason: null, finalized: false,
  };
  await saveJSON(PATHS.duelSessionFor(id), session);
  await addToIndex(session);
  return session;
}

export async function createChallengeSession({ challengerId, challengerToken, challengerName, opponentId, opponentToken, opponentName }) {
  if (String(challengerId) === String(opponentId)) throw Object.assign(new Error('Cannot challenge yourself'), { status: 400 });
  const [p1, p2, d1, d2] = await Promise.all([
    getPlayerProfileByUserId(challengerId), getPlayerProfileByUserId(opponentId),
    validateSavedDeckForUser(challengerId), validateSavedDeckForUser(opponentId),
  ]);
  if (!p1 || String(p1.token || '') !== String(challengerToken) || !p2 || String(p2.token || '') !== String(opponentToken)) throw Object.assign(new Error('Invalid player identity'), { status: 401 });
  if (!d1.ok || !d2.ok) throw Object.assign(new Error(`Both players need valid saved decks. ${[...d1.errors, ...d2.errors].join(' ')}`), { status: 400 });
  const id = randomId(), createdAt = now();
  const session = {
    version: 1, id, mode: 'pvp', status: 'pending', revision: 1, createdAt, updatedAt: createdAt, finishedAt: null,
    player1: playerRecord({ userId: challengerId, displayName: challengerName || p1.discordName, token: challengerToken }),
    player2: playerRecord({ userId: opponentId, displayName: opponentName || p2.discordName, token: opponentToken }),
    pendingDecks: { player1: { name: d1.deck.name, cards: expandDeck(d1.deck) }, player2: { name: d2.deck.name, cards: expandDeck(d2.deck) } },
    state: null, winner: null, reason: null, finalized: false,
  };
  await saveJSON(PATHS.duelSessionFor(id), session);
  await addToIndex(session);
  return session;
}

export function resolveSeat(session, token) {
  const h = sha(token);
  for (const seat of ['player1', 'player2']) {
    const stored = String(session?.[seat]?.tokenHash || '');
    if (stored.length === h.length && stored && crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(h))) return seat;
  }
  return null;
}

export async function decideChallenge(sessionId, token, decision) {
  const current = await getSession(sessionId);
  if (!current) throw Object.assign(new Error('Session not found'), { status: 404 });
  if (current.mode !== 'pvp' || current.status !== 'pending') throw Object.assign(new Error('Challenge is not pending'), { status: 409 });
  if (resolveSeat(current, token) !== 'player2') throw Object.assign(new Error('Only the challenged player may decide'), { status: 403 });
  const d = String(decision || '').toLowerCase();
  if (!['accept', 'deny'].includes(d)) throw Object.assign(new Error('Decision must be accept or deny'), { status: 400 });

  let freshDecks = null;
  if (d === 'accept') {
    const [d1, d2] = await Promise.all([
      validateSavedDeckForUser(current.player1.userId),
      validateSavedDeckForUser(current.player2.userId),
    ]);
    if (!d1.ok || !d2.ok) throw Object.assign(new Error(`Both players still need valid saved decks. ${[...d1.errors, ...d2.errors].join(' ')}`), { status: 409 });
    freshDecks = {
      player1: { name: d1.deck.name, cards: shuffle(expandDeck(d1.deck)) },
      player2: { name: d2.deck.name, cards: shuffle(expandDeck(d2.deck)) },
    };
  }

  return mutateSession(sessionId, session => {
    if (session.mode !== 'pvp' || session.status !== 'pending') throw Object.assign(new Error('Challenge is no longer pending'), { status: 409 });
    if (resolveSeat(session, token) !== 'player2') throw Object.assign(new Error('Only the challenged player may decide'), { status: 403 });
    if (d === 'deny') {
      session.status = 'denied'; session.finishedAt = now(); session.reason = 'denied'; delete session.pendingDecks; return session;
    }
    session.state = openingState(freshDecks.player1, freshDecks.player2);
    delete session.pendingDecks;
    session.status = 'live';
    return session;
  });
}

export async function expireChallenge(sessionId) {
  return mutateSession(sessionId, session => {
    if (session.mode === 'pvp' && session.status === 'pending') {
      session.status = 'expired'; session.finishedAt = now(); session.reason = 'challenge_timeout'; delete session.pendingDecks;
    }
    return session;
  });
}

export async function mutateSession(sessionId, mutator) {
  const id = safeSessionId(sessionId);
  const next = await updateJSONAtomic(PATHS.duelSessionFor(id), session => {
    if (!session?.id) throw Object.assign(new Error('Session not found'), { status: 404 });
    const result = mutator(session) || session;
    result.revision = Number(result.revision || 0) + 1;
    result.updatedAt = now();
    return result;
  });
  await refreshIndex(next);
  return next;
}

function publicPlayer(session, seat) {
  const player = session[seat] || {}, state = session.state?.[seat] || {};
  return {
    displayName: player.displayName || seat,
    controller: player.controller || 'human',
    hp: Number(state.hp ?? config.duel.starting_hp),
    field: Array.isArray(state.field) ? state.field : [],
    discard: Array.isArray(state.discard) ? state.discard : [],
    handCount: Array.isArray(state.hand) ? state.hand.length : 0,
    deckCount: Array.isArray(state.deck) ? state.deck.length : 0,
    deckName: state.deckName || '',
  };
}

export function serializeSpectator(session, spectatorCount = 0) {
  return {
    version: session.version || 1,
    id: session.id, mode: session.mode, status: session.status, revision: session.revision,
    createdAt: session.createdAt, updatedAt: session.updatedAt, finishedAt: session.finishedAt,
    currentPlayer: session.state?.currentPlayer || null,
    turn: Number(session.state?.turn || 0),
    winner: session.winner, reason: session.reason,
    player1: publicPlayer(session, 'player1'), player2: publicPlayer(session, 'player2'),
    spectatorCount: Number(spectatorCount || 0),
  };
}

export function serializePlayer(session, token, spectatorCount = 0) {
  const seat = resolveSeat(session, token);
  if (!seat) return null;
  const base = serializeSpectator(session, spectatorCount);
  const own = session.state?.[seat] || {};
  return { ...base, seat, localPlayer: seat, hand: Array.isArray(own.hand) ? own.hand : [] };
}

export async function finishSession(sessionId, { winnerSeat, reason = 'completed' } = {}) {
  const session = await mutateSession(sessionId, s => {
    if (s.status === 'finished') return s;
    if (!['player1', 'player2', null].includes(winnerSeat ?? null)) throw Object.assign(new Error('Invalid winner'), { status: 400 });
    s.status = 'finished'; s.winner = winnerSeat || null; s.reason = reason; s.finishedAt = now();
    return s;
  });
  await finalizeSession(session.id);
  return await getSession(session.id);
}

function summaryFromSession(session) {
  const started = new Date(session.createdAt).getTime(), finished = new Date(session.finishedAt || session.updatedAt).getTime();
  const info = seat => {
    const p = session[seat], st = session.state?.[seat] || {};
    return { displayName: p?.displayName || seat, finalHp: Number(st.hp ?? 0), deckName: st.deckName || '', cardsPlayed: Number(st.counters?.cardsPlayed || 0), damageDealt: Number(st.counters?.damageDealt || 0), healing: Number(st.counters?.healing || 0), traps: Number(st.counters?.traps || 0) };
  };
  return {
    version: 1, duelId: session.id, sessionId: session.id, mode: session.mode, winner: session.winner, reason: session.reason,
    startedAt: session.createdAt, finishedAt: session.finishedAt, duration: Math.max(0, finished - started), turnCount: Number(session.state?.turn || 0),
    players: { player1: info('player1'), player2: info('player2') }, events: Array.isArray(session.state?.events) ? session.state.events : [], wager: session.wager || null,
  };
}

export async function finalizeSession(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw Object.assign(new Error('Session not found'), { status: 404 });
  if (session.status !== 'finished') throw Object.assign(new Error('Session is not finished'), { status: 409 });
  const summary = summaryFromSession(session);
  await saveJSON(PATHS.summaryFor(session.id), summary);

  if (session.mode === 'pvp' && session.winner) {
    await updateJSONAtomic(PATHS.playerData, data => {
      data.__finalizedDuels ||= {};
      if (data.__finalizedDuels[session.id]) return data;
      const loserSeat = session.winner === 'player1' ? 'player2' : 'player1';
      const winId = session[session.winner]?.userId, loseId = session[loserSeat]?.userId;
      if (winId && !String(winId).startsWith('bot:')) { data[winId] ||= {}; data[winId].wins = Number(data[winId].wins || 0) + 1; }
      if (loseId && !String(loseId).startsWith('bot:')) { data[loseId] ||= {}; data[loseId].losses = Number(data[loseId].losses || 0) + 1; }
      data.__finalizedDuels[session.id] = { at: now(), winner: session.winner };
      return data;
    }, { defaultValue: {} });
  }

  const final = await mutateSession(session.id, s => { s.finalized = true; s.summaryId = s.id; return s; });
  return { session: final, summary };
}

export async function abandonSessionsForUser(userId) {
  const rows = await listSessions({ activeOnly: true });
  let count = 0;
  for (const row of rows) {
    if (!(row.players || []).some(p => String(p.userId) === String(userId))) continue;
    await mutateSession(row.id, s => { s.status = 'abandoned'; s.reason = 'player_unlinked'; s.finishedAt = now(); return s; }).catch(() => {});
    count++;
  }
  return count;
}
