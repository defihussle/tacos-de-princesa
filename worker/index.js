/* ==========================================================================
   Tacos De Princesa — worker/index.js
   The site is static files (wrangler.toml [assets]); this Worker only runs
   for /api/* (run_worker_first) and anything without a matching file.

   GET /api/config
     What the ordering page needs: { environment, sdkUrl, orderingOpen,
     closedDates, phone, stores: { 'one-york': { publicKey, merchantId } } }.
     Only enabled stores are listed; nothing secret is in it.

   POST /api/create-order   (JSON, same-site only)
     { source: 'clv_…', cart: [{ item, qty, mods: [{ g, label }], note }],
       pickup: { name, phone, location, asap, time: 'YYYY-MM-DDTHH:MM' | null } }
   Checks everything (ordering open, store enabled, same-day pickup while
   open), prices the cart from worker/menu.js (browser prices are never
   trusted), creates a Clover atomic order with the store's settings, pays
   it with the card token, then sends it to the kitchen printer. An order
   that isn't paid is deleted, so it never reaches the kitchen. Clover calls
   that are safe to repeat are retried on a rate-limit answer; the pay call is
   retried once (same idempotency key). After a failed/retried pay the order is
   read: PAID is a success, a removed or unpaid order means no charge (clear
   message), and only an unreadable order is "unconfirmed" — then the customer
   is told to call us (never to re-order) and it's reconciled in the background
   (paid -> printed, unpaid -> deleted, removed/unknown -> staff emailed).
   The whole create/pay/settle flow is registered with ctx.waitUntil from the
   start and the response awaits it, so a customer who closes the tab mid-payment
   is still charged-and-printed or not-charged, never left silent. The customer
   waits at most ~15 s for an answer; past that they get the "couldn't confirm"
   answer and we settle in the background.
   Online orders are taken Mon-Fri from opening (10:30) until 17:30, never on
   holidays (worker/hours.js); pickup is the same day, ASAP or a 15-minute
   slot up to 17:45.
   Printing happens in that same background task: one retry if Clover refuses,
   then the job's state is checked ~12 s and ~20 s after printing. If it failed
   or hasn't printed, ONE alert email goes to ALERT_EMAILS. All background work
   (and its alert) is timed to finish within ~30 s of the response OR the client
   disconnect, which is when Cloudflare cancels waitUntil work; the staff alert
   goes out before any part that might be cut. (A later check would need a Queue.)
   Each dish is sent as the Clover inventory item it is (worker/clover-ids.js):
   { item: { id }, modifications: [{ modifier: { id }, name, amount }], note },
   so Clover fills in the name, price, tax and labels (which route it to the
   right printer and KDS). Fails closed: if anything in the cart has no
   Clover ID for this environment, the order is refused, never sent by name.
     -> 200 { success: true, orderId, total }
     -> 4xx/5xx { success: false, error }   (error is shown to the customer)

   GET /api/health
     Ordering open, enabled stores and, per store, which settings are set
     and a live Clover check of its tax rate and order type: yes/no and
     ok/fail only, never values. Plus the commit it was built from
     (BUILD_COMMIT, set by scripts/deploy-preview.sh), and menu: whether
     every website item and option has a Clover ID for this environment
     (missing keys listed) and whether each store's merchant has those IDs.

   SETTINGS (wrangler.toml [vars] / [previews.vars] / [env.livetest.vars])
     ORDERING_OPEN       "true" to take orders; anything else pauses them
     STORES_ENABLED      stores taking orders, e.g. "one-york" or
                         "one-york,king-st-w"
     CLOSED_DATES        days with no pickups (PATH holidays), Toronto dates:
                         "2026-12-25,2026-12-28"; empty for none
     CLOVER_ENV          "sandbox" or "production"
     CLOVER_CURRENCY     "usd" (sandbox test merchant) or "cad"
     ALERT_EMAILS        who gets "order didn't print" emails, comma-separated
                         (each must be a verified Email Routing destination)
     ALERT_FROM          the sender, an address on tacosprincesa.ca
   Binding ALERT_EMAIL (send_email) sends them.
   Per store, each of these can be suffixed with the store (_ONE_YORK,
   _KING_ST_W) to override the shared value, e.g. CLOVER_MERCHANT_ID_ONE_YORK:
     CLOVER_MERCHANT_ID, CLOVER_PUBLIC_KEY, CLOVER_TAX_RATE_ID,
     CLOVER_ORDER_TYPE_ID (required in production),
     CLOVER_PRIVATE_TOKEN (a secret: never in wrangler.toml)

   GOING LIVE: see docs/go-live.md.

   NOT DONE YET (known gaps)
   - Timing: scheduled pickups print as soon as they're paid; holding them
     until 20 minutes before pickup needs a scheduled job (Cron Trigger plus
     storage such as KV or a Durable Object).
   - If Clover creates the order but its OWN reply to the create call is lost
     (a timeout before the ID arrives), that unpaid order can't be cleaned up
     here — the ID never reaches us. (A dropped client connection is handled:
     the flow runs under ctx.waitUntil and finishes server-side.)
   ========================================================================== */

import { GROUPS, ITEMS, TAX_RATE } from './menu.js';
import { CLOVER_IDS } from './clover-ids.js';
import { HOURS, PICKUP, torontoNow, orderingWindow, pickupSlots, toMinutes, clockText } from './hours.js';
import { RateLimiter } from './ratelimit.js';

// The per-IP rate limiter Durable Object (bound as RATE_LIMITER in wrangler.toml)
// must be exported from the Worker's entrypoint.
export { RateLimiter };

const CLOVER_URLS = {
  sandbox: { api: 'https://apisandbox.dev.clover.com', ecom: 'https://scl-sandbox.dev.clover.com', sdk: 'https://checkout.sandbox.dev.clover.com/sdk.js' },
  production: { api: 'https://api.clover.com', ecom: 'https://scl.clover.com', sdk: 'https://checkout.clover.com/sdk.js' },
};

// Stores (opening hours and pickup rules: worker/hours.js).
// suffix: the store's settings suffix.
const LOCATIONS = {
  'king-st-w': { label: 'King St W (150 King St W, in the PATH)', suffix: 'KING_ST_W' },
  'one-york': { label: 'One York (One York Street, 2nd Floor)', suffix: 'ONE_YORK' },
};

// A slot offered a few minutes ago may now be slightly too soon
const SLOT_GRACE_MINUTES = 10;

// Create and pay call timeouts (ms). The customer waits for these, so they're
// kept short and also capped by CUSTOMER_DEADLINE_MS below.
const CREATE = { timeoutMs: 7000 };
const PAY = { timeoutMs: 6000 };

// The customer never waits longer than this for an answer. If create + pay +
// the confirming read would take longer, we stop, give the "couldn't confirm"
// answer and finish in the background. READ_FLOOR_MS: the smallest window worth
// doing the confirming read in; below it we skip straight to the background.
const CUSTOMER_DEADLINE_MS = 15000;
const READ_FLOOR_MS = 2000;

// Background work (print checks, reconcile) runs under ctx.waitUntil, which
// Cloudflare may cancel ~30 s after the response is sent OR the client
// disconnects. The whole create -> pay -> settle flow is registered with
// waitUntil, so it survives a disconnect; BG_BUDGET_MS is measured from the
// flow's start and kept under 30 s so the final alert email still goes out.
// ALERT_RESERVE_MS is the room left after the last Clover call for that email.
const BG_BUDGET_MS = 27000;
const ALERT_RESERVE_MS = 1500;

