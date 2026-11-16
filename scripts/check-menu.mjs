// Menu match check: the page (js/order.js) and the Worker (worker/menu.js)
// must have the same item keys, prices, option groups, option labels and
// option prices, and the same tax rate. If they differ, orders are rejected
// ("no longer on the menu") or charged differently from what the page shows.
// Also checks worker/clover-ids.js (production): every website item and
// option has a Clover ID, no ID is left over, and each modifier's price is
// the website option's price (Single Taco: the dish's price, see
// PRICE_ON_OPTION). Prices against Clover itself: scripts/check-clover.mjs.
// And the opening hours, ordering cutoff, pickup slots and holidays: section
// "0b" of js/order.js and worker/hours.js must give the same results.
//
// Run before every merge to main (and after any menu change):
//   node scripts/check-menu.mjs
// Prints each difference and exits 1, or "Menu check passed" and exits 0.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const worker = await import(pathToFileURL(join(root, 'worker/menu.js')).href);
const { CLOVER_IDS, PRICE_ON_OPTION } = await import(pathToFileURL(join(root, 'worker/clover-ids.js')).href);
const hours = await import(pathToFileURL(join(root, 'worker/hours.js')).href);

// The page's menu: section 1 of js/order.js run on its own (it has no
// browser code), giving its GROUPS and ITEMS
const source = readFileSync(join(root, 'js/order.js'), 'utf8');
const start = source.indexOf('/* ---- 1. Menu data');
const end = source.indexOf('/* ---- 2. Helpers');
if (start < 0 || end < start) {
  console.error('check-menu: couldn’t find the "1. Menu data" section in js/order.js');
  process.exit(1);
}
const page = new Function(source.slice(start, end) + '\nreturn { GROUPS: GROUPS, ITEMS: ITEMS };')();
const pageTax = Number((/taxRate:\s*([\d.]+)/.exec(source) || [])[1]);

