// Offline tests of the Worker: hours/cutoff/holidays and the print retry,
// check and alert. Clover, email and time are simulated. No network.
const WORKER_URL = new URL('../worker/index.js', import.meta.url).href;
const RealDate = Date;
let clock = 0; // virtual ms
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [clock])); }
  static now() { return clock; }
};
// Virtual timers: setTimeout advances the clock instead of waiting
const realSetTimeout = setTimeout;
globalThis.setTimeout = (fn, ms) => { realSetTimeout(() => { clock += Math.max(0, ms || 0); fn(); }, 0); return 0; };

const { default: worker } = await import(WORKER_URL);
const at = (iso) => { clock = RealDate.parse(iso); };

// Clover simulator: per test, how print_event and the job state behave
let printMode, calls, logs;
globalThis.fetch = async (url, init) => {
  const u = String(url), method = (init && init.method) || 'GET';
  calls.push(method + ' ' + u.replace(/^https:\/\/[^/]+/, '') + ' @' + Math.round((clock - started) / 1000) + 's');
  const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
  if (u.includes('/turnstile/v0/siteverify')) return ok({ success: true, hostname: 'x.dev', action: 'order' });
  if (u.endsWith('/atomic_order/orders')) return ok({ id: 'ORD1', total: 791 });
  if (u.includes('/pay')) return ok({ id: 'ORD1', status: 'paid' });
  if (u.endsWith('/print_event') && method === 'POST') {
    if (printMode.refuse) return new Response(JSON.stringify({ message: 'default printing device is missing' }), { status: 400 });
    if (printMode.refuseOnce && !printMode.refused) { printMode.refused = true; return new Response('{"message":"busy"}', { status: 503 }); }
    return ok({ id: 'JOB1', state: 'CREATED' });
  }
  if (u.includes('/print_event/')) {
    const state = printMode.states.shift();
    if (state === 'MISSING') return new Response(JSON.stringify({ message: 'The print event is missing' }), { status: 404 });
    if (state === 'THROW') throw new Error('network timeout');
    if (state && typeof state === 'object') return new Response(JSON.stringify(state.body), { status: state.status });
    return ok({ id: 'JOB1', state });
  }
  return ok({});
};
let started = 0;
const sent = [];
const env = {
  ORDERING_OPEN: 'true', STORES_ENABLED: 'one-york', CLOSED_DATES: '2026-11-18', CLOVER_ENV: 'production', CLOVER_CURRENCY: 'cad',
  CLOVER_MERCHANT_ID: '7Z068VHSYD2K1', CLOVER_PUBLIC_KEY: 'pk', CLOVER_TAX_RATE_ID: 'SCA3PKB974QJJ', CLOVER_ORDER_TYPE_ID: 'DR9JRZ31WB6Y4',
  CLOVER_PRIVATE_TOKEN: 'fake', ALERT_EMAILS: 'omer@narcostacos.ca, second@example.com', ALERT_FROM: 'alerts@tacosprincesa.ca',
  ALERT_EMAIL: { send: async (msg) => { sent.push(msg); return { messageId: 'm' + sent.length }; } },
  // Production fails closed without Turnstile; configure real keys (siteverify mocked above).
  TURNSTILE_SITE_KEY: '0xRealSiteKey', TURNSTILE_SECRET: '0xRealSecretKey',
};
const cart = [{ item: 'tacos/single-taco', qty: 1, mods: [{ g: 'filling', label: 'Barbacoa' }], note: 'extra lime' }];

async function order(pickup, mode) {
  printMode = Object.assign({ states: [] }, mode || {});
  calls = []; logs = []; sent.length = 0; started = clock;
  const background = [];
  const ctx = { waitUntil: (p) => background.push(p) };
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  const res = await worker.fetch(new Request('https://x.dev/api/create-order', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://x.dev' },
    body: JSON.stringify({ source: 'clv_1TSTabcdefghij', turnstile: 'XXXX.DUMMY.TOKEN.XXXX', cart, pickup: Object.assign({ name: 'Ana Test', phone: '647-555-0123', location: 'one-york' }, pickup) }),
  }), env, ctx);
  const body = await res.json();
  const answeredAt = Math.round((clock - started) / 1000);
  let settled = false; Promise.all(background).then(() => { settled = true; });
  await Promise.resolve();
  const printStillRunningAtAnswer = background.length === 1 && !settled;
  await Promise.all(background);
  console.log = origLog; console.error = origErr;
  return { status: res.status, body, answeredAt, printStillRunningAtAnswer, calls, logs, sent: sent.slice() };
}

