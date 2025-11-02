// routes/trade.js
// Trade sessions & limits
// Mount at ROOT so paths match spec exactly:
//   POST /trade/start
//   GET  /trade/:session/state
//   POST /trade/:session/select
//   POST /trade/:session/decision
//   GET  /me/:token/trade/limits
//   NEW: GET /trade/:session/collections?token=...   (session-gated view of both collections)
//   NEW: GET /trade/:session/summary?token=...       (summary of both selections with metadata)
//
// Factory router so we can DM via Discord client from server.js

import express from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import {
  resolveUserIdByToken,
  pad3,
} from '../utils/deckUtils.js';
import { load_file, save_file } from '../utils/storageClient.js';

// ✅ NEW: for decision receipts w/ thumbnails
import { EmbedBuilder } from 'discord.js';

// ✅ Try to read image_base from central config, but keep hard fallbacks
let CONFIG_IMAGE_BASE = '';
try {
  // eslint-disable-next-line import/no-unresolved
  const cfg = await import('../utils/config.js');
  CONFIG_IMAGE_BASE = (cfg?.image_base || cfg?.IMAGE_BASE || '').trim();
} catch (_) {
  // no-op; will use envs/fallbacks below
}

const LINKED_DECKS_FILE = 'data/linked_decks.json';
const TRADES_FILE       = 'data/trades.json';
const TRADE_LIMITS_FILE = 'data/trade_limits.json';

const cardListPath      = path.resolve('./logic/CoreMasterReference.json'); // static asset

const MAX_PER_DAY = 3;
const SESSION_TTL_HOURS = 24;

// 🔧 NEW: Toggle whether the server also DMs the initiator on /trade/start
const SEND_SERVER_TRADE_DM = String(process.env.SEND_SERVER_TRADE_DM || 'false').toLowerCase() === 'true';

function todayStr() {
  return new Date().toISOString().slice(0,10);
}
function randomId(len=24) {
  return crypto.randomBytes(Math.ceil((len*3)/4)).toString('base64url').slice(0, len);
}

// ---- Persistent storage helpers (remote) ----
// ✅ load_file already returns parsed JSON from the persistent service.
//    Handle both object and string just in case a backend ever returns text.
async function readJsonRemote(name, fb) {
  try {
    const raw = await load_file(name);
    if (raw == null) return fb;
    if (typeof raw === 'object') return raw;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return fb; }
    }
    return fb;
  } catch {
    return fb;
  }
}
async function writeJsonRemote(name, data) {
  // ✅ save_file expects a JS value; do NOT JSON.stringify here.
  await save_file(name, data);
}

// ---- Local read helper for static card master ----
async function readJsonLocal(file, fb) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return fb;
  }
}

function clampCards(cards) {
  const set = new Set();
  const out = [];
  for (const c of (cards||[])) {
    const id = pad3(c);
    if (!set.has(id) && out.length < 3) {
      set.add(id);
      out.push(id);
    }
  }
  return out;
}
function incLimit(limits, userId, day) {
  limits[userId] ||= {};
  limits[userId][day] = (limits[userId][day] || 0) + 1;
}
function getUsed(limits, userId, day) {
  return limits?.[userId]?.[day] || 0;
}
function hasExpired(session) {
  if (!session?.expiresAt) return false;
  return Date.now() > new Date(session.expiresAt).getTime();
}
function dayOf(isoLike) {
  try { return new Date(isoLike).toISOString().slice(0,10); } catch { return todayStr(); }
}

// Count how many sessions the user has *started today* by scanning TRADES_FILE.
// We purposely do not count "expired" sessions; everything else (active/decision/accepted/denied) counts.
function countInitiationsToday(tradesObj = {}, initiatorId, day = todayStr()) {
  let n = 0;
  for (const s of Object.values(tradesObj || {})) {
    if (!s || s?.initiator?.userId !== initiatorId) continue;
    const d = dayOf(s.createdAt);
    if (d !== day) continue;
    if (s.status === 'expired') continue;
    n += 1;
  }
  return n;
}

