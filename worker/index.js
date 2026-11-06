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
     -> 200 { success: true, orderId, total }
     -> 4xx/5xx { success: false, error }   (error is shown to the customer)

   GET /api/health
     Ordering open, enabled stores and, per store, which settings are set
     and a live Clover check of its tax rate and order type: yes/no and
     ok/fail only, never values. Plus the commit it was built from
     (BUILD_COMMIT, set by scripts/deploy-preview.sh).

   SETTINGS (wrangler.toml [vars] / [previews.vars] / [env.livetest.vars])
     ORDERING_OPEN       "true" to take orders; anything else pauses them
     STORES_ENABLED      stores taking orders, e.g. "one-york" or
                         "one-york,king-st-w"
     CLOSED_DATES        days with no pickups (PATH holidays), Toronto dates:
                         "2026-12-25,2026-12-28"; empty for none
     CLOVER_ENV          "sandbox" or "production"
     CLOVER_CURRENCY     "usd" (sandbox test merchant) or "cad"
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

const CLOVER_URLS = {
  sandbox: { api: 'https://apisandbox.dev.clover.com', ecom: 'https://scl-sandbox.dev.clover.com', sdk: 'https://checkout.sandbox.dev.clover.com/sdk.js' },
  production: { api: 'https://api.clover.com', ecom: 'https://scl.clover.com', sdk: 'https://checkout.clover.com/sdk.js' },
};

// Keep in sync with LOCATIONS and CONFIG (pickup timing) in js/order.js.
// suffix: the store's settings suffix. days: 0 = Sunday ... 6 = Saturday
const LOCATIONS = {
  'king-st-w': { label: 'King St W (150 King St W, in the PATH)', suffix: 'KING_ST_W', days: [1, 2, 3, 4, 5], open: '10:30', close: '18:00' },
  'one-york': { label: 'One York (One York Street, 2nd Floor)', suffix: 'ONE_YORK', days: [1, 2, 3, 4, 5], open: '10:30', close: '19:00' },
};

const PICKUP = {
  timeZone: 'America/Toronto',
  slotMinutes: 15,
  kitchenLeadMinutes: 20,
  lastSlotBeforeClose: 30,
  graceMinutes: 10, // a slot chosen a few minutes ago may now be slightly too soon
};

const LIMITS = {
  bodyBytes: 20000, linesMax: 30, qtyMax: 20, itemsMax: 60, modsMax: 12,
  noteMax: 140, nameMax: 60, totalMax: 150000, // cents
};

const PHONE = '647-298-2267';
const BIG_ORDER = 'That’s a big order! Please call us at ' + PHONE + ' to place it.';
const PAUSED = 'Online ordering is paused, please call ' + PHONE + '.';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/create-order') {
      if (request.method !== 'POST') return json({ success: false, error: 'Use POST.' }, 405, { Allow: 'POST' });
      return createOrder(request, env, url);
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
      ready: !missingSettings(env, id).length && results[0] === 'ok' && (results[1] === 'ok' || (!isProduction(env) && results[1] === 'not set')),
      settings: settings,
      orderTypeSet: !!s.orderTypeId,
      clover: { taxRate: results[0], orderType: results[1] },
    };
  }));

  return {
    ready: orderingOpen(env) && Object.keys(stores).length > 0 && Object.keys(stores).every(function (id) { return stores[id].ready; }),
    commit: env.BUILD_COMMIT || 'unknown',
    clover: isProduction(env) ? 'production' : 'sandbox',
    currency: env.CLOVER_CURRENCY || 'cad',
    orderingOpen: orderingOpen(env),
    storesEnabled: enabledStores(env),
    closedDates: closedDates(env).length,
    stores: stores,
  };
}

// A problem with what the browser sent: the message is shown to the customer
class BadRequest extends Error {}


/* ---- Create + pay ----------------------------------------------------- */

