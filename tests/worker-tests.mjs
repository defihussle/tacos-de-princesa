import {
  setNow, delays, logs, logText, resetLogs, restoreConsole,
  clover, emails, makeEnv, post, get, MONDAY_NOON, goodBody, happyHandlers, worker,
  setAdvanceClock, now, httpRes, resetRateLimiter, doCalls,
} from './worker-harness.mjs';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; } else { fail++; failures.push(name + (extra ? ' :: ' + extra : '')); }
}
function fresh(total) { clover.reset(); clover.handlers = happyHandlers(total); emails.length = 0; resetLogs(); delays.length = 0; resetRateLimiter(); }
const TOTAL = 2034; // pollo 1500 + guac 300 = 1800 + 13% = 2034
// Production fails closed without Turnstile, so production order tests supply
// real-looking keys and a token (the siteverify mock passes by default).
const PROD_TS = { TURNSTILE_SITE_KEY: '0xRealSiteKey', TURNSTILE_SECRET: '0xRealSecretKey' };
function prodEnv(over) { return makeEnv(Object.assign({ CLOVER_ENV: 'production', CLOVER_MERCHANT_ID: '7Z068VHSYD2K1', CLOVER_ORDER_TYPE_ID: 'OT1' }, PROD_TS, over || {})); }
function prodBody(over) { return goodBody(Object.assign({ turnstile: 'XXXX.DUMMY.TOKEN.XXXX' }, over || {})); }
setNow(MONDAY_NOON);

// ===== A. Money: happy path and payload shape ================================
{
  fresh(TOTAL);
  const r = await post(makeEnv(), goodBody());
  check('A1 happy path 200', r.status === 200 && r.data.success === true && r.data.orderId === 'ORD123' && r.data.total === TOTAL, JSON.stringify(r));
  const atomic = clover.calls.find(c => c.route === 'atomic');
  const line = atomic && atomic.body.orderCart.lineItems[0];
  check('A2 atomic line is Clover IDs only', line && line.item.id === 'R441N4ZEK42HP' && !('name' in line) && !('price' in line), JSON.stringify(line));
  check('A3 modifier id+name+amount', line && line.modifications.length === 1 && line.modifications[0].modifier.id === 'BY7VRB3GNS83A' && line.modifications[0].name === 'Add Guacamole' && line.modifications[0].amount === 300);
  check('A4 note reaches the line', line && line.note === 'no salt');
  check('A5 order note has pickup/name/phone/location', /ONLINE PICKUP: ASAP/.test(atomic.body.orderCart.note) && /Name: Audit Tester/.test(atomic.body.orderCart.note) && /Phone: 647-555-0123/.test(atomic.body.orderCart.note) && /One York/.test(atomic.body.orderCart.note));
  check('A6 no orderType in sandbox when unset', !('orderType' in atomic.body.orderCart));
  const payc = clover.calls.find(c => c.route === 'pay');
  check('A7 pay amount is server total', payc && payc.body.amount === TOTAL && payc.body.currency === 'usd' && payc.body.source === 'clv_1234567890abcdef' && payc.body.ecomind === 'ecom');
  check('A8 idempotency key present', payc && !!payc.headers['idempotency-key']);
  check('A9 happy path subrequests ' + clover.calls.length, clover.calls.length <= 6);
  check('A10 printed, no alert', emails.length === 0 && /PRINTED ORD123/.test(logText()));
  check('A11 no PII in logs (name/phone absent)', !/Audit Tester|647-555-0123/.test(logText()), logText());
}
// client-sent prices are ignored
{
  fresh(TOTAL);
  const b = goodBody(); b.cart[0].price = 1; b.cart[0].unitPrice = 1; b.total = 1; b.amount = 1;
  const r = await post(makeEnv(), b);
  const payc = clover.calls.find(c => c.route === 'pay');
  check('A12 price tampering ignored', r.status === 200 && payc.body.amount === TOTAL);
}
// qty expansion: one Clover line per dish
{
  fresh(3390); // 1500 x2 = 3000 + 390
  const b = goodBody(); b.cart = [{ item: 'tacos/pollo', qty: 2, mods: [], note: '' }];
  const r = await post(makeEnv(), b);
  const atomic = clover.calls.find(c => c.route === 'atomic');
  check('A13 qty 2 -> two line items', r.status === 200 && atomic.body.orderCart.lineItems.length === 2);
}
// Clover total mismatch > 1 cent refuses and deletes
{
  fresh(TOTAL + 2);
  const r = await post(makeEnv(), goodBody());
  check('A14 total mismatch refused', r.status === 500 && /couldn.t price/.test(r.data.error));
  check('A15 mismatch order deleted', clover.calls.some(c => c.route === 'delOrder'));
  check('A16 mismatch never pays', !clover.calls.some(c => c.route === 'pay'));
}
// 1-cent difference tolerated, charges Clover's figure
{
  fresh(TOTAL + 1);
  const r = await post(makeEnv(), goodBody());
  const payc = clover.calls.find(c => c.route === 'pay');
  check('A17 1-cent tolerance charges Clover total', r.status === 200 && payc.body.amount === TOTAL + 1 && r.data.total === TOTAL + 1);
}
// decline -> delete, 402, friendly message, sandbox detail only
{
  fresh(TOTAL);
  clover.handlers.pay = () => ({ status: 402, body: { error: { code: 'card_declined', message: 'DECLINED: do not honor' } } });
  const r = await post(makeEnv(), goodBody());
  check('A18 decline 402 + delete', r.status === 402 && /declined and no charge/.test(r.data.error) && clover.calls.some(c => c.route === 'delOrder'));
  check('A19 sandbox shows detail', typeof r.data.detail === 'string' && /do not honor/i.test(r.data.detail));
  fresh(TOTAL);
  clover.handlers.pay = () => ({ status: 402, body: { error: { code: 'card_declined', message: 'DECLINED: do not honor' } } });
  const r2 = await post(prodEnv(), prodBody());
  check('A20 production hides Clover detail', r2.status === 402 && !('detail' in r2.data), JSON.stringify(r2.data));
  const at2 = clover.calls.find(c => c.route === 'atomic');
  check('A21 production order gets orderType', at2 && at2.body.orderCart.orderType && at2.body.orderCart.orderType.id === 'OT1');
}
// token_already_used -> "details expired"
{
  fresh(TOTAL);
  clover.handlers.pay = () => ({ status: 400, body: { error: { code: 'token_already_used', message: 'token used' } } });
  const r = await post(makeEnv(), goodBody());
  check('A22 reused token message', r.status === 400 && /expired/.test(r.data.error) && clover.calls.some(c => c.route === 'delOrder'));
}
// unclear pay: network error, order turns out PAID -> success + print
{
  fresh(TOTAL);
  clover.handlers.pay = () => ({ throw: true });
  clover.handlers.getOrder = () => ({ body: { id: 'ORD123', paymentState: 'PAID' } });
  const r = await post(makeEnv(), goodBody());
  check('A23 unclear-but-paid confirms success', r.status === 200 && r.data.success === true);
  check('A24 unclear-but-paid still prints', clover.calls.some(c => c.route === 'print'));
}
// unclear pay + order read keeps failing -> customer told to call us (never to
// re-order), order left in Clover, staff emailed to check Clover
{
  fresh(TOTAL);
  clover.handlers.pay = () => ({ throw: true });
  clover.handlers.getOrder = () => ({ status: 500, body: { message: 'boom' } });
  const r = await post(makeEnv(), goodBody());
  check('A25 unknown state -> call us (no re-order), no delete', r.status === 502 &&
    /couldn.t confirm your payment/.test(r.data.error) && /don.t order again/.test(r.data.error) &&
    !clover.calls.some(c => c.route === 'delOrder'), JSON.stringify(r.data));
  check('A26 unknown state reconciled + staff emailed to check Clover', emails.length === 2 &&
    /could not confirm whether this order was paid/.test(emails[0].text) && /Clover Orders app/.test(emails[0].text) &&
    /could not safely settle/.test(logText()), (emails[0] && emails[0].text) + ' || ' + logText());
}
// REGRESSION (A1c): after an UNCLEAR pay, an order that reads OPEN is NOT "no
// charge" — a charge can still be landing. -> payment_unconfirmed, NEVER a
// synchronous delete. (Frozen clock here can't reach the 10s verdict, so the
// background leaves the order and emails staff.)
{
  fresh(TOTAL);
  clover.handlers.pay = () => ({ throw: true });   // getOrder default = OPEN throughout
  const r = await post(makeEnv(), goodBody());
  check('A27 unclear pay + order OPEN -> unconfirmed, NOT "no charge", no sync delete',
    r.status === 502 && r.data.code === 'payment_unconfirmed' && /don.t order again/.test(r.data.error) &&
    !/no charge was made/.test(r.data.error) && r.data.noCharge !== true &&
    !clover.calls.some(c => c.route === 'delOrder'),
    JSON.stringify(r.data) + ' del=' + clover.calls.some(c => c.route === 'delOrder'));
  check('A27a OPEN unconfirmed never sends the order to print_event', !clover.calls.some(c => c.route === 'print'));
}
// unclear pay + Clover already removed the order (404, delete_order_on_failure)
// -> no charge, clear answer, no delete attempt, no email
{
  fresh(TOTAL);
  clover.handlers.pay = () => ({ throw: true });
  clover.handlers.getOrder = () => httpRes(404, { message: 'not found' });
  const r = await post(makeEnv(), goodBody());
  check('A27b unclear + order 404 (auto-removed) -> no charge, no delete, no email',
    r.status === 502 && /no charge/.test(r.data.error) && !clover.calls.some(c => c.route === 'delOrder') &&
    emails.length === 0, JSON.stringify(r.data));
}
// delete failure (clear decline) -> logged AND staff emailed (stranded order)
{
  fresh(TOTAL);
  clover.handlers.pay = () => ({ status: 402, body: { error: { code: 'card_declined', message: 'DECLINED' } } });
  clover.handlers.delOrder = () => ({ status: 500, body: { message: 'cannot delete' } });
  const r = await post(makeEnv(), goodBody());
  check('A28 decline + delete failure logged, customer still sees decline', r.status === 402 &&
    /declined and no charge/.test(r.data.error) && /UNPAID ORDER NOT DELETED/.test(logText()));
  check('A29 delete failure now emails staff (stranded order)', emails.length === 2 &&
    /could NOT be deleted/.test(emails[0].text) && /Clover Orders app/.test(emails[0].text), (emails[0] && emails[0].text));
}
// atomic failure -> 502, nothing charged
{
  fresh(TOTAL);
  clover.handlers.atomic = () => ({ status: 400, body: { message: 'bad order' } });
  const r = await post(makeEnv(), goodBody());
  check('A30 atomic failure 502, no pay', r.status === 502 && !clover.calls.some(c => c.route === 'pay'));
}

