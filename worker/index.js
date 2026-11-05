/* ==========================================================================
   Tacos De Princesa — worker/index.js
   The site is static files (wrangler.toml [assets]); this Worker only runs
   for /api/* (run_worker_first) and anything without a matching file.

   POST /api/create-order   (JSON, same-site only)
     { source: 'clv_…', cart: [{ item, qty, mods: [{ g, label }], note }],
       pickup: { name, phone, location, asap, time: 'YYYY-MM-DDTHH:MM' | null } }
   Checks everything, prices the cart from worker/menu.js (browser prices are
   never trusted), creates a Clover atomic order, then pays it with the card
   token. An order that isn't paid is deleted, so it never reaches the kitchen.
     -> 200 { success: true, orderId, total }
     -> 4xx/5xx { success: false, error }   (error is shown to the customer)

   GET /api/health
     Which settings this deployment can see (yes/no only, never values) and
     the commit it was built from (BUILD_COMMIT, set by
     scripts/deploy-preview.sh), to check a deployment's setup.

   Settings: the secret CLOVER_PRIVATE_TOKEN (the merchant's private
   Ecommerce API token; see wrangler.toml for where it's set), and in
   wrangler.toml [vars] / [previews.vars]: CLOVER_ENV, CLOVER_MERCHANT_ID,
   CLOVER_TAX_RATE_ID, CLOVER_CURRENCY, optionally CLOVER_ORDER_TYPE_ID.

   GOING LIVE (sandbox -> the restaurant's Clover merchant)
   1. Clover: in the live merchant's dashboard, create an Ecommerce API token
      ("Hosted iFrame + API/SDK") and an HST 13% tax rate; note the public
      token, private token, merchant ID and tax rate ID. Check the merchant's
      currency is CAD.
   2. wrangler.toml [vars]: CLOVER_ENV = "production", CLOVER_MERCHANT_ID,
      CLOVER_TAX_RATE_ID (live values), CLOVER_CURRENCY = "cad".
   3. Cloudflare: Workers > tacos-de-princesa > Settings > Variables and
      Secrets: CLOVER_PRIVATE_TOKEN = the live private token (type Secret).
   4. js/order.js CONFIG.clover: the live public token and merchant ID.
   5. order.html: the Clover SDK script becomes https://checkout.clover.com/sdk.js
   6. Place a real low-value order, check it in Clover, refund it.

   NOT DONE YET (known gaps)
   - Kitchen: orders appear in Clover but aren't sent to the order printer or
     Kitchen Display. Next step: POST /v3/merchants/{mId}/print_event
     { orderRef: { id } } after payment, then check on the restaurant's devices.
   - Timing: scheduled orders reach Clover as soon as they're paid; holding
     them until 20 minutes before pickup needs a scheduled job (Cron Trigger
     plus storage such as KV or a Durable Object).
   - SMS: the confirmation page says a text is coming; nothing sends one.
   - No rate limiting on /api/create-order (Clover's reCAPTCHA on the card
     form is the only bot check). Consider Cloudflare rate limiting rules.
   - If Clover creates the order but the connection drops before its reply,
     that unpaid order can't be cleaned up here (its ID never arrives).
   ========================================================================== */

import { GROUPS, ITEMS, TAX_RATE } from './menu.js';

const CLOVER_URLS = {
  sandbox: { api: 'https://apisandbox.dev.clover.com', ecom: 'https://scl-sandbox.dev.clover.com' },
  production: { api: 'https://api.clover.com', ecom: 'https://scl.clover.com' },
};

// Keep in sync with LOCATIONS and CONFIG (pickup timing) in js/order.js.
// days: 0 = Sunday ... 6 = Saturday
const LOCATIONS = {
  'king-st-w': { label: 'King St W (150 King St W, in the PATH)', days: [1, 2, 3, 4, 5], open: '10:30', close: '18:00' },
  'one-york': { label: 'One York (One York Street, 2nd Floor)', days: [1, 2, 3, 4, 5], open: '10:30', close: '18:00' },
};

const PICKUP = {
  timeZone: 'America/Toronto',
  slotMinutes: 15,
  kitchenLeadMinutes: 20,
  lastSlotBeforeClose: 15,
  daysAhead: 7,
  graceMinutes: 10, // a slot chosen a few minutes ago may now be slightly too soon
};

const LIMITS = {
  bodyBytes: 20000, linesMax: 30, qtyMax: 20, itemsMax: 60, modsMax: 12,
  noteMax: 140, nameMax: 60, totalMax: 150000, // cents
};

const PHONE = '647-298-2267';
const BIG_ORDER = 'That’s a big order! Please call us at ' + PHONE + ' to place it.';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/create-order') {
      if (request.method !== 'POST') return json({ success: false, error: 'Use POST.' }, 405, { Allow: 'POST' });
      return createOrder(request, env, url);
    }
    if (url.pathname === '/api/health') return json(health(env));
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

const REQUIRED = ['CLOVER_PRIVATE_TOKEN', 'CLOVER_MERCHANT_ID', 'CLOVER_TAX_RATE_ID'];

function missingSettings(env) {
  return REQUIRED.filter(function (key) { return !env[key]; });
}

function health(env) {
  const settings = {};
  REQUIRED.forEach(function (key) { settings[key] = !!env[key]; });
  return {
    ready: !missingSettings(env).length,
    commit: env.BUILD_COMMIT || 'unknown',
    clover: env.CLOVER_ENV === 'production' ? 'production' : 'sandbox',
    currency: env.CLOVER_CURRENCY || 'cad',
    settings: settings,
  };
}

// A problem with what the browser sent: the message is shown to the customer
class BadRequest extends Error {}


