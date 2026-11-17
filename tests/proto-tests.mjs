import { setNow, clover, makeEnv, post, MONDAY_NOON, goodBody, happyHandlers, restoreConsole } from './worker-harness.mjs';
let pass = 0, fail = 0; const bad = [];
const check = (n, c, x) => { c ? pass++ : (fail++, bad.push(n + ' :: ' + x)); };
setNow(MONDAY_NOON);
async function probe(name, mutate, wantStatus) {
  clover.reset(); clover.handlers = happyHandlers(2034);
  const b = goodBody(); mutate(b);
  const r = await post(makeEnv(), b);
  check(name, r.status === wantStatus && (wantStatus !== 400 || clover.calls.length === 0), 'status=' + r.status + ' ' + JSON.stringify(r.data));
}
await probe('P1 item __proto__', b => { b.cart[0].item = '__proto__'; }, 400);
await probe('P2 item constructor', b => { b.cart[0].item = 'constructor'; }, 400);
await probe('P3 item toString', b => { b.cart[0].item = 'toString'; }, 400);
await probe('P4 mod group __proto__', b => { b.cart[0].mods = [{ g: '__proto__', label: 'x' }]; }, 400);
await probe('P5 location __proto__', b => { b.pickup = Object.assign({}, b.pickup, { location: '__proto__' }); }, 400);
await probe('P6 location constructor', b => { b.pickup = Object.assign({}, b.pickup, { location: 'constructor' }); }, 400);
await probe('P7 pickup asap truthy string not ASAP', b => { b.pickup = Object.assign({}, b.pickup, { asap: 'true', time: null }); }, 400);
await probe('P8 cart line null', b => { b.cart = [null]; }, 400);
await probe('P9 cart line string', b => { b.cart = ['tacos/pollo']; }, 400);
await probe('P10 source array', b => { b.source = ['clv_1234567890abcdef']; }, 400);
// after pollution attempts, a normal order still works and Object.prototype is clean
{
  clover.reset(); clover.handlers = happyHandlers(2034);
  const r = await post(makeEnv(), goodBody());
  check('P11 normal order unaffected after probes', r.status === 200, JSON.stringify(r.data));
  check('P12 Object.prototype not polluted', !('x' in {}) && ({}).polluted === undefined, 'polluted');
}
restoreConsole();
console.log('proto/typing probes: ' + pass + ' passed, ' + fail + ' failed');
bad.forEach(b => console.log('  FAIL ' + b));
process.exitCode = fail ? 1 : 0;