// ===== B. Validation / menu rules ===========================================
async function expect400(name, mutate, msgRe) {
  fresh(TOTAL);
  const b = goodBody(); mutate(b);
  const r = await post(makeEnv(), b);
  check(name, r.status === 400 && (!msgRe || msgRe.test(r.data.error)) && clover.calls.length === 0,
    'status=' + r.status + ' msg=' + (r.data && r.data.error) + ' calls=' + clover.calls.length);
}
await expect400('B1 unknown item', b => { b.cart[0].item = 'tacos/unicorn'; }, /no longer on the menu/);
await expect400('B2 option from another group', b => { b.cart[0].mods = [{ g: 'dressing', label: 'Ranch' }]; });
await expect400('B3 duplicate option', b => { b.cart[0].mods = [{ g: 'guac', label: 'Add guacamole' }, { g: 'guac', label: 'Add guacamole' }]; });
await expect400('B4 qty 0', b => { b.cart[0].qty = 0; }, /quantities/);
await expect400('B5 qty negative', b => { b.cart[0].qty = -3; }, /quantities/);
await expect400('B6 qty fractional', b => { b.cart[0].qty = 1.5; }, /quantities/);
await expect400('B7 qty 21', b => { b.cart[0].qty = 21; }, /quantities/);
await expect400('B8 qty as string', b => { b.cart[0].qty = '2'; }, /quantities/);
await expect400('B9 empty cart', b => { b.cart = []; }, /empty/);
await expect400('B10 cart not array', b => { b.cart = { a: 1 }; }, /empty/);
await expect400('B11 31 lines', b => { b.cart = Array.from({ length: 31 }, () => ({ item: 'tacos/pollo', qty: 1, mods: [], note: '' })); }, /big order/i);
await expect400('B12 61+ expanded items', b => { b.cart = Array.from({ length: 4 }, () => ({ item: 'tacos/pollo', qty: 16, mods: [], note: '' })); }, /big order/i);
await expect400('B13 total over $1500', b => { b.cart = Array.from({ length: 30 }, () => ({ item: 'birria/mix-match', qty: 2, mods: [{ g: 'mix1', label: 'Birria' }, { g: 'mix2', label: 'Birria' }, { g: 'mix3', label: 'Birria' }, { g: 'guac', label: 'Add guacamole' }], note: '' })); }, /big order/i);
await expect400('B14 bad source prefix', b => { b.source = 'tok_1234567890abc'; }, /Card details/);
await expect400('B15 source too short', b => { b.source = 'clv_shrt'; }, /Card details/);
await expect400('B16 source too long', b => { b.source = 'clv_' + 'a'.repeat(201); }, /Card details/);
await expect400('B17 salad without dressing', b => { b.cart = [{ item: 'ensaladas/fiesta', qty: 1, mods: [{ g: 'protein', label: 'No protein' }], note: '' }]; });
await expect400('B18 salad with two dressings', b => { b.cart = [{ item: 'ensaladas/fiesta', qty: 1, mods: [{ g: 'dressing', label: 'Ranch' }, { g: 'dressing', label: 'Honey Dijon' }, { g: 'protein', label: 'No protein' }], note: '' }]; });
await expect400('B19 single taco no filling', b => { b.cart = [{ item: 'tacos/single-taco', qty: 1, mods: [], note: '' }]; });
await expect400('B20 single taco two fillings', b => { b.cart = [{ item: 'tacos/single-taco', qty: 1, mods: [{ g: 'filling', label: 'Pollo' }, { g: 'filling', label: 'Pescado' }], note: '' }]; });
await expect400('B21 mix&match missing a pick', b => { b.cart = [{ item: 'birria/mix-match', qty: 1, mods: [{ g: 'mix1', label: 'Pollo' }, { g: 'mix2', label: 'Pollo' }], note: '' }]; });
await expect400('B22 mods not an array', b => { b.cart[0].mods = { g: 'guac' }; });
await expect400('B23 31 mods', b => { b.cart[0].mods = Array.from({ length: 31 }, (_, i) => ({ g: 'guac', label: 'x' + i })); });
await expect400('B24 note not a string', b => { b.cart[0].note = { x: 1 }; });
await expect400('B25 nachos without base', b => { b.cart = [{ item: 'nachos/pollo', qty: 1, mods: [], note: '' }]; });

