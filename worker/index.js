/* ==========================================================================
   Tacos De Princesa — worker/index.js
   The site is static files (wrangler.toml [assets]); this Worker only runs
   for /api/* (run_worker_first) and anything without a matching file.

   POST /api/create-order
     { source: 'clv_…', cart: [{ item, qty, mods: [{ g, label }], note }],
       pickup: { name, phone, location, asap, time: 'YYYY-MM-DDTHH:MM' | null } }
   Prices the cart from worker/menu.js (browser prices are never trusted),
   creates a Clover atomic order, then pays it with the card token.
     -> 200 { success: true, orderId, total }
     -> 4xx/5xx { success: false, error }

   GET /api/health
     Which settings this deployment can see (yes/no only, never values) and
     the commit it was built from (BUILD_COMMIT, set by
     scripts/deploy-preview.sh), to check a preview's setup.

   Settings: the secret CLOVER_PRIVATE_TOKEN (the merchant's private
   Ecommerce API token; see wrangler.toml for where it's set), and in
   wrangler.toml [vars]: CLOVER_ENV, CLOVER_MERCHANT_ID, CLOVER_TAX_RATE_ID,
   CLOVER_CURRENCY (default 'cad'; must match the merchant's currency).
   ========================================================================== */

import { GROUPS, ITEMS, TAX_RATE } from './menu.js';

const CLOVER_URLS = {
  sandbox: { api: 'https://apisandbox.dev.clover.com', ecom: 'https://scl-sandbox.dev.clover.com' },
  production: { api: 'https://api.clover.com', ecom: 'https://scl.clover.com' },
};

// Keep in sync with LOCATIONS in js/order.js
const LOCATIONS = {
  'king-st-w': 'King St W (150 King St W, in the PATH)',
  'one-york': 'One York (One York Street, 2nd Floor)',
};

const LIMITS = { linesMax: 30, qtyMax: 20, itemsMax: 60, noteMax: 140, nameMax: 60 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/create-order') {
      if (request.method !== 'POST') return json({ success: false, error: 'Use POST.' }, 405, { Allow: 'POST' });
      return createOrder(request, env);
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

async function createOrder(request, env) {
  const missing = missingSettings(env);
  if (missing.length) {
    console.error('create-order: missing settings: ' + missing.join(', '));
    return json({ success: false, error: 'Online payment isn’t set up yet. Please order in store.' }, 503);
  }
  const urls = CLOVER_URLS[env.CLOVER_ENV === 'production' ? 'production' : 'sandbox'];

  let order;
  try {
    const body = await request.json();
    order = priceOrder(body);
  } catch (error) {
    if (error instanceof BadRequest) return json({ success: false, error: error.message }, 400);
    return json({ success: false, error: 'The order couldn’t be read. Please refresh and try again.' }, 400);
  }

  const auth = { authorization: 'Bearer ' + env.CLOVER_PRIVATE_TOKEN };
  const merchantUrl = urls.api + '/v3/merchants/' + encodeURIComponent(env.CLOVER_MERCHANT_ID);

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
  if (!created.ok) {
    console.error('create-order: atomic order failed', created.status, created.error);
    return json({ success: false, error: 'We couldn’t place your order. Please try again.' }, 502);
  }
  const orderId = created.data.id;

  // Clover's total should match ours; if not, don't charge
  if (typeof created.data.total === 'number' && Math.abs(created.data.total - order.total) > 1) {
    console.error('create-order: total mismatch', orderId, 'clover', created.data.total, 'ours', order.total);
    await clover(merchantUrl + '/orders/' + orderId, auth, null, 'DELETE');
    return json({ success: false, error: 'We couldn’t price your order. Please try again.' }, 500);
  }
  const amount = typeof created.data.total === 'number' ? created.data.total : order.total;

  // 2. Pay it. The clv_ token is single-use, so a retry can't charge twice.
  const paid = await clover(urls.ecom + '/v1/orders/' + orderId + '/pay', Object.assign({
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
    // delete_order_on_failure doesn't cover every failure (e.g. a currency
    // error), so make sure an unpaid order doesn't reach the kitchen
    await clover(merchantUrl + '/orders/' + orderId, auth, null, 'DELETE');
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

// POST/DELETE to Clover. Returns { ok, status, data, error } and never throws;
// error is Clover's error object or message, without request details.
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

function priceOrder(body) {
  if (!body || typeof body !== 'object') throw new BadRequest('The order is empty.');

  const source = body.source;
  if (typeof source !== 'string' || !/^clv_[A-Za-z0-9_-]{8,200}$/.test(source)) {
    throw new BadRequest('Card details are missing. Please enter your card again.');
  }

  const cart = body.cart;
  if (!Array.isArray(cart) || !cart.length) throw new BadRequest('Your cart is empty.');
  if (cart.length > LIMITS.linesMax) throw new BadRequest('That’s a big order! Please call us to place it.');

  const lineItems = [];
  let subtotal = 0;
  cart.forEach(function (line) {
    const priced = priceLine(line);
    subtotal += priced.price * line.qty;
    // One Clover line item per dish, so each prints and shows on its own
    for (let i = 0; i < line.qty; i++) lineItems.push(priced);
  });
  if (lineItems.length > LIMITS.itemsMax) throw new BadRequest('That’s a big order! Please call us to place it.');

  const pickup = checkPickup(body.pickup);
  const tax = Math.round(subtotal * TAX_RATE);
  return {
    source: source,
    lineItems: lineItems,
    subtotal: subtotal,
    tax: tax,
    total: subtotal + tax,
    note: [
      'ONLINE PICKUP: ' + pickup.when,
      'Name: ' + pickup.name,
      'Phone: ' + pickup.phone,
      'Location: ' + LOCATIONS[pickup.location],
    ].join('\n'),
  };
}

// -> { name: 'Pollo Burrito', price: 1800, note: 'Bowl, Add guacamole. "extra spicy"' }
function priceLine(line) {
  const unknown = new BadRequest('Something in your cart is no longer on the menu. Please remove it and try again.');
  const item = line && ITEMS[line.item];
  if (!item) throw unknown;
  if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > LIMITS.qtyMax) throw new BadRequest('Please check the quantities in your cart.');

  const mods = Array.isArray(line.mods) ? line.mods : [];
  const seen = {};
  let price = item.price;
  mods.forEach(function (mod) {
    const group = mod && item.groups.indexOf(mod.g) !== -1 && GROUPS[mod.g];
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

function checkPickup(pickup) {
  if (!pickup || typeof pickup !== 'object') throw new BadRequest('Pickup details are missing.');

  const name = clean(typeof pickup.name === 'string' ? pickup.name : '').slice(0, LIMITS.nameMax);
  if (!name) throw new BadRequest('Please add a name for the order.');

  const digits = String(pickup.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (digits.length !== 10) throw new BadRequest('Please add a 10-digit phone number.');

  if (!Object.prototype.hasOwnProperty.call(LOCATIONS, pickup.location)) throw new BadRequest('Please choose a pickup location.');

  let when = 'ASAP';
  if (!pickup.asap) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(pickup.time || '');
    if (!m) throw new BadRequest('Please choose a pickup time.');
    // The time is already Toronto time: format it without converting
    const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    when = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(date);
  }

  return {
    name: name,
    phone: digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6),
    location: pickup.location,
    when: when,
  };
}

// One line of plain text: no control characters, single spaces
function clean(text) {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}
