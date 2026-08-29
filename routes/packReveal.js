import express from 'express';
import { readPackReveal } from '../utils/packRevealStore.js';
const router = express.Router();
router.get('/reveal/:revealId', async (req,res) => {
  try { const record = await readPackReveal(req.params.revealId); if (!record) return res.status(404).json({ error: 'Reveal not found' }); res.set('Cache-Control','no-store').json(record); }
  catch (e) { res.status(500).json({ error: e?.message || 'Internal error' }); }
});
router.get('/:revealId', async (req,res) => {
  try { const record = await readPackReveal(req.params.revealId); if (!record) return res.status(404).json({ error: 'Reveal not found' }); res.set('Cache-Control','no-store').json(record); }
  catch (e) { res.status(500).json({ error: e?.message || 'Internal error' }); }
});
export default router;