// positive special cases
{
  fresh(791); // single taco 700 + 13% = 791
  const b = goodBody(); b.cart = [{ item: 'tacos/single-taco', qty: 1, mods: [{ g: 'filling', label: 'Camarón' }], note: '' }];
  const r = await post(makeEnv(), b);
  const line = clover.calls.find(c => c.route === 'atomic').body.orderCart.lineItems[0];
  check('B26 single taco: $0 item + $7 modifier', r.status === 200 && line.modifications[0].amount === 700 && line.modifications[0].name === 'Shrimp', JSON.stringify(line));
}
{
  fresh(2260); // mix&match 2000 + 13%
  const b = goodBody(); b.cart = [{ item: 'birria/mix-match', qty: 1, mods: [{ g: 'mix1', label: 'Pollo' }, { g: 'mix2', label: 'Pollo' }, { g: 'mix3', label: 'Pollo' }], note: '' }];
  const r = await post(makeEnv(), b);
  const line = clover.calls.find(c => c.route === 'atomic').body.orderCart.lineItems[0];
  check('B27 mix&match repeats allowed, 3 modifiers', r.status === 200 && line.modifications.length === 3 && line.modifications.every(m => m.name === 'Pollo Tacos'));
}
{
  fresh(1356); // fiesta 1200 + 13%
  const b = goodBody(); b.cart = [{ item: 'ensaladas/fiesta', qty: 1, mods: [{ g: 'dressing', label: 'Ranch' }, { g: 'protein', label: 'No protein' }], note: '' }];
  const r = await post(makeEnv(), b);
  const line = clover.calls.find(c => c.route === 'atomic').body.orderCart.lineItems[0];
  check('B28 "No protein" sends no modifier', r.status === 200 && line.modifications.length === 1 && line.modifications[0].name === 'Ranch');
}
{
  fresh(2034); // fiesta 1200 + camaron 600 = 1800 + 13%
  const b = goodBody(); b.cart = [{ item: 'ensaladas/fiesta', qty: 1, mods: [{ g: 'dressing', label: 'Ranch' }, { g: 'protein', label: 'Camarón' }], note: '' }];
  const r = await post(makeEnv(), b);
  check('B29 salad protein priced', r.status === 200 && r.data.total === 2034);
}
// note handling
{
  fresh(TOTAL);
  const b = goodBody(); b.cart[0].note = 'A'.repeat(300) + '\u0000\u0007end';
  const r = await post(makeEnv(), b);
  const line = clover.calls.find(c => c.route === 'atomic').body.orderCart.lineItems[0];
  check('B30 note truncated to 140, control chars stripped', r.status === 200 && line.note.length <= 140 && !/[\u0000-\u001f\u007f]/.test(line.note));
}

// ===== C. Pickup, hours, cutoff =============================================
{
  fresh(TOTAL); setNow('2026-11-16T22:30:59Z'); // Mon 17:30:59 Toronto (EST)
  const r = await post(makeEnv(), goodBody());
  check('C1 17:30:59 still accepted', r.status === 200, JSON.stringify(r.data));
}
{
  fresh(TOTAL); setNow('2026-11-16T22:31:00Z'); // Mon 17:31:00
  const r = await post(makeEnv(), goodBody());
  check('C2 17:31 refused with cutoff message', r.status === 400 && /closes at 5:30 pm/.test(r.data.error), JSON.stringify(r.data));
}
{
  fresh(TOTAL); setNow('2026-11-16T15:29:00Z'); // Mon 10:29 Toronto
  const r = await post(makeEnv(), goodBody());
  check('C3 10:29 refused (before opening)', r.status === 400 && /not taking online orders/.test(r.data.error));
  fresh(TOTAL); setNow('2026-11-16T15:30:00Z'); // 10:30
  const r2 = await post(makeEnv(), goodBody());
  check('C4 10:30 accepted', r2.status === 200);
}
{
  fresh(TOTAL); setNow('2026-11-15T17:00:00Z'); // Sunday
  const r = await post(makeEnv(), goodBody());
  check('C5 Sunday refused', r.status === 400 && /not taking online orders/.test(r.data.error));
}
{
  fresh(TOTAL); setNow('2026-12-25T17:00:00Z'); // Christmas (Friday)
  const r = await post(makeEnv(), goodBody());
  check('C6 holiday refused by name', r.status === 400 && /closed today for Christmas Day/.test(r.data.error));
}
{
  fresh(TOTAL); setNow('2026-12-28T17:00:00Z'); // observed Boxing Day (Sat 26 -> Mon 28)
  const r = await post(makeEnv(), goodBody());
  check('C7 observed Boxing Day (Mon Dec 28) refused', r.status === 400 && /Boxing Day/.test(r.data.error), JSON.stringify(r.data));
}
{
  fresh(TOTAL); setNow(MONDAY_NOON);
  const env = makeEnv({ CLOSED_DATES: '2026-11-16, junk, 2026-13-99' });
  const r = await post(env, goodBody());
  check('C8 CLOSED_DATES closes today, junk ignored', r.status === 400 && /not taking online orders/.test(r.data.error));
}
{
  fresh(TOTAL); setNow(MONDAY_NOON);
  const b = goodBody(); b.pickup = Object.assign({}, b.pickup, { location: 'king-st-w' });
  const r = await post(makeEnv(), b);
  check('C9 disabled store refused', r.status === 400 && /isn.t taking online orders yet/.test(r.data.error));
}
{
  fresh(TOTAL); setNow(MONDAY_NOON);
  const b = goodBody(); b.pickup = Object.assign({}, b.pickup, { location: 'attacker' });
  const r = await post(makeEnv(), b);
  check('C10 unknown location refused', r.status === 400 && /choose a pickup location/.test(r.data.error));
}
// slots
async function slotTest(name, nowUtc, time, ok) {
  fresh(TOTAL); setNow(nowUtc);
  const b = goodBody(); b.pickup = Object.assign({}, b.pickup, { asap: false, time });
  const r = await post(makeEnv(), b);
  check(name, ok ? r.status === 200 : (r.status === 400 && /no longer available/.test(r.data.error)), 'status=' + r.status + ' ' + JSON.stringify(r.data));
}
await slotTest('C11 12:15 slot at 12:00 ok', '2026-11-16T17:00:00Z', '2026-11-16T12:15', true);
await slotTest('C12 12:30 slot at 12:19 ok (grace)', '2026-11-16T17:19:00Z', '2026-11-16T12:30', true);
await slotTest('C13 12:30 slot at 12:21 gone', '2026-11-16T17:21:00Z', '2026-11-16T12:30', false);
await slotTest('C14 last slot 17:45 ok', '2026-11-16T21:30:00Z', '2026-11-16T17:45', true);
await slotTest('C15 18:00 never a slot', '2026-11-16T21:30:00Z', '2026-11-16T18:00', false);
await slotTest('C16 tomorrow refused', '2026-11-16T17:00:00Z', '2026-11-17T12:15', false);
await slotTest('C17 non-slot minute refused', '2026-11-16T17:00:00Z', '2026-11-16T12:20', false);
{
  fresh(TOTAL); setNow(MONDAY_NOON);
  const b = goodBody(); b.pickup = Object.assign({}, b.pickup, { asap: false, time: 'garbage' });
  const r = await post(makeEnv(), b);
  check('C18 garbage time refused', r.status === 400 && /choose a pickup time/.test(r.data.error));
}
// phone + name
async function pickupTest(name, patch, status, re) {
  fresh(TOTAL); setNow(MONDAY_NOON);
  const b = goodBody(); b.pickup = Object.assign({}, b.pickup, patch);
  const r = await post(makeEnv(), b);
  check(name, r.status === status && (!re || re.test(r.data.error || '')), 'status=' + r.status + ' ' + (r.data && r.data.error));
}
await pickupTest('C19 phone +1 format ok', { phone: '+1 (647) 555-0123' }, 200);
await pickupTest('C20 7-digit phone refused', { phone: '555-0123' }, 400, /10-digit/);
await pickupTest('C21 area code 0 refused', { phone: '047-555-0123' }, 400, /10-digit/);
await pickupTest('C22 11 digits not starting 1 refused', { phone: '2647-555-0123' }, 400, /10-digit/);
await pickupTest('C23 empty name refused', { name: '  ' }, 400, /add a name/);
await pickupTest('C24 control-char name refused', { name: '\u0001\u0002' }, 400, /add a name/);
{
  fresh(TOTAL); setNow(MONDAY_NOON);
  const b = goodBody(); b.pickup = Object.assign({}, b.pickup, { name: 'Bob\r\nBcc: evil@example.com  X'.repeat(5) });
  clover.handlers.print = () => ({ status: 500, body: { message: 'printer down' } });
  const r = await post(makeEnv(), b);
  check('C25 CRLF name order still placed', r.status === 200);
  check('C26 alert email body is CRLF-clean, no header injection', emails.length === 2 && emails.every(m => !/\r/.test(m.text) && !/^Bcc:/m.test(m.text)), JSON.stringify(emails[0] && emails[0].text));
  const nameLine = emails[0] && (emails[0].text.match(/^Customer: (.*)$/m) || [])[1];
  check('C27 name truncated to 60 in alert', !!nameLine && nameLine.length <= 60 + 15, nameLine);
}