// Build a Collection UI link following the UI/cog contract:
// ?mode=trade&tradeSession=<id>&role=<initiator|partner>[&stage=...&partner=...]
function buildUiLink({ base, token, apiBase, meBase, sessionId, role, stage, partnerName }) {
  const ts = Date.now();
  const qp = new URLSearchParams();
  qp.set('mode', 'trade');
  qp.set('tradeSession', sessionId);
  if (role) qp.set('role', role);
  if (token) qp.set('token', token);
  if (apiBase) qp.set('api', apiBase);
  if (meBase) qp.set('me', meBase);
  if (stage) qp.set('stage', stage);
  if (partnerName) qp.set('partner', partnerName);
  qp.set('ts', String(ts));
  return `${String(base || '').replace(/\/+$/, '')}/index.html?${qp.toString()}`;
}

/* ---------------- Card metadata helpers (for thumbnails/labels) ---------------- */
let __cardIndex = null;
async function loadCardIndex() {
  if (__cardIndex) return __cardIndex;
  const raw = await readJsonLocal(cardListPath, []);
  const list = Array.isArray(raw) ? raw : (raw.cards || []);
  const index = {};
  for (const c of list) {
    const id  = pad3(c.card_id);
    const img = c.filename || c.image || '';
    index[id] = {
      name: c.name,
      rarity: c.rarity || 'Common',
      type: c.type || '',
      filename: img || `${id}_${String(c.name||'').replace(/[^a-zA-Z0-9._-]/g,'')}_${String(c.type||'').replace(/[^a-zA-Z0-9._-]/g,'')}.png`
    };
  }
  __cardIndex = index;
  return __cardIndex;
}
function metaFor(id, idx) {
  return idx[id] || { name: `#${id}`, rarity: 'Common', type: '', filename: `${id}.png` };
}
function collectionToArray(collection = {}, idx = {}) {
  const out = [];
  for (const [id, qtyRaw] of Object.entries(collection)) {
    const qty = Number(qtyRaw || 0);
    if (qty <= 0) continue;
    const m = metaFor(id, idx);
    out.push({ card_id: `#${id}`, id, qty, name: m.name, rarity: m.rarity, filename: m.filename });
  }
  // sort nicely: rarity then id
  out.sort((a, b) => {
    const rOrder = { Legendary: 3, Rare: 2, Uncommon: 1, Common: 0 };
    const dr = (rOrder[b.rarity]||0) - (rOrder[a.rarity]||0);
    if (dr) return dr;
    return a.id.localeCompare(b.id);
  });
  return out;
}

// ✅ Image base + fallback resolver
function getImageBase() {
  const env = (process.env.IMAGE_BASE || process.env.image_base || '').trim();
  const cfg = CONFIG_IMAGE_BASE;
  // Prefer configured base; then env; then stable fallbacks
  return (
    cfg ||
    env ||
    'https://madv313.github.io/Card-Collection-UI/images/cards'
  );
}
function cardImageUrl(filename) {
  const base = getImageBase().replace(/\/+$/, '');
  return `${base}/${filename}`; // filename expected from CoreMasterReference.json
}
function cardBackUrl() {
  const base = getImageBase().replace(/\/+$/, '');
  // Use your standard back image filename
  return `${base}/000_CardBack_Unique.png`;
}

/* ---------------- Bot-key helpers (header/env) ---------------- */
function getBotKeyFromHeaders(req) {
  const direct = req.get('X-Bot-Key') || req.get('x-bot-key');
  if (direct) return direct.trim();
  const auth = req.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}
