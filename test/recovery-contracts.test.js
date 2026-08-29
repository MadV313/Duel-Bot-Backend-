import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

function makeStore(seed = {}) {
  const rows = new Map();
  for (const [key, value] of Object.entries(seed)) rows.set(key, { value: structuredClone(value), version: 1 });
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const key = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.replace(/^\/+/, ''));
    requests.push({ method: req.method, key, storageKey: req.headers['x-storage-key'], ifMatch: req.headers['if-match'] || null });
    if (key === '_health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    if (req.headers['x-storage-key'] !== 'test-secret') { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    if (req.method === 'GET') {
      const row = rows.get(key); if (!row) { res.writeHead(404); return res.end('{"error":"missing"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: `"v${row.version}"` }); return res.end(JSON.stringify(row.value));
    }
    if (req.method === 'PUT') {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
      const old=rows.get(key); const expected=old?`"v${old.version}"`:null;
      if (req.headers['if-match'] && req.headers['if-match'] !== expected) { res.writeHead(412); return res.end('{"error":"conflict"}'); }
      const version=(old?.version||0)+1; rows.set(key,{value:body,version});
      res.writeHead(200,{ 'Content-Type':'application/json', ETag:`"v${version}"` }); return res.end('{"ok":true}');
    }
    if (req.method === 'DELETE') { if(!rows.has(key)){res.writeHead(404);return res.end();} rows.delete(key);res.writeHead(204);return res.end(); }
    res.writeHead(405); res.end();
  });
  return { server, rows, requests };
}

const starterCards = Array.from({length:20},(_,i)=>String(i+1).padStart(3,'0'));
const collection = Object.fromEntries(starterCards.map(id=>[id,3]));
const seed = {
  'data/linked_decks.json': {
    u1: { discordName:'Alpha', token:'alpha_token_1234567890', collection:{...collection,'020':10}, deck:{name:'Alpha Deck',cards:starterCards.map(id=>({id,qty:1}))} },
    u2: { discordName:'Bravo', token:'bravo_token_1234567890', collection:{...collection}, deck:{name:'Bravo Deck',cards:starterCards.map(id=>({id,qty:1}))} },
  },
  'data/coin_bank.json': { u1:100, u2:100 },
  'data/player_data.json': { u1:{wins:0,losses:0}, u2:{wins:0,losses:0} },
  'data/sells_by_day.json': {}, 'data/trades.json': {}, 'data/trade_limits.json': {}, 'data/trade_queue.json': {},
  'data/summaries/_sessions/index.json': {},
  'data/logs/current_duel_log.json': {},
};
const fake = makeStore(seed);
await new Promise(resolve=>fake.server.listen(0,'127.0.0.1',resolve));
const address=fake.server.address();
process.env.PERSISTENT_DATA_URL=`http://127.0.0.1:${address.port}`;
process.env.STORAGE_KEY='test-secret';
process.env.STORAGE_RETRIES='20';
process.env.STORAGE_RETRY_BASE_MS='1';
process.env.STORAGE_TIMEOUT_MS='3000';
process.env.API_BASE='https://api.sv13tcg.com';
process.env.PASS_API_QUERY='false';
process.env.BUY_LIMIT_PER_DAY='5';
process.env.SELL_LIMIT_PER_DAY='5';
process.env.CARD_PACK_COST='3';

const storage = await import('../utils/storageClient.js');
const deck = await import('../utils/deckUtils.js');
const links = await import('../utils/playerLinks.js');
const economy = await import('../utils/economyService.js');
const sessions = await import('../logic/duelSessions.js');
const actions = await import('../logic/duelActions.js');
const tradeCore = await import('../utils/tradeCore.js');
const tradeLimits = await import('../utils/tradeLimits.js');

process.on('exit',()=>fake.server.close());

