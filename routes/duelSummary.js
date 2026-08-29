import express from 'express';
import { PATHS, loadJSON } from '../utils/storageClient.js';
const router = express.Router();
router.get('/:sessionId', async (req, res) => {
  try { const summary = await loadJSON(PATHS.summaryFor(req.params.sessionId)); res.set('Cache-Control','no-store').json(summary); }
  catch (e) { res.status(e?.status === 404 ? 404 : 500).json({ error: e?.status === 404 ? 'Summary not found' : (e?.message || 'Internal error') }); }
});
router.post('*', (_req, res) => res.status(410).json({ error: 'Duel summaries are server-authored during finalization.' }));
export default router;