function constantTimeEq(a = '', b = '') {
  const al = a.length, bl = b.length;
  let mismatch = al ^ bl;
  for (let i = 0; i < Math.max(al, bl); i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

/* ---------------- Profile token helpers ---------------- */
function getProfileToken(profile) {
  if (!profile) return '';
  // Try several plausible fields in case schema differs
  return String(
    profile.token ||
    profile.deckToken ||
    profile.viewerToken ||
    profile.accessToken ||
    ''
  ).trim();
}

// Fallback scan: find a profile by token if the key lookup fails
function findProfileByToken(linked, wantedToken) {
  if (!wantedToken) return null;
  for (const [uid, prof] of Object.entries(linked || {})) {
    const t = getProfileToken(prof);
    if (t && t === wantedToken) {
      return { uid: String(uid), profile: prof, token: t };
    }
  }
  return null;
}

export default function createTradeRouter(bot) {
  const router = express.Router();

  // POST /trade/start  (bot-only)
  router.post('/trade/start', async (req, res) => {
    try {
      // ⛓️ Accept X-Bot-Key or Authorization: Bearer ... ; env BOT_API_KEY or BOT_KEY
      const headerKey = getBotKeyFromHeaders(req);
      const expected  = (process.env.BOT_API_KEY || process.env.BOT_KEY || '').trim();

      // helpful diagnostics (appears in Railway logs)
      console.log('[auth/trade/start]', {
        hdr_present: !!headerKey,
        env_present: !!expected,
        eq: headerKey && expected ? constantTimeEq(headerKey, expected) : false,
        hdr_len: headerKey ? headerKey.length : 0,
        env_len: expected ? expected.length : 0
      });

      if (!expected) return res.status(500).json({ error: 'Server BOT key not configured' });
      if (!headerKey || !constantTimeEq(headerKey, expected)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Accept either initiatorToken or initiatorId
      const {
        initiatorToken,
        initiatorId: initiatorIdRaw,
        partnerId: partnerIdRaw,
        apiBase,
        meBase,              // ✅ NEW: allow caller to pass ME base
        collectionUiBase
      } = req.body || {};

      if (!partnerIdRaw || (!initiatorToken && !initiatorIdRaw)) {
        return res.status(400).json({ error: 'Missing initiator and/or partner.' });
      }

      // Normalize IDs to strings for map lookups
      const partnerId   = String(partnerIdRaw);
      let   initiatorId = initiatorIdRaw ? String(initiatorIdRaw) : '';

      if (initiatorToken && !initiatorId) {
        const resolved = await resolveUserIdByToken(String(initiatorToken));
        if (!resolved) return res.status(400).json({ error: 'Invalid initiator token' });
        initiatorId = String(resolved);
      }
      if (!initiatorId) {
        return res.status(400).json({ error: 'Cannot resolve initiator' });
      }
      if (initiatorId === partnerId) {
        return res.status(400).json({ error: 'Cannot trade with yourself.' });
      }

      const [linked, limits, tradesBefore] = await Promise.all([
        readJsonRemote(LINKED_DECKS_FILE, {}),
        readJsonRemote(TRADE_LIMITS_FILE, {}),
        readJsonRemote(TRADES_FILE, {})
      ]);

      // Primary lookups
      let iniProfile = linked[initiatorId];
      let parProfile = linked[partnerId];
      let iniToken   = getProfileToken(iniProfile);
      let parToken   = getProfileToken(parProfile);

      // 🔁 Fallback: if initiator not found by key, try to match the token across the file
      if ((!iniProfile || !iniToken) && initiatorToken) {
        const found = findProfileByToken(linked, String(initiatorToken));
        if (found) {
          iniProfile = found.profile;
          iniToken   = found.token;
          // correct initiatorId to the actual key to avoid later mismatches
          initiatorId = found.uid;
        }
      }

      // (Partner usually comes from the dropdown → exact key; token fallback rarely needed.)

      // Small diagnostic so we can see which side is missing
      console.log('[trade/start] profiles', {
        initiatorId, partnerId,
        iniFound: !!iniProfile, parFound: !!parProfile,
        iniHasToken: !!iniToken, parHasToken: !!parToken,
      });

      if (!iniProfile || !iniToken) {
        return res.status(400).json({ error: 'Initiator must be linked first.' });
      }
      if (!parProfile || !parToken) {
        return res.status(400).json({ error: 'Partner must be linked first.' });
      }

      // Enforce 3/day (initiations) — compute from TRADES file (authoritative for "starts today")
      const day = todayStr();
      const usedFromFile = getUsed(limits, initiatorId, day);
      const usedFromTrades = countInitiationsToday(tradesBefore, initiatorId, day);
      const used = Math.max(usedFromTrades, Math.min(usedFromFile, usedFromTrades)); // favor real count
      // Debug to help catch mismatches
      console.log('[trade/start] limit check', { day, initiatorId, usedFromFile, usedFromTrades, used, MAX_PER_DAY });

      if (used >= MAX_PER_DAY) {
        return res.status(429).json({ error: `Trade limit reached (${MAX_PER_DAY}/day).` });
      }

      const sessionId = randomId(20);
      const now = new Date();
      const session = {
        id: sessionId,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_TTL_HOURS*3600*1000).toISOString(),
        status: 'active',           // active | accepted | denied | expired
        stage: 'pickMine',          // pickMine → pickTheirs → decision (initiator picks both sides; partner decides)
        initiator: {
          userId: initiatorId,
          token: iniToken,
          name: iniProfile.discordName || initiatorId,
          selection: [],            // up to 3 (ids)
        },
        partner: {
          userId: partnerId,
          token: parToken,
          name: parProfile.discordName || partnerId,
          selection: [],            // up to 3 (ids)
        },
        // ✅ store bases for consistent deep-links
        apiBase: apiBase || process.env.API_BASE || process.env.api_base || '',
        meBase:  meBase  || process.env.ME_BASE || process.env.me_base  || '',
      };

      // Persist session
      const trades = { ...(tradesBefore || {}) };
      trades[sessionId] = session;
      await writeJsonRemote(TRADES_FILE, trades);

      // Mirror today's count into TRADE_LIMITS_FILE (optional; keeps legacy endpoint happy)
      // We DO NOT rely on this to enforce limits anymore — source of truth is TRADES_FILE scan.
      const limitsCopy = { ...(limits || {}) };
      limitsCopy[initiatorId] ||= {};
      limitsCopy[initiatorId][day] = countInitiationsToday(trades, initiatorId, day);
      await writeJsonRemote(TRADE_LIMITS_FILE, limitsCopy);

      // Build link for initiator (role=initiator)
      const uiBase = (collectionUiBase ||
        process.env.COLLECTION_UI_BASE ||
        process.env.COLLECTION_UI ||
        'https://madv313.github.io/Card-Collection-UI');

      const initLink = buildUiLink({
        base: uiBase,
        token: iniToken,
        apiBase: session.apiBase,   // ✅ use stored
        meBase:  session.meBase,    // ✅ include me=
        sessionId,
        role: 'initiator',
        stage: 'pickMine',
        partnerName: parProfile.discordName || ''
      });

      // ⛔️ Server-side raw URL DM is disabled by default (use SEND_SERVER_TRADE_DM=true to re-enable)
      if (SEND_SERVER_TRADE_DM) {
        try {
          const user = await bot.users.fetch(initiatorId);
          await user.send({
            content: `🔄 **Trade started with <@${partnerId}>**\nSelect up to 3 cards to offer: ${initLink}`
          });
        } catch (e) {
          console.warn('[trade] Failed to DM initiator:', e?.message || e);
        }
      }

      return res.json({
        ok: true,
        sessionId,
        stage: session.stage,
        urlInitiator: initLink,
        message: 'Trade session created.'
      });
    } catch (e) {
      console.error('[trade/start] error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /trade/:session/state
  router.get('/trade/:session/state', async (req, res) => {
    try {
      const { session } = req.params;
      const trades = await readJsonRemote(TRADES_FILE, {});
      const s = trades[session];
      if (!s) return res.status(404).json({ error: 'Session not found' });

      if (hasExpired(s) && s.status === 'active') {
        s.status = 'expired';
        trades[session] = s;
        await writeJsonRemote(TRADES_FILE, trades);
      }

      // Return safe view
      const payload = {
        ok: true,
        id: s.id,
        status: s.status,
        stage: s.stage,
        expiresAt: s.expiresAt,
        initiator: {
          name: s.initiator.name,
          userId: s.initiator.userId,
          selection: s.initiator.selection,
        },
        partner: {
          name: s.partner.name,
          userId: s.partner.userId,
          selection: s.partner.selection,
        }
      };
      return res.json(payload);
    } catch (e) {
      console.error('[trade/state] error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // NEW: GET /trade/:session/collections?token=...
  // Returns role + both collections (with metadata) for session-gated viewing in UI.
  router.get('/trade/:session/collections', async (req, res) => {
    try {
      const { session } = req.params;
      const { token } = req.query || {};
      if (!token) return res.status(400).json({ error: 'Missing token' });

      const trades = await readJsonRemote(TRADES_FILE, {});
      const s = trades[session];
      if (!s) return res.status(404).json({ error: 'Session not found' });

      // Identify which side is requesting
      let role = null;
      if (token === s.initiator.token) role = 'initiator';
      else if (token === s.partner.token) role = 'partner';
      else return res.status(403).json({ error: 'Invalid session token' });

      // Load profiles and card metadata
      const [linked, idx] = await Promise.all([
        readJsonRemote(LINKED_DECKS_FILE, {}),
        loadCardIndex()
      ]);
      const A = linked[s.initiator.userId] || {};
      const B = linked[s.partner.userId] || {};

      const myCol      = role === 'initiator' ? A.collection : B.collection;
      const partnerCol = role === 'initiator' ? B.collection : A.collection;

      return res.json({
        ok: true,
        role,
        status: s.status,
        stage: s.stage,
        me: collectionToArray(myCol || {}, idx),
        partner: collectionToArray(partnerCol || {}, idx)
      });
    } catch (e) {
      console.error('[trade/collections] error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // NEW: GET /trade/:session/summary?token=...
  // Returns both sides’ selections with metadata for a confirmation screen.
  router.get('/trade/:session/summary', async (req, res) => {
    try {
      const { session } = req.params;
      const { token } = req.query || {};
      if (!token) return res.status(400).json({ error: 'Missing token' });

      const trades = await readJsonRemote(TRADES_FILE, {});
      const s = trades[session];
      if (!s) return res.status(404).json({ error: 'Session not found' });

      if (![s.initiator.token, s.partner.token].includes(token)) {
        return res.status(403).json({ error: 'Invalid session token' });
      }

      const idx = await loadCardIndex();
      const mapSel = (arr=[]) => arr.map(id => {
        const m = metaFor(id, idx);
        return { card_id: `#${id}`, id, name: m.name, rarity: m.rarity, filename: m.filename };
      });

      return res.json({
        ok: true,
        status: s.status,
        stage: s.stage,
        initiator: {
          userId: s.initiator.userId,
          name: s.initiator.name,
          selection: mapSel(s.initiator.selection)
        },
        partner: {
          userId: s.partner.userId,
          name: s.partner.name,
          selection: mapSel(s.partner.selection)
        }
      });
    } catch (e) {
      console.error('[trade/summary] error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // POST /trade/:session/select
  // Body: { token, cards: ["001","..."] }
  router.post('/trade/:session/select', async (req, res) => {
    try {
      const { session } = req.params;
      const { token, cards } = req.body || {};
      if (!token || !Array.isArray(cards)) {
        return res.status(400).json({ error: 'Missing token or cards' });
      }
  
      const trades = await readJsonRemote(TRADES_FILE, {});
      const s = trades[session];
      if (!s) return res.status(404).json({ error: 'Session not found' });
      if (hasExpired(s) || s.status !== 'active') {
        s.status = 'expired';
        trades[session] = s;
        await writeJsonRemote(TRADES_FILE, trades);
        return res.status(410).json({ error: 'Session expired' });
      }
  
      const idFromToken = await resolveUserIdByToken(token);
      if (!idFromToken) return res.status(403).json({ error: 'Invalid token' });
  
      const sel = clampCards(cards);
  
      // Initiator selects their cards
      if (s.stage === 'pickMine') {
        if (idFromToken !== s.initiator.userId) {
          return res.status(403).json({ error: 'Not initiator turn' });
        }
        s.initiator.selection = sel;
        s.stage = 'pickTheirs';
        trades[session] = s;
        await writeJsonRemote(TRADES_FILE, trades);
  
        // DM partner to review & pick
        try {
          const uiBase = (process.env.COLLECTION_UI_BASE ||
            process.env.COLLECTION_UI ||
            'https://madv313.github.io/Card-Collection-UI');
          const apiBase = s.apiBase || process.env.API_BASE || process.env.api_base || '';
          const meBase  = s.meBase  || process.env.ME_BASE || process.env.me_base  || '';
          const partnerLink = buildUiLink({
            base: uiBase,
            token: s.partner.token,
            apiBase,
            meBase,
            sessionId: s.id,
            role: 'partner',
            stage: 'pickTheirs',
            partnerName: s.initiator.name
          });
          const partnerUser = await bot.users.fetch(s.partner.userId);
          await partnerUser.send({
            content: `📨 **Trade offer from <@${s.initiator.userId}>**\nSelect up to 3 cards you want to trade in return: ${partnerLink}`
          });
        } catch (e) {
          console.warn('[trade/select] Failed to DM partner:', e?.message || e);
        }
  
        return res.json({
          ok: true,
          stage: s.stage,
          initiator: { selection: s.initiator.selection },
          partner: { selection: s.partner.selection },
          message: 'Your selection is saved. Waiting for partner.'
        });
      }
  
      // Initiator selects FROM partner’s collection
      if (s.stage === 'pickTheirs') {
        if (idFromToken !== s.initiator.userId) {
          return res.status(403).json({ error: 'Not initiator turn' });
        }
        s.partner.selection = sel;           // initiator picks FROM partner’s collection
        s.stage = 'decision';                // next: partner reviews & accepts/denies
        trades[session] = s;
        await writeJsonRemote(TRADES_FILE, trades);
  
        // (Optional) DM partner a link that opens straight to decision stage
        try {
          const uiBase = (process.env.COLLECTION_UI_BASE ||
            process.env.COLLECTION_UI ||
            'https://madv313.github.io/Card-Collection-UI');
          const apiBase = s.apiBase || process.env.API_BASE || process.env.api_base || '';
          const meBase  = s.meBase  || process.env.ME_BASE || process.env.me_base  || '';
          const partnerLink = buildUiLink({
            base: uiBase,
            token: s.partner.token,
            apiBase,
            meBase,
            sessionId: s.id,
            role: 'partner',
            stage: 'decision',
            partnerName: s.initiator.name
          });
          const partnerUser = await bot.users.fetch(s.partner.userId);
          await partnerUser.send({
            content: `📨 **Trade proposal from <@${s.initiator.userId}>**\nReview and decide: ${partnerLink}`
          });
        } catch (e) {
          console.warn('[trade/select] Failed to DM partner (decision):', e?.message || e);
        }
  
        return res.json({
          ok: true,
          stage: s.stage,
          initiator: { selection: s.initiator.selection },
          partner:   { selection: s.partner.selection },
          message: 'Your request is saved. Waiting for partner decision.'
        });
      }
  
      // Any other stage is invalid for /select
      return res.status(400).json({ error: `Cannot select cards during stage "${s.stage}"` });
    } catch (e) {
      console.error('[trade/select] error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // POST /trade/:session/decision
  // Body: { token, decision: "accept"|"deny" } OR { token, accept: true|false }
  router.post('/trade/:session/decision', async (req, res) => {
    try {
      const { session } = req.params;
      const { token } = req.body || {};
      let { decision } = req.body || {};
      const hasAcceptBool = Object.prototype.hasOwnProperty.call(req.body || {}, 'accept');

      if (!token || (typeof decision === 'undefined' && !hasAcceptBool)) {
        return res.status(400).json({ error: 'Missing token or decision' });
      }

      if (hasAcceptBool) {
        decision = req.body.accept ? 'accept' : 'deny';
      }

      if (!['accept','deny'].includes(String(decision))) {
        return res.status(400).json({ error: 'Invalid decision' });
      }

      const trades = await readJsonRemote(TRADES_FILE, {});
      const s = trades[session];
      if (!s) return res.status(404).json({ error: 'Session not found' });
      if (hasExpired(s) || s.status !== 'active') {
        s.status = 'expired';
        trades[session] = s;
        await writeJsonRemote(TRADES_FILE, trades);
        return res.status(410).json({ error: 'Session expired' });
      }

      const userId = await resolveUserIdByToken(token);
      if (!userId || userId !== s.partner.userId) {
        return res.status(403).json({ error: 'Only partner can decide' });
      }
      if (s.stage !== 'decision') {
        return res.status(400).json({ error: 'Not in decision stage' });
      }

      // Load card index once (for thumbnails)
      const idx = await loadCardIndex();

      // Helper to build up to 3 card embeds with thumbnails (with past-tense titles)
      function buildCardEmbeds(ids = [], titlePrefix = '') {
        const embeds = [];
        for (const id of ids) {
          const m = metaFor(id, idx);
          const img = m.filename ? cardImageUrl(m.filename) : cardBackUrl();
          const emb = new EmbedBuilder()
            .setTitle(`${titlePrefix} #${id} — ${m.name}`)
            .setThumbnail(img)
            .setColor(0x00ccff)
            .setFooter({ text: `${m.rarity}${m.type ? ` • ${m.type}` : ''}` });
          embeds.push(emb);
        }
        return embeds;
      }

      if (decision === 'deny') {
        s.status = 'denied';
        trades[session] = s;
        await writeJsonRemote(TRADES_FILE, trades);

        // Build concise headers (mention in description so it renders)
        const headerIniDeny = new EmbedBuilder()
          .setTitle('❌ Trade denied.')
          .setDescription(`With <@${s.partner.userId}>. No cards were exchanged.`)
          .setColor(0xff3b30);

        const headerParDeny = new EmbedBuilder()
          .setTitle('❌ Trade denied.')
          .setDescription(`With <@${s.initiator.userId}>. No cards were exchanged.`)
          .setColor(0xff3b30);

        // DM both sides
        try {
          const u = await bot.users.fetch(s.initiator.userId);
          await u.send({ embeds: [headerIniDeny] });
        } catch {}
        try {
          const p = await bot.users.fetch(s.partner.userId);
          await p.send({ embeds: [headerParDeny] });
        } catch {}

        return res.json({ ok: true, status: s.status, message: 'Trade denied.' });
      }

      // ACCEPT: validate ownership, then swap
      const linked = await readJsonRemote(LINKED_DECKS_FILE, {});
      const A = linked[s.initiator.userId];
      const B = linked[s.partner.userId];
      if (!A?.collection || !B?.collection) {
        return res.status(400).json({ error: 'Profiles unavailable.' });
      }
      const colA = { ...A.collection };
      const colB = { ...B.collection };

      const giveA = s.initiator.selection; // A → B
      const giveB = s.partner.selection;   // B → A

      // Validate A owns giveA
      for (const id of giveA) {
        if ((colA[id] || 0) <= 0) {
          return res.status(409).json({ error: `Initiator no longer owns #${id}` });
        }
      }
      // Validate B owns giveB
      for (const id of giveB) {
        if ((colB[id] || 0) <= 0) {
          return res.status(409).json({ error: `Partner no longer owns #${id}` });
        }
      }

      // Perform swap (1 copy per selection)
      for (const id of giveA) {
        colA[id] = (colA[id] || 0) - 1;
        if (colA[id] <= 0) delete colA[id];
        colB[id] = (colB[id] || 0) + 1;
      }
      for (const id of giveB) {
        colB[id] = (colB[id] || 0) - 1;
        if (colB[id] <= 0) delete colB[id];
        colA[id] = (colA[id] || 0) + 1;
      }

      A.collection = colA;
      B.collection = colB;

      await writeJsonRemote(LINKED_DECKS_FILE, linked);

      s.status = 'accepted';
      trades[session] = s;
      await writeJsonRemote(TRADES_FILE, trades);

      // ✅ Build rich DM receipts with thumbnails for BOTH players
      // Header embeds: mentions in description so they render
      const headerIni = new EmbedBuilder()
        .setTitle('✅ Trade accepted.')
        .setDescription(`With <@${s.partner.userId}>. Cards have been swapped.`)
        .setColor(0x34c759);

      const headerPar = new EmbedBuilder()
        .setTitle('✅ Trade accepted.')
        .setDescription(`With <@${s.initiator.userId}>. Cards have been swapped.`)
        .setColor(0x34c759);

      // Thumbnail card embeds (cap at 3 per side) — titles in past tense
      // Initiator's perspective
      const iniCardThumbs = [
        ...buildCardEmbeds(giveB.slice(0, 3), 'Received'),
        ...buildCardEmbeds(giveA.slice(0, 3), 'Gave')
      ];
      // Partner's perspective
      const parCardThumbs = [
        ...buildCardEmbeds(giveA.slice(0, 3), 'Received'),
        ...buildCardEmbeds(giveB.slice(0, 3), 'Gave')
      ];

      // Send to initiator
      try {
        const ini = await bot.users.fetch(s.initiator.userId);
        await ini.send({ embeds: [headerIni, ...iniCardThumbs] });
      } catch {}

      // Send to partner
      try {
        const par = await bot.users.fetch(s.partner.userId);
        await par.send({ embeds: [headerPar, ...parCardThumbs] });
      } catch {}

      return res.json({
        ok: true,
        status: s.status,
        message: 'Trade accepted and applied.'
      });
    } catch (e) {
      console.error('[trade/decision] error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // GET /me/:token/trade/limits
  router.get('/me/:token/trade/limits', async (req, res) => {
    try {
      const { token } = req.params;
      const userId = await resolveUserIdByToken(String(token||''));
      if (!userId) return res.status(404).json({ error: 'Invalid token' });

      const [limits, trades] = await Promise.all([
        readJsonRemote(TRADE_LIMITS_FILE, {}),
        readJsonRemote(TRADES_FILE, {})
      ]);

      const day = todayStr();
      const usedFromFile = getUsed(limits, userId, day);
      const usedFromTrades = countInitiationsToday(trades, userId, day);
      // Source of truth is the scan; expose that number
      const used = usedFromTrades;

      // Keep legacy file in sync for transparency (optional)
      if ((limits?.[userId]?.[day] || 0) !== used) {
        const copy = { ...(limits || {}) };
        copy[userId] ||= {};
        copy[userId][day] = used;
        await writeJsonRemote(TRADE_LIMITS_FILE, copy);
      }

      const remaining = Math.max(0, MAX_PER_DAY - used);
      return res.json({ ok: true, userId, day, usedToday: used, remaining, maxPerDay: MAX_PER_DAY });
    } catch (e) {
      console.error('[trade/limits] error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
