import express from 'express';
import { getHistory } from '../logic/chatRegistry.js';
import { getSession } from '../logic/duelSessions.js';

const router = express.Router();

router.get('/:room/history', async (req, res) => {
  try {
    const room = String(req.params.room || '').trim();
    if (!room) return res.status(400).json({ error: 'room required' });
    const session = await getSession(room);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.set('Cache-Control', 'no-store').json({ ok: true, room, messages: getHistory(room) });
  } catch (e) {
    res.status(e?.status || 500).json({ error: e?.message || 'Internal error' });
  }
});

export default router;