const problems = [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

if (pageTax !== worker.TAX_RATE) problems.push(`tax rate: page ${pageTax}, worker ${worker.TAX_RATE}`);

for (const key of new Set([...Object.keys(page.ITEMS), ...Object.keys(worker.ITEMS)])) {
  const p = page.ITEMS[key];
  const w = worker.ITEMS[key];
  if (!p) { problems.push(`${key}: only in worker/menu.js`); continue; }
  if (!w) { problems.push(`${key}: only in js/order.js`); continue; }
  if (p.price !== w.price) problems.push(`${key}: price page ${p.price}, worker ${w.price}`);
  if (!same(p.groups, w.groups)) problems.push(`${key}: option groups page [${p.groups}], worker [${w.groups}]`);
  if (p.fullName !== w.fullName) problems.push(`${key}: name page "${p.fullName}", worker "${w.fullName}"`);
  if ((p.nameFrom || null) !== (w.nameFrom || null)) problems.push(`${key}: nameFrom page ${p.nameFrom}, worker ${w.nameFrom}`);
}

for (const key of new Set([...Object.keys(page.GROUPS), ...Object.keys(worker.GROUPS)])) {
  const p = page.GROUPS[key];
  const w = worker.GROUPS[key];
  if (!p) { problems.push(`group ${key}: only in worker/menu.js`); continue; }
  if (!w) { problems.push(`group ${key}: only in js/order.js`); continue; }
  if (p.type !== w.type) problems.push(`group ${key}: type page ${p.type}, worker ${w.type}`);
  const options = (g) => g.options.map((o) => `${o.label} ${o.price}`);
  if (!same(options(p), options(w))) {
    problems.push(`group ${key}: options differ\n    page:   ${options(p).join(' | ')}\n    worker: ${options(w).join(' | ')}`);
  }
}

// Clover IDs (production). Options are "group|label".
const ids = CLOVER_IDS.production;
const priceOnOption = {}; // group -> website price of the dish whose price it carries
for (const [key, g] of Object.entries(PRICE_ON_OPTION)) {
  if (!worker.ITEMS[key]) problems.push(`clover-ids PRICE_ON_OPTION: ${key} isn't a website item`);
  else priceOnOption[g] = worker.ITEMS[key].price;
}
if (!ids.merchantId) problems.push('clover-ids production: no merchantId');
for (const key of Object.keys(worker.ITEMS)) {
  if (!ids.items[key]) problems.push(`${key}: no production Clover item ID`);
}
for (const key of Object.keys(ids.items)) {
  if (!worker.ITEMS[key]) problems.push(`clover-ids: item ${key} isn't on the website`);
}
const websiteOptions = new Set();
for (const [g, group] of Object.entries(worker.GROUPS)) {
  for (const o of group.options) {
    const key = `${g}|${o.label}`;
    websiteOptions.add(key);
    const link = ids.options[key];
    if (link === undefined) { problems.push(`${key}: no production Clover modifier`); continue; }
    if (link === null) { if (!o.none) problems.push(`${key}: null (sends nothing) but it isn't a "none" option`); continue; }
    if (!link.id || !link.name || !Number.isInteger(link.price)) { problems.push(`${key}: needs id, name and price`); continue; }
    const expected = g in priceOnOption ? priceOnOption[g] + o.price : o.price;
    if (link.price !== expected) problems.push(`${key}: Clover modifier price ${link.price}, website ${expected}`);
  }
}
for (const key of Object.keys(ids.options)) {
  if (!websiteOptions.has(key)) problems.push(`clover-ids: option ${key} isn't on the website`);
}

// Hours, cutoff, pickup and holidays: the page's section 0b against worker/hours.js
const h0 = source.indexOf('/* ---- 0b. Hours, pickup and holidays');
const h1 = source.indexOf('/* ---- 0c.');
if (h0 < 0 || h1 < h0) {
  problems.push('couldn’t find section "0b. Hours, pickup and holidays" in js/order.js');
} else {
  const pageHours = new Function(source.slice(h0, h1) +
    ';return { LOCATIONS, PICKUP, holidayClosures, closureOn, orderingWindow, pickupSlots, torontoNow };')();
  const stores = new Set([...Object.keys(pageHours.LOCATIONS), ...Object.keys(hours.HOURS)]);
  for (const id of stores) {
    const pg = pageHours.LOCATIONS[id] && pageHours.LOCATIONS[id].hours;
    if (!same(pg, hours.HOURS[id])) problems.push(`hours for ${id}: page ${JSON.stringify(pg)}, worker ${JSON.stringify(hours.HOURS[id])}`);
  }
  if (!same(pageHours.PICKUP, hours.PICKUP)) problems.push(`pickup rules: page ${JSON.stringify(pageHours.PICKUP)}, worker ${JSON.stringify(hours.PICKUP)}`);
  for (let year = 2024; year <= 2060; year++) {
    if (!same(pageHours.holidayClosures(year), hours.holidayClosures(year))) problems.push(`holidays ${year} differ`);
  }
  // Every day from Nov 2026 to Dec 2028, around the clock, with a one-off closure
  const closed = ['2027-03-03'];
  const minutes = [0, 629, 630, 631, 900, 1049, 1050, 1051, 1060, 1065, 1066, 1080, 1439];
  for (let m = 600; m <= 1110; m += 5) minutes.push(m);
  let diffs = 0;
  for (let day = Date.UTC(2026, 10, 1); day <= Date.UTC(2028, 11, 31); day += 86400000) {
    const iso = new Date(day).toISOString().slice(0, 10);
    const weekday = new Date(day).getUTCDay();
    for (const id of stores) {
      const hp = pageHours.LOCATIONS[id].hours, hw = hours.HOURS[id];
      for (const min of minutes) {
        const now = { iso, weekday, minutes: min };
        if (!same(pageHours.orderingWindow(hp, now, closed), hours.orderingWindow(hw, now, closed)) ||
            !same(pageHours.pickupSlots(hp, min), hours.pickupSlots(hw, min))) {
          if (diffs++ < 5) problems.push(`ordering/pickup rules differ for ${id} on ${iso} at minute ${min}`);
        }
      }
    }
  }
  // Toronto clock, including the daylight-saving switches
  for (const at of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', '2027-03-14T06:59:00Z', '2027-03-14T07:01:00Z', '2027-07-01T22:31:00Z']) {
    if (!same(pageHours.torontoNow(new Date(at)), hours.torontoNow(new Date(at)))) problems.push(`Toronto time differs at ${at}`);
  }
}

if (problems.length) {
  console.error(`Menu check FAILED (${problems.length}):\n  ` + problems.join('\n  '));
  process.exit(1);
}
const sandbox = CLOVER_IDS.sandbox;
console.log(`Menu check passed: ${Object.keys(page.ITEMS).length} items, ${Object.keys(page.GROUPS).length} option groups, tax ${pageTax}; ` +
  `hours, cutoff, pickup slots and holidays match; ` +
  `production Clover IDs for all ${Object.keys(ids.items).length} items and ${Object.keys(ids.options).length} options ` +
  `(sandbox: ${Object.keys(sandbox.items).length} items, ${Object.keys(sandbox.options).length} options).`);