// Retry Clover calls that are safe to repeat (create, print, order reads,
// delete) when Clover rate-limits us: up to RETRY.attempts tries total, short
// backoff, honouring Retry-After (capped). Clover allows ~16 req/s and 5
// concurrent per token, so a lunch-rush burst can be briefly throttled (429);
// a quick retry rides it out. Never used for the pay call (see settleOrder).
const RETRY = { attempts: 3, backoffMs: [250, 750], retryAfterCapMs: 2000 };

// Printing (see the header): Clover call timeouts and when the job is checked
// (ms after printing). Timed so that, even if every Clover reply hits its
// timeout, the last check and its alert finish before the ~30 s budget.
// checksReconcileMs/reconcileRetryMs are the compressed schedule used when
// printing happens after a background reconcile has spent part of the budget.
const PRINT = {
  timeoutMs: 6000, stateTimeoutMs: 2500, retryAfterMs: 5000, checksMs: [12000, 20000],
  checksReconcileMs: [5000, 9000], reconcileRetryMs: 2000,
};

// When a pay answer can't be read, the customer is told we couldn't confirm it;
// in the background we re-read the order's payment state a few times, then
// settle it (print / delete / leave). settleReserveMs is the budget held back
// after the last read to print or delete and email within the ~30 s.
// A reconcile re-reads the order and settles it. settleMs: never delete until a
// read at least this long after the last pay attempt still shows it unpaid (a
// slow charge can still land in that window). actReserveMs: budget held back
// after a read to act on it (delete + email); if a verdict read + that reserve
// won't fit, the order is LEFT and staff emailed, never deleted blind.
const RECONCILE = { readTimeoutMs: 4000, settleMs: 10000, actReserveMs: 4000 };

const LIMITS = {
  bodyBytes: 20000, linesMax: 30, qtyMax: 20, itemsMax: 60, modsMax: 30,
  noteMax: 140, nameMax: 60, totalMax: 150000, // cents
};

const PHONE = '647-298-2267';
const BIG_ORDER = 'That’s a big order! Please call us at ' + PHONE + ' to place it.';
const PAUSED = 'Online ordering is paused, please call ' + PHONE + '.';
// Shown when a payment can't be confirmed: the customer must NOT re-order.
const UNCONFIRMED = 'We couldn’t confirm your payment. Please don’t order again — call us at ' + PHONE + ' and we’ll check right away.';
const TOO_MANY = 'Too many attempts. Please wait a few minutes or call us at ' + PHONE + '.';
const BOT_REFUSED = 'We couldn’t verify your browser. Please refresh the page and try again, or call us at ' + PHONE + '.';

// Turnstile (a bot check on our own /api/create-order, the only place a charge
// can happen). The secret is a dashboard secret; the site key is public and
// sent to the page via /api/config. Preview and sandbox use Cloudflare's
// documented TEST keys; production must use real keys and refuses test keys.
const TURNSTILE = {
  siteverifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  action: 'order',
  timeoutMs: 6000,
};
// Cloudflare's documented test keys all start with 1x/2x/3x then zeros; real
// keys start with 0x. Production refuses test keys (fail closed).
function isTurnstileTestKey(key) { return /^[123]x0{6}/.test(String(key || '')); }
function posInt(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; }

// Per-IP rate limits, held in the RATE_LIMITER Durable Object. Tunable via vars
// in every environment (see wrangler.toml). The order window is generous (PATH
// offices share one IP); the failed-payment window is strict (card testers).
function rateLimitSettings(env) {
  return {
    orderLimit: posInt(env.RATE_ORDER_LIMIT, 20), orderWindowMs: posInt(env.RATE_ORDER_WINDOW_S, 60) * 1000,
    failLimit: posInt(env.RATE_FAIL_LIMIT, 5), failWindowMs: posInt(env.RATE_FAIL_WINDOW_S, 600) * 1000,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/create-order') {
      if (request.method !== 'POST') return json({ success: false, error: 'Use POST.' }, 405, { Allow: 'POST' });
      return createOrder(request, env, url, ctx);
    }
    if (url.pathname === '/api/config') return json(config(env));
    if (url.pathname === '/api/health') {
      if (healthRateLimited()) return json({ error: 'Too many requests.' }, 429);
      return json(await health(env, request));
    }
    if (url.pathname.startsWith('/api/')) return json({ success: false, error: 'Not found.' }, 404);
    return env.ASSETS.fetch(request);
  },
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers),
  });
}


/* ---- Settings --------------------------------------------------------- */

function cloverUrls(env) {
  return CLOVER_URLS[isProduction(env) ? 'production' : 'sandbox'];
}

function isProduction(env) {
  return env.CLOVER_ENV === 'production';
}

function orderingOpen(env) {
  return env.ORDERING_OPEN === 'true';
}

function list(value) {
  return String(value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function enabledStores(env) {
  return list(env.STORES_ENABLED).filter(function (id) { return Object.prototype.hasOwnProperty.call(LOCATIONS, id); });
}

function closedDates(env) {
  return list(env.CLOSED_DATES).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); });
}

// A store's value for a setting: CLOVER_X_ONE_YORK, else the shared CLOVER_X
function storeSetting(env, id, key) {
  return env[key + '_' + LOCATIONS[id].suffix] || env[key] || '';
}

function storeSettings(env, id) {
  return {
    merchantId: storeSetting(env, id, 'CLOVER_MERCHANT_ID'),
    publicKey: storeSetting(env, id, 'CLOVER_PUBLIC_KEY'),
    taxRateId: storeSetting(env, id, 'CLOVER_TAX_RATE_ID'),
    orderTypeId: storeSetting(env, id, 'CLOVER_ORDER_TYPE_ID'),
    privateToken: storeSetting(env, id, 'CLOVER_PRIVATE_TOKEN'),
  };
}

function requiredSettings(env) {
  const keys = ['CLOVER_PRIVATE_TOKEN', 'CLOVER_MERCHANT_ID', 'CLOVER_PUBLIC_KEY', 'CLOVER_TAX_RATE_ID'];
  if (isProduction(env)) keys.push('CLOVER_ORDER_TYPE_ID');
  return keys;
}

function missingSettings(env, id) {
  return requiredSettings(env).filter(function (key) { return !storeSetting(env, id, key); });
}

// Clover inventory IDs for this environment (worker/clover-ids.js)
function cloverIds(env) {
  return CLOVER_IDS[isProduction(env) ? 'production' : 'sandbox'];
}

// Website items and options with no Clover ID here ("group|label" for
// options). null is a real entry: a choice that sends no modifier.
function missingCloverIds(env) {
  const ids = cloverIds(env);
  const missing = Object.keys(ITEMS).filter(function (key) { return !ids.items[key]; });
  Object.keys(GROUPS).forEach(function (g) {
    GROUPS[g].options.forEach(function (o) {
      const key = g + '|' + o.label;
      const link = ids.options[key];
      if (link === undefined || (link === null && !o.none)) missing.push(key);
    });
  });
  return missing;
}

// The IDs belong to one merchant: a store on another merchant has none
function storeHasCloverIds(env, id) {
  const merchantId = cloverIds(env).merchantId;
  return !!merchantId && storeSetting(env, id, 'CLOVER_MERCHANT_ID') === merchantId;
}

function config(env) {
  const stores = {};
  enabledStores(env).forEach(function (id) {
    const s = storeSettings(env, id);
    stores[id] = { publicKey: s.publicKey, merchantId: s.merchantId };
  });
  return {
    environment: isProduction(env) ? 'production' : 'sandbox',
    sdkUrl: cloverUrls(env).sdk,
    orderingOpen: orderingOpen(env),
    closedDates: closedDates(env),
    phone: PHONE,
    // Public Turnstile site key for the page to render the widget ('' = off).
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
    stores: stores,
  };
}

