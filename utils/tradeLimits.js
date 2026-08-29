import { config } from './config.js';
import { PATHS, loadJSON, updateJSONAtomic } from './storageClient.js';

export const utcTradeDay = (date = new Date()) => date.toISOString().slice(0, 10);

function dayOf(value) {
  try { return new Date(value).toISOString().slice(0, 10); }
  catch { return ''; }
}

export function countTradeInitiationsToday(trades = {}, userId, day = utcTradeDay()) {
  const uid = String(userId);
  let used = 0;
  for (const trade of Object.values(trades || {})) {
    if (String(trade?.initiator?.userId || '') !== uid) continue;
    if (dayOf(trade.createdAt) !== day) continue;
    // Once initiated, a denied/accepted/cancelled trade still consumed an initiation.
    // Only sessions explicitly expired before use are excluded to retain the legacy rule.
    if (trade.status === 'expired') continue;
    used += 1;
  }
  return used;
}

export async function getTradeLimitStatus(userId, { syncLedger = true } = {}) {
  const uid = String(userId);
  const day = utcTradeDay();
  const trades = await loadJSON(PATHS.trades).catch(() => ({}));
  const used = countTradeInitiationsToday(trades, uid, day);
  const limit = config.trade.daily_initiation_limit;
  const remaining = Math.max(0, limit - used);

  if (syncLedger) {
    await updateJSONAtomic(PATHS.tradeLimits, ledger => {
      ledger[uid] ||= {};
      ledger[uid][day] = used;
      return ledger;
    }, { defaultValue: {} }).catch(() => {});
  }
  return { day, used, usedToday: used, limit, maxPerDay: limit, remaining };
}
