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
   that isn't paid is deleted, so it never reaches the kitchen.
   Online orders are taken Mon-Fri from opening (10:30) until 17:30, never on
   holidays (worker/hours.js); pickup is the same day, ASAP or a 15-minute
   slot up to 17:45.
   Printing happens after the customer has their answer (ctx.waitUntil): one
   retry after ~5 s if Clover refuses, then the job's state is checked ~15 s
   and ~26 s later. If it failed or hasn't printed, ONE alert email goes to
   ALERT_EMAILS. (Cloudflare cancels waitUntil work 30 s after the response,
   so the last check can't be later; a later check would need a Queue.)
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
   - If Clover creates the order but the connection drops before its reply,
     that unpaid order can't be cleaned up here (its ID never arrives).
   ========================================================================== */

import { GROUPS, ITEMS, TAX_RATE } from './menu.js';
import { CLOVER_IDS } from './clover-ids.js';
import { HOURS, PICKUP, torontoNow, orderingWindow, pickupSlots, toMinutes, clockText } from './hours.js';

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

// Printing (see the header): Clover call timeout, retry delay, and when the
// job is checked (ms after the response). Must finish within 30 s.
const PRINT = { timeoutMs: 6000, retryAfterMs: 5000, checksMs: [15000, 26000] };

const LIMITS = {
  bodyBytes: 20000, linesMax: 30, qtyMax: 20, itemsMax: 60, modsMax: 30,
  noteMax: 140, nameMax: 60, totalMax: 150000, // cents
};

const PHONE = '647-298-2267';
const BIG_ORDER = 'That’s a big order! Please call us at ' + PHONE + ' to place it.';
const PAUSED = 'Online ordering is paused, please call ' + PHONE + '.';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/create-order') {
      if (request.method !== 'POST') return json({ success: false, error: 'Use POST.' }, 405, { Allow: 'POST' });
      return createOrder(request, env, url, ctx);
    }
    if (url.pathname === '/api/config') return json(config(env));
    if (url.pathname === '/api/health') return json(await health(env));
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
    stores: stores,
  };
}

async function health(env) {
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
      Object.keys(stores).every(function (id) { return stores[id].ready; }),
    commit: env.BUILD_COMMIT || 'unknown',
    clover: isProduction(env) ? 'production' : 'sandbox',
    currency: env.CLOVER_CURRENCY || 'cad',
    orderingOpen: orderingOpen(env),
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
  // The switch is checked here, not only on the page
  if (!orderingOpen(env)) return json({ success: false, error: PAUSED }, 503);

  // Only the ordering page (same site, JSON) may place orders
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ success: false, error: 'Not allowed.' }, 403);
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) {
    return json({ success: false, error: 'The order couldn’t be read. Please refresh and try again.' }, 415);
  }

  let order;
  try {
    const text = await request.text();
    if (text.length > LIMITS.bodyBytes) throw new BadRequest(BIG_ORDER);
    order = priceOrder(JSON.parse(text), new Date(), env);
  } catch (error) {
    if (error instanceof BadRequest) return json({ success: false, error: error.message }, 400);
    return json({ success: false, error: 'The order couldn’t be read. Please refresh and try again.' }, 400);
  }

  const store = order.location;
  const missing = missingSettings(env, store);
  if (missing.length) {
    console.error('create-order: missing settings for ' + store + ': ' + missing.join(', '));
    return json({ success: false, error: 'Online payment isn’t set up yet. Please call us at ' + PHONE + ' to order.' }, 503);
  }
  // Every dish and option needs its Clover ID; never fall back to name + price
  if (order.missing.length || !storeHasCloverIds(env, store)) {
    console.error('create-order: no Clover IDs for ' + (order.missing.join(', ') || 'merchant of ' + store) +
      ' (' + (isProduction(env) ? 'production' : 'sandbox') + ')');
    return json({ success: false, error: 'Online payment isn’t set up yet. Please call us at ' + PHONE + ' to order.' }, 503);
  }
  const s = storeSettings(env, store);
  const urls = cloverUrls(env);
  const auth = { authorization: 'Bearer ' + s.privateToken };
  const merchantUrl = urls.api + '/v3/merchants/' + encodeURIComponent(s.merchantId);
  const orderUrl = function (id) { return merchantUrl + '/orders/' + encodeURIComponent(id); };

  // 1. Create the order. Each line is the Clover item (Clover fills in its
  // name, price, tax and labels) plus its modifiers; no name or price here.
  const orderCart = {
    title: 'Online Pickup',
    note: order.note,
    lineItems: order.lineItems.map(cloverLine),
  };
  if (s.orderTypeId) orderCart.orderType = { id: s.orderTypeId };

  const created = await clover(merchantUrl + '/atomic_order/orders', auth, { orderCart: orderCart });
  const orderId = created.ok && created.data && created.data.id;
  if (!orderId) {
    console.error('create-order: atomic order failed', store, created.status, created.error);
    return json({ success: false, error: 'We couldn’t place your order and no charge was made. Please try again.' }, 502);
  }

  // Clover's total should match ours; if not, don't charge
  if (typeof created.data.total === 'number' && Math.abs(created.data.total - order.total) > 1) {
    console.error('create-order: total mismatch', orderId, 'clover', created.data.total, 'ours', order.total);
    await deleteUnpaid(orderUrl(orderId), auth);
    return json({ success: false, error: 'We couldn’t price your order and no charge was made. Please call us at ' + PHONE + '.' }, 500);
  }
  const amount = typeof created.data.total === 'number' ? created.data.total : order.total;

  // 2. Pay it. The clv_ token is single-use, so a retry can't charge twice.
  const paid = await clover(urls.ecom + '/v1/orders/' + encodeURIComponent(orderId) + '/pay', Object.assign({
    'idempotency-key': crypto.randomUUID(),
    'x-forwarded-for': request.headers.get('cf-connecting-ip') || '',
    'user-agent': request.headers.get('user-agent') || 'tacos-de-princesa',
  }, auth), {
    source: order.source,
    amount: amount,
    currency: env.CLOVER_CURRENCY || 'cad',
    ecomind: 'ecom',
    metadata: { delete_order_on_failure: true },
  });

  if (!paid.ok) {
    console.error('create-order: payment failed', orderId, paid.status, paid.error);

    // No clear answer (timeout, Clover 5xx): the charge may still have gone
    // through, so look at the order before deleting anything
    if (paid.status === 0 || paid.status >= 500) {
      const check = await clover(orderUrl(orderId), auth, null, 'GET');
      if (check.ok && check.data && check.data.paymentState === 'PAID') {
        console.log('create-order: paid (confirmed after an unclear reply)', orderId);
        return paidOrder(ctx, env, merchantUrl, auth, orderId, order, amount);
      }
      if (!check.ok) {
        console.error('create-order: PAYMENT STATE UNKNOWN, order left in Clover', orderId, check.status);
        return json({ success: false, error: 'We couldn’t confirm your payment. Please call us at ' + PHONE + ' before trying again.' }, 502);
      }
    }

    // Not paid: make sure it can't reach the kitchen. delete_order_on_failure
    // doesn't cover every failure (e.g. a currency error).
    await deleteUnpaid(orderUrl(orderId), auth);

    // Declines come back as 402 { code: 'card_declined', message: 'DECLINED: …' };
    // Clover's message isn't customer-friendly, so it's only logged
    const error = paid.error || {};
    const declined = paid.status === 402 || error.code === 'card_declined' || error.type === 'card_error';
    const badSource = !declined && (error.code === 'token_already_used' ||
      (error.code === 'invalid_request' && /source/i.test(error.message || '')));
    return json({
      success: false,
      error: declined ? 'Your card was declined and no charge was made. Please try another card.'
        : badSource ? 'Your card details expired. Please enter them again.'
        : 'Payment didn’t go through and no charge was made. Please try again.',
      // Sandbox only: Clover's own reason, for testing (e.g. the test
      // merchant's per-card sale limit). Never shown to real customers.
      detail: isProduction(env) ? undefined : String((typeof paid.error === 'string' ? paid.error : error.message) || '').slice(0, 200) || undefined,
    }, declined ? 402 : badSource ? 400 : 502);
  }

  return paidOrder(ctx, env, merchantUrl, auth, orderId, order, amount);
}

