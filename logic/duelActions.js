import { getSpectatorCount } from './chatRegistry.js';
import { finishSession, getSession, mutateSession, resolveSeat, serializePlayer } from './duelSessions.js';
import {
  discardHandCard,
  drawCardAction,
  endTurnAndAdvance,
  normalizeFieldEntry,
  playCardEffect,
  prepareDuelEffects,
  removeFieldCard,
  runBotTurn,
  startTurn,
  turnAlreadyStarted,
} from './duelEffects.js';

const event = (type, extra = {}) => ({ at: new Date().toISOString(), type, ...extra });
const otherSeat = seat => seat === 'player1' ? 'player2' : 'player1';

function ensureLive(session, seat) {
  if (!session || session.status !== 'live' || !session.state) throw Object.assign(new Error('Session is not live'), { status: 409 });
  if (!seat) throw Object.assign(new Error('Invalid player token'), { status: 401 });
}

function currentSeatFor(session, token) {
  const seat = resolveSeat(session, token);
  ensureLive(session, seat);
  return seat;
}

async function finalizedViewIfNeeded(session, token) {
  if (session.status !== 'finished') return { session, view: serializePlayer(session, token, getSpectatorCount(session.id)) };
  const final = await finishSession(session.id, { winnerSeat: session.winner ?? null, reason: session.reason || 'completed' });
  return { session: final, view: serializePlayer(final, token, getSpectatorCount(final.id)) };
}

export async function applyAction(sessionId, token, action, parameters = {}) {
  await prepareDuelEffects();
  const before = await getSession(sessionId);
  const seat = currentSeatFor(before, token);
  const name = String(action || '').toLowerCase();

  if (name === 'forfeit' || name === 'concede') {
    const finished = await finishSession(sessionId, { winnerSeat: otherSeat(seat), reason: 'forfeit' });
    return { session: finished, view: serializePlayer(finished, token, getSpectatorCount(finished.id)) };
  }

  // Idempotent opening/reconnect helper. The original Duel UI auto-draws once at
  // the start of a turn; a reconnect must never draw a second copy.
  if (name === 'start_turn' && turnAlreadyStarted(before, seat)) {
    if (before.state.currentPlayer !== seat) throw Object.assign(new Error('It is not your turn'), { status: 409 });
    return { session: before, view: serializePlayer(before, token, getSpectatorCount(before.id)) };
  }

  const updated = await mutateSession(sessionId, session => {
    const currentSeat = currentSeatFor(session, token);
    if (session.state.currentPlayer !== currentSeat) throw Object.assign(new Error('It is not your turn'), { status: 409 });

    if (name === 'start_turn') {
      startTurn(session, currentSeat);
    } else if (name === 'draw') {
      // Kept as a compatibility/debug action. Production Duel-UI hides Draw and
      // relies on start_turn/end_turn auto-draw semantics.
      drawCardAction(session, currentSeat);
    } else if (name === 'play_card') {
      const id = String(parameters.cardId ?? parameters.id ?? '');
      playCardEffect(session, currentSeat, id);
    } else if (name === 'discard') {
      const id = String(parameters.cardId ?? parameters.id ?? '');
      discardHandCard(session, currentSeat, id);
    } else if (name === 'remove_field_card') {
      const id = String(parameters.cardId ?? parameters.id ?? '');
      removeFieldCard(session, currentSeat, id);
    } else if (name === 'end_turn') {
      endTurnAndAdvance(session, currentSeat);
    } else {
      throw Object.assign(new Error(`Unsupported action: ${name}`), { status: 400 });
    }
    return session;
  });

  return finalizedViewIfNeeded(updated, token);
}

// Temporary migration bridge for old internal callers. Browser clients never use
// this route. Identity/session fields remain immutable and the endpoint itself is
// protected by BOT_API_KEY in routes/duel.js.
export async function applyTrustedSnapshot(sessionId, snapshot) {
  const updated = await mutateSession(sessionId, session => {
    if (session.status !== 'live') throw Object.assign(new Error('Session is not live'), { status: 409 });
    const src = snapshot?.state || snapshot;
    for (const seat of ['player1', 'player2']) {
      if (!src?.[seat]) continue;
      const target = session.state[seat];
      if (Number.isFinite(Number(src[seat].hp))) target.hp = Math.max(0, Number(src[seat].hp));
      for (const field of ['hand', 'deck', 'discard']) {
        if (Array.isArray(src[seat][field])) target[field] = [...src[seat][field]].map(value => String(value?.cardId ?? value?.id ?? value));
      }
      if (Array.isArray(src[seat].field)) target.field = src[seat].field.map(value => normalizeFieldEntry(value));
    }
    if (['player1', 'player2'].includes(src?.currentPlayer)) session.state.currentPlayer = src.currentPlayer;
    if (Number.isFinite(Number(src?.turn))) session.state.turn = Number(src.turn);
    session.state.events ||= [];
    session.state.events.push(event('trusted_snapshot'));
    if (session.state.player1.hp <= 0 || session.state.player2.hp <= 0) {
      session.status = 'finished';
      session.finishedAt = new Date().toISOString();
      session.winner = session.state.player1.hp <= 0 && session.state.player2.hp <= 0
        ? null
        : (session.state.player1.hp <= 0 ? 'player2' : 'player1');
      session.reason = 'hp_zero';
    }
    return session;
  });

  if (updated.status === 'finished' && !updated.finalized) {
    return finishSession(sessionId, { winnerSeat: updated.winner ?? null, reason: updated.reason || 'hp_zero' });
  }
  return updated;
}

export async function applyBotTurn(sessionId, humanToken) {
  await prepareDuelEffects();
  const before = await getSession(sessionId);
  const humanSeat = currentSeatFor(before, humanToken);
  if (before.mode !== 'practice') throw Object.assign(new Error('Bot turns only exist in practice'), { status: 400 });
  const botSeat = before.player1.controller === 'bot' ? 'player1' : 'player2';
  if (before.state.currentPlayer !== botSeat) throw Object.assign(new Error('It is not the bot turn'), { status: 409 });

  const updated = await mutateSession(sessionId, session => {
    if (session.mode !== 'practice') throw Object.assign(new Error('Bot turns only exist in practice'), { status: 400 });
    const liveHumanSeat = resolveSeat(session, humanToken);
    ensureLive(session, liveHumanSeat);
    const liveBotSeat = session.player1.controller === 'bot' ? 'player1' : 'player2';
    if (session.state.currentPlayer !== liveBotSeat) throw Object.assign(new Error('It is not the bot turn'), { status: 409 });
    runBotTurn(session, liveBotSeat);
    return session;
  });

  const result = await finalizedViewIfNeeded(updated, humanToken);
  return result.session;
}