// Cache the live Clover checks in /api/health for ~5 min (per isolate) so the
// endpoint can't be used to spam Clover; a crude per-isolate rate limit caps
// request volume too.
const HEALTH = { cacheMs: 300000, rateMax: 60, rateWindowMs: 60000 };
let healthCache = { at: 0, data: null };
const healthRate = { windowStart: 0, count: 0 };

function healthRateLimited() {
  const now = Date.now();
  if (now - healthRate.windowStart > HEALTH.rateWindowMs) { healthRate.windowStart = now; healthRate.count = 0; }
  healthRate.count += 1;
  return healthRate.count > HEALTH.rateMax;
}

async function cachedHealth(env) {
  const now = Date.now();
  if (healthCache.data && now - healthCache.at < HEALTH.cacheMs) return healthCache.data;
  const data = await computeHealth(env);
  healthCache = { at: now, data: data };
  return data;
}

// Public answer in production is ready + commit only; the full detail needs the
// HEALTH_TOKEN header (or use livetest behind Cloudflare Access).
async function health(env, request) {
  const full = await cachedHealth(env);
  const authed = !isProduction(env) ||
    (!!env.HEALTH_TOKEN && request.headers.get('x-health-token') === env.HEALTH_TOKEN);
  return authed ? full : { ready: full.ready, commit: full.commit };
}

async function computeHealth(env) {
  const stores = {};
  await Promise.all(enabledStores(env).map(async function (id) {
    const s = storeSettings(env, id);
    const settings = {};
    requiredSettings(env).concat(isProduction(env) ? [] : ['CLOVER_ORDER_TYPE_ID']).forEach(function (key) {
      settings[key] = !!storeSetting(env, id, key);
    });

    // Read the tax rate and order type back from Clover with this store's
    // token: proves the token, merchant and IDs belong together
    const auth = { authorization: 'Bearer ' + s.privateToken };
    const merchantUrl = cloverUrls(env).api + '/v3/merchants/' + encodeURIComponent(s.merchantId);
    const check = function (path, id) {
      if (!id) return Promise.resolve('not set');
      if (!s.privateToken || !s.merchantId) return Promise.resolve('fail');
      return clover(merchantUrl + path + encodeURIComponent(id), auth, null, 'GET', 8000)
        .then(function (r) { return r.ok && r.data && r.data.id === id ? 'ok' : 'fail'; });
    };
    const results = await Promise.all([check('/tax_rates/', s.taxRateId), check('/order_types/', s.orderTypeId)]);

    stores[id] = {
      ready: !missingSettings(env, id).length && results[0] === 'ok' && (results[1] === 'ok' || (!isProduction(env) && results[1] === 'not set')) &&
        storeHasCloverIds(env, id),
      settings: settings,
      cloverIds: storeHasCloverIds(env, id) ? 'ok' : 'not for this merchant',
      orderTypeSet: !!s.orderTypeId,
      clover: { taxRate: results[0], orderType: results[1] },
    };
  }));

  const missingIds = missingCloverIds(env);
  return {
    ready: orderingOpen(env) && !missingIds.length && Object.keys(stores).length > 0 &&
      Object.keys(stores).every(function (id) { return stores[id].ready; }) &&
      (!isProduction(env) || turnstileReady(env)),
    commit: env.BUILD_COMMIT || 'unknown',
    clover: isProduction(env) ? 'production' : 'sandbox',
    currency: env.CLOVER_CURRENCY || 'cad',
    orderingOpen: orderingOpen(env),
    // Bot/card-tester defences: Turnstile configured (yes/no), rate limiter bound.
    turnstile: turnstileReady(env),
    rateLimiter: !!env.RATE_LIMITER,
    storesEnabled: enabledStores(env),
    closedDates: closedDates(env).length,
    alerts: { recipients: list(env.ALERT_EMAILS).length, sender: !!env.ALERT_FROM, binding: !!env.ALERT_EMAIL },
    menu: { ready: !missingIds.length, missingCloverIds: missingIds },
    stores: stores,
  };
}

// A problem with what the browser sent: the message is shown to the customer
class BadRequest extends Error {}


/* ---- Create + pay ----------------------------------------------------- */