// ===== D. Request plumbing ===================================================
{
  fresh(TOTAL); setNow(MONDAY_NOON);
  const r = await post(makeEnv(), goodBody(), { headers: { origin: 'https://evil.example' } });
  check('D1 cross-origin refused 403', r.status === 403 && clover.calls.length === 0);
  fresh(TOTAL);
  const r2 = await post(makeEnv(), goodBody(), { headers: { origin: 'https://preview.example' } });
  check('D2 same-origin ok', r2.status === 200);
  fresh(TOTAL);
  const r3 = await post(makeEnv(), goodBody(), { omitOrigin: true }); // no Origin header
  check('D3 missing Origin now REFUSED (403)', r3.status === 403 && clover.calls.length === 0, 'status=' + r3.status);
}
{
  fresh(TOTAL);
  const r = await post(makeEnv(), null, { raw: 'not json' });
  check('D4 invalid JSON 400', r.status === 400 && /refresh and try again/.test(r.data.error));
  fresh(TOTAL);
  const r2 = await post(makeEnv(), goodBody(), { headers: { 'content-type': 'text/plain' } });
  check('D5 wrong content-type 415', r2.status === 415);
  fresh(TOTAL);
  const r3 = await post(makeEnv(), goodBody(), { headers: { 'content-type': 'application/jsonx' } });
  check('D6 application/jsonx refused', r3.status === 415);
  fresh(TOTAL);
  const r4 = await post(makeEnv(), null, { raw: JSON.stringify(goodBody()) + ' '.repeat(20001) });
  check('D7 oversized body refused as big order', r4.status === 400 && /big order/i.test(r4.data.error));
  fresh(TOTAL);
  const r5 = await post(makeEnv(), null, { method: 'GET', raw: undefined });
  check('D8 GET create-order 405', r5.status === 405);
  const r6 = await get(makeEnv(), '/api/nothing-here');
  check('D9 unknown /api 404', r6.status === 404);
}
{
  fresh(TOTAL);
  const env = makeEnv({ ORDERING_OPEN: 'false' });
  const r = await post(env, goodBody());
  check('D10 ORDERING_OPEN false -> 503 paused', r.status === 503 && /paused/.test(r.data.error) && clover.calls.length === 0);
  for (const v of ['False', '', ' true', 'TRUE', undefined]) {
    fresh(TOTAL);
    const e2 = makeEnv({ ORDERING_OPEN: v }); if (v === undefined) delete e2.ORDERING_OPEN;
    const r2 = await post(e2, goodBody());
    check('D11 ORDERING_OPEN ' + JSON.stringify(v) + ' pauses', r2.status === 503);
  }
}
{
  fresh(TOTAL);
  const env = makeEnv({ CLOVER_ENV: 'Production', CLOVER_MERCHANT_ID: '7Z068VHSYD2K1' });
  const r = await post(env, goodBody());
  check('D12 CLOVER_ENV typo fails closed, no Clover call', r.status === 503 && /isn.t set up yet/.test(r.data.error) && clover.calls.length === 0);
}
{
  fresh(TOTAL);
  const env = makeEnv({ CLOVER_ENV: 'production', CLOVER_MERCHANT_ID: '7Z068VHSYD2K1' }); // no order type
  const r = await post(env, goodBody());
  check('D13 production without order type fails closed', r.status === 503 && clover.calls.length === 0);
}
{
  fresh(TOTAL);
  const env = makeEnv(); delete env.CLOVER_PRIVATE_TOKEN;
  const r = await post(env, goodBody());
  check('D14 missing token fails closed', r.status === 503 && clover.calls.length === 0);
}
{
  fresh(TOTAL);
  const env = makeEnv({ STORES_ENABLED: ' one-york , king-st-w , bogus ' });
  const r = await post(env, goodBody());
  check('D15 STORES_ENABLED whitespace tolerated', r.status === 200);
}

// ===== E. Print + alert path ================================================
{
  fresh(TOTAL); setNow(MONDAY_NOON);
  clover.handlers.print = () => ({ status: 500, body: { message: 'Printer unavailable' } });
  const r = await post(makeEnv(), goodBody());
  check('E1 print refused twice -> customer still 200', r.status === 200);
  check('E2 one alert to each recipient', emails.length === 2 && emails[0].to === 'owner@example.ca' && emails[1].to === 'second@example.ca');
  check('E3 retry delay ~5s recorded', delays.includes(5000));
  check('E4 alert has order/pickup/customer/items, no card data', emails.every(m =>
    /Order: ORD123/.test(m.text) && /Pickup: ASAP/.test(m.text) && /Audit Tester/.test(m.text) &&
    /1 x Pollo Tacos \(Add guacamole\)/.test(m.text) && /Clover Orders app/.test(m.text) &&
    !/clv_|card|cvv/i.test(m.text)), emails[0] && emails[0].text);
  check('E5 subject names the order', emails[0] && emails[0].subject === 'Online order ORD123 did not print');
}
{
  fresh(TOTAL);
  let printCalls = 0;
  clover.handlers.print = () => (++printCalls === 1 ? { status: 500, body: { message: 'x' } } : { body: { id: 'JOB2' } });
  const r = await post(makeEnv(), goodBody());
  check('E6 retry succeeds, no alert', r.status === 200 && emails.length === 0 && /PRINT SENT/.test(logText()));
}
{
  fresh(TOTAL);
  clover.handlers.printState = () => ({ body: { state: 'FAILED' } });
  await post(makeEnv(), goodBody());
  check('E7 FAILED state alerts', emails.length === 2 && /reported the job as FAILED/.test(emails[0].text));
}
{
  fresh(TOTAL);
  clover.handlers.printState = () => ({ body: { state: 'CREATED' } });
  await post(makeEnv(), goodBody());
  check('E8 stuck CREATED alerts after both checks', emails.length === 2 && /hadn.t printed/.test(emails[0].text));
}
{
  fresh(TOTAL); // regression a39bd92: 401 with 'missing' text must alert
  clover.handlers.printState = () => ({ status: 401, body: { message: 'missing credentials' } });
  await post(makeEnv(), goodBody());
  check('E9 401-with-missing stays UNKNOWN and alerts', emails.length === 2 && /UNKNOWN \(HTTP 401\)/.test(emails[0].text + logText()));
}
{
  fresh(TOTAL);
  clover.handlers.print = () => ({ status: 500, body: {} });
  const env = makeEnv({ ALERT_EMAIL: { send: async () => { const e = new Error('not verified'); e.code = 'E_RECIPIENT_NOT_VERIFIED'; throw e; } } });
  const r = await post(env, goodBody());
  check('E10 email failure logged per recipient, no crash', r.status === 200 && /ALERT FAILED to owner@example.ca/.test(logText()) && /ALERT FAILED to second@example.ca/.test(logText()));
}
{
  fresh(TOTAL);
  clover.handlers.print = () => ({ status: 500, body: {} });
  const env = makeEnv(); delete env.ALERT_EMAIL;
  const r = await post(env, goodBody());
  check('E11 missing binding -> ALERT NOT SENT log', r.status === 200 && /ALERT NOT SENT/.test(logText()));
}
{
  fresh(TOTAL); // declined order must never print
  clover.handlers.pay = () => ({ status: 402, body: { error: { code: 'card_declined' } } });
  await post(makeEnv(), goodBody());
  check('E12 declined order never prints', !clover.calls.some(c => c.route === 'print'));
}

