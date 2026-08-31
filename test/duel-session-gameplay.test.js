import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareDuelEffects,
  playCardEffect,
  endTurnAndAdvance,
  runBotTurn,
  redactConcealedField,
  removeFieldCard,
  startTurn,
} from '../logic/duelEffects.js';

await prepareDuelEffects();

function session({ currentPlayer = 'player1' } = {}) {
  return {
    id: 'test-session-123456',
    mode: 'practice',
    status: 'live',
    revision: 1,
    player1: { controller: 'human' },
    player2: { controller: 'bot' },
    state: {
      turn: 1,
      currentPlayer,
      events: [],
      player1: { hp: 200, hand: [], deck: [], field: [], discard: [], deckName: 'P1', counters: {}, buffs: {} },
      player2: { hp: 200, hand: [], deck: [], field: [], discard: [], deckName: 'P2', counters: {}, buffs: {} },
    },
  };
}

test('Derringer resolves real damage instead of only moving to field', () => {
  const s = session();
  s.state.player1.hand = ['028'];
  playCardEffect(s, 'player1', '028');
  assert.equal(s.state.player2.hp, 180);
  assert.equal(s.state.player1.hand.length, 0);
  assert.equal(s.state.player1.field.length, 1);
  assert.equal(s.state.player1.field[0].cardId, '028');
});

test('field remains three slots and manual field removal moves to discard', () => {
  const s = session();
  s.state.player1.field = [
    { cardId:'031', isFaceDown:false },
    { cardId:'034', isFaceDown:false },
    { cardId:'039', isFaceDown:false },
  ];
  s.state.player1.hand = ['010'];
  assert.throws(() => playCardEffect(s, 'player1', '010'), /field is full/i);
  removeFieldCard(s, 'player1', '039');
  assert.equal(s.state.player1.field.length, 2);
  assert.deepEqual(s.state.player1.discard, ['039']);
});

test('end turn cleans ephemeral cards, swaps turn, and auto-draws once', () => {
  const s = session();
  s.state.player1.field = [
    { cardId:'010', isFaceDown:false },
    { cardId:'034', isFaceDown:false },
  ];
  s.state.player2.hand = ['001','002','003'];
  s.state.player2.deck = ['004','005'];
  endTurnAndAdvance(s, 'player1');
  assert.equal(s.state.currentPlayer, 'player2');
  assert.equal(s.state.player2.hand.length, 4);
  assert.equal(s.state.player2.deck.length, 1);
  assert.equal(s.state.player1.field.length, 1);
  assert.equal(s.state.player1.field[0].cardId, '034');
  assert.ok(s.state.player1.discard.includes('010'));
});

test('start turn is idempotent and reconnect-safe', () => {
  const s = session();
  s.state.player1.hand = ['001','002','003'];
  s.state.player1.deck = ['004','005'];
  assert.equal(startTurn(s, 'player1'), true);
  assert.equal(startTurn(s, 'player1'), false);
  assert.equal(s.state.player1.hand.length, 4);
  assert.equal(s.state.player1.deck.length, 1);
});

test('practice bot resolves card damage and returns control', () => {
  const s = session({ currentPlayer: 'player2' });
  s.state.player2.hand = ['028','083','084'];
  s.state.player2.deck = ['001','002'];
  s.state.player1.hand = ['003','004','005'];
  s.state.player1.deck = ['006'];
  runBotTurn(s, 'player2');
  assert.equal(s.state.player1.hp, 180);
  assert.equal(s.state.currentPlayer, 'player1');
});

test('Combat Boots blocks Bear Trap / tripwire trap damage', () => {
  const s = session({ currentPlayer: 'player2' });
  s.state.player1.field = [{ cardId:'106', isFaceDown:true, _fired:false }];
  s.state.player2.field = [{ cardId:'034', isFaceDown:false, _fired:false }];
  s.state.player2.hand = ['010'];
  playCardEffect(s, 'player2', '010');
  assert.equal(s.state.player1.hp, 185, 'attack still damages defender');
  assert.equal(s.state.player2.hp, 200, 'Bear Trap is negated by Combat Boots');
  assert.equal(s.state.player1.field[0]._fired, true);
  assert.equal(s.state.player1.field[0].isFaceDown, false);
});

test('concealed trap IDs are redacted from remote/spectator payloads', async () => {
  const redacted = await redactConcealedField([
    { cardId:'106', isFaceDown:true, _fired:false },
    { cardId:'031', isFaceDown:false, _fired:false },
    { cardId:'107', isFaceDown:false, _fired:true },
  ]);
  assert.deepEqual(redacted[0], { cardId:'000', isFaceDown:true, concealed:true });
  assert.equal(redacted[1].cardId, '031');
  assert.equal(redacted[2].cardId, '107');
});
