import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareDuelEffects,
  playCardEffect,
  endTurnAndAdvance,
  runBotTurn,
  redactConcealedField,
  removeFieldCard,
  resolveCombatExhaustion,
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


test('combat exhaustion ends by remaining HP instead of endless turn passing', () => {
  const s = session();
  s.state.player1.hp = 112;
  s.state.player2.hp = 74;
  s.state.player1.hand = ['083']; // harmless loot remains
  s.state.player2.hand = ['106']; // armed trap alone cannot fire without an attack/infected play
  s.state.player2.field = [{ cardId:'107', isFaceDown:true, _fired:false }];
  s.state.player1.deck = [];
  s.state.player2.deck = [];

  endTurnAndAdvance(s, 'player1');

  assert.equal(s.status, 'finished');
  assert.equal(s.winner, 'player1');
  assert.equal(s.reason, 'combat_exhaustion');
  assert.equal(s.state.player2.field[0].cardId, '107');
});

test('combat exhaustion is a draw when final HP is tied', () => {
  const s = session();
  s.state.player1.hp = 90;
  s.state.player2.hp = 90;
  s.state.player1.hand = ['083'];
  s.state.player2.hand = ['084'];
  s.state.player1.deck = [];
  s.state.player2.deck = [];

  assert.equal(resolveCombatExhaustion(s), true);
  assert.equal(s.status, 'finished');
  assert.equal(s.winner, null);
  assert.equal(s.reason, 'combat_exhaustion');
});

test('offensive card or implemented weapon recovery prevents premature exhaustion', () => {
  const attackReady = session();
  attackReady.state.player1.deck = [];
  attackReady.state.player2.deck = [];
  attackReady.state.player1.hand = ['028'];
  assert.equal(resolveCombatExhaustion(attackReady), false);
  assert.equal(attackReady.status, 'live');

  const recoverable = session();
  recoverable.state.player1.deck = [];
  recoverable.state.player2.deck = [];
  recoverable.state.player1.hand = ['075']; // Weapon Cleaning Kit
  recoverable.state.player1.discard = ['028'];
  assert.equal(resolveCombatExhaustion(recoverable), false);
  assert.equal(recoverable.status, 'live');
});

test('single empty player still loses when opponent retains real combat pressure', () => {
  const s = session();
  s.state.player1.hand = [];
  s.state.player1.deck = [];
  s.state.player2.hand = ['028'];
  s.state.player2.deck = [];

  startTurn(s, 'player1');

  assert.equal(s.status, 'finished');
  assert.equal(s.winner, 'player2');
  assert.equal(s.reason, 'no_cards');
});

test('practice bot clears a full persistent field so it can keep playing instead of deadlocking', () => {
  const s = session({ currentPlayer: 'player2' });
  s.state.player2.field = [
    { cardId:'031', isFaceDown:false, _fired:false },
    { cardId:'034', isFaceDown:false, _fired:false },
    { cardId:'106', isFaceDown:true, _fired:false },
  ];
  s.state.player2.hand = ['028'];
  s.state.player2.deck = ['001'];
  s.state.player1.hand = ['083'];
  s.state.player1.deck = ['002'];

  runBotTurn(s, 'player2');

  assert.equal(s.state.player1.hp, 180);
  assert.ok(s.state.player2.discard.includes('031'));
  assert.ok(s.state.player2.discard.includes('028'));
  assert.ok(s.state.events.some(e => e.type === 'bot_field_cleared'));
  assert.equal(s.state.currentPlayer, 'player1');
});
