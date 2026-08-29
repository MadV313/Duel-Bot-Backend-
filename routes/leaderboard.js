import express from 'express';
import { PATHS, loadJSON } from '../utils/storageClient.js';
const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    const [linked, stats, bank] = await Promise.all([loadJSON(PATHS.linkedDecks).catch(() => ({})), loadJSON(PATHS.playerData).catch(() => ({})), loadJSON(PATHS.wallet).catch(() => ({}))]);
    const minMatches = Math.max(0, Number(process.env.LEADERBOARD_MIN_MATCHES || 3));
    const rows = Object.entries(linked || {}).map(([userId, p]) => {
      const s = stats?.[userId] || {}; const wins = Number(s.wins || 0), losses = Number(s.losses || 0), matches = wins + losses;
      return { name: p?.discordName || 'Survivor', wins, losses, matches, winRate: matches ? wins / matches : 0, coins: Number(bank?.[userId] || 0), provisional: matches < minMatches };
    });
    const winRate = rows.filter(r => r.matches >= minMatches).sort((a,b) => b.winRate-a.winRate || b.wins-a.wins || a.losses-b.losses || a.name.localeCompare(b.name));
    const coins = [...rows].sort((a,b) => b.coins-a.coins || a.name.localeCompare(b.name));
    res.set('Cache-Control','no-store').json({ updatedAt: new Date().toISOString(), minimumMatches: minMatches, winRate, coins });
  } catch (e) { res.status(500).json({ error: e?.message || 'Internal error' }); }
});
export default router;
