import express from 'express';
import { getSpectatorCount } from '../logic/chatRegistry.js';
import { PlayerLinks } from '../utils/playerLinks.js';
import { getPlayerProfileByUserId, resolveUserIdByToken } from '../utils/deckUtils.js';
import { applyAction, applyBotTurn, applyTrustedSnapshot } from '../logic/duelActions.js';
import { redactConcealedField } from '../logic/duelEffects.js';
import { createChallengeSession, createPracticeSession, decideChallenge, finalizeSession, getSession, listSessions, serializePlayer, serializeSpectator } from '../logic/duelSessions.js';

const router = express.Router();
export const botAlias = express.Router();
const botKey = () => String(process.env.BOT_API_KEY || process.env.BOT_KEY || '');
const keyFrom = req => String(req.get('X-Bot-Key') || req.get('Authorization')?.replace(/^Bearer\s+/i,'') || '');
const protectedBot = (req,res,next) => { const expected=botKey(); if (!expected) return res.status(503).json({error:'BOT_API_KEY is not configured'}); if (keyFrom(req)!==expected) return res.status(401).json({error:'Unauthorized'}); next(); };
const sendError = (res,e) => res.status(e?.status || 500).json({ error: e?.message || 'Internal error' });

// Concealed traps must remain visually AND structurally concealed from the other
// player and spectators. The canonical session retains the real card IDs server-side.
async function redactPlayerView(view) {
  if (!view || !['player1','player2'].includes(view.seat)) return view;
  const remote = view.seat === 'player1' ? 'player2' : 'player1';
  return { ...view, [remote]: { ...view[remote], field: await redactConcealedField(view[remote]?.field) } };
}
async function redactSpectatorView(view) {
  if (!view) return view;
  return {
    ...view,
    player1: { ...view.player1, field: await redactConcealedField(view.player1?.field) },
    player2: { ...view.player2, field: await redactConcealedField(view.player2?.field) },
  };
}

router.get('/status', (_req,res) => res.json({ ok:true, engine:'DuelSession', version:2 }));

async function practiceHandler(req,res) {
  try {
    const token = String(req.body?.token || req.query?.token || '');
    const userId = await resolveUserIdByToken(token);
    if (!userId) return res.status(401).json({ error:'Invalid player token' });
    const profile = await getPlayerProfileByUserId(userId);
    const deckMode = String(req.body?.deckMode || req.body?.practiceDeck || req.query?.deckMode || 'random').toLowerCase() === 'saved' ? 'saved' : 'random';
    const session = await createPracticeSession({ userId, token, displayName: profile?.discordName, deckMode });
    res.status(201).json({ ok:true, sessionId:session.id, mode:session.mode, status:session.status, url:PlayerLinks.duel(session.id,token), spectatorUrl:PlayerLinks.spectator(session.id) });
  } catch(e) { sendError(res,e); }
}
router.post('/practice', practiceHandler);
botAlias.post('/practice', practiceHandler);
botAlias.get('/practice', (_req,res) => res.status(410).json({ error:'Legacy global practice initialization retired. POST /duel/practice with the player token.' }));

router.post('/start', protectedBot, async (req,res) => {
  try {
    const { challengerId, opponentId } = req.body || {};
    const [p1,p2] = await Promise.all([getPlayerProfileByUserId(String(challengerId||'')),getPlayerProfileByUserId(String(opponentId||''))]);
    if (!p1?.token || !p2?.token) return res.status(400).json({error:'Both players must be linked.'});
    const session = await createChallengeSession({ challengerId:String(challengerId), challengerToken:p1.token, challengerName:p1.discordName, opponentId:String(opponentId), opponentToken:p2.token, opponentName:p2.discordName });
    res.status(201).json({ ok:true, sessionId:session.id, status:session.status, challengerUrl:PlayerLinks.duel(session.id,p1.token), opponentUrl:PlayerLinks.duel(session.id,p2.token), spectatorUrl:PlayerLinks.spectator(session.id) });
  } catch(e){ sendError(res,e); }
});