// 3. Paid: answer the customer now; print in the background. Printing never
// delays or changes the customer's answer.
function paidOrder(ctx, env, merchantUrl, auth, orderId, order, amount) {
  console.log('ORDER ' + orderId + ' store=' + order.location + ' amount=' + amount);
  const job = printAndVerify(env, merchantUrl, auth, orderId, order).catch(function (error) {
    console.error('PRINT CHECK ERROR ' + orderId + ': ' + error);
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(job);
  return json({ success: true, orderId: orderId, total: amount });
}

// Send the order to the kitchen printer, retry once, then check it really
// printed: a 200 only means Clover accepted the job (an offline printer
// accepts it and never prints). Alerts by email if it didn't print.
async function printAndVerify(env, merchantUrl, auth, orderId, order) {
  const started = Date.now();
  const wait = function (ms) { return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, ms)); }); };
  const where = ' (store ' + order.location + ')';
  const print = function () {
    return clover(merchantUrl + '/print_event', auth, { orderRef: { id: orderId } }, 'POST', PRINT.timeoutMs);
  };

  let printed = await print();
  if (!(printed.ok && printed.data && printed.data.id)) {
    console.error('PRINT FAILED ' + orderId + where + ', HTTP ' + printed.status + ', attempt 1: retrying in 5 s', printed.error);
    await wait(PRINT.retryAfterMs);
    printed = await print();
  }
  const jobId = printed.ok && printed.data && printed.data.id;
  if (!jobId) {
    console.error('PRINT FAILED ' + orderId + where + ', HTTP ' + printed.status + ', attempt 2: print it from Clover by hand', printed.error);
    return sendPrintAlert(env, orderId, order, 'Clover refused the print request twice (' + errorText(printed) + ').');
  }
  console.log('PRINT SENT ' + orderId + where + ', job ' + jobId);

  let state = 'CREATED';
  for (const at of PRINT.checksMs) {
    await wait(started + at - Date.now());
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
  const r = await clover(merchantUrl + '/print_event/' + encodeURIComponent(jobId),
    Object.assign({ 'user-agent': 'tacos-de-princesa' }, auth), null, 'GET', 4000);
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

// Delete an unpaid order. 404 means it's already gone (delete_order_on_failure).
async function deleteUnpaid(url, auth) {
  const removed = await clover(url, auth, null, 'DELETE');
  if (!removed.ok && removed.status !== 404) {
    console.error('create-order: UNPAID ORDER NOT DELETED, remove it in Clover', url.split('/').pop(), removed.status);
  }
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
    };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: String(error) };
  }
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
