// Authenticated JSON storage client for the private sv13-tcg-data service.
// Node 20+ native fetch is used so there is one HTTP implementation.

const storageBase = () => String(process.env.PERSISTENT_DATA_URL || '').trim().replace(/\/+$/, '');
const storageKey = () => String(process.env.STORAGE_KEY || '');
const RETRIES = Math.max(0, Number(process.env.STORAGE_RETRIES || 3));
const TIMEOUT_MS = Math.max(1000, Number(process.env.STORAGE_TIMEOUT_MS || 12000));
const RETRY_BASE_MS = Math.max(25, Number(process.env.STORAGE_RETRY_BASE_MS || 250));

export class StorageError extends Error {
  constructor(message, { status = 0, path = '', body = '', cause } = {}) {
    super(message, { cause });
    this.name = 'StorageError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const baseRequired = () => {
  const base = storageBase();
  if (!base) throw new StorageError('PERSISTENT_DATA_URL is not configured');
  return base;
};
const urlFor = filename => `${baseRequired()}/${String(filename || '').replace(/^\/+/, '')}`;

function authHeaders(extra = {}) {
  const headers = { 'Cache-Control': 'no-store', ...extra };
  const key = storageKey();
  if (key) headers['X-Storage-Key'] = key;
  return headers;
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (cause) {
    throw new StorageError(`Storage request failed: ${cause?.message || cause}`, { cause });
  } finally {
    clearTimeout(timer);
  }
}

async function parseJson(res, path) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch (cause) {
    throw new StorageError(`Invalid JSON returned for ${path}`, { status: res.status, path, body: text.slice(0, 1000), cause });
  }
}

async function throwFor(res, path) {
  const body = await res.text().catch(() => '');
  throw new StorageError(`Storage ${res.status} for ${path}`, { status: res.status, path, body: body.slice(0, 1000) });
}

export async function loadJSONWithMeta(filename, { allowMissing = false } = {}) {
  const url = urlFor(filename);
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await request(url, { method: 'GET', headers: authHeaders() });
      if (allowMissing && res.status === 404) return { data: null, etag: null, missing: true };
      if (!res.ok) await throwFor(res, filename);
      return { data: await parseJson(res, filename), etag: res.headers.get('etag'), missing: false };
    } catch (error) {
      last = error;
      if (error?.status && error.status < 500 && ![409, 412, 429].includes(error.status)) throw error;
      if (attempt < RETRIES) await sleep(RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw last;
}

export async function loadJSON(filename) {
  return (await loadJSONWithMeta(filename)).data;
}

export async function saveJSON(filename, data, { ifMatch } = {}) {
  const url = urlFor(filename);
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const headers = authHeaders({ 'Content-Type': 'application/json' });
      if (ifMatch) headers['If-Match'] = ifMatch;
      const res = await request(url, { method: 'PUT', headers, body: JSON.stringify(data) });
      if (!res.ok) await throwFor(res, filename);
      let response = {};
      try { response = await parseJson(res, filename); } catch { response = {}; }
      return { ok: true, etag: res.headers.get('etag'), data: response };
    } catch (error) {
      last = error;
      if ([409, 412].includes(error?.status)) throw error;
      if (error?.status && error.status < 500 && error.status !== 429) throw error;
      if (attempt < RETRIES) await sleep(RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw last;
}

export async function deleteJSON(filename, { ifMatch } = {}) {
  const headers = authHeaders();
  if (ifMatch) headers['If-Match'] = ifMatch;
  const res = await request(urlFor(filename), { method: 'DELETE', headers });
  if (res.status === 404) return false;
  if (!res.ok) await throwFor(res, filename);
  return true;
}

export async function updateJSONAtomic(filename, mutator, { defaultValue, retries = RETRIES } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const current = await loadJSONWithMeta(filename, { allowMissing: defaultValue !== undefined });
    const base = current.missing ? structuredClone(defaultValue) : current.data;
    const next = await mutator(structuredClone(base));
    if (next === undefined) throw new StorageError(`Mutator for ${filename} returned undefined`, { path: filename });
    try {
      // Missing first-write has no ETag because Repo #1 intentionally implements If-Match, not create-if-absent.
      // Initialize canonical files during deployment to avoid this one-time race.
      await saveJSON(filename, next, { ifMatch: current.etag || undefined });
      return next;
    } catch (error) {
      if ([409, 412].includes(error?.status) && attempt < retries) {
        await sleep(RETRY_BASE_MS * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  throw new StorageError(`Atomic update exhausted retries for ${filename}`, { path: filename });
}

export async function loadOrInitJSON(filename, defaultValue = {}) {
  const current = await loadJSONWithMeta(filename, { allowMissing: true });
  if (!current.missing) return current.data;
  await saveJSON(filename, defaultValue);
  return structuredClone(defaultValue);
}

export async function healthCheck() {
  const base = storageBase();
  if (!base) return false;
  try {
    const res = await request(`${base}/_health`, { method: 'GET', headers: authHeaders() });
    return res.ok;
  } catch { return false; }
}

export async function load_file(filename) { return loadJSON(filename); }
export async function save_file(filename, data) { await saveJSON(filename, data); return data; }

export const PATHS = Object.freeze({
  linkedDecks: 'data/linked_decks.json',
  wallet: 'data/coin_bank.json',
  coinBank: 'data/coin_bank.json', // compatibility alias
  playerData: 'data/player_data.json',
  trades: 'data/trades.json',
  tradeLimits: 'data/trade_limits.json',
  tradeQueue: 'data/trade_queue.json',
  sellsByDay: 'data/sells_by_day.json',
  currentDuelLog: 'data/logs/current_duel_log.json',
  duelLogCurrent: 'data/logs/current_duel_log.json',
  summariesDir: 'data/summaries',
  packRevealsDir: 'data/pack_reveals',
  // Internal session persistence lives under the Repo #1-approved summaries prefix.
  duelSessionsDir: 'data/summaries/_sessions',
  duelSessionIndex: 'data/summaries/_sessions/index.json',
  summaryFor: id => `data/summaries/${safeId(id)}.json`,
  packRevealFor: id => `data/pack_reveals/${safeId(id)}.json`,
  duelSessionFor: id => `data/summaries/_sessions/${safeId(id)}.json`,
  summaryFile: id => `data/summaries/${safeId(id)}.json`, // legacy helper alias
});

function safeId(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new StorageError('Invalid storage identifier');
  return id;
}