const results = [];
const check = (name, cond, extra) => { results.push([name, cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  — ' + extra : '')); };

// ---- Hours and cutoff (Mon 2026-11-16, Toronto = UTC-5)
at('2026-11-16T12:07:00-05:00');
let r = await order({ asap: true, time: null }, { states: ['MISSING'] });
check('allowed time (Mon 12:07), ASAP: paid', r.status === 200 && r.body.success, `HTTP ${r.status}`);
check('  answered at 0 s while printing was still running in the background', r.printStillRunningAtAnswer && r.answeredAt === 0);
check('  printed (job gone at the 15 s check): no alert', r.sent.length === 0 && r.logs.some((l) => l.startsWith('PRINTED ORD1')), r.logs.filter((l) => /PRINT/.test(l)).join(' | '));
r = await order({ asap: false, time: '2026-11-16T12:30' }, { states: ['MISSING'] });
check('allowed time, 12:30 slot (first slot after 12:07)', r.status === 200);
r = await order({ asap: false, time: '2026-11-16T12:15' });
check('12:15 slot refused (less than 20 min away)', r.status === 400, r.body.error);
at('2026-11-16T17:20:00-05:00');
r = await order({ asap: false, time: '2026-11-16T17:45' }, { states: ['MISSING'] });
check('17:20, 17:45 slot (last slot) accepted', r.status === 200, r.body.error || '');
r = await order({ asap: false, time: '2026-11-16T18:00' });
check('17:20, 18:00 slot refused (after 17:45)', r.status === 400, r.body.error);
at('2026-11-16T17:30:59-05:00');
r = await order({ asap: true, time: null }, { states: ['MISSING'] });
check('17:30:59 ASAP still accepted', r.status === 200, r.body.error || '');
at('2026-11-16T17:31:00-05:00');
r = await order({ asap: true, time: null });
check('17:31:00 refused with the cutoff message', r.status === 400 && r.body.error === 'Online ordering closes at 5:30 pm. Please call 647-298-2267.', JSON.stringify(r.body.error));
check('  nothing sent to Clover after the cutoff', r.calls.filter((c) => !c.includes('/turnstile/')).length === 0);
at('2026-11-16T10:29:00-05:00');
r = await order({ asap: true, time: null });
check('10:29 refused (before opening)', r.status === 400, r.body.error);
at('2026-11-16T10:30:00-05:00');
r = await order({ asap: true, time: null }, { states: ['MISSING'] });
check('10:30 accepted', r.status === 200, r.body.error || '');

// ---- Holidays and closures
at('2026-12-25T12:00:00-05:00');
r = await order({ asap: true, time: null });
check('Christmas Day (Fri 2026-12-25) closed', r.status === 400 && r.body.error === 'We’re closed today for Christmas Day. Please call 647-298-2267.', r.body.error);
at('2026-12-28T12:00:00-05:00');
r = await order({ asap: true, time: null });
check('Boxing Day observed (Mon 2026-12-28, the 26th is a Saturday)', r.status === 400 && /Boxing Day/.test(r.body.error), r.body.error);
at('2027-12-28T12:00:00-05:00');
r = await order({ asap: true, time: null });
check('Boxing Day 2027 (Sun) -> Tue 2027-12-28', r.status === 400 && /Boxing Day/.test(r.body.error), r.body.error);
at('2026-11-18T12:00:00-05:00');
r = await order({ asap: true, time: null });
check('CLOSED_DATES one-off (2026-11-18) closed', r.status === 400 && /not taking online orders/.test(r.body.error), r.body.error);
at('2026-11-21T12:00:00-05:00');
r = await order({ asap: true, time: null });
check('Saturday closed', r.status === 400, r.body.error);

// ---- Printing
at('2026-11-16T12:07:00-05:00');
r = await order({ asap: true, time: null }, { refuse: true });
const mail = r.sent[0] || {};
check('print refused twice: retried after ~5 s', r.calls.filter((c) => c.startsWith('POST /v3/merchants/7Z068VHSYD2K1/print_event')).map((c) => c.split('@')[1]).join(',') === '0s,5s', r.calls.filter((c) => c.includes('print_event')).join(' | '));
check('  one alert email per recipient (2 recipients)', r.sent.length === 2 && r.sent.map((m) => m.to).join(',') === 'omer@narcostacos.ca,second@example.com');
check('  email has order, store, pickup, customer, items, instruction; no card data',
  /ORD1/.test(mail.text) && /One York/.test(mail.text) && /Pickup: ASAP/.test(mail.text) && /Ana Test, 647-555-0123/.test(mail.text) &&
  /1 x Single Taco \(Barbacoa\) "extra lime"/.test(mail.text) && /Print it from the Clover Orders app\./.test(mail.text) && !/clv_|card/i.test(mail.text));
check('  PRINT FAILED lines logged', r.logs.filter((l) => l.startsWith('PRINT FAILED')).length === 2);
check('  customer still got success', r.status === 200 && r.body.success);
r = await order({ asap: true, time: null }, { refuseOnce: true, states: ['MISSING'] });
check('print refused once, retry works: printed, no alert', r.sent.length === 0 && r.logs.some((l) => l.startsWith('PRINTED')));
r = await order({ asap: true, time: null }, { states: ['FAILED'] });
check('job FAILED at the 12 s check: alert', r.sent.length === 2 && /FAILED/.test(r.sent[0].text), r.calls.filter((c) => c.includes('print_event/')).join(' | '));
r = await order({ asap: true, time: null }, { states: ['CREATED', 'CREATED'] });
check('job still CREATED at 12 s and 20 s (printer offline): alert', r.sent.length === 2 && /hadn’t printed 20 seconds/.test(r.sent[0].text),
  r.calls.filter((c) => c.includes('print_event/')).map((c) => c.split('@')[1]).join(','));
r = await order({ asap: true, time: null }, { states: ['PRINTING', 'MISSING'] });
check('PRINTING at 12 s, gone at 20 s: printed, no alert', r.sent.length === 0);
const missing401 = { status: 401, body: { message: 'Unauthorized: The print event is missing' } };
r = await order({ asap: true, time: null }, { states: [missing401, missing401] });
check('401 whose body says "missing" (both checks): NOT treated as printed, alert sent',
  r.sent.length === 2 && r.sent[0].text.includes('UNKNOWN (HTTP 401)') && !r.logs.some((l) => l.startsWith('PRINTED')),
  r.logs.filter((l) => /PRINT FAILED|PRINTED/.test(l)).join(' | '));
r = await order({ asap: true, time: null }, { states: [{ status: 200, body: { foo: 1 } }, { status: 200, body: { state: 'WEIRD' } }] });
check('200 with an unexpected body (both checks): alert', r.sent.length === 2 && r.sent[0].text.includes('UNKNOWN (HTTP 200)'));
r = await order({ asap: true, time: null }, { states: ['THROW', 'THROW'] });
check('network error / timeout (both checks): alert', r.sent.length === 2 && /UNKNOWN/.test(r.sent[0].text));
r = await order({ asap: true, time: null }, { states: [{ status: 503, body: {} }, 'MISSING'] });
check('503 at 12 s, then 404 at 20 s: printed, no alert', r.sent.length === 0 && r.logs.some((l) => l.startsWith('PRINTED')));
const env2 = env.ALERT_EMAIL; env.ALERT_EMAIL = undefined;
r = await order({ asap: true, time: null }, { refuse: true });
env.ALERT_EMAIL = env2;
check('no email binding: logs ALERT NOT SENT, customer unaffected', r.status === 200 && r.logs.some((l) => l.startsWith('ALERT NOT SENT')));

console.log('\nEXAMPLE ALERT EMAIL\nTo: ' + mail.to + '\nFrom: ' + mail.from + '\nSubject: ' + mail.subject + '\n\n' + mail.text);
console.log('\n' + results.filter((x) => x[1]).length + '/' + results.length + ' passed');