// ===== F. config + health ====================================================
{
  fresh(TOTAL);
  const r = await get(makeEnv(), '/api/config');
  check('F1 config shape, no secrets', r.status === 200 && r.data.environment === 'sandbox' &&
    r.data.sdkUrl === 'https://checkout.sandbox.dev.clover.com/sdk.js' &&
    r.data.stores['one-york'].publicKey === 'pub-test' && !JSON.stringify(r.data).includes('secret-test-token'));
  check('F2 config lists only enabled stores', !('king-st-w' in r.data.stores));
}
{
  // /api/health caches the Clover checks ~5 min, so space the clock between
  // checks that must recompute.
  fresh(TOTAL); setNow('2026-11-16T10:00:00Z');
  const r = await get(makeEnv(), '/api/health');
  check('F3 health ready in sandbox without order type', r.status === 200 && r.data.ready === true && r.data.stores['one-york'].clover.orderType === 'not set', JSON.stringify(r.data));
  check('F4 health leaks no secret values', !JSON.stringify(r.data).includes('secret-test-token') && !JSON.stringify(r.data).includes('TAXID'));
  check('F5 health reports turnstile + rateLimiter flags', r.data.turnstile === false && r.data.rateLimiter === true, JSON.stringify({ t: r.data.turnstile, rl: r.data.rateLimiter }));
  fresh(TOTAL); setNow('2026-11-16T10:10:00Z');
  const r2 = await get(makeEnv({ CLOVER_ORDER_TYPE_ID: 'OT9' }), '/api/health');
  check('F6 health with order type -> orderType ok', r2.data.stores['one-york'].clover.orderType === 'ok');
  fresh(TOTAL); setNow('2026-11-16T10:20:00Z');
  clover.handlers.taxRate = () => ({ status: 401, body: { message: 'Unauthorized' } });
  const r3 = await get(makeEnv(), '/api/health');
  check('F7 bad token -> taxRate fail, not ready', r3.data.ready === false && r3.data.stores['one-york'].clover.taxRate === 'fail');
}
// F8: health caches the Clover checks (one call for many requests)
{
  fresh(TOTAL); setNow('2026-11-16T11:00:00Z');
  await get(makeEnv(), '/api/health');
  const after1 = clover.calls.length;
  await get(makeEnv(), '/api/health');  // within 5 min -> cached
  await get(makeEnv(), '/api/health');
  check('F8 health Clover checks cached (1 call for many requests)', after1 === 1 && clover.calls.length === 1, 'after1=' + after1 + ' total=' + clover.calls.length);
}
// F9/F10: production hides detail unless the HEALTH_TOKEN header matches
{
  const prod = { CLOVER_ENV: 'production', CLOVER_MERCHANT_ID: '7Z068VHSYD2K1', CLOVER_ORDER_TYPE_ID: 'OT1',
    HEALTH_TOKEN: 's3cret', TURNSTILE_SITE_KEY: '0xRealSiteKey', TURNSTILE_SECRET: '0xRealSecretKey' };
  fresh(TOTAL); setNow('2026-11-16T11:10:00Z');
  const pub = await get(makeEnv(prod), '/api/health');
  check('F9 production public health = ready + commit only', Object.keys(pub.data).sort().join(',') === 'commit,ready', Object.keys(pub.data).join(','));
  fresh(TOTAL); setNow('2026-11-16T11:20:00Z');
  const detail = await get(makeEnv(prod), '/api/health', { 'x-health-token': 's3cret' });
  check('F10 production detailed health needs the token', !!detail.data.stores && typeof detail.data.turnstile === 'boolean' && detail.data.turnstile === true, JSON.stringify(Object.keys(detail.data)));
}