async function createOrder(request, env, url) {
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
  const s = storeSettings(env, store);
  const urls = cloverUrls(env);
  const auth = { authorization: 'Bearer ' + s.privateToken };
  const merchantUrl = urls.api + '/v3/merchants/' + encodeURIComponent(s.merchantId);
  const orderUrl = function (id) { return merchantUrl + '/orders/' + encodeURIComponent(id); };

  // 1. Create the order (Clover adds the tax from the store's tax rate)
  const orderCart = {
    title: 'Online Pickup',
    note: order.note,
    lineItems: order.lineItems.map(function (line) {
      return { name: line.name, price: line.price, note: line.note || undefined, taxRates: [{ id: s.taxRateId }] };
    }),
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
        return paidOrder(merchantUrl, auth, orderId, store, amount);
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

  return paidOrder(merchantUrl, auth, orderId, store, amount);
}

// 3. Paid: send it to the kitchen printer, log the order, answer success.
// A failed print never turns a paid order into an error for the customer.
async function paidOrder(merchantUrl, auth, orderId, store, amount) {
  const printed = await clover(merchantUrl + '/print_event', auth, { orderRef: { id: orderId } }, 'POST', 8000);
  const printId = printed.ok && printed.data && printed.data.id;
  if (!printId) {
    console.error('PRINT FAILED ' + orderId + ' (store ' + store + ', HTTP ' + printed.status + '): print it from Clover by hand', printed.error);
  }
  console.log('ORDER ' + orderId + ' store=' + store + ' amount=' + amount + ' print=' + (printId || 'FAILED'));
  return json({ success: true, orderId: orderId, total: amount });
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

  const lineItems = [];
  let subtotal = 0;
  cart.forEach(function (line) {
    const priced = priceLine(line);
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

// -> { name: 'Pollo Burrito', price: 1800, note: 'Add guacamole. "extra spicy"' }
function priceLine(line) {
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

  // Name and options as the cart shows them (see lineName/modsText in js/order.js)
  const named = item.nameFrom && mods.find(function (m) { return m.g === item.nameFrom; });
  const options = mods.filter(function (m) { return m !== named; }).map(function (m) { return m.label; });
  return {
    name: named ? item.fullName + ' ' + named.label : item.fullName,
    price: price,
    note: [options.join(', '), note && '"' + note + '"'].filter(Boolean).join('. '),
  };
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

  const location = LOCATIONS[pickup.location];
  const open = toMinutes(location.open);
  const last = toMinutes(location.close) - PICKUP.lastSlotBeforeClose;
  const today = torontoNow(now);
  const closed = new BadRequest('We’re not taking online orders right now. Please call us at ' + PHONE + '.');
  const timeGone = new BadRequest('That pickup time is no longer available. Please go back and choose another.');

  // Open now: a store day, not a closed date, between opening and the last
  // time an ASAP order can still be ready by the last slot
  if (location.days.indexOf(today.weekday) === -1 || closedDates(env).indexOf(today.iso) !== -1 ||
      today.minutes < open || today.minutes + PICKUP.kitchenLeadMinutes > last + PICKUP.graceMinutes) throw closed;

  let when;
  if (pickup.asap === true) {
    when = 'ASAP (ordered ' + timeText(today.minutes) + ')';
  } else {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(typeof pickup.time === 'string' ? pickup.time : '');
    if (!m) throw new BadRequest('Please choose a pickup time.');
    const minutes = +m[2] * 60 + +m[3];
    if (m[1] !== today.iso ||
        minutes % PICKUP.slotMinutes !== 0 ||
        minutes < open + PICKUP.kitchenLeadMinutes || minutes > last ||
        minutes < today.minutes + PICKUP.kitchenLeadMinutes - PICKUP.graceMinutes) throw timeGone;
    when = 'Today ' + timeText(minutes);
  }

  return {
    name: name,
    phone: digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6),
    location: pickup.location,
    when: when,
  };
}

// Today's date ('YYYY-MM-DD'), weekday and minutes since midnight in Toronto
function torontoNow(now) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: PICKUP.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).forEach(function (part) { p[part.type] = part.value; });
  const y = +p.year, m = +p.month, d = +p.day;
  return {
    iso: p.year + '-' + p.month + '-' + p.day,
    weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
    minutes: +p.hour * 60 + +p.minute,
  };
}

function toMinutes(hhmm) {
  const parts = hhmm.split(':');
  return +parts[0] * 60 + +parts[1];
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