/* ---- Create + pay ----------------------------------------------------- */

async function createOrder(request, env, url) {
  const missing = missingSettings(env);
  if (missing.length) {
    console.error('create-order: missing settings: ' + missing.join(', '));
    return json({ success: false, error: 'Online payment isn’t set up yet. Please call us at ' + PHONE + ' to order.' }, 503);
  }

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
    order = priceOrder(JSON.parse(text), new Date());
  } catch (error) {
    if (error instanceof BadRequest) return json({ success: false, error: error.message }, 400);
    return json({ success: false, error: 'The order couldn’t be read. Please refresh and try again.' }, 400);
  }

  const urls = CLOVER_URLS[env.CLOVER_ENV === 'production' ? 'production' : 'sandbox'];
  const auth = { authorization: 'Bearer ' + env.CLOVER_PRIVATE_TOKEN };
  const merchantUrl = urls.api + '/v3/merchants/' + encodeURIComponent(env.CLOVER_MERCHANT_ID);
  const orderUrl = function (id) { return merchantUrl + '/orders/' + encodeURIComponent(id); };

  // 1. Create the order (Clover adds the tax from CLOVER_TAX_RATE_ID)
  const orderCart = {
    title: 'Online Pickup',
    note: order.note,
    lineItems: order.lineItems.map(function (line) {
      return { name: line.name, price: line.price, note: line.note || undefined, taxRates: [{ id: env.CLOVER_TAX_RATE_ID }] };
    }),
  };
  if (env.CLOVER_ORDER_TYPE_ID) orderCart.orderType = { id: env.CLOVER_ORDER_TYPE_ID };

  const created = await clover(merchantUrl + '/atomic_order/orders', auth, { orderCart: orderCart });
  const orderId = created.ok && created.data && created.data.id;
  if (!orderId) {
    console.error('create-order: atomic order failed', created.status, created.error);
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
        console.log('create-order: paid (confirmed after an unclear reply)', orderId, amount);
        return json({ success: true, orderId: orderId, total: amount });
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
    }, declined ? 402 : badSource ? 400 : 502);
  }

  console.log('create-order: paid', orderId, amount);
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
// Clover's error object or message, without request details.
async function clover(url, headers, body, method) {
  try {
    const response = await fetch(url, {
      method: method || 'POST',
      headers: Object.assign({ accept: 'application/json', 'content-type': 'application/json' }, headers),
      body: body ? JSON.stringify(body) : undefined,
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

function priceOrder(body, now) {
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

  const pickup = checkPickup(body.pickup, now);
  const tax = Math.round(subtotal * TAX_RATE);
  if (subtotal + tax > LIMITS.totalMax) throw new BadRequest(BIG_ORDER);

  return {
    source: source,
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

// -> { name: 'Pollo Burrito', price: 1800, note: 'Bowl, Add guacamole. "extra spicy"' }
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
  // 'one' groups (e.g. bowl or wrap) need exactly one choice
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

function checkPickup(pickup, now) {
  if (!pickup || typeof pickup !== 'object') throw new BadRequest('Pickup details are missing.');

  const name = clean(typeof pickup.name === 'string' ? pickup.name : '').slice(0, LIMITS.nameMax);
  if (!name) throw new BadRequest('Please add a name for the order.');

  const digits = String(pickup.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (!/^[2-9]\d{9}$/.test(digits)) throw new BadRequest('Please add a 10-digit phone number.');

  if (typeof pickup.location !== 'string' || !Object.prototype.hasOwnProperty.call(LOCATIONS, pickup.location)) {
    throw new BadRequest('Please choose a pickup location.');
  }
  const location = LOCATIONS[pickup.location];
  const open = toMinutes(location.open);
  const close = toMinutes(location.close);
  const today = torontoNow(now);
  const timeGone = new BadRequest('That pickup time is no longer available. Please go back and choose another.');

  let when;
  if (pickup.asap === true) {
    // Same rule as the page: ASAP only while open, with time to cook
    if (location.days.indexOf(today.weekday) === -1 || today.minutes < open ||
        today.minutes + PICKUP.kitchenLeadMinutes > close + PICKUP.graceMinutes) throw timeGone;
    when = 'ASAP (ordered ' + timeText(today.minutes) + ')';
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(typeof pickup.time === 'string' ? pickup.time : '');
    if (!m) throw new BadRequest('Please choose a pickup time.');
    // The time is Toronto time; work in whole days and minutes, no conversion
    const day = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const minutes = +m[4] * 60 + +m[5];
    const daysAway = Math.round((day - Date.UTC(today.y, today.m - 1, today.d)) / 86400000);
    const weekday = new Date(day).getUTCDay();
    if (isNaN(daysAway) || daysAway < 0 || daysAway > PICKUP.daysAhead ||
        location.days.indexOf(weekday) === -1 ||
        minutes % PICKUP.slotMinutes !== 0 ||
        minutes < open + PICKUP.kitchenLeadMinutes || minutes > close - PICKUP.lastSlotBeforeClose ||
        (daysAway === 0 && minutes < today.minutes + PICKUP.kitchenLeadMinutes - PICKUP.graceMinutes)) throw timeGone;
    when = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
      .format(new Date(day)) + ', ' + timeText(minutes);
  }

  return {
    name: name,
    phone: digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6),
    location: pickup.location,
    when: when,
  };
}

// Today's date, weekday and minutes since midnight in Toronto
function torontoNow(now) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: PICKUP.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).forEach(function (part) { p[part.type] = part.value; });
  const y = +p.year, m = +p.month, d = +p.day;
  return { y: y, m: m, d: d, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(), minutes: +p.hour * 60 + +p.minute };
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
