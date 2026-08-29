import express from 'express';
import { getPlayerCollectionMap, getPlayerProfileByUserId, getUserStats } from '../utils/deckUtils.js';
const router = express.Router();
router.get('/:id', async (req,res) => {
  try {
    const profile = await getPlayerProfileByUserId(req.params.id); if (!profile) return res.status(404).json({ error: 'Player not found' });
    const [collection, stats] = await Promise.all([getPlayerCollectionMap(req.params.id), getUserStats(req.params.id)]);
    // Legacy adapter intentionally does not expose profile.token.
    res.set('Cache-Control','no-store').json({ id: String(req.params.id), discordName: profile.discordName || '', collection, deck: profile.deck || { name:'My Deck', cards:[] }, ...stats });
  } catch (e) { res.status(500).json({ error: e?.message || 'Internal error' }); }
});
export default router;