test('storage client authenticates, uses ETags, supports DELETE, and uses /_health', async () => {
  assert.equal(await storage.healthCheck(), true);
  assert.match(storage.PATHS.duelSessionFor('abc123'), /^data\/summaries\/_sessions\//);
  const meta=await storage.loadJSONWithMeta(storage.PATHS.wallet);
  assert.match(meta.etag,/v1/);
  await storage.updateJSONAtomic(storage.PATHS.wallet, bank=>{bank.u1+=1;return bank;});
  assert.equal((await storage.loadJSON(storage.PATHS.wallet)).u1,101);
  await storage.saveJSON('data/summaries/delete-me.json',{ok:true});
  assert.equal(await storage.deleteJSON('data/summaries/delete-me.json'),true);
  assert.equal(fake.requests.filter(r=>r.key!=='_health').every(r=>r.storageKey==='test-secret'),true);
  assert.ok(fake.requests.some(r=>r.method==='PUT'&&r.ifMatch));
});

test('atomic updates survive concurrent writers without lost increments', async () => {
  await storage.saveJSON('data/summaries/counter.json',{n:0});
  await Promise.all(Array.from({length:10},()=>storage.updateJSONAtomic('data/summaries/counter.json',x=>({n:Number(x.n||0)+1}),{retries:30})));
  assert.equal((await storage.loadJSON('data/summaries/counter.json')).n,10);
});

test('rarity normalization, weighted packs, and deck validation enforce canonical rules', async () => {
  assert.equal(deck.normalizeRarity('common'),'Common');
  assert.equal(economy.sellValueForRarity('common'),0.5);
  const master=await deck.loadMaster({ refresh:true });
  assert.equal(master.find(card=>card.card_id==='020')?.rarity,'Rare');
  // Preserve the original per-card weighting while normalizing lowercase rarity first:
  // Common weight 5 followed by lowercase rare weight 2 => boundary is 5/7.
  const weighted=[{card_id:'001',rarity:'Common'},{card_id:'020',rarity:'rare'}];
  assert.equal(economy.pickWeighted(weighted,()=>0.71).card_id,'001');
  assert.equal(economy.pickWeighted(weighted,()=>0.72).card_id,'020');
  const good=deck.validateDeck({name:'ok',cards:starterCards.map(id=>({id,qty:1}))},collection);
  assert.equal(good.ok,true);
  assert.equal(deck.validateDeck({cards:[{id:'001',qty:6},...starterCards.slice(1).map(id=>({id,qty:1}))]},collection).ok,false);
  assert.equal(deck.validateDeck({cards:[{id:'001',qty:3},{id:'001',qty:3},...starterCards.slice(1).map(id=>({id,qty:1}))]},collection).ok,false);
  assert.equal(deck.validateDeck({cards:[{id:'000',qty:1},...starterCards.slice(0,19).map(id=>({id,qty:1}))]},{...collection,'000':1}).ok,false);
});

test('player links use new SV13 domains and never propagate me=', () => {
  const url=links.PlayerLinks.duel('session_1234567890','alpha_token_1234567890');
  assert.match(url,/^https:\/\/duel\.sv13tcg\.com\//);
  assert.match(url,/session=session_1234567890/);
  assert.match(url,/token=alpha_token_1234567890/);
  assert.equal(url.includes('me='),false);
  assert.equal(url.includes('role='),false);
});

test('practice sessions are unique and spectator serializer never leaks hands or deck order', async () => {
  const a=await sessions.createPracticeSession({userId:'u1',token:'alpha_token_1234567890',displayName:'Alpha',deckMode:'random'});
  const b=await sessions.createPracticeSession({userId:'u1',token:'alpha_token_1234567890',displayName:'Alpha',deckMode:'random'});
  assert.notEqual(a.id,b.id);
  const publicView=sessions.serializeSpectator(a,2);
  assert.equal('hand' in publicView.player1,false); assert.equal('deck' in publicView.player1,false);
  assert.equal(typeof publicView.player1.handCount,'number'); assert.equal(typeof publicView.player1.deckCount,'number');
  const privateView=sessions.serializePlayer(a,'alpha_token_1234567890',2);
  assert.ok(Array.isArray(privateView.hand));
});

test('PvP challenge stores token hashes, resolves seats, and finalizes stats exactly once', async () => {
  const s=await sessions.createChallengeSession({challengerId:'u1',challengerToken:'alpha_token_1234567890',challengerName:'Alpha',opponentId:'u2',opponentToken:'bravo_token_1234567890',opponentName:'Bravo'});
  const persisted=await storage.loadJSON(storage.PATHS.duelSessionFor(s.id));
  assert.equal(JSON.stringify(persisted).includes('alpha_token_1234567890'),false);
  assert.equal(sessions.resolveSeat(persisted,'alpha_token_1234567890'),'player1');
  const live=await sessions.decideChallenge(s.id,'bravo_token_1234567890','accept'); assert.equal(live.status,'live');
  await sessions.finishSession(s.id,{winnerSeat:'player1',reason:'test'});
  await sessions.finalizeSession(s.id);
  const stats=await storage.loadJSON(storage.PATHS.playerData);
  assert.equal(stats.u1.wins,1); assert.equal(stats.u2.losses,1);
  await sessions.finalizeSession(s.id);
  const statsAgain=await storage.loadJSON(storage.PATHS.playerData);
  assert.equal(statsAgain.u1.wins,1); assert.equal(statsAgain.u2.losses,1);
  const summary=await storage.loadJSON(storage.PATHS.summaryFor(s.id)); assert.equal(summary.sessionId,s.id); assert.equal(summary.winner,'player1');
});

test('trade core revalidates ownership and trade limit is derived from canonical sessions', async () => {
  const linked={
    a:{collection:{'001':1,'002':1}},
    b:{collection:{'003':1,'004':1}},
  };
  const swap=tradeCore.applyCardExchange(linked,{initiator:{userId:'a',selection:['001','000']},partner:{userId:'b',selection:['003']}});
  assert.deepEqual(swap.giveA,['001']); assert.deepEqual(swap.giveB,['003']);
  assert.equal(swap.linked.a.collection['003'],1); assert.equal(swap.linked.b.collection['001'],1);
  assert.throws(()=>tradeCore.applyCardExchange({a:{collection:{}},b:{collection:{'004':1}}},{initiator:{userId:'a',selection:['001']},partner:{userId:'b',selection:['004']}}),e=>e?.status===409);

  const day=new Date().toISOString();
  await storage.saveJSON(storage.PATHS.trades,{
    t1:{createdAt:day,status:'active',initiator:{userId:'u1'}},
    t2:{createdAt:day,status:'accepted',initiator:{userId:'u1'}},
    t3:{createdAt:day,status:'expired',initiator:{userId:'u1'}},
    t4:{createdAt:day,status:'active',initiator:{userId:'u2'}},
  });
  const status=await tradeLimits.getTradeLimitStatus('u1');
  assert.equal(status.used,2); assert.equal(status.remaining,1);
  const ledger=await storage.loadJSON(storage.PATHS.tradeLimits);
  assert.equal(ledger.u1[status.day],2);
});

test('secure action forfeit resolves token-to-seat and finalizes the duel exactly once', async () => {
  const s=await sessions.createChallengeSession({challengerId:'u1',challengerToken:'alpha_token_1234567890',challengerName:'Alpha',opponentId:'u2',opponentToken:'bravo_token_1234567890',opponentName:'Bravo'});
  await sessions.decideChallenge(s.id,'bravo_token_1234567890','accept');
  const before=await storage.loadJSON(storage.PATHS.playerData);
  const out=await actions.applyAction(s.id,'alpha_token_1234567890','forfeit');
  assert.equal(out.session.status,'finished'); assert.equal(out.session.winner,'player2'); assert.equal(out.view.seat,'player1');
  assert.equal(out.session.finalized,true);
  const after=await storage.loadJSON(storage.PATHS.playerData);
  assert.equal(Number(after.u2.wins||0),Number(before.u2.wins||0)+1);
  assert.equal(Number(after.u1.losses||0),Number(before.u1.losses||0)+1);
  await sessions.finalizeSession(s.id);
  const again=await storage.loadJSON(storage.PATHS.playerData);
  assert.equal(again.u2.wins,after.u2.wins); assert.equal(again.u1.losses,after.u1.losses);
});

test('pack purchases enforce 5/day, 3-coin cost, 3 cards, and persistent opaque reveals', async () => {
  // Reset u2 purchase state and give enough headroom/coins.
  await storage.updateJSONAtomic(storage.PATHS.linkedDecks,linked=>{linked.u2.packPurchasesByDay={};linked.u2.collection={};return linked;});
  await storage.updateJSONAtomic(storage.PATHS.wallet,bank=>{bank.u2=100;return bank;});
  const ids=[];
  for(let n=0;n<5;n++){const out=await economy.buyPack('u2');assert.equal(out.cards.length,3);assert.equal(out.cost,3);ids.push(out.revealId);assert.ok(await storage.loadJSON(storage.PATHS.packRevealFor(out.revealId)));}
  assert.equal(new Set(ids).size,5);
  await assert.rejects(()=>economy.buyPack('u2'),e=>e?.status===429);
  assert.equal((await storage.loadJSON(storage.PATHS.wallet)).u2,85);
});

test('Discord/API sell service shares a single 5-card daily ledger', async () => {
  const day=new Date().toISOString().slice(0,10);
  await storage.updateJSONAtomic(storage.PATHS.sellsByDay,x=>{x.u1={};return x;});
  await storage.updateJSONAtomic(storage.PATHS.linkedDecks,x=>{x.u1.collection['020']=10;return x;});
  const result=await economy.sellCards('u1',[{id:'020',qty:5}]);
  assert.equal(result.quantity,5);
  assert.equal((await storage.loadJSON(storage.PATHS.sellsByDay)).u1[day],5);
  await assert.rejects(()=>economy.sellCards('u1',[{id:'020',qty:1}]),e=>e?.status===429);
});

test.after(async()=>{await new Promise(resolve=>fake.server.close(resolve));});