// ===== G. Retry, pay idempotency, reconcile, 30s budget =====================
setNow(MONDAY_NOON);
// --- rate-limit retry on create -----
{
  fresh(TOTAL);
  let n = 0;
  clover.handlers.atomic = () => (++n === 1 ? httpRes(429, { message: 'rate' }) : { body: { id: 'ORD123', total: TOTAL } });
  const r = await post(makeEnv(), goodBody());
  check('G1 429 on create -> retried then placed (backoff 250)', r.status === 200 && n === 2 && delays.includes(250), 'n=' + n);
}
{
  fresh(TOTAL);
  let n = 0;
  clover.handlers.atomic = () => (++n === 1 ? httpRes(429, { message: 'rate' }, { 'retry-after': '1' }) : { body: { id: 'ORD123', total: TOTAL } });
  const r = await post(makeEnv(), goodBody());
  check('G2 Retry-After honoured (1s) on create', r.status === 200 && delays.includes(1000));
}
{
  fresh(TOTAL);
  let n = 0;
  clover.handlers.atomic = () => (++n === 1 ? httpRes(429, { message: 'rate' }, { 'retry-after': '9' }) : { body: { id: 'ORD123', total: TOTAL } });
  const r = await post(makeEnv(), goodBody());
  check('G3 Retry-After capped at 2s', r.status === 200 && delays.includes(2000) && !delays.includes(9000));
}
{
  fresh(TOTAL);
  let n = 0;
  clover.handlers.atomic = () => { n++; return httpRes(429, { message: 'rate' }); };
  const r = await post(makeEnv(), goodBody());
  check('G4 persistent 429 on create -> 502, 3 tries, never pays', r.status === 502 && n === 3 && !clover.calls.some(c => c.route === 'pay'), 'n=' + n);
}
{
  fresh(TOTAL);
  let n = 0;
  clover.handlers.atomic = () => { n++; return httpRes(503, { message: 'unavailable' }); };
  const r = await post(makeEnv(), goodBody());
  check('G5 503 without Retry-After is NOT retried', r.status === 502 && n === 1, 'n=' + n);
  fresh(TOTAL);
  let m = 0;
  clover.handlers.atomic = () => (++m === 1 ? httpRes(503, { message: 'unavailable' }, { 'retry-after': '1' }) : { body: { id: 'ORD123', total: TOTAL } });
  const r2 = await post(makeEnv(), goodBody());
  check('G6 503 WITH Retry-After is retried then placed', r2.status === 200 && m === 2 && delays.includes(1000), 'm=' + m);
}
// --- pay retry / idempotency -----
{
  fresh(TOTAL);
  let n = 0;
  clover.handlers.pay = () => (++n === 1 ? httpRes(429, { message: 'slow' }) : { body: { id: 'PAY1', status: 'succeeded' } });
  const r = await post(makeEnv(), goodBody());
  const pays = clover.calls.filter(c => c.route === 'pay');
  check('G7 pay 429 -> retried once, order placed', r.status === 200 && pays.length === 2);
  check('G8 pay retry reuses the SAME idempotency key', pays.length === 2 && !!pays[0].headers['idempotency-key'] &&
    pays[0].headers['idempotency-key'] === pays[1].headers['idempotency-key'], pays.map(p => p.headers['idempotency-key']).join(' vs '));
}
{
  fresh(TOTAL);
  let n = 0;
  clover.handlers.pay = () => (++n === 1 ? { throw: true } : { body: { id: 'PAY1', status: 'succeeded' } });
  const r = await post(makeEnv(), goodBody());
  check('G9 pay timeout then success on replay -> placed', r.status === 200 && clover.calls.filter(c => c.route === 'pay').length === 2);
}
{
  fresh(TOTAL);
  let n = 0;
  clover.handlers.pay = () => { n++; return httpRes(402, { error: { code: 'card_declined', message: 'DECLINED' } }); };
  const r = await post(makeEnv(), goodBody());
  check('G10 a clear decline is NEVER retried', r.status === 402 && n === 1, 'n=' + n);
}
{
  fresh(TOTAL);
  let n = 0;
  clover.handlers.pay = () => (++n === 1 ? httpRes(500, { message: 'boom' }) : httpRes(402, { error: { code: 'card_declined', message: 'DECLINED' } }));
  const r = await post(makeEnv(), goodBody());
  check('G11 unclear then clear decline -> 402, deleted, no 3rd pay', r.status === 402 && /declined/.test(r.data.error) &&
    clover.calls.filter(c => c.route === 'pay').length === 2 && clover.calls.some(c => c.route === 'delOrder'));
}
{ // the dangerous case: retried token_already_used masks a REAL charge
  fresh(TOTAL);
  let n = 0;
  clover.handlers.pay = () => (++n === 1 ? httpRes(500, { message: 'boom' }) : httpRes(400, { error: { code: 'token_already_used', message: 'token used' } }));
  clover.handlers.getOrder = () => ({ body: { id: 'ORD123', paymentState: 'PAID' } });
  const r = await post(makeEnv(), goodBody());
  check('G12 retried token_already_used but order PAID -> success, NOT deleted', r.status === 200 && r.data.success === true &&
    !clover.calls.some(c => c.route === 'delOrder') && clover.calls.some(c => c.route === 'print'), JSON.stringify(r.data));
}
{
  fresh(TOTAL);
  const r = await post(makeEnv(), goodBody());
  const payc = clover.calls.find(c => c.route === 'pay');
  check('G13 idempotency key is a v4 UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payc.headers['idempotency-key']), payc.headers['idempotency-key']);
}
// --- background reconcile (reached only when the sync read ERRORS) + 30s budget --
{
  fresh(TOTAL);
  setAdvanceClock(true); setNow(MONDAY_NOON);
  clover.handlers.pay = () => ({ throw: true });
  let g = 0; // sync read (1) errors -> reconcile; reconcile reads OPEN, OPEN, then PAID
  clover.handlers.getOrder = () => {
    g++;
    if (g === 1) return httpRes(500, { message: 'read boom' });
    if (g <= 3) return { body: { id: 'ORD123', paymentState: 'OPEN' } };
    return { body: { id: 'ORD123', paymentState: 'PAID' } };
  };
  clover.handlers.printState = () => ({ body: { state: 'CREATED' } }); // never DONE -> both checks run
  const t0 = now();
  const r = await post(makeEnv(), goodBody());
  check('G14 unreadable pay outcome -> customer told to call us (code flag)', r.status === 502 &&
    /don.t order again/.test(r.data.error) && r.data.code === 'payment_unconfirmed', JSON.stringify(r.data));
  check('G15 late-PAID reconcile prints the ticket + alerts staff to call the customer',
    clover.calls.some(c => c.route === 'print') && emails.some(m => /was paid after the customer was told/i.test(m.subject)),
    emails.map(m => m.subject).join(' | '));
  check('G16 ALL background work (reconcile + print checks) ends before 30s', now() - t0 < 30000, 'elapsed=' + (now() - t0) + 'ms');
  setAdvanceClock(false); setNow(MONDAY_NOON);
}
{ // unreadable then never-paid -> reconcile deletes + emails "removed", within budget
  fresh(TOTAL);
  setAdvanceClock(true); setNow(MONDAY_NOON);
  clover.handlers.pay = () => ({ throw: true });
  let g = 0; // sync read errors, reconcile reads stay OPEN
  clover.handlers.getOrder = () => (++g === 1 ? httpRes(500, { message: 'boom' }) : { body: { id: 'ORD123', paymentState: 'OPEN' } });
  const t0 = now();
  const r = await post(makeEnv(), goodBody());
  check('G17 never-paid reconcile deletes + emails "removed", within 30s',
    r.status === 502 && clover.calls.some(c => c.route === 'delOrder') &&
    emails.some(m => /was removed/i.test(m.subject)) && (now() - t0) < 30000, 'elapsed=' + (now() - t0));
  setAdvanceClock(false); setNow(MONDAY_NOON);
}
{ // sync read errors, reconcile reads a 404 -> Clover already removed it (no charge)
  fresh(TOTAL);
  setAdvanceClock(true); setNow(MONDAY_NOON);
  clover.handlers.pay = () => ({ throw: true });
  let g = 0;
  clover.handlers.getOrder = () => (++g === 1 ? httpRes(500, { message: 'boom' }) : httpRes(404, { message: 'gone' }));
  const t0 = now();
  const r = await post(makeEnv(), goodBody());
  check('G18 reconcile 404 -> emails "removed by Clover (no charge)", no delete',
    emails.some(m => /removed by Clover/i.test(m.subject)) && !clover.calls.some(c => c.route === 'delOrder') &&
    (now() - t0) < 30000, emails.map(m => m.subject).join(' | '));
  setAdvanceClock(false); setNow(MONDAY_NOON);
}
// --- item 2: whole flow is ONE waitUntil task (survives a client disconnect) --
{
  fresh(TOTAL);
  const r = await post(makeEnv(), goodBody());
  check('G19 happy order: entire create/pay/print flow is one waitUntil task', r.jobs === 1 && /PRINTED ORD123/.test(logText()), 'jobs=' + r.jobs);
}
{
  fresh(TOTAL);
  clover.handlers.pay = () => ({ status: 402, body: { error: { code: 'card_declined' } } });
  const r = await post(makeEnv(), goodBody());
  check('G20 decline: still one waitUntil task, order deleted in it', r.jobs === 1 && clover.calls.some(c => c.route === 'delOrder'), 'jobs=' + r.jobs);
}
{ // normal paid print where EVERY print-state read times out: alert still fits < 30s
  fresh(TOTAL);
  setAdvanceClock(true); setNow(MONDAY_NOON);
  clover.handlers.printState = () => ({ throw: true }); // every state read times out -> UNKNOWN
  const t0 = now();
  const r = await post(makeEnv(), goodBody());
  check('G21 normal paid print with timing-out state reads: alerts, ends < 30s',
    r.status === 200 && emails.length === 2 && /hadn.t printed/.test(emails[0].text) && (now() - t0) < 30000,
    'elapsed=' + (now() - t0));
  setAdvanceClock(false); setNow(MONDAY_NOON);
}

// ===== H. A1c: unclear-OPEN is not "no charge"; noCharge flag; catch-all =====
setNow(MONDAY_NOON);
{ // timeout -> OPEN -> unconfirmed; reconcile deletes ONLY after a >=10s-post-pay read
  fresh(TOTAL);
  setAdvanceClock(true); setNow(MONDAY_NOON);
  clover.handlers.pay = () => ({ throw: true }); // getOrder default = OPEN throughout
  const t0 = now();
  const r = await post(makeEnv(), goodBody());
  check('H1 timeout + OPEN -> payment_unconfirmed', r.status === 502 && r.data.code === 'payment_unconfirmed');
  check('H1b reconcile deletes only after a >=10s-post-pay read + emails "removed"',
    clover.calls.some(c => c.route === 'delOrder') && emails.some(m => /was removed/i.test(m.subject)) &&
    /still unpaid 1[0-9] s after pay/.test(logText()), logText().split('\n').filter(l => /RECONCILE/.test(l)).join(' | '));
  check('H1c an unpaid order is never sent to print_event', !clover.calls.some(c => c.route === 'print'));
  check('H1d background < 30s', now() - t0 < 30000, 'elapsed=' + (now() - t0));
  setAdvanceClock(false); setNow(MONDAY_NOON);
}
{ // timeout -> OPEN -> the charge lands late -> reconcile sees PAID -> print + alert
  fresh(TOTAL);
  setAdvanceClock(true); setNow(MONDAY_NOON);
  clover.handlers.pay = () => ({ throw: true });
  let g = 0; // sync read + early reconcile reads OPEN; PAID at the verdict read
  clover.handlers.getOrder = () => (++g <= 3 ? { body: { id: 'ORD123', paymentState: 'OPEN' } } : { body: { id: 'ORD123', paymentState: 'PAID' } });
  clover.handlers.printState = () => ({ body: { state: 'CREATED' } });
  const t0 = now();
  const r = await post(makeEnv(), goodBody());
  check('H2 late-landing charge -> PAID reconcile prints + alerts, no delete', r.status === 502 &&
    clover.calls.some(c => c.route === 'print') && !clover.calls.some(c => c.route === 'delOrder') &&
    emails.some(m => /was paid after the customer was told/i.test(m.subject)));
  check('H2b background < 30s', now() - t0 < 30000, 'elapsed=' + (now() - t0));
  setAdvanceClock(false); setNow(MONDAY_NOON);
}
{ // retried token_already_used + OPEN -> unconfirmed (a landing charge consumed the token)
  fresh(TOTAL);
  let n = 0;
  clover.handlers.pay = () => (++n === 1 ? httpRes(500, { message: 'boom' }) : httpRes(400, { error: { code: 'token_already_used', message: 'used' } }));
  const r = await post(makeEnv(), goodBody());
  check('H3 retried token_already_used + OPEN -> unconfirmed, no sync delete',
    r.status === 502 && r.data.code === 'payment_unconfirmed' && r.data.noCharge !== true &&
    !clover.calls.some(c => c.route === 'delOrder'), JSON.stringify(r.data));
}
{ // retried, then a CLEAR decline + OPEN -> no charge (the card was refused)
  fresh(TOTAL);
  let n = 0;
  clover.handlers.pay = () => (++n === 1 ? httpRes(500, { message: 'boom' }) : httpRes(402, { error: { code: 'card_declined', message: 'DECLINED' } }));
  const r = await post(makeEnv(), goodBody());
  check('H4 retried then clear decline + OPEN -> 402 noCharge, deleted (read before delete)',
    r.status === 402 && r.data.noCharge === true && /declined/.test(r.data.error) && clover.calls.some(c => c.route === 'delOrder'));
}
{ // item 2: an unexpected error AFTER the pay request was sent -> unconfirmed + email
  fresh(TOTAL);
  clover.handlers.pay = () => ({ throw: true }); // unclear -> retry -> backoff sleep()
  const realST = globalThis.setTimeout;
  let boom = false;
  globalThis.setTimeout = function (cb, ms, ...rest) { if (!boom) { boom = true; throw new Error('kaboom after pay'); } return realST(cb, ms, ...rest); };
  let r;
  try { r = await post(makeEnv(), goodBody()); } finally { globalThis.setTimeout = realST; }
  check('H5 error after pay was sent -> unconfirmed + staff emailed (not "no charge")',
    r.status === 502 && r.data.code === 'payment_unconfirmed' && r.data.noCharge !== true &&
    emails.some(m => /after payment was sent/i.test(m.subject)), JSON.stringify(r.data) + ' | ' + emails.map(m => m.subject).join('|'));
}
{ // the noCharge flag is set where no charge is certain
  fresh(TOTAL);
  clover.handlers.pay = () => httpRes(402, { error: { code: 'card_declined', message: 'DECLINED' } });
  const r = await post(makeEnv(), goodBody());
  check('H6 plain decline carries noCharge:true', r.status === 402 && r.data.noCharge === true && /declined/.test(r.data.error));
  fresh(TOTAL);
  const r2 = await post(makeEnv(), goodBody(), { headers: { 'content-type': 'text/plain' } });
  check('H7 pre-Clover validation error carries noCharge:true', r2.status === 415 && r2.data.noCharge === true);
  fresh(TOTAL);
  clover.handlers.atomic = () => ({ status: 400, body: { message: 'bad order' } });
  const r3 = await post(makeEnv(), goodBody());
  check('H8 create-failed carries noCharge:true, never pays', r3.status === 502 && r3.data.noCharge === true && !clover.calls.some(c => c.route === 'pay'));
}

// ===== J. Turnstile (bot check before any Clover call) ======================
setNow(MONDAY_NOON);
const noOrderCall = () => !clover.calls.some(c => ['atomic', 'pay', 'getOrder', 'delOrder'].includes(c.route));
{ // valid token in production -> passes, order proceeds
  fresh(TOTAL);
  const r = await post(prodEnv(), prodBody());
  check('J0 valid Turnstile passes (order placed)', r.status === 200 && r.data.success === true, JSON.stringify(r.data));
  const sv = clover.calls.find(c => c.route === 'turnstile');
  check('J0b siteverify sent the token + remoteip', !!sv && /response=XXXX\.DUMMY\.TOKEN\.XXXX/.test(sv.body) && /remoteip=203\.0\.113\.1/.test(sv.body), sv && sv.body);
}
{ // missing token
  fresh(TOTAL);
  const r = await post(prodEnv(), goodBody()); // no turnstile field
  check('J1 missing token -> refused, noCharge, no Clover', r.status === 400 && r.data.noCharge === true && /verify your browser/.test(r.data.error) && noOrderCall(), JSON.stringify(r.data));
}
{ // invalid token (siteverify success:false)
  fresh(TOTAL);
  clover.handlers.turnstile = () => ({ body: { success: false, 'error-codes': ['invalid-input-response'] } });
  const r = await post(prodEnv(), prodBody());
  check('J2 invalid token -> refused, noCharge, no Clover', r.status === 400 && r.data.noCharge === true && noOrderCall());
}
{ // expired / reused token
  fresh(TOTAL);
  clover.handlers.turnstile = () => ({ body: { success: false, 'error-codes': ['timeout-or-duplicate'] } });
  const r = await post(prodEnv(), prodBody());
  check('J3 expired/reused token -> refused, noCharge, no Clover', r.status === 400 && r.data.noCharge === true && noOrderCall());
}
{ // wrong hostname (real key enforces it)
  fresh(TOTAL);
  clover.handlers.turnstile = () => ({ body: { success: true, hostname: 'evil.example', action: 'order' } });
  const r = await post(prodEnv(), prodBody());
  check('J4 wrong hostname -> refused, noCharge, no Clover', r.status === 400 && r.data.noCharge === true && noOrderCall());
}
{ // wrong action
  fresh(TOTAL);
  clover.handlers.turnstile = () => ({ body: { success: true, hostname: 'preview.example', action: 'login' } });
  const r = await post(prodEnv(), prodBody());
  check('J4b wrong action -> refused, noCharge, no Clover', r.status === 400 && r.data.noCharge === true && noOrderCall());
}
{ // siteverify unreachable -> fail closed in production
  fresh(TOTAL);
  clover.handlers.turnstile = () => ({ throw: true });
  const r = await post(prodEnv(), prodBody());
  check('J5 siteverify down -> fail closed 503, noCharge, no Clover', r.status === 503 && r.data.noCharge === true && noOrderCall(), JSON.stringify(r.data));
}
{ // production without Turnstile configured -> fail closed
  fresh(TOTAL);
  const env = makeEnv({ CLOVER_ENV: 'production', CLOVER_MERCHANT_ID: '7Z068VHSYD2K1', CLOVER_ORDER_TYPE_ID: 'OT1' });
  const r = await post(env, goodBody());
  check('J6 production not configured -> fail closed 503, no Clover', r.status === 503 && r.data.noCharge === true && noOrderCall());
}
{ // production with TEST keys -> refused (fail closed)
  fresh(TOTAL);
  const env = makeEnv({ CLOVER_ENV: 'production', CLOVER_MERCHANT_ID: '7Z068VHSYD2K1', CLOVER_ORDER_TYPE_ID: 'OT1',
    TURNSTILE_SITE_KEY: '1x00000000000000000000BB', TURNSTILE_SECRET: '1x0000000000000000000000000000000AA' });
  const r = await post(env, prodBody());
  check('J7 production TEST keys -> fail closed 503, no Clover', r.status === 503 && r.data.noCharge === true && noOrderCall());
}
{ // sandbox with test keys + token -> passes (siteverify skips hostname/action)
  fresh(TOTAL);
  const r = await post(makeEnv({ TURNSTILE_SITE_KEY: '1x00000000000000000000BB', TURNSTILE_SECRET: '1x0000000000000000000000000000000AA' }),
    goodBody({ turnstile: 'XXXX.DUMMY.TOKEN.XXXX' }));
  check('J8 sandbox test keys + token -> order placed', r.status === 200 && r.data.success === true, JSON.stringify(r.data));
}

// ===== K. Rate limits (per IP, Durable Object) ==============================
{ // order limit: N allowed, N+1 refused (same IP)
  fresh(TOTAL);
  const env = makeEnv({ RATE_ORDER_LIMIT: '3' });
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await post(env, goodBody())).status);
  const last = await post(env, goodBody());
  check('K1 order limit: 3 ok then refused', statuses.slice(0, 3).every(s => s === 200) && last.status === 429 &&
    last.data.noCharge === true && /Too many attempts/.test(last.data.error), JSON.stringify(statuses) + ' last=' + last.status);
}
{ // failure limit: declines count; once over, further orders blocked
  fresh(TOTAL);
  const env = makeEnv({ RATE_FAIL_LIMIT: '3' });
  clover.handlers.pay = () => ({ status: 402, body: { error: { code: 'card_declined' } } });
  const declines = [];
  for (let i = 0; i < 3; i++) declines.push((await post(env, goodBody())).status);
  const callsBefore = clover.calls.length;
  const blocked = await post(env, goodBody());
  check('K2 failure limit: 3 declines then blocked (blocked made no Clover call)', declines.every(s => s === 402) &&
    blocked.status === 429 && blocked.data.noCharge === true && clover.calls.length === callsBefore,
    JSON.stringify(declines) + ' blocked=' + blocked.status);
}
{ // one staff email per IP per window (not on every hit)
  fresh(TOTAL);
  const env = makeEnv({ RATE_FAIL_LIMIT: '3' });
  clover.handlers.pay = () => ({ status: 402, body: { error: { code: 'card_declined' } } });
  for (let i = 0; i < 3; i++) await post(env, goodBody());
  const emailsBefore = emails.length;
  await post(env, goodBody());             // first block -> one alert (to each of 2 recipients)
  const afterFirstBlock = emails.length;
  await post(env, goodBody());             // second block -> deduped, no new email
  check('K3 one staff alert per window (2 recipients, deduped)', emailsBefore === 0 && afterFirstBlock === 2 && emails.length === 2 &&
    /too many attempts/i.test(emails[0].subject), 'before=' + emailsBefore + ' after1=' + afterFirstBlock + ' total=' + emails.length);
}
{ // the limit is per IP: a different address is not blocked
  fresh(TOTAL);
  const env = makeEnv({ RATE_ORDER_LIMIT: '2' });
  await post(env, goodBody(), { ip: '198.51.100.7' });
  await post(env, goodBody(), { ip: '198.51.100.7' });
  const blockedA = await post(env, goodBody(), { ip: '198.51.100.7' });
  const freshB = await post(env, goodBody(), { ip: '198.51.100.9' });
  check('K4 limits are per-IP', blockedA.status === 429 && freshB.status === 200, 'A=' + blockedA.status + ' B=' + freshB.status);
}
{ // missing Origin is refused (also covered by D3)
  fresh(TOTAL);
  const r = await post(makeEnv(), goodBody(), { omitOrigin: true });
  check('K5 missing Origin refused, no Clover', r.status === 403 && noOrderCall());
}

