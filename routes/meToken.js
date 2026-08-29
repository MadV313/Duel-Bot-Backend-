import express from 'express';
import { PATHS, loadJSON, updateJSONAtomic } from '../utils/storageClient.js';
import { getPlayerCollectionMap, getPlayerProfileByUserId, getUserStats, loadMaster, pad3, resolveUserIdByToken, validateDeck } from '../utils/deckUtils.js';
import { getSellStatus, previewSell, sellCards } from '../utils/economyService.js';
import { getTradeLimitStatus } from '../utils/tradeLimits.js';

const router = express.Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

async function userFor(req, res) {
  const userId = await resolveUserIdByToken(String(req.params.token || ''));
  if (!userId) { res.status(404).json({ error: 'Invalid player token' }); return null; }
  return userId;
}

router.get('/:token/collection', async (req, res) => {
  try {
    const userId = await userFor(req, res); if (!userId) return;
    const [collection, master] = await Promise.all([getPlayerCollectionMap(userId), loadMaster()]);
    const cards = master.filter(c => c.card_id !== '000').map(c => ({ number: c.card_id, card_id: c.card_id, owned: Number(collection[c.card_id] || 0), name: c.name, rarity: c.rarity, type: c.type, image: c.image || '' }));
    res.json({ userId, totalUnique: cards.filter(c => c.owned > 0).length, totalOwned: cards.reduce((n, c) => n + c.owned, 0), cards });
  } catch (e) { res.status(e?.status || 500).json({ error: e?.message || 'Internal error' }); }
});

router.get('/:token/stats', async (req, res) => {
  try { const userId = await userFor(req, res); if (!userId) return; res.json(await getUserStats(userId)); }
  catch (e) { res.status(e?.status || 500).json({ error: e?.message || 'Internal error' }); }
});

router.get('/:token/coins', async (req, res) => {
  try {
    const userId = await userFor(req, res); if (!userId) return;
    const bank = await loadJSON(PATHS.wallet).catch(() => ({}));
    res.json({ coins: Number(bank?.[userId] || 0) });
  } catch (e) { res.status(500).json({ error: e?.message || 'Internal error' }); }
});

router.get('/:token/deck', async (req, res) => {
  try {
    const userId = await userFor(req, res); if (!userId) return;
    const profile = await getPlayerProfileByUserId(userId);
    res.json({ deck: profile?.deck || { name: 'My Deck', cards: [] } });
  } catch (e) { res.status(500).json({ error: e?.message || 'Internal error' }); }
});

router.put('/:token/deck', async (req, res) => {
  try {
    const userId = await userFor(req, res); if (!userId) return;
    let normalized;
    await updateJSONAtomic(PATHS.linkedDecks, linked => {
      const profile = linked?.[userId];
      if (!profile) throw Object.assign(new Error('Player profile not found'), { status: 404 });
      const validation = validateDeck(req.body?.deck ?? req.body, profile.collection || {});
      if (!validation.ok) throw Object.assign(new Error(validation.errors.join(' ')), { status: 400, validation });
      normalized = validation.deck; profile.deck = normalized; profile.lastDeckSavedAt = new Date().toISOString(); linked[userId] = profile; return linked;
    }, { defaultValue: {} });
    res.json({ ok: true, deck: normalized });
  } catch (e) { res.status(e?.status || 500).json({ error: e?.message || 'Internal error', details: e?.validation?.errors }); }
});

router.delete('/:token/deck', async (req, res) => {
  try {
    const userId = await userFor(req, res); if (!userId) return;
    await updateJSONAtomic(PATHS.linkedDecks, linked => { if (!linked?.[userId]) throw Object.assign(new Error('Player profile not found'), { status: 404 }); linked[userId].deck = { name: 'My Deck', cards: [] }; linked[userId].lastDeckSavedAt = new Date().toISOString(); return linked; }, { defaultValue: {} });
    res.json({ ok: true, deck: { name: 'My Deck', cards: [] } });
  } catch (e) { res.status(e?.status || 500).json({ error: e?.message || 'Internal error' }); }
});

router.get('/:token/sell/status', async (req, res) => {
  try { const userId = await userFor(req, res); if (!userId) return; const st = await getSellStatus(userId); res.json({ ...st, soldToday: st.used, soldRemaining: st.remaining, resetAtISO: st.resetsAt }); }
  catch (e) { res.status(e?.status || 500).json({ error: e?.message || 'Internal error' }); }
});
router.post('/:token/sell/preview', async (req, res) => {
  try { const userId = await userFor(req, res); if (!userId) return; res.json(await previewSell(userId, req.body?.items ?? req.body?.cards ?? [])); }
  catch (e) { res.status(e?.status || 500).json({ error: e?.message || 'Internal error' }); }
});
router.post('/:token/sell', async (req, res) => {
  try { const userId = await userFor(req, res); if (!userId) return; res.json(await sellCards(userId, req.body?.items ?? req.body?.cards ?? [])); }
  catch (e) { res.status(e?.status || 500).json({ error: e?.message || 'Internal error' }); }
});
router.get('/:token/trade/limits', async (req, res) => {
  try {
    const userId = await userFor(req, res); if (!userId) return;
    res.json(await getTradeLimitStatus(userId));
  } catch (e) { res.status(e?.status || 500).json({ error: e?.message || 'Internal error' }); }
});

export default router;
