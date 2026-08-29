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
import { PATHS, loadJSON, updateJSONAtomic } from '../utils/storageClient.js';
import { config, UI } from '../utils/config.js';
import { applyCardExchange, normalizeTradeSelection } from '../utils/tradeCore.js';
import { countTradeInitiationsToday, getTradeLimitStatus, utcTradeDay } from '../utils/tradeLimits.js';

// Decision receipts keep the original rich card-thumbnail behavior.
import { EmbedBuilder } from 'discord.js';

const LINKED_DECKS_FILE = PATHS.linkedDecks;
const TRADES_FILE       = PATHS.trades;
const TRADE_LIMITS_FILE = PATHS.tradeLimits;

const cardListPath      = path.resolve('./logic/CoreMasterReference.json'); // static asset

const MAX_PER_DAY = config.trade.daily_initiation_limit;
const SESSION_TTL_HOURS = config.trade.ttl_hours;

// 🔧 NEW: Toggle whether the server also DMs the initiator on /trade/start
const SEND_SERVER_TRADE_DM = String(process.env.SEND_SERVER_TRADE_DM || 'false').toLowerCase() === 'true';

const todayStr = utcTradeDay;
function randomId(len=24) {
  return crypto.randomBytes(Math.ceil((len*3)/4)).toString('base64url').slice(0, len);
}

// ---- Persistent storage helpers (remote) ----
// ✅ load_file already returns parsed JSON from the persistent service.
//    Handle both object and string just in case a backend ever returns text.
async function readJsonRemote(name, fb) {
  try {
    const raw = await loadJSON(name);
    return raw && typeof raw === 'object' ? raw : fb;
  } catch {
    return fb;
  }
}

// ---- Local read helper for static card master ----
async function readJsonLocal(file, fb) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return fb;
  }
}