async function createOrder(request, env, url, ctx) {
  // The switch is checked here, not only on the page. These checks are all
  // before any Clover call, so no charge is possible: noCharge: true.
  if (!orderingOpen(env)) return json({ success: false, noCharge: true, error: PAUSED }, 503);

  // Only the ordering page (same site, JSON) may place orders. The Origin must
  // match the site — a missing Origin is now refused too.
  if (request.headers.get('origin') !== url.origin) return json({ success: false, noCharge: true, error: 'Not allowed.' }, 403);
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) {
    return json({ success: false, noCharge: true, error: 'The order couldn’t be read. Please refresh and try again.' }, 415);
  }

  let body;
  try {
    const text = await request.text();
    if (text.length > LIMITS.bodyBytes) throw new BadRequest(BIG_ORDER);
    body = JSON.parse(text);
  } catch (error) {
    if (error instanceof BadRequest) return json({ success: false, noCharge: true, error: error.message }, 400);
    return json({ success: false, noCharge: true, error: 'The order couldn’t be read. Please refresh and try again.' }, 400);
  }

  // Bots & card-testers: per-IP rate limits then a Turnstile check, both before
  // any Clover call. Refuses with noCharge (no charge is possible yet).
  const screen = await screenRequest(env, request, url, body, ctx);
  if (!screen.ok) return screen.response;

  let order;
  try {
    order = priceOrder(body, new Date(), env);
  } catch (error) {
    if (error instanceof BadRequest) return json({ success: false, noCharge: true, error: error.message }, 400);
    return json({ success: false, noCharge: true, error: 'The order couldn’t be read. Please refresh and try again.' }, 400);
  }

  const store = order.location;
  const missing = missingSettings(env, store);
  if (missing.length) {
    console.error('create-order: missing settings for ' + store + ': ' + missing.join(', '));
    return json({ success: false, noCharge: true, error: 'Online payment isn’t set up yet. Please call us at ' + PHONE + ' to order.' }, 503);
  }
  // Every dish and option needs its Clover ID; never fall back to name + price
  if (order.missing.length || !storeHasCloverIds(env, store)) {
    console.error('create-order: no Clover IDs for ' + (order.missing.join(', ') || 'merchant of ' + store) +
      ' (' + (isProduction(env) ? 'production' : 'sandbox') + ')');
    return json({ success: false, noCharge: true, error: 'Online payment isn’t set up yet. Please call us at ' + PHONE + ' to order.' }, 503);
  }

  // The whole create -> pay -> settle flow runs as ONE ctx.waitUntil task so a
  // client disconnect can't cancel a charge mid-flight. The response is handed
  // back (resolveResp) the moment we have an answer; print/reconcile keep
  // running in the same task, within BG_BUDGET_MS of the flow's start.
  const flow = {
    env: env, request: request, order: order, store: store, ip: screen.ip,
    s: storeSettings(env, store), urls: cloverUrls(env), flowStart: Date.now(),
    paySent: false, orderId: null, amount: null,
  };
  flow.auth = { authorization: 'Bearer ' + flow.s.privateToken };
  flow.merchantUrl = flow.urls.api + '/v3/merchants/' + encodeURIComponent(flow.s.merchantId);

  let resolveResp;
  const response = new Promise(function (r) { resolveResp = r; });
  const task = settleOrder(flow, resolveResp).catch(function (error) {
    console.error('create-order: flow error ' + ((error && error.stack) || error));
    if (flow.paySent) {
      // The pay request went out; we can't be sure it didn't land. Tell the
      // customer to call us (never to re-order) and alert staff to check Clover.
      resolveResp(json({ success: false, code: 'payment_unconfirmed', error: UNCONFIRMED }, 502));
      return sendAlert(flow.env, 'Online order hit an error after payment was sent — check Clover',
        'An online order failed with an unexpected error AFTER the payment request was sent, so we could not confirm whether it ' +
        'went through.' + (flow.orderId ? ' Order: ' + flow.orderId + '.' : '') + ' Please check the Clover Orders app: if it’s ' +
        'paid, print the ticket from the Clover Orders app' + (flow.order ? ' and call the customer at ' + flow.order.pickup.phone : '') +
        '. Error: ' + String((error && error.message) || error).slice(0, 200));
    }
    // Error before the pay request: no charge was made.
    resolveResp(json({ success: false, noCharge: true, error: 'Payment didn’t go through and no charge was made. Please try again.' }, 502));
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(task); else await task;
  return response;
}

// The Clover flow: create the order, pay it, answer the customer, then settle
// (print / reconcile / delete) in the same task. `resolveResp` is called once
// with the customer's Response; it may be called before the settle work ends.
async function settleOrder(c, resolveResp) {
  const env = c.env, order = c.order, s = c.s, urls = c.urls, auth = c.auth, merchantUrl = c.merchantUrl;
  const orderUrl = function (id) { return merchantUrl + '/orders/' + encodeURIComponent(id); };
  const answerDeadline = c.flowStart + CUSTOMER_DEADLINE_MS;
  const bgDeadline = c.flowStart + BG_BUDGET_MS;
  let answered = false;
  const answer = function (data, status, headers) {
    if (answered) return;
    answered = true;
    resolveResp(json(data, status, headers));
  };
  // Timeout for a call the customer is waiting on: at most `want`, shrinking as
  // the answer deadline nears, but never so small the call can't succeed.
  const budget = function (want) { return Math.max(2500, Math.min(want, answerDeadline - Date.now())); };

  // 1. Create the order. Each line is the Clover item (Clover fills in its
  // name, price, tax and labels) plus its modifiers; no name or price here.
  const orderCart = { title: 'Online Pickup', note: order.note, lineItems: order.lineItems.map(cloverLine) };
  if (s.orderTypeId) orderCart.orderType = { id: s.orderTypeId };
  const created = await cloverRetry(function () {
    return clover(merchantUrl + '/atomic_order/orders', auth, { orderCart: orderCart }, 'POST', budget(CREATE.timeoutMs));
  });
  const orderId = created.ok && created.data && created.data.id;
  if (!orderId) {
    console.error('create-order: atomic order failed', c.store, created.status, created.error);
    return answer({ success: false, noCharge: true, error: 'We couldn’t place your order and no charge was made. Please try again.' }, 502);
  }
  c.orderId = orderId;

  // Clover's total should match ours; if not, don't charge
  if (typeof created.data.total === 'number' && Math.abs(created.data.total - order.total) > 1) {
    console.error('create-order: total mismatch', orderId, 'clover', created.data.total, 'ours', order.total);
    answer({ success: false, noCharge: true, error: 'We couldn’t price your order and no charge was made. Please call us at ' + PHONE + '.' }, 500);
    return deleteUnpaid(env, orderUrl(orderId), auth, orderId, order, order.total, 'The order total did not match Clover');
  }
  const amount = typeof created.data.total === 'number' ? created.data.total : order.total;
  c.amount = amount;

  // 2. Pay it. The clv_ token is single-use, so even if a first attempt charged
  // and we retry, the second can't charge again (it gets token_already_used).
  // One Idempotency-Key is made here and reused on the retry: Clover documents
  // it for the create-a-charge family; pay-for-an-order isn't documented to
  // honour it, so we never trust the retry's own answer — after a retry the
  // real outcome is confirmed by reading the order below.
  const payUrl = urls.ecom + '/v1/orders/' + encodeURIComponent(orderId) + '/pay';
  const payHeaders = Object.assign({
    'idempotency-key': crypto.randomUUID(),
    'x-forwarded-for': c.request.headers.get('cf-connecting-ip') || '',
    'user-agent': c.request.headers.get('user-agent') || 'tacos-de-princesa',
  }, auth);
  const payBody = { source: order.source, amount: amount, currency: env.CLOVER_CURRENCY || 'cad', ecomind: 'ecom', metadata: { delete_order_on_failure: true } };

  c.paySent = true; // from here a charge may exist; an error answers "unconfirmed"
  let paid = await clover(payUrl, payHeaders, payBody, 'POST', budget(PAY.timeoutMs));
  // Retry ONCE, same key, on an unclear answer (timeout/network, 429, 5xx).
  // Never retry a clear card decline.
  let retried = false;
  if (!paid.ok && payUnclear(paid)) {
    retried = true;
    const back = Math.min(paid.retryAfter != null ? paid.retryAfter : 500, 1500, Math.max(0, answerDeadline - Date.now()));
    console.error('create-order: pay unclear (HTTP ' + paid.status + '), retrying once with the same idempotency key', orderId);
    await sleep(back);
    paid = await clover(payUrl, payHeaders, payBody, 'POST', budget(PAY.timeoutMs));
  }
  const payEndedAt = Date.now(); // when the last pay attempt finished

  // Paid outright: answer now, print in the same background task.
  if (paid.ok) {
    console.log('ORDER ' + orderId + ' store=' + order.location + ' amount=' + amount);
    answer({ success: true, orderId: orderId, total: amount });
    return printAndVerify(env, merchantUrl, auth, orderId, order, { deadline: bgDeadline }).catch(function (error) {
      console.error('PRINT CHECK ERROR ' + orderId + ': ' + error);
    });
  }

  console.error('create-order: payment failed', orderId, paid.status, paid.error);

  // A clear card decline (402 / card_declined / card_error) is the only failure
  // where an unpaid order proves no charge: the card was refused, so nothing
  // landed. After anything unclear (timeout, 5xx, 429) or a retried
  // token_already_used, an OPEN order may just be a charge still landing.
  const clearDecline = isCardDecline(paid);

  // Read the order when the answer was unclear OR we retried (a retry can hide a
  // charge the first attempt made). What the read tells us:
  //   PAID   -> success + print
  //   404    -> Clover removed it (delete_order_on_failure): no charge
  //   unpaid -> no charge ONLY if this was a clear decline; else the charge may
  //             still be landing, so DON'T delete -> unconfirmed + reconcile
  //   unreadable / no budget -> unconfirmed + reconcile
  const mustRead = payUnclear(paid) || retried;
  if (mustRead) {
    const left = answerDeadline - Date.now();
    if (left >= READ_FLOOR_MS) {
      const check = await cloverRetry(function () { return clover(orderUrl(orderId), auth, null, 'GET', Math.min(PAY.timeoutMs, left)); });
      if (check.ok && check.data && check.data.paymentState === 'PAID') {
        console.log('create-order: paid (confirmed after an unclear reply)', orderId);
        answer({ success: true, orderId: orderId, total: amount });
        return printAndVerify(env, merchantUrl, auth, orderId, order, { deadline: bgDeadline }).catch(function (error) {
          console.error('PRINT CHECK ERROR ' + orderId + ': ' + error);
        });
      }
      if (check.status === 404) {
        console.log('create-order: order already removed by Clover, no charge', orderId);
        answerNoCharge(answer, env, paid);
        return recordFail(c);
      }
      if (clearDecline && check.ok && check.data && check.data.paymentState) {
        console.log('create-order: declined, order ' + check.data.paymentState + ' (no charge)', orderId);
        answerNoCharge(answer, env, paid);
        return Promise.all([recordFail(c), deleteUnpaid(env, orderUrl(orderId), auth, orderId, order, amount, 'The card was declined')]);
      }
      console.error('create-order: PAYMENT UNCONFIRMED ' + orderId + ', read ' +
        (check.ok ? (check.data && check.data.paymentState) : 'HTTP ' + check.status) + ', reconciling');
    } else {
      console.error('create-order: PAYMENT UNCONFIRMED ' + orderId + ', no answer budget to read, reconciling');
    }
    // Unconfirmed: the charge may still be landing. Tell the customer to call us
    // (never to re-order) and reconcile in the background; never delete until a
    // read well after the pay attempt still shows the order unpaid.
    answer({ success: false, code: 'payment_unconfirmed', error: UNCONFIRMED }, 502);
    return reconcileUnclear(env, merchantUrl, auth, orderUrl(orderId), orderId, order, amount, payEndedAt, bgDeadline);
  }

  // Clear decline (or other clear 4xx), not retried: no charge. Delete and tell
  // the customer (fast path).
  answerNoCharge(answer, env, paid);
  return Promise.all([recordFail(c), deleteUnpaid(env, orderUrl(orderId), auth, orderId, order, amount, 'The payment did not go through')]);
}

// The clear "no charge" answer: a card decline, an expired/used token, or a
// generic failure. Never a double-charge risk (the charge did not go through).
function answerNoCharge(answer, env, paid) {
  const error = paid.error || {};
  const declined = isCardDecline(paid);
  const badSource = !declined && (error.code === 'token_already_used' ||
    (error.code === 'invalid_request' && /source/i.test(error.message || '')));
  answer({
    success: false,
    noCharge: true,
    error: declined ? 'Your card was declined and no charge was made. Please try another card.'
      : badSource ? 'Your card details expired. Please enter them again.'
      : 'Payment didn’t go through and no charge was made. Please try again.',
    // Sandbox only: Clover's own reason, for testing (e.g. the test merchant's
    // per-card sale limit). Never shown to real customers.
    detail: isProduction(env) ? undefined : String((typeof paid.error === 'string' ? paid.error : error.message) || '').slice(0, 200) || undefined,
  }, declined ? 402 : badSource ? 400 : 502);
}

// Send the order to the kitchen printer, retry once, then check it really
// printed: a 200 only means Clover accepted the job (an offline printer
// accepts it and never prints). Alerts by email if it didn't print.
async function printAndVerify(env, merchantUrl, auth, orderId, order, opts) {
  opts = opts || {};
  const checksMs = opts.checksMs || PRINT.checksMs;
  const retryMs = opts.retryMs != null ? opts.retryMs : PRINT.retryAfterMs;
  // Hard stop so the final alert still goes out before Cloudflare cancels us.
  const deadline = opts.deadline || (Date.now() + BG_BUDGET_MS);
  const started = Date.now();
  const where = ' (store ' + order.location + ')';
  const print = function () {
    return cloverRetry(function () {
      return clover(merchantUrl + '/print_event', auth, { orderRef: { id: orderId } }, 'POST', PRINT.timeoutMs);
    });
  };

  let printed = await print();
  // Retry the print only if there's still room for the retry and an alert.
  if (!(printed.ok && printed.data && printed.data.id) && Date.now() + retryMs + PRINT.timeoutMs + ALERT_RESERVE_MS <= deadline) {
    console.error('PRINT FAILED ' + orderId + where + ', HTTP ' + printed.status + ', attempt 1: retrying in ' + Math.round(retryMs / 1000) + ' s', printed.error);
    await sleep(retryMs);
    printed = await print();
  }
  const jobId = printed.ok && printed.data && printed.data.id;
  if (!jobId) {
    console.error('PRINT FAILED ' + orderId + where + ', HTTP ' + printed.status + ': print it from Clover by hand', printed.error);
    return sendPrintAlert(env, orderId, order, 'Clover refused the print request (' + errorText(printed) + ').');
  }
  console.log('PRINT SENT ' + orderId + where + ', job ' + jobId);

  let state = 'CREATED';
  for (const at of checksMs) {
    // Only do this check if it plus its timeout plus the alert fit the budget.
    if (started + at + PRINT.stateTimeoutMs + ALERT_RESERVE_MS > deadline) break;
    await sleep(started + at - Date.now());
    state = await printState(merchantUrl, auth, jobId);
    if (state === 'DONE') { console.log('PRINTED ' + orderId + ', job ' + jobId); return; }
    if (state === 'FAILED') break;
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.error('PRINT FAILED ' + orderId + where + ', job ' + jobId + ' is ' + state + ' after ' + seconds + ' s: print it from Clover by hand');
  return sendPrintAlert(env, orderId, order, state === 'FAILED'
    ? 'The printer reported the job as FAILED.'
    : 'The ticket still hadn’t printed ' + seconds + ' seconds after the order (Clover says: ' + state + '). The printer may be offline or out of paper.');
}

// A print job's state: CREATED, PRINTING, FAILED, or DONE. Clover discards a
// job once it has printed, so only HTTP 404 counts as printed. Anything else
// (401, 403, 5xx, a timeout, an unexpected body) is UNKNOWN, which alerts if
// it's still that at the last check: better a needless email than a lost order.
const PRINT_STATES = ['CREATED', 'PRINTING', 'FAILED', 'DONE'];

async function printState(merchantUrl, auth, jobId) {
  const r = await cloverRetry(function () {
    return clover(merchantUrl + '/print_event/' + encodeURIComponent(jobId),
      Object.assign({ 'user-agent': 'tacos-de-princesa' }, auth), null, 'GET', PRINT.stateTimeoutMs);
  });
  if (r.status === 404) return 'DONE';
  if (r.ok && r.data && PRINT_STATES.indexOf(r.data.state) !== -1) return r.data.state;
  return 'UNKNOWN (HTTP ' + r.status + ')';
}

function errorText(result) {
  const e = result.error;
  return 'HTTP ' + result.status + (e ? ': ' + String(typeof e === 'string' ? e : e.message || JSON.stringify(e)).slice(0, 150) : '');
}

// ONE email to everyone in ALERT_EMAILS. Never contains card details (the
// Worker only ever has a single-use card token anyway).
function sendPrintAlert(env, orderId, order, reason) {
  const counts = {};
  order.lineItems.forEach(function (line) { counts[line.label] = (counts[line.label] || 0) + 1; });
  const text = [
    'An online order did not print in the kitchen.',
    '',
    reason,
    '',
    'Order: ' + orderId,
    'Store: ' + LOCATIONS[order.location].label,
    'Pickup: ' + order.pickup.when,
    'Customer: ' + order.pickup.name + ', ' + order.pickup.phone,
    '',
    'Items:',
  ].concat(Object.keys(counts).map(function (label) { return '- ' + counts[label] + ' x ' + label; })).concat([
    '',
    'Print it from the Clover Orders app.',
  ]).join('\n');
  return sendAlert(env, 'Online order ' + orderId + ' did not print', text);
}

async function sendAlert(env, subject, text) {
  const to = list(env.ALERT_EMAILS);
  if (!to.length || !env.ALERT_FROM || !env.ALERT_EMAIL) {
    console.error('ALERT NOT SENT (ALERT_EMAILS, ALERT_FROM or the ALERT_EMAIL binding is missing): ' + subject);
    return;
  }
  for (const address of to) {
    try {
      await sendEmail(env, address, subject, text);
      console.log('ALERT SENT to ' + address + ': ' + subject);
    } catch (error) {
      console.error('ALERT FAILED to ' + address + ': ' + ((error && (error.code || error.message)) || error) + ' — ' + subject);
    }
  }
}

// Cloudflare's send_email binding: the structured send(), or a raw message
// on runtimes that only take an EmailMessage
async function sendEmail(env, to, subject, text) {
  try {
    await env.ALERT_EMAIL.send({ to: to, from: env.ALERT_FROM, subject: subject, text: text });
  } catch (error) {
    if (error && error.code) throw error; // a real Email error (e.g. recipient not verified)
    const { EmailMessage } = await import('cloudflare:email');
    const raw = [
      'From: ' + env.ALERT_FROM, 'To: ' + to, 'Subject: ' + subject, 'Date: ' + new Date().toUTCString(),
      'Message-ID: <' + crypto.randomUUID() + '@' + env.ALERT_FROM.split('@')[1] + '>',
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text,
    ].join('\r\n');
    await env.ALERT_EMAIL.send(new EmailMessage(env.ALERT_FROM, to, raw));
  }
}

// Delete an unpaid order so it can't reach the kitchen. 404 means it's already
// gone (delete_order_on_failure). If it can't be deleted the order is stranded
// in Clover, so alert staff as well as logging it. Returns true if it's gone.
async function deleteUnpaid(env, url, auth, orderId, order, amount, reason) {
  const removed = await cloverRetry(function () { return clover(url, auth, null, 'DELETE', PAY.timeoutMs); });
  if (removed.ok || removed.status === 404) return true;
  console.error('create-order: UNPAID ORDER NOT DELETED ' + orderId + ', remove it in Clover, HTTP ' + removed.status);
  await sendAlert(env, 'Unpaid order ' + orderId + ' could not be removed — delete it in Clover',
    alertBody(order, orderId, amount, reason + ', but the order could NOT be deleted (HTTP ' + removed.status +
      '). It may reach the kitchen. Please delete it in the Clover Orders app.'));
  return false;
}

// Call Clover. Returns { ok, status, data, error } and never throws; error is
// Clover's error object or message, without request details. timeoutMs, if
// given, gives up (status 0) after that long.
async function clover(url, headers, body, method, timeoutMs) {
  try {
    const response = await fetch(url, {
      method: method || 'POST',
      headers: Object.assign({ accept: 'application/json', 'content-type': 'application/json' }, headers),
      body: body ? JSON.stringify(body) : undefined,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { message: text.slice(0, 200) }; }
    return {
      ok: response.ok,
      status: response.status,
      data: data,
      error: response.ok ? null : (data && (data.error || data.message)) || null,
      retryAfter: parseRetryAfter(response.headers.get('retry-after')),
    };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: String(error), retryAfter: null };
  }
}


/* ---- Retry, timing and reconcile -------------------------------------- */

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, ms)); }); }
function sleepUntil(t) { return sleep(t - Date.now()); }