// ===== L. A3 follow-ups: Turnstile-first, IPv6 /64, strict action/hostname ===
setNow(MONDAY_NOON);
{ // a bad / missing token is refused WITHOUT touching the Durable Object
  fresh(TOTAL);
  clover.handlers.turnstile = () => ({ body: { success: false, 'error-codes': ['invalid-input-response'] } });
  const r = await post(prodEnv(), prodBody());
  check('L1 invalid token refused, DO untouched', r.status === 400 && r.data.noCharge === true && doCalls() === 0, 'doCalls=' + doCalls());
  fresh(TOTAL);
  const r2 = await post(prodEnv(), goodBody()); // no token
  check('L2 missing token refused, DO untouched', r2.status === 400 && doCalls() === 0, 'doCalls=' + doCalls());
}
{ // BOT_REFUSED now offers the phone number
  fresh(TOTAL);
  const r = await post(prodEnv(), goodBody());
  check('L3 bot-refused message offers the phone', /verify your browser/.test(r.data.error) && /647-298-2267/.test(r.data.error), r.data.error);
}
{ // strict: success but missing/mismatched action or hostname -> refused
  fresh(TOTAL);
  clover.handlers.turnstile = () => ({ body: { success: true, hostname: 'preview.example' } }); // no action
  const r = await post(prodEnv(), prodBody());
  check('L4 missing action refused (strict)', r.status === 400 && r.data.noCharge === true);
  fresh(TOTAL);
  clover.handlers.turnstile = () => ({ body: { success: true, action: 'order' } }); // no hostname
  const r2 = await post(prodEnv(), prodBody());
  check('L5 missing hostname refused (strict)', r2.status === 400 && r2.data.noCharge === true);
}
{ // IPv6 keyed by /64: addresses in one /64 share a limit; another /64 is separate
  fresh(TOTAL);
  const env = makeEnv({ RATE_ORDER_LIMIT: '2' });
  await post(env, goodBody(), { ip: '2001:db8:1:2:aaaa::1' });
  await post(env, goodBody(), { ip: '2001:db8:1:2:aaaa::1' });
  const sameNet = await post(env, goodBody(), { ip: '2001:db8:1:2:bbbb::9' }); // same /64
  const otherNet = await post(env, goodBody(), { ip: '2001:db8:1:3::1' });     // different /64
  check('L6 IPv6 /64 shares a limit; other /64 separate', sameNet.status === 429 && otherNet.status === 200, 'same=' + sameNet.status + ' other=' + otherNet.status);
}
setNow(MONDAY_NOON);

restoreConsole();
console.log('\n=== RESULTS: ' + pass + ' passed, ' + fail + ' failed ===');
if (failures.length) { console.log('FAILURES:'); failures.forEach(f => console.log('  - ' + f)); process.exitCode = 1; }