function clampCards(cards) { return normalizeTradeSelection(cards, config.trade.max_cards_per_side); }
// Build a Collection UI link following the UI/cog contract:
// ?mode=trade&tradeSession=<id>&role=<initiator|partner>[&stage=...&partner=...]
function buildUiLink({ base, token, apiBase, sessionId, role, stage, partnerName }) {
  const ts = Date.now();
  const qp = new URLSearchParams();
  qp.set('mode', 'trade');
  qp.set('tradeSession', sessionId);
  if (role) qp.set('role', role);
  if (token) qp.set('token', token);
  if (apiBase) qp.set('api', apiBase);
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
  return env || config.image_base || 'https://sv13tcg.com/assets/cards';
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

      const [linked, tradesBefore] = await Promise.all([
        readJsonRemote(LINKED_DECKS_FILE, {}),
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
      const used = countTradeInitiationsToday(tradesBefore, initiatorId, day);
      console.log('[trade/start] limit check', { day, initiatorId, used, MAX_PER_DAY });

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
        apiBase: apiBase || (config.pass_api_query ? config.api_base : ''),
      };

      // Persist with Repo #1 CAS so simultaneous starts cannot bypass the daily limit
      // or overwrite unrelated trade sessions.
      let usedAfter = 0;
      await updateJSONAtomic(TRADES_FILE, current => {
        const usedNow = countTradeInitiationsToday(current, initiatorId, day);
        if (usedNow >= MAX_PER_DAY) throw Object.assign(new Error(`Trade limit reached (${MAX_PER_DAY}/day).`), { status: 429 });
        current[sessionId] = session;
        usedAfter = usedNow + 1;
        return current;
      }, { defaultValue: {} });

      // Mirror the canonical count for older consumers. This ledger is not used to
      // authorize a trade start; the CAS-protected session scan above is authoritative.
      await updateJSONAtomic(TRADE_LIMITS_FILE, current => {
        current[initiatorId] ||= {};
        current[initiatorId][day] = usedAfter;
        return current;
      }, { defaultValue: {} });

      // Build link for initiator (role=initiator)
      const uiBase = (collectionUiBase ||
        process.env.COLLECTION_UI_BASE ||
        process.env.COLLECTION_UI ||
        UI.collection);

      const initLink = buildUiLink({
        base: uiBase,
        token: iniToken,
        apiBase: session.apiBase,   // ✅ use stored
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
      return res.status(e?.status || 500).json({ error: e?.message || 'Internal error' });
    }
  });

  // GET /trade/:session/state
  router.get('/trade/:session/state', async (req, res) => {
    try {
      const { session } = req.params;
      const token = String(req.query?.token || req.get('X-Player-Token') || '');
      if (!token) return res.status(401).json({ error: 'Player token required' });
      const userId = await resolveUserIdByToken(token);
      if (!userId) return res.status(401).json({ error: 'Invalid player token' });
      const trades = await readJsonRemote(TRADES_FILE, {});
      const s = trades[session];
      if (!s) return res.status(404).json({ error: 'Session not found' });
      const role = String(userId) === String(s.initiator.userId) ? 'initiator' : String(userId) === String(s.partner.userId) ? 'partner' : null;
      if (!role) return res.status(403).json({ error: 'Not a participant in this trade' });
      if (hasExpired(s) && s.status === 'active') {
        s.status = 'expired';
        await updateJSONAtomic(TRADES_FILE, current => { if (current?.[session]?.status === 'active' && hasExpired(current[session])) current[session].status = 'expired'; return current; }, { defaultValue: {} });
      }
      return res.json({
        ok: true, id: s.id, status: s.status, stage: s.stage, expiresAt: s.expiresAt, role,
        initiator: { name: s.initiator.name, selection: s.initiator.selection },
        partner: { name: s.partner.name, selection: s.partner.selection }
      });
    } catch (e) {
      console.error('[trade/state] error:', e);
      return res.status(e?.status || 500).json({ error: e?.message || 'Internal error' });
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

      // Resolve the current canonical player token to a participant. Do not treat
      // role= or a stale token copied into the trade record as authorization.
      const viewerId = await resolveUserIdByToken(String(token));
      let role = null;
      if (String(viewerId) === String(s.initiator.userId)) role = 'initiator';
      else if (String(viewerId) === String(s.partner.userId)) role = 'partner';
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

      const viewerId = await resolveUserIdByToken(String(token));
      if (![String(s.initiator.userId), String(s.partner.userId)].includes(String(viewerId || ''))) {
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
      if (!token || !Array.isArray(cards)) return res.status(400).json({ error: 'Missing token or cards' });
      const idFromToken = await resolveUserIdByToken(String(token));
      if (!idFromToken) return res.status(403).json({ error: 'Invalid token' });
      const sel = clampCards(cards);

      let after = null;
      await updateJSONAtomic(TRADES_FILE, trades => {
        const trade = trades?.[session];
        if (!trade) throw Object.assign(new Error('Session not found'), { status: 404 });
        if (hasExpired(trade) || trade.status !== 'active') {
          if (trade.status === 'active') trade.status = 'expired';
          throw Object.assign(new Error('Session expired'), { status: 410 });
        }
        if (idFromToken !== trade.initiator.userId) throw Object.assign(new Error('Not initiator turn'), { status: 403 });
        if (trade.stage === 'pickMine') {
          trade.initiator.selection = sel;
          trade.stage = 'pickTheirs';
        } else if (trade.stage === 'pickTheirs') {
          trade.partner.selection = sel;
          trade.stage = 'decision';
        } else {
          throw Object.assign(new Error(`Cannot select cards during stage "${trade.stage}"`), { status: 400 });
        }
        trade.updatedAt = new Date().toISOString();
        trade.revision = Number(trade.revision || 0) + 1;
        after = structuredClone(trade);
        trades[session] = trade;
        return trades;
      }, { defaultValue: {} });

      // Preserve the original partner notification flow. role= is display context only;
      // authorization remains token/session based on every API call.
      try {
        const uiBase = process.env.COLLECTION_UI_BASE || process.env.COLLECTION_UI || UI.collection;
        const partnerLink = buildUiLink({
          base: uiBase,
          token: after.partner.token,
          apiBase: after.apiBase || '',
          sessionId: after.id,
          role: 'partner',
          stage: after.stage,
          partnerName: after.initiator.name
        });
        const partnerUser = await bot.users.fetch(after.partner.userId);
        const content = after.stage === 'decision'
          ? `📨 **Trade proposal from <@${after.initiator.userId}>**\nReview and decide: ${partnerLink}`
          : `📨 **Trade offer from <@${after.initiator.userId}>**\nSelect up to 3 cards you want to trade in return: ${partnerLink}`;
        await partnerUser.send({ content });
      } catch (e) {
        console.warn('[trade/select] Failed to DM partner:', e?.message || e);
      }

      return res.json({
        ok: true,
        stage: after.stage,
        initiator: { selection: after.initiator.selection },
        partner: { selection: after.partner.selection },
        message: after.stage === 'decision'
          ? 'Your request is saved. Waiting for partner decision.'
          : 'Your selection is saved. Waiting for partner.'
      });
    } catch (e) {
      console.error('[trade/select] error:', e);
      return res.status(e?.status || 500).json({ error: e?.message || 'Internal error' });
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
      if (!token || (typeof decision === 'undefined' && !hasAcceptBool)) return res.status(400).json({ error: 'Missing token or decision' });
      if (hasAcceptBool) decision = req.body.accept ? 'accept' : 'deny';
      decision = String(decision || '').toLowerCase();
      if (!['accept','deny'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });

      const userId = await resolveUserIdByToken(String(token));
      if (!userId) return res.status(403).json({ error: 'Invalid player token' });

      let snapshot = null;
      if (decision === 'deny') {
        await updateJSONAtomic(TRADES_FILE, trades => {
          const trade = trades?.[session];
          if (!trade) throw Object.assign(new Error('Session not found'), { status: 404 });
          if (hasExpired(trade)) { trade.status = 'expired'; throw Object.assign(new Error('Session expired'), { status: 410 }); }
          if (String(userId) !== String(trade.partner.userId)) throw Object.assign(new Error('Only partner can decide'), { status: 403 });
          if (trade.status !== 'active' || trade.stage !== 'decision') throw Object.assign(new Error('Trade is not awaiting a decision'), { status: 409 });
          trade.status = 'denied'; trade.stage = 'done'; trade.updatedAt = new Date().toISOString(); trade.revision = Number(trade.revision || 0) + 1;
          snapshot = structuredClone(trade); trades[session] = trade; return trades;
        }, { defaultValue: {} });

        const headerIniDeny = new EmbedBuilder().setTitle('❌ Trade denied.').setDescription(`With <@${snapshot.partner.userId}>. No cards were exchanged.`).setColor(0xff3b30);
        const headerParDeny = new EmbedBuilder().setTitle('❌ Trade denied.').setDescription(`With <@${snapshot.initiator.userId}>. No cards were exchanged.`).setColor(0xff3b30);
        try { const u = await bot.users.fetch(snapshot.initiator.userId); await u.send({ embeds: [headerIniDeny] }); } catch {}
        try { const u = await bot.users.fetch(snapshot.partner.userId); await u.send({ embeds: [headerParDeny] }); } catch {}
        return res.json({ ok: true, status: 'denied', message: 'Trade denied.' });
      }

      // Claim this decision before touching player collections. The applying state prevents
      // double application from duplicate clicks or concurrent requests.
      await updateJSONAtomic(TRADES_FILE, trades => {
        const trade = trades?.[session];
        if (!trade) throw Object.assign(new Error('Session not found'), { status: 404 });
        if (hasExpired(trade)) { trade.status = 'expired'; throw Object.assign(new Error('Session expired'), { status: 410 }); }
        if (String(userId) !== String(trade.partner.userId)) throw Object.assign(new Error('Only partner can decide'), { status: 403 });
        if (trade.status === 'applying') throw Object.assign(new Error('Trade application is already in progress'), { status: 409 });
        if (trade.status === 'accepted') { snapshot = structuredClone(trade); return trades; }
        if (trade.status !== 'active' || trade.stage !== 'decision') throw Object.assign(new Error('Trade is not awaiting a decision'), { status: 409 });
        trade.status = 'applying'; trade.applyingAt = new Date().toISOString(); trade.updatedAt = trade.applyingAt; trade.revision = Number(trade.revision || 0) + 1;
        snapshot = structuredClone(trade); trades[session] = trade; return trades;
      }, { defaultValue: {} });

      if (snapshot.status === 'accepted') return res.json({ ok: true, status: 'accepted', message: 'Trade already accepted and applied.' });

      const giveA = clampCards(snapshot.initiator.selection);
      const giveB = clampCards(snapshot.partner.selection);
      try {
        await updateJSONAtomic(LINKED_DECKS_FILE, linked =>
          applyCardExchange(linked, snapshot, { maxCards: config.trade.max_cards_per_side }).linked,
        { defaultValue: {} });
      } catch (e) {
        await updateJSONAtomic(TRADES_FILE, trades => {
          const trade = trades?.[session];
          if (trade?.status === 'applying') { trade.status = 'active'; trade.stage = 'decision'; trade.applyError = String(e?.message || e).slice(0, 200); trade.updatedAt = new Date().toISOString(); trade.revision = Number(trade.revision || 0) + 1; }
          return trades;
        }, { defaultValue: {} }).catch(() => {});
        throw e;
      }

      await updateJSONAtomic(TRADES_FILE, trades => {
        const trade = trades?.[session];
        if (!trade) throw Object.assign(new Error('Session disappeared after exchange'), { status: 500 });
        if (trade.status !== 'applying') throw Object.assign(new Error(`Unexpected trade status ${trade.status}`), { status: 409 });
        trade.status = 'accepted'; trade.stage = 'done'; trade.acceptedAt = new Date().toISOString(); trade.updatedAt = trade.acceptedAt; trade.revision = Number(trade.revision || 0) + 1; delete trade.applyError;
        snapshot = structuredClone(trade); trades[session] = trade; return trades;
      }, { defaultValue: {} });

      const idx = await loadCardIndex();
      function buildCardEmbeds(ids = [], titlePrefix = '') {
        return ids.slice(0,3).map(id => {
          const m = metaFor(id, idx); const img = m.filename ? cardImageUrl(m.filename) : cardBackUrl();
          return new EmbedBuilder().setTitle(`${titlePrefix} #${id} — ${m.name}`).setThumbnail(img).setColor(0x00ccff).setFooter({ text: `${m.rarity}${m.type ? ` • ${m.type}` : ''}` });
        });
      }
      const headerIni = new EmbedBuilder().setTitle('✅ Trade accepted.').setDescription(`With <@${snapshot.partner.userId}>. Cards have been swapped.`).setColor(0x34c759);
      const headerPar = new EmbedBuilder().setTitle('✅ Trade accepted.').setDescription(`With <@${snapshot.initiator.userId}>. Cards have been swapped.`).setColor(0x34c759);
      const iniCardThumbs = [...buildCardEmbeds(giveB,'Received'), ...buildCardEmbeds(giveA,'Gave')];
      const parCardThumbs = [...buildCardEmbeds(giveA,'Received'), ...buildCardEmbeds(giveB,'Gave')];
      try { const u = await bot.users.fetch(snapshot.initiator.userId); await u.send({ embeds: [headerIni, ...iniCardThumbs] }); } catch {}
      try { const u = await bot.users.fetch(snapshot.partner.userId); await u.send({ embeds: [headerPar, ...parCardThumbs] }); } catch {}
      return res.json({ ok: true, status: 'accepted', message: 'Trade accepted and applied.' });
    } catch (e) {
      console.error('[trade/decision] error:', e);
      return res.status(e?.status || 500).json({ error: e?.message || 'Internal error' });
    }
  });

  // GET /me/:token/trade/limits
  router.get('/me/:token/trade/limits', async (req, res) => {
    try {
      const { token } = req.params;
      const userId = await resolveUserIdByToken(String(token||''));
      if (!userId) return res.status(404).json({ error: 'Invalid token' });

      const status = await getTradeLimitStatus(userId);
      return res.json({ ok: true, ...status });
    } catch (e) {
      console.error('[trade/limits] error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
