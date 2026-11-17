/* ==========================================================================
   Per-IP rate limiter — a Durable Object (one globally-consistent instance per
   IP, keyed by idFromName(ip)). Called over its fetch() interface (so it works
   on the Worker's older compatibility date, without RPC), with a JSON body of
   the current limits (worker/index.js rateLimitSettings; tunable via vars):
     POST /order  -> records an order attempt, returns
                     { orders, fails, orderOver, failOver, shouldEmail }
     POST /fail   -> records a failed payment, returns { fails }
   Two sliding windows are kept as timestamp lists in storage: order attempts
   (generous; PATH offices share one IP) and failed payments (strict; card
   testers). shouldEmail debounces staff alerts to one per IP per fail window.
   An alarm prunes/clears the lists so storage doesn't grow.

   The chosen tool: the Workers Rate Limiting binding can't express a 10-minute
   window (its period is only 10 or 60 s) and counts per Cloudflare location, so
   a card tester could fail 5 times in each location. A Durable Object gives one
   strict, global count per IP and a real 10-minute window. SQLite-backed, so it
   runs on the Workers Free plan.
   ========================================================================== */

export class RateLimiter {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const now = Date.now();
    const path = new URL(request.url).pathname;
    const b = await request.json().catch(function () { return {}; });
    const orderWindowMs = pos(b.orderWindowMs, 60000);
    const failWindowMs = pos(b.failWindowMs, 600000);
    const orderLimit = pos(b.orderLimit, 20);
    const failLimit = pos(b.failLimit, 5);

    let orders = (await this.storage.get('orders')) || [];
    let fails = (await this.storage.get('fails')) || [];
    orders = orders.filter(function (t) { return t > now - orderWindowMs; });
    fails = fails.filter(function (t) { return t > now - failWindowMs; });

    if (path === '/fail') {
      fails.push(now);
      await this.storage.put('fails', fails);
      await this.bumpAlarm(now, Math.max(orderWindowMs, failWindowMs));
      return jsonRes({ fails: fails.length });
    }

    // /order (default): record an attempt and report both windows.
    orders.push(now);
    await this.storage.put('orders', orders);
    const orderOver = orders.length > orderLimit;
    const failOver = fails.length >= failLimit;

    let shouldEmail = false;
    if (orderOver || failOver) {
      const last = (await this.storage.get('emailedAt')) || 0;
      if (last <= now - failWindowMs) { shouldEmail = true; await this.storage.put('emailedAt', now); }
    }
    await this.bumpAlarm(now, Math.max(orderWindowMs, failWindowMs));
    return jsonRes({ orders: orders.length, fails: fails.length, orderOver: orderOver, failOver: failOver, shouldEmail: shouldEmail });
  }

  async bumpAlarm(now, windowMs) {
    try {
      const existing = await this.storage.getAlarm();
      if (!existing) await this.storage.setAlarm(now + windowMs + 5000);
    } catch (e) { /* alarms unavailable: lists are still pruned on each call */ }
  }

  // Clean up once the windows have passed so storage doesn't grow.
  async alarm() {
    const now = Date.now();
    const orders = ((await this.storage.get('orders')) || []).filter(function (t) { return t > now - 600000; });
    const fails = ((await this.storage.get('fails')) || []).filter(function (t) { return t > now - 600000; });
    if (!orders.length && !fails.length) {
      await this.storage.deleteAll();
    } else {
      await this.storage.put('orders', orders);
      await this.storage.put('fails', fails);
      await this.storage.setAlarm(now + 600000 + 5000);
    }
  }
}

function pos(v, d) { return typeof v === 'number' && v > 0 ? v : d; }
function jsonRes(body) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}