// Retry-After header -> ms from now, or null (accepts seconds or an HTTP date).
function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

// Retry a Clover call that is safe to repeat when Clover rate-limits us (429,
// or 503 with a Retry-After): up to RETRY.attempts tries total, short backoff,
// honouring Retry-After (capped). Only for idempotent/repeatable calls, never
// for pay.
async function cloverRetry(fn) {
  let r;
  for (let i = 0; i < RETRY.attempts; i++) {
    r = await fn();
    const rateLimited = r.status === 429 || (r.status === 503 && r.retryAfter != null);
    if (!rateLimited || i === RETRY.attempts - 1) return r;
    const delay = r.retryAfter != null
      ? Math.min(r.retryAfter, RETRY.retryAfterCapMs)
      : RETRY.backoffMs[Math.min(i, RETRY.backoffMs.length - 1)];
    await sleep(delay);
  }
  return r;
}

// An unclear pay answer: timeout/network (0), rate limit (429), or server
// error (5xx). The charge may or may not have gone through.
function payUnclear(paid) {
  return paid.status === 0 || paid.status === 429 || paid.status >= 500;
}

// A clear card decline: no money moved, safe to delete and tell the customer.
function isCardDecline(paid) {
  const e = paid.error || {};
  return paid.status === 402 || e.code === 'card_declined' || e.type === 'card_error';
}

