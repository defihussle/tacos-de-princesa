// Browser check of the payment page's end states (item A1b-1), run with the
// Playwright MCP: mcp__puppeteer__browser_run_code_unsafe { filename:
// ".local/audit-tests/browser-page-states.js" }. Needs the static server on
// http://127.0.0.1:8099 (scratchpad/serve.mjs) serving the repo root.
//
// It loads the REAL order.html + js/order.js, stubs /api/config, the Clover
// SDK and /api/create-order, seeds a cart + pickup so the page opens on the
// payment step, then drives Pay for three outcomes and checks the DOM:
//   decline      -> status line shows the message, Pay stays usable, no notice
//   unconfirmed  -> Pay LOCKED, call-us notice (tap-to-call), cart kept
//   lost conn.   -> Pay LOCKED, call-us notice (tap-to-call), cart kept
async (page) => {
  const BASE = 'http://127.0.0.1:8099';

  const cloverStub = "window.Clover = function(){ return {" +
    " elements: function(){ return { create: function(){ return { mount:function(){}, addEventListener:function(){}, on:function(){} }; } }; }," +
    " createToken: function(){ return Promise.resolve({ token: 'clv_browsertest1234567890' }); }" +
    " }; };";

  const config = {
    environment: 'sandbox', sdkUrl: BASE + '/stub-sdk.js', orderingOpen: true,
    closedDates: [], phone: '647-298-2267',
    turnstileSiteKey: '1x00000000000000000000BB', // test sitekey (always passes, invisible)
    stores: { 'one-york': { publicKey: 'pub-test', merchantId: '2N9FRNJANSV31' } },
  };

  // Stub the Turnstile API so render()/execute() yields a dummy token deterministically.
  const turnstileStub = "window.turnstile = { render: function(c, o){ window.__tsOpts = o; return 'w1'; }," +
    " execute: function(){ if (window.__tsOpts && window.__tsOpts.callback) window.__tsOpts.callback('XXXX.DUMMY.TOKEN.XXXX'); }," +
    " reset: function(){} };";

  let scenario = 'decline';
  let calls = 0;
  let lastBody = null;

  await page.clock.install({ time: new Date('2026-11-16T17:00:00Z') }); // Mon 12:00 Toronto

  await page.route('**/stub-sdk.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: cloverStub }));
  await page.route('**/turnstile/v0/api.js*', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: turnstileStub }));
  await page.route('**/api/config', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) }));
  await page.route('**/api/create-order', route => {
    calls++;
    try { lastBody = JSON.parse(route.request().postData() || '{}'); } catch (e) { lastBody = null; }
    if (scenario === 'success') return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, orderId: 'ORD-BROWSER', total: 1695 }) });
    if (scenario === 'lost') return route.abort('connectionreset');
    if (scenario === 'unconfirmed') return route.fulfill({ status: 502, contentType: 'application/json',
      body: JSON.stringify({ success: false, code: 'payment_unconfirmed', error: 'We couldn’t confirm your payment. Please don’t order again — call us at 647-298-2267 and we’ll check right away.' }) });
    if (scenario === 'nonjson') return route.fulfill({ status: 500, contentType: 'text/html',
      body: '<!doctype html><title>500</title><h1>Internal Server Error</h1>' }); // e.g. a Cloudflare error page
    return route.fulfill({ status: 402, contentType: 'application/json', // a clear decline: noCharge true
      body: JSON.stringify({ success: false, noCharge: true, error: 'Your card was declined and no charge was made. Please try another card.' }) });
  });

  // Seed cart + pickup + step before order.js runs, so the page opens on payment.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('tdp-order-cart-v1', JSON.stringify({ savedAt: Date.now(), lines: [{ item: 'tacos/pollo', qty: 1, mods: [], note: '' }] }));
      const pickup = { name: 'Browser Test', phone: '647-555-0123', location: 'one-york', asap: true, time: null, timeText: 'ASAP', sendToKitchenAt: 'now' };
      sessionStorage.setItem('tdp-order-session-v1', JSON.stringify({ step: 'payment', form: { name: 'Browser Test', phone: '647-555-0123', location: 'one-york', time: 'asap' }, pickup: pickup, confirmed: null }));
      history.replaceState({ step: 'payment' }, '');
    } catch (e) { /* ignore */ }
  });

  const results = [];
  const assert = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });

  async function reach() {
    await page.goto(BASE + '/order.html', { waitUntil: 'load' });
    await page.waitForFunction(
      () => document.body.dataset.step === 'payment' &&
            document.querySelector('[data-pay]') && document.querySelector('[data-pay]').disabled === false,
      { timeout: 8000 });
  }
  const snap = () => page.evaluate(() => {
    const notice = document.querySelector('[data-pay-notice]');
    return {
      step: document.body.dataset.step,
      payDisabled: document.querySelector('[data-pay]').disabled,
      noticeHidden: notice.hidden,
      noticeText: (notice.textContent || '').trim(),
      noticeHasTel: !!notice.querySelector('a[href^="tel:"]'),
      status: (document.querySelector('[data-pay-status]').textContent || '').trim(),
      cartLines: document.querySelectorAll('[data-cart-lines] li').length,
    };
  });

  // --- decline (noCharge:true): status line, Pay re-enabled, no notice ---
  scenario = 'decline'; calls = 0;
  await reach();
  await page.click('[data-pay]');
  await page.waitForTimeout(700);
  let s = await snap();
  assert('decline: create-order called once', calls === 1, 'calls=' + calls);
  assert('decline: message in status line', /declined/i.test(s.status), s.status);
  assert('decline: Pay stays usable', s.payDisabled === false);
  assert('decline: no notice box', s.noticeHidden === true);
  assert('decline: cart kept on screen', s.cartLines >= 1, 'lines=' + s.cartLines);

  // --- non-JSON 500 (e.g. a Cloudflare error page): fail closed -> LOCKED ---
  scenario = 'nonjson'; calls = 0;
  await reach();
  await page.click('[data-pay]');
  await page.waitForTimeout(700);
  s = await snap();
  assert('non-JSON reply: Pay LOCKED (fail closed)', s.payDisabled === true);
  assert('non-JSON reply: call-us notice shown', s.noticeHidden === false && s.noticeHasTel === true);
  assert('non-JSON reply: not worded as a decline', !/declined/i.test(s.noticeText));
  assert('non-JSON reply: cart kept on screen', s.cartLines >= 1, 'lines=' + s.cartLines);

  // --- unconfirmed: Pay LOCKED, notice with tap-to-call, cart kept ---
  scenario = 'unconfirmed'; calls = 0;
  await reach();
  await page.click('[data-pay]');
  await page.waitForTimeout(700);
  s = await snap();
  assert('unconfirmed: Pay LOCKED', s.payDisabled === true);
  assert('unconfirmed: notice shown', s.noticeHidden === false);
  assert('unconfirmed: notice says couldn’t confirm', /couldn.t confirm/i.test(s.noticeText), s.noticeText);
  assert('unconfirmed: notice NOT worded as a decline', !/declined/i.test(s.noticeText));
  assert('unconfirmed: tap-to-call link present', s.noticeHasTel === true);
  assert('unconfirmed: status line cleared', s.status === '', s.status);
  assert('unconfirmed: cart kept on screen', s.cartLines >= 1, 'lines=' + s.cartLines);
  // second attempt must not reach the Worker
  await page.evaluate(() => document.querySelector('[data-pay-form]').requestSubmit && document.querySelector('[data-pay-form]').requestSubmit());
  await page.waitForTimeout(300);
  assert('unconfirmed: re-submit does NOT call the Worker again', calls === 1, 'calls=' + calls);

  // --- lost connection: Pay LOCKED, notice with tap-to-call ---
  scenario = 'lost'; calls = 0;
  await reach();
  await page.click('[data-pay]');
  await page.waitForTimeout(700);
  s = await snap();
  assert('lost: Pay LOCKED', s.payDisabled === true);
  assert('lost: notice shown', s.noticeHidden === false);
  assert('lost: notice says lost the connection', /lost the connection/i.test(s.noticeText), s.noticeText);
  assert('lost: tap-to-call link present', s.noticeHasTel === true);
  assert('lost: cart kept on screen', s.cartLines >= 1, 'lines=' + s.cartLines);
  await page.evaluate(() => document.querySelector('[data-pay-form]').requestSubmit && document.querySelector('[data-pay-form]').requestSubmit());
  await page.waitForTimeout(300);
  assert('lost: re-submit does NOT call the Worker again', calls === 1, 'calls=' + calls);

  // --- success: Turnstile token is sent and a full order confirms ---
  scenario = 'success'; calls = 0; lastBody = null;
  await reach();
  await page.click('[data-pay]');
  await page.waitForTimeout(700);
  assert('success: Turnstile token sent with the order', !!lastBody && lastBody.turnstile === 'XXXX.DUMMY.TOKEN.XXXX', lastBody && lastBody.turnstile);
  const confirmed = await page.evaluate(() => document.body.dataset.step);
  assert('success: order confirmed (reached confirmation step)', confirmed === 'confirmed', 'step=' + confirmed);

  // --- cart shows the closed message under the greyed Checkout when closed ---
  await page.clock.setFixedTime(new Date('2026-11-16T07:00:00Z')); // 2am Toronto: closed
  await page.goto(BASE + '/order.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.step === 'menu', { timeout: 8000 }).catch(() => {});
  const closed = await page.evaluate(() => {
    const el = document.querySelector('[data-cart-closed]');
    return { hidden: el.hidden, text: (el.textContent || '').trim(), checkoutDisabled: document.querySelector('[data-checkout]').disabled };
  });
  assert('closed: cart shows the closed message under greyed Checkout',
    closed.hidden === false && /closed right now|opens for online orders|ordering closes/i.test(closed.text) && closed.checkoutDisabled === true,
    JSON.stringify(closed));

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);
  return JSON.stringify({ passed, failed: failed.length, failures: failed, all: results }, null, 2);
}
