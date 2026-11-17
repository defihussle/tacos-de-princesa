// Audit harness: runs worker/index.js under Node with Clover mocked.
// READ-ONLY against the repo; nothing in the repo is modified.
// The Worker under test is imported relative to this file (tests/ is at the
// repo root), so the suite is portable.
const WORKER_URL = new URL('../worker/index.js', import.meta.url).href;

// ---- controllable clock ----------------------------------------------------
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { a.length ? super(...a) : super(FakeDate._now); }
  static now() { return FakeDate._now; }
}
FakeDate._now = RealDate.now();
globalThis.Date = FakeDate;
export function setNow(iso) { FakeDate._now = RealDate.parse(iso); }

// ---- immediate timers (record requested delays) ----------------------------
// Timers fire immediately but record the requested delay. With advanceClock on,
// each scheduled delay also advances the virtual clock, so background work that
// uses sleepUntil() reflects real elapsed time (used to assert the ~30 s budget).
const realSetTimeout = globalThis.setTimeout;
export const delays = [];
let advanceClock = false;
export function setAdvanceClock(on) { advanceClock = !!on; }
export function now() { return FakeDate._now; }
globalThis.setTimeout = function (cb, ms, ...rest) {
  const d = ms | 0;
  delays.push(d);
  if (advanceClock) FakeDate._now += d;
  return realSetTimeout(cb, 0, ...rest);
};

// ---- captured logs ----------------------------------------------------------
export const logs = [];
const realLog = console.log, realErr = console.error;
console.log = (...a) => { logs.push(['log', a.join(' ')]); };
console.error = (...a) => { logs.push(['err', a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')]); };
export function logText() { return logs.map(l => l[1]).join('\n'); }
export function resetLogs() { logs.length = 0; }
export function restoreConsole() { console.log = realLog; console.error = realErr; }

// ---- fake Clover ------------------------------------------------------------
// state.script: ordered reactions keyed by matcher; state.calls records all.
export const clover = {
  calls: [],
  // handlers: { atomic, pay, getOrder, delOrder, print, printState, taxRate, orderType }
  handlers: {},
  reset() { this.calls = []; this.handlers = {}; },
};
function jsonRes(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}
// Like jsonRes but lets a test set response headers (e.g. Retry-After on a 429).
export function httpRes(status, body, headers) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
  });
}
globalThis.fetch = async function (url, init = {}) {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch (e) { body = init.body || null; } // siteverify is form-encoded
  const rec = { url: u, method, body, headers: init.headers || {} };
  clover.calls.push(rec);
  const h = clover.handlers;
  // Turnstile siteverify (default: success) — only hit when a test sets TURNSTILE_SECRET.
  if (/\/turnstile\/v0\/siteverify$/.test(u)) {
    rec.route = 'turnstile';
    const tfn = h.turnstile || (() => ({ body: { success: true, hostname: 'preview.example', action: 'order' } }));
    const out = await tfn(rec, u);
    if (out instanceof Response) return out;
    if (out && out.throw) throw new TypeError('fetch failed (simulated network error)');
    return jsonRes(out.status ?? 200, out.body);
  }
  const route =
    /\/atomic_order\/orders$/.test(u) && method === 'POST' ? 'atomic' :
    /\/v1\/orders\/[^/]+\/pay$/.test(u) && method === 'POST' ? 'pay' :
    /\/print_event$/.test(u) && method === 'POST' ? 'print' :
    /\/print_event\/[^/]+$/.test(u) && method === 'GET' ? 'printState' :
    /\/orders\/[^/]+$/.test(u) && method === 'GET' ? 'getOrder' :
    /\/orders\/[^/]+$/.test(u) && method === 'DELETE' ? 'delOrder' :
    /\/tax_rates\//.test(u) ? 'taxRate' :
    /\/order_types\//.test(u) ? 'orderType' : 'other';
  rec.route = route;
  const fn = h[route];
  if (!fn) throw new TypeError('fetch failed (no handler for ' + route + ': ' + u + ')');
  const out = await fn(rec, u);
  if (out instanceof Response) return out;
  if (out && out.throw) throw new TypeError('fetch failed (simulated network error)');
  return jsonRes(out.status ?? 200, out.body);
};

