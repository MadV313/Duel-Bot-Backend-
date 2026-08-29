import { config } from '../utils/config.js';
import { finishSession, getSession, mutateSession, resolveSeat, serializePlayer } from './duelSessions.js';

const event = (type, extra = {}) => ({ at: new Date().toISOString(), type, ...extra });
const otherSeat = seat => seat === 'player1' ? 'player2' : 'player1';

function ensureLive(session, seat) {
  if (!session || session.status !== 'live' || !session.state) throw Object.assign(new Error('Session is not live'), { status: 409 });
  if (!seat) throw Object.assign(new Error('Invalid player token'), { status: 401 });
}

export async function applyAction(sessionId, token, action, parameters = {}) {
  const before = await getSession(sessionId);
  const seat = resolveSeat(before, token);
  ensureLive(before, seat);
  const name = String(action || '').toLowerCase();
  if (name === 'forfeit' || name === 'concede') {
    const finished = await finishSession(sessionId, { winnerSeat: otherSeat(seat), reason: 'forfeit' });
    return { session: finished, view: serializePlayer(finished, token) };
  }

  const updated = await mutateSession(sessionId, session => {
    const currentSeat = resolveSeat(session, token);
    ensureLive(session, currentSeat);
    if (session.state.currentPlayer !== currentSeat) throw Object.assign(new Error('It is not your turn'), { status: 409 });
    const own = session.state[currentSeat];
    own.counters ||= {};

    if (name === 'draw') {
      if (own.hand.length >= config.duel.hand_limit) throw Object.assign(new Error('Hand limit reached'), { status: 409 });
      const card = own.deck.shift();
      if (!card) throw Object.assign(new Error('Deck is empty'), { status: 409 });
      own.hand.push(card); session.state.events.push(event('draw', { seat: currentSeat }));
    } else if (name === 'play_card') {
      const id = String(parameters.cardId ?? parameters.id ?? '');
      const idx = own.hand.indexOf(id);
      if (idx < 0) throw Object.assign(new Error('Card is not in your hand'), { status: 400 });
      if (own.field.length >= config.duel.field_limit) throw Object.assign(new Error('Field limit reached'), { status: 409 });
      own.hand.splice(idx, 1); own.field.push(id); own.counters.cardsPlayed = Number(own.counters.cardsPlayed || 0) + 1;
      session.state.events.push(event('play_card', { seat: currentSeat, cardId: id }));
    } else if (name === 'discard') {
      const id = String(parameters.cardId ?? parameters.id ?? '');
      const idx = own.hand.indexOf(id);
      if (idx < 0) throw Object.assign(new Error('Card is not in your hand'), { status: 400 });
      own.hand.splice(idx, 1); own.discard.push(id); session.state.events.push(event('discard', { seat: currentSeat, cardId: id }));
    } else if (name === 'end_turn') {
      session.state.currentPlayer = otherSeat(currentSeat); session.state.turn = Number(session.state.turn || 0) + 1;
      session.state.events.push(event('end_turn', { seat: currentSeat, next: session.state.currentPlayer }));
    } else {
      throw Object.assign(new Error(`Unsupported action: ${name}`), { status: 400 });
    }
    return session;
  });
  return { session: updated, view: serializePlayer(updated, token) };
}

// Temporary migration bridge for the old Duel UI. Only server-to-server callers may use this.
// It intentionally refuses identity/session fields and should be removed after Repo #8 speaks /action natively.
export async function applyTrustedSnapshot(sessionId, snapshot) {
  const updated = await mutateSession(sessionId, session => {
    if (session.status !== 'live') throw Object.assign(new Error('Session is not live'), { status: 409 });
    const src = snapshot?.state || snapshot;
    for (const seat of ['player1', 'player2']) {
      if (!src?.[seat]) continue;
      const target = session.state[seat];
      if (Number.isFinite(Number(src[seat].hp))) target.hp = Math.max(0, Number(src[seat].hp));
      for (const field of ['hand', 'deck', 'field', 'discard']) if (Array.isArray(src[seat][field])) target[field] = [...src[seat][field]].map(String);
    }
    if (['player1', 'player2'].includes(src?.currentPlayer)) session.state.currentPlayer = src.currentPlayer;
    if (Number.isFinite(Number(src?.turn))) session.state.turn = Number(src.turn);
    session.state.events.push(event('trusted_snapshot'));
    if (session.state.player1.hp <= 0 || session.state.player2.hp <= 0) {
      session.status = 'finished'; session.finishedAt = new Date().toISOString();
      session.winner = session.state.player1.hp <= 0 ? 'player2' : 'player1'; session.reason = 'hp_zero';
    }
    return session;
  });
  // The migration bridge is server-to-server only, but a terminal snapshot must
  // still enter the canonical exactly-once finalizer so summary/stats cannot drift.
  if (updated.status === 'finished' && !updated.finalized) {
    return finishSession(sessionId, { winnerSeat: updated.winner, reason: updated.reason || 'hp_zero' });
  }
  return updated;
}

export async function applyBotTurn(sessionId, humanToken) {
  const before = await getSession(sessionId);
  const humanSeat = resolveSeat(before, humanToken);
  ensureLive(before, humanSeat);
  if (before.mode !== 'practice') throw Object.assign(new Error('Bot turns only exist in practice'), { status: 400 });
  const botSeat = before.player1.controller === 'bot' ? 'player1' : 'player2';
  if (before.state.currentPlayer !== botSeat) throw Object.assign(new Error('It is not the bot turn'), { status: 409 });
  return mutateSession(sessionId, session => {
    const own = session.state[botSeat]; own.counters ||= {};
    if (own.hand.length < config.duel.hand_limit && own.deck.length) own.hand.push(own.deck.shift());
    if (own.hand.length && own.field.length < config.duel.field_limit) {
      const card = own.hand.shift(); own.field.push(card); own.counters.cardsPlayed = Number(own.counters.cardsPlayed || 0) + 1;
      session.state.events.push(event('bot_play_card', { seat: botSeat, cardId: card }));
    }
    session.state.currentPlayer = humanSeat; session.state.turn = Number(session.state.turn || 0) + 1;
    session.state.events.push(event('bot_end_turn', { seat: botSeat, next: humanSeat }));
    return session;
  });
}