// The customer was told we couldn't confirm their payment. Re-read the order's
// payment state, then settle it:
//   PAID    -> alert staff + print (an unpaid order is NEVER printed)
//   removed  (404, delete_order_on_failure) -> alert staff, no charge
//   unpaid confirmed >= settleMs after the pay attempt -> delete + alert
//   otherwise (couldn't read late enough, or reads errored) -> LEAVE + alert
// Runs in the same ctx.waitUntil task, within `deadline`. We never delete until
// a read at least settleMs after the last pay attempt still shows the order
// unpaid, because a slow charge can still land in that window. A PAID order's
// staff alert goes out BEFORE printing, so "call the customer" is sent even if
// the print checks get cut.
async function reconcileUnclear(env, merchantUrl, auth, orderUrl, orderId, order, amount, payEndedAt, deadline) {
  deadline = deadline || (Date.now() + BG_BUDGET_MS);
  const deleteAfter = payEndedAt + RECONCILE.settleMs;
  const start = Date.now();
  let state = 'unknown';
  let lastReadAt = 0;
  let prev = 0;
  // A couple of early reads to catch a landing charge or a removed order, then a
  // verdict read no earlier than deleteAfter; each only if it plus room to act fits.
  for (const when of [start + 3000, start + 8000, Math.max(start + 8000, deleteAfter)]) {
    if (when <= prev) continue;
    if (when + RECONCILE.readTimeoutMs + RECONCILE.actReserveMs > deadline) break;
    prev = when;
    await sleepUntil(when);
    const check = await cloverRetry(function () { return clover(orderUrl, auth, null, 'GET', RECONCILE.readTimeoutMs); });
    lastReadAt = Date.now();
    if (check.status === 404) { state = 'removed'; break; }
    if (check.ok && check.data) {
      if (check.data.paymentState === 'PAID') { state = 'PAID'; break; }
      state = 'unpaid';
    } else {
      state = 'unknown';
    }
    if (state === 'unpaid' && Date.now() >= deleteAfter) break; // trustworthy unpaid verdict
  }

  if (state === 'PAID') {
    console.log('RECONCILE ' + orderId + ': PAID after an unclear reply — alerting staff, printing');
    await sendAlert(env, 'Order ' + orderId + ' was paid after the customer was told it couldn’t be confirmed',
      alertBody(order, orderId, amount, 'This order WAS paid, but the customer saw “we couldn’t confirm your payment.” ' +
        'Please call them at ' + order.pickup.phone + ' to confirm the pickup. The kitchen ticket is printing now.'));
    return printAndVerify(env, merchantUrl, auth, orderId, order,
      { checksMs: PRINT.checksReconcileMs, retryMs: PRINT.reconcileRetryMs, deadline: deadline });
  }
  if (state === 'removed') {
    console.log('RECONCILE ' + orderId + ': Clover already removed the order (no charge)');
    return sendAlert(env, 'Unconfirmed order ' + orderId + ' was removed by Clover (no charge)',
      alertBody(order, orderId, amount, 'The payment did not go through, so Clover removed this order automatically. ' +
        'No charge went through. If the customer calls, they can order again.'));
  }
  if (state === 'unpaid' && lastReadAt >= deleteAfter) {
    console.log('RECONCILE ' + orderId + ': still unpaid ' + Math.round((lastReadAt - payEndedAt) / 1000) + ' s after pay — deleting');
    const gone = await deleteUnpaid(env, orderUrl, auth, orderId, order, amount, 'A payment was never confirmed');
    if (gone) {
      await sendAlert(env, 'Unconfirmed order ' + orderId + ' was removed',
        alertBody(order, orderId, amount, 'The payment was never confirmed (the order was still unpaid well after the attempt), ' +
          'so it was removed and did not reach the kitchen. No charge should have gone through; check Clover if the customer calls.'));
    }
    return;
  }
  // Couldn't confirm it unpaid late enough (tight budget) or reads errored:
  // LEAVE the order and ask staff to check it — never delete a possibly-charged one.
  console.error('RECONCILE ' + orderId + ': could not safely settle (state ' + state + ') — leaving the order, alerting staff');
  return sendAlert(env, 'Order ' + orderId + ' — payment unconfirmed, please check Clover',
    alertBody(order, orderId, amount, 'We could not confirm whether this order was paid, so it was LEFT in Clover. ' +
      'Please check it in the Clover Orders app: if it’s paid, print the ticket from the Clover Orders app and call the ' +
      'customer at ' + order.pickup.phone + '; if not, delete it.'));
}