// ---- fake email binding -----------------------------------------------------
export const emails = [];
export function makeEnv(overrides = {}) {
  return Object.assign({
    ORDERING_OPEN: 'true',
    STORES_ENABLED: 'one-york',
    CLOSED_DATES: '',
    CLOVER_ENV: 'sandbox',
    CLOVER_CURRENCY: 'usd',
    CLOVER_MERCHANT_ID: '2N9FRNJANSV31',
    CLOVER_PUBLIC_KEY: 'pub-test',
    CLOVER_TAX_RATE_ID: 'TAXID',
    CLOVER_PRIVATE_TOKEN: 'secret-test-token',
    ALERT_EMAILS: 'owner@example.ca,second@example.ca',
    ALERT_FROM: 'alerts@tacosprincesa.ca',
    ALERT_EMAIL: { send: async (msg) => { emails.push(msg); } },
    BUILD_COMMIT: 'audit',
    // Bot/rate defences. RATE_LIMITER uses the real DO class (above). Turnstile
    // is OFF by default (no secret -> skipped in sandbox); tests set it on.
    RATE_LIMITER: rateLimiterNS,
    RATE_ORDER_LIMIT: '20', RATE_ORDER_WINDOW_S: '60',
    RATE_FAIL_LIMIT: '5', RATE_FAIL_WINDOW_S: '600',
  }, overrides);
}

// ---- driver -----------------------------------------------------------------
const mod = await import(WORKER_URL);
export const worker = mod.default;
export const RateLimiter = mod.RateLimiter;

// ---- fake RateLimiter Durable Object namespace ------------------------------
// Backed by the REAL RateLimiter class + in-memory storage, so tests exercise
// the actual windowing logic. Keyed by IP (idFromName). reset() clears all IPs.
const doStore = {};
function fakeDO() {
  const mem = new Map();
  const storage = {
    get: async (k) => (mem.has(k) ? mem.get(k) : undefined),
    put: async (k, v) => { mem.set(k, v); },
    deleteAll: async () => { mem.clear(); },
    getAlarm: async () => (mem.has('__alarm') ? mem.get('__alarm') : null),
    setAlarm: async (t) => { mem.set('__alarm', t); },
  };
  return new RateLimiter({ storage });
}
let doCallCount = 0;
export function doCalls() { return doCallCount; }
export const rateLimiterNS = {
  idFromName(ip) { return ip; },
  get(id) {
    doCallCount += 1;
    const inst = doStore[id] || (doStore[id] = fakeDO());
    return { fetch: (u, init) => inst.fetch(new Request(u, init)) };
  },
};
export function resetRateLimiter() { for (const k in doStore) delete doStore[k]; doCallCount = 0; }

export async function post(env, body, opts = {}) {
  const jobs = [];
  const ctx = { waitUntil: (p) => jobs.push(p.catch ? p : Promise.resolve(p)) };
  // Same-origin by default (the Worker now requires it), with a default caller IP
  // for rate limiting. opts.headers overrides; opts.omitOrigin drops Origin.
  const headers = Object.assign(
    { 'content-type': 'application/json', origin: 'https://preview.example', 'cf-connecting-ip': opts.ip || '203.0.113.1' },
    opts.headers || {},
  );
  if (opts.omitOrigin) delete headers.origin;
  const method = opts.method || 'POST';
  const req = new Request('https://preview.example' + (opts.path || '/api/create-order'), {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : (opts.raw !== undefined ? opts.raw : JSON.stringify(body)),
  });
  const res = await worker.fetch(req, env, ctx);
  const data = await res.json().catch(() => null);
  await Promise.all(jobs).catch(() => {});
  return { status: res.status, data, jobs: jobs.length };
}
export async function get(env, path, headers) {
  const res = await worker.fetch(new Request('https://preview.example' + path, { headers: headers || {} }), env, { waitUntil() {} });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// handy fixtures
export const MONDAY_NOON = '2026-11-16T17:00:00Z'; // Mon 12:00 Toronto (EST)
export function goodBody(over = {}) {
  return Object.assign({
    source: 'clv_1234567890abcdef',
    cart: [{ item: 'tacos/pollo', qty: 1, mods: [{ g: 'guac', label: 'Add guacamole' }], note: 'no salt' }],
    pickup: { name: 'Audit Tester', phone: '647-555-0123', location: 'one-york', asap: true, time: null },
  }, over);
}
export function happyHandlers(total) {
  return {
    atomic: () => ({ body: { id: 'ORD123', total } }),
    pay: () => ({ body: { id: 'PAY1', status: 'succeeded' } }),
    print: () => ({ body: { id: 'JOB1' } }),
    printState: () => jsonRes(404, { message: 'not found' }),
    delOrder: () => ({ body: {} }),
    getOrder: () => ({ body: { id: 'ORD123', paymentState: 'OPEN' } }),
    taxRate: (r, u) => ({ body: { id: decodeURIComponent(u.split('/').pop()) } }),
    orderType: (r, u) => ({ body: { id: decodeURIComponent(u.split('/').pop()) } }),
  };
}