router.post('/:session/decision', async (req,res) => {
  try { const s=await decideChallenge(req.params.session,String(req.body?.token||''),req.body?.decision); res.json({ok:true,sessionId:s.id,status:s.status}); }
  catch(e){ sendError(res,e); }
});

router.get('/active', async (_req,res) => {
  try {
    const rows=await listSessions({activeOnly:true});
    res.json(rows.map(row => ({ id:row.id,mode:row.mode,status:row.status,revision:row.revision,createdAt:row.createdAt,updatedAt:row.updatedAt,players:(row.players||[]).map(p=>({displayName:p.displayName,controller:p.controller})) })));
  } catch(e){ sendError(res,e); }
});

router.get('/:session/state', async (req,res) => {
  try {
    const s=await getSession(req.params.session); if(!s) return res.status(404).json({error:'Session not found'});
    const token=String(req.query?.token||req.get('X-Player-Token')||'');
    const view=serializePlayer(s,token,getSpectatorCount(s.id));
    if(!view) return res.status(401).json({error:'Invalid player token'});
    res.set('Cache-Control','no-store').json(await redactPlayerView(view));
  } catch(e){ sendError(res,e); }
});

router.get('/:session/spectator', async (req,res) => {
  try { const s=await getSession(req.params.session); if(!s) return res.status(404).json({error:'Session not found'}); res.set('Cache-Control','no-store').json(await redactSpectatorView(serializeSpectator(s,getSpectatorCount(s.id)))); }
  catch(e){ sendError(res,e); }
});

router.post('/:session/action', async (req,res) => {
  try { const result=await applyAction(req.params.session,String(req.body?.token||''),req.body?.action,req.body?.parameters||{}); res.json({ok:true,revision:result.session.revision,state:await redactPlayerView(result.view)}); }
  catch(e){ sendError(res,e); }
});
router.post('/:session/bot-turn', async (req,res) => {
  try { const s=await applyBotTurn(req.params.session,String(req.body?.token||'')); res.json({ok:true,revision:s.revision,state:await redactPlayerView(serializePlayer(s,String(req.body?.token||''),getSpectatorCount(s.id)))}); }
  catch(e){ sendError(res,e); }
});

router.post('/:session/sync', protectedBot, async (req,res) => {
  try { const s=await applyTrustedSnapshot(req.params.session,req.body?.state||req.body||{}); res.json({ok:true,revision:s.revision,status:s.status}); }
  catch(e){ sendError(res,e); }
});
router.post('/:session/finalize', protectedBot, async (req,res) => {
  try { const out=await finalizeSession(req.params.session); res.json({ok:true,summaryId:out.summary.sessionId,summary:out.summary}); }
  catch(e){ sendError(res,e); }
});

// Compatibility endpoints require an explicit session and never fall back to unrelated global state.
router.get('/state', async (req,res) => {
  try {
    const id=String(req.query?.session||''); if(!id) return res.status(400).json({error:'session is required'});
    const s=await getSession(id); if(!s) return res.status(404).json({error:'Session not found'});
    const token=String(req.query?.token||req.get('X-Player-Token')||'');
    if (token) { const view=serializePlayer(s,token,getSpectatorCount(id)); if(!view)return res.status(401).json({error:'Invalid player token'}); return res.json(await redactPlayerView(view)); }
    return res.json(await redactSpectatorView(serializeSpectator(s,getSpectatorCount(id))));
  } catch(e){ sendError(res,e); }
});
router.get('/current', async (req,res) => {
  try { const id=String(req.query?.session||''); if(!id) return res.status(400).json({error:'session is required'}); const s=await getSession(id); if(!s) return res.status(404).json({error:'Session not found'}); res.json(await redactSpectatorView(serializeSpectator(s,getSpectatorCount(id)))); }
  catch(e){ sendError(res,e); }
});

export default router;