// Shared body for a staff alert email. Never any card data (the Worker only
// ever holds a single-use token).
function alertBody(order, orderId, amount, lead) {
  const counts = {};
  order.lineItems.forEach(function (line) { counts[line.label] = (counts[line.label] || 0) + 1; });
  return [lead, '',
    'Order: ' + orderId,
    'Store: ' + LOCATIONS[order.location].label,
    'Amount: ' + money(amount),
    'Pickup: ' + order.pickup.when,
    'Customer: ' + order.pickup.name + ', ' + order.pickup.phone,
    '', 'Items:',
  ].concat(Object.keys(counts).map(function (label) { return '- ' + counts[label] + ' x ' + label; })).join('\n');
}

function money(cents) { return '$' + (Math.round(cents) / 100).toFixed(2); }


/* ---- Bots & card-testers: rate limits + Turnstile --------------------- */

// Is Turnstile configured for this environment? (site key + secret present).
function turnstileConfigured(env) { return !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET); }

// Turnstile must be real-configured in production; production refuses test keys.
function turnstileReady(env) {
  if (!turnstileConfigured(env)) return false;
  if (isProduction(env) && (isTurnstileTestKey(env.TURNSTILE_SITE_KEY) || isTurnstileTestKey(env.TURNSTILE_SECRET))) return false;
  return true;
}

// Verify the Turnstile token with Cloudflare before any Clover call. Fails
// closed in production (missing secret, test keys, or siteverify unreachable ->
// refuse). In sandbox/preview without a secret, Turnstile is skipped.
async function verifyTurnstile(env, token, request, url) {
  const secret = env.TURNSTILE_SECRET || '';
  if (isProduction(env)) {
    if (!turnstileReady(env)) {
      console.error('turnstile: not configured, or a TEST key, in production — refusing');
      return { ok: false, status: 503, error: 'Online payment isn’t set up yet. Please call us at ' + PHONE + ' to order.' };
    }
  } else if (!secret) {
    return { ok: true }; // sandbox/preview with no Turnstile set up: skip
  }
  if (typeof token !== 'string' || !token) {
    return { ok: false, status: 400, error: BOT_REFUSED };
  }

  const form = new URLSearchParams();
  form.set('secret', secret);
  form.set('response', token);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) form.set('remoteip', ip);

  let data;
  try {
    const res = await fetch(TURNSTILE.siteverifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(TURNSTILE.timeoutMs),
    });
    data = await res.json();
  } catch (error) {
    console.error('turnstile: siteverify unreachable', String(error));
    if (isProduction(env)) return { ok: false, status: 503, error: BOT_REFUSED };
    return { ok: true }; // sandbox: don't block on an outage
  }

  if (!data || data.success !== true) {
    console.error('turnstile: verification failed', (data && data['error-codes']) || 'no body');
    return { ok: false, status: 400, error: BOT_REFUSED };
  }
  // A real secret: require the action and the serving host to match EXACTLY
  // (not just "if present"). The test secret returns hostname example.com and
  // no action, so these checks are skipped for it.
  if (!isTurnstileTestKey(secret)) {
    if (data.action !== TURNSTILE.action) {
      console.error('turnstile: action mismatch', data.action);
      return { ok: false, status: 400, error: BOT_REFUSED };
    }
    if (!url || data.hostname !== url.hostname) {
      console.error('turnstile: hostname mismatch', data.hostname);
      return { ok: false, status: 400, error: BOT_REFUSED };
    }
  }
  return { ok: true };
}

// The rate-limit key: the full IPv4 address, or the /64 prefix for IPv6 (so a
// tester can't rotate addresses inside one /64).
function rateKey(ip) {
  if (!ip || ip.indexOf(':') === -1) return ip; // IPv4 (or empty)
  const addr = ip.split('%')[0];                // strip any zone id
  const sides = addr.split('::');
  const head = sides[0] ? sides[0].split(':') : [];
  const tail = sides.length > 1 && sides[1] ? sides[1].split(':') : [];
  const fill = Math.max(0, 8 - head.length - tail.length);
  const groups = head.concat(new Array(fill).fill('0')).concat(tail);
  return groups.slice(0, 4).map(function (g) { return (g || '0').toLowerCase(); }).join(':') + '::/64';
}

// Call the per-IP RateLimiter Durable Object (keyed by rateKey). Fails OPEN on
// any error or when the binding/IP is missing (availability over strictness).
async function rateLimit(env, ip, path, extra) {
  const ns = env.RATE_LIMITER;
  if (!ns || !ip) { if (!ns) console.error('rate-limit: RATE_LIMITER not bound — failing open'); return null; }
  try {
    const stub = ns.get(ns.idFromName(rateKey(ip)));
    const payload = Object.assign(rateLimitSettings(env), extra || {});
    const res = await stub.fetch('https://ratelimiter' + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (error) {
    console.error('rate-limit: DO error — failing open', String(error));
    return null;
  }
}

// Record one failed payment for this IP (card-tester signal).
function recordFail(c) {
  return rateLimit(c.env, c.ip, '/fail').catch(function () {});
}

// Turnstile then the rate limiter, before any Clover call. Turnstile goes first
// so a request with no/bad token is refused WITHOUT touching the Durable Object
// (a bot can't run the DO up). An order attempt is recorded only once past
// Turnstile; failed payments are recorded later (recordFail). Returns { ok, ip }
// or { ok:false, response }. One staff email per IP per window.
async function screenRequest(env, request, url, body, ctx) {
  const ip = request.headers.get('cf-connecting-ip') || '';

  const human = await verifyTurnstile(env, body && body.turnstile, request, url);
  if (!human.ok) return { ok: false, response: json({ success: false, noCharge: true, error: human.error }, human.status) };

  const rl = await rateLimit(env, ip, '/order');
  if (rl && (rl.orderOver || rl.failOver)) {
    console.error('rate-limit: blocked (orders=' + rl.orders + ', fails=' + rl.fails + ')');
    if (rl.shouldEmail) {
      const alert = sendAlert(env, 'Online ordering — too many attempts from one address',
        'An address hit the ordering rate limit (orders in the window: ' + rl.orders + ', failed payments in the window: ' + rl.fails +
        '). If this is a card tester, the limit is holding them off; no action is needed. If a real customer is stuck, ask them to call ' + PHONE + '.')
        .catch(function () {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(alert); else await alert;
    }
    return { ok: false, response: json({ success: false, noCharge: true, error: TOO_MANY }, 429) };
  }

  return { ok: true, ip: ip };
}


/* ---- Pricing + validation --------------------------------------------- */
// Cart lines use the same shape as the cart in js/order.js

function priceOrder(body, now, env) {
  if (!body || typeof body !== 'object') throw new BadRequest('The order is empty.');

  const source = body.source;
  if (typeof source !== 'string' || !/^clv_[A-Za-z0-9_-]{8,200}$/.test(source)) {
    throw new BadRequest('Card details are missing. Please enter your card again.');
  }

  const cart = body.cart;
  if (!Array.isArray(cart) || !cart.length) throw new BadRequest('Your cart is empty.');
  if (cart.length > LIMITS.linesMax) throw new BadRequest(BIG_ORDER);

  const ids = cloverIds(env);
  const missing = [];
  const lineItems = [];
  let subtotal = 0;
  cart.forEach(function (line) {
    const priced = priceLine(line, ids, missing);
    subtotal += priced.price * line.qty;
    // One Clover line item per dish, so each prints and shows on its own
    for (let i = 0; i < line.qty; i++) lineItems.push(priced);
  });
  if (lineItems.length > LIMITS.itemsMax) throw new BadRequest(BIG_ORDER);

  const pickup = checkPickup(body.pickup, now, env);
  const tax = Math.round(subtotal * TAX_RATE);
  if (subtotal + tax > LIMITS.totalMax) throw new BadRequest(BIG_ORDER);

  return {
    source: source,
    location: pickup.location,
    lineItems: lineItems,
    missing: missing.filter(function (key, i) { return missing.indexOf(key) === i; }),
    pickup: pickup,
    subtotal: subtotal,
    tax: tax,
    total: subtotal + tax,
    // What the kitchen and front counter see on the order
    note: [
      'ONLINE PICKUP: ' + pickup.when,
      'Name: ' + pickup.name,
      'Phone: ' + pickup.phone,
      'Location: ' + LOCATIONS[pickup.location].label,
    ].join('\n'),
  };
}

// -> { price: 1800 (website, per dish), item: Clover item ID,
//      modifications: [{ modifier: { id }, name, amount }], note: customer's text }
// Keys with no Clover ID go into missing (and item/modifications are left
// incomplete: createOrder refuses the order).
function priceLine(line, ids, missing) {
  const unknown = new BadRequest('Something in your cart is no longer on the menu. Please remove it and try again.');
  if (!line || typeof line !== 'object' || typeof line.item !== 'string') throw unknown;
  const item = Object.prototype.hasOwnProperty.call(ITEMS, line.item) && ITEMS[line.item];
  if (!item) throw unknown;
  if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > LIMITS.qtyMax) throw new BadRequest('Please check the quantities in your cart.');

  const mods = line.mods == null ? [] : line.mods;
  if (!Array.isArray(mods) || mods.length > LIMITS.modsMax) throw unknown;
  const seen = {};
  let price = item.price;
  mods.forEach(function (mod) {
    if (!mod || typeof mod.g !== 'string' || typeof mod.label !== 'string') throw unknown;
    const group = item.groups.indexOf(mod.g) !== -1 && GROUPS[mod.g];
    const option = group && group.options.find(function (o) { return o.label === mod.label; });
    if (!option || seen[mod.g + '|' + mod.label]) throw unknown;
    seen[mod.g + '|' + mod.label] = true;
    price += option.price;
  });
  // 'one' groups (e.g. a salad's dressing) need exactly one choice
  item.groups.forEach(function (key) {
    if (GROUPS[key].type !== 'one') return;
    if (mods.filter(function (m) { return m.g === key; }).length !== 1) throw unknown;
  });

  let note = line.note == null ? '' : line.note;
  if (typeof note !== 'string') throw unknown;
  note = clean(note).slice(0, LIMITS.noteMax);

  // The Clover item and modifiers. A modifier is sent with Clover's name and
  // price (Clover doesn't fill them in from the ID). Single Taco: the item
  // is $0 in Clover and the protein modifier carries the $7.00.
  const cloverItem = ids.items[line.item];
  if (!cloverItem) missing.push(line.item);
  const modifications = [];
  mods.forEach(function (mod) {
    const key = mod.g + '|' + mod.label;
    const link = ids.options[key];
    if (link === null) return; // e.g. "No protein": nothing to send
    if (!link) { missing.push(key); return; }
    modifications.push({ modifier: { id: link.id }, name: link.name, amount: link.price });
  });

  // For staff (print alerts): the dish as the cart shows it
  const named = item.nameFrom && mods.find(function (m) { return m.g === item.nameFrom; });
  const shown = mods.filter(function (m) {
    return m !== named && !GROUPS[m.g].options.find(function (o) { return o.label === m.label; }).none;
  }).map(function (m) { return m.label; });
  const label = (named ? item.fullName + ' ' + named.label : item.fullName) +
    (shown.length ? ' (' + shown.join(', ') + ')' : '') + (note ? ' "' + note + '"' : '');

  return { price: price, item: cloverItem, modifications: modifications, note: note, label: label };
}

// One dish as a Clover order line
function cloverLine(line) {
  const out = { item: { id: line.item } };
  if (line.modifications.length) out.modifications = line.modifications;
  if (line.note) out.note = line.note;
  return out;
}

// Same-day pickup only, while the store is open (same rules as pickupDay()
// in js/order.js): ASAP, or a 15-minute slot from 20 minutes from now up to
// 30 minutes before closing. Never on CLOSED_DATES.
function checkPickup(pickup, now, env) {
  if (!pickup || typeof pickup !== 'object') throw new BadRequest('Pickup details are missing.');

  const name = clean(typeof pickup.name === 'string' ? pickup.name : '').slice(0, LIMITS.nameMax);
  if (!name) throw new BadRequest('Please add a name for the order.');

  const digits = String(pickup.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (!/^[2-9]\d{9}$/.test(digits)) throw new BadRequest('Please add a 10-digit phone number.');

  if (typeof pickup.location !== 'string' || !Object.prototype.hasOwnProperty.call(LOCATIONS, pickup.location)) {
    throw new BadRequest('Please choose a pickup location.');
  }
  if (enabledStores(env).indexOf(pickup.location) === -1) {
    throw new BadRequest('That location isn’t taking online orders yet. Please call us at ' + PHONE + '.');
  }

  const hours = HOURS[pickup.location];
  const today = torontoNow(now);
  const timeGone = new BadRequest('That pickup time is no longer available. Please go back and choose another.');

  // Taking orders right now: an open day that isn't a holiday or a closed
  // date, from opening until the cutoff (17:30)
  const window = orderingWindow(hours, today, closedDates(env));
  if (!window.ok) {
    if (window.reason === 'holiday') throw new BadRequest('We’re closed today for ' + window.holiday + '. Please call ' + PHONE + '.');
    if (window.reason === 'after') {
      throw new BadRequest('Online ordering closes at ' + clockText(toMinutes(hours.close) - PICKUP.orderUntilBeforeClose) + '. Please call ' + PHONE + '.');
    }
    throw new BadRequest('We’re not taking online orders right now. Please call us at ' + PHONE + '.');
  }

  let when;
  if (pickup.asap === true) {
    when = 'ASAP (ordered ' + timeText(today.minutes) + ')';
  } else {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(typeof pickup.time === 'string' ? pickup.time : '');
    if (!m) throw new BadRequest('Please choose a pickup time.');
    const minutes = +m[2] * 60 + +m[3];
    // Today, and one of the slots offered (a few minutes' grace for the time
    // the customer took to pay)
    if (m[1] !== today.iso || pickupSlots(hours, today.minutes - SLOT_GRACE_MINUTES).indexOf(minutes) === -1) throw timeGone;
    when = 'Today ' + timeText(minutes);
  }

  return {
    name: name,
    phone: digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6),
    location: pickup.location,
    when: when,
  };
}

// 750 -> '12:30 p.m.'
function timeText(minutes) {
  const h = Math.floor(minutes / 60);
  return ((h + 11) % 12 + 1) + ':' + String(minutes % 60).padStart(2, '0') + (h < 12 ? ' a.m.' : ' p.m.');
}

// One line of plain text: no control characters, single spaces
function clean(text) {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}
