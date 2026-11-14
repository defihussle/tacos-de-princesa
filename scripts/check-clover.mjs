// Clover inventory check: worker/clover-ids.js against Clover's own
// inventory. READ-ONLY (GET requests only); nothing in Clover changes.
//
// Fails (exit 1) if, for the chosen environment:
//   - an item or modifier ID doesn't exist in Clover
//   - a Clover item's price isn't the website price (Single Taco: $0, with
//     the price on the protein modifier, see PRICE_ON_OPTION)
//   - a modifier's name or price isn't what the Worker sends (clover-ids.js)
//   - a modifier isn't in a modifier group attached to every Clover item
//     whose website dish offers it
// Also warns (no failure) about mapped items that are hidden, unlabelled
// (they'd reach no printer or KDS) or without HST 13%.
//
// Run by hand before every merge to main and after any menu change in Clover:
//   CLOVER_TOKEN=<private token> node scripts/check-clover.mjs              (production)
//   CLOVER_TOKEN=<sandbox token> node scripts/check-clover.mjs --env sandbox
// Or against a saved export (no network, no token):
//   node scripts/check-clover.mjs --file .local/clover-inventory-live.json
// The token is only read from the environment; never put it in a file.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { GROUPS, ITEMS } = await import(pathToFileURL(join(root, 'worker/menu.js')).href);
const { CLOVER_IDS, PRICE_ON_OPTION } = await import(pathToFileURL(join(root, 'worker/clover-ids.js')).href);

const args = process.argv.slice(2);
const argValue = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const envName = argValue('--env') || 'production';
const file = argValue('--file');
const ids = CLOVER_IDS[envName];
if (!ids) { console.error(`check-clover: unknown --env ${envName} (production or sandbox)`); process.exit(1); }
if (!ids.merchantId || !Object.keys(ids.items).length) {
  console.error(`check-clover: worker/clover-ids.js has no ${envName} IDs yet`);
  process.exit(1);
}

// Clover's inventory: { items: [{ id, name, price, hidden, labels, taxRates,
// modifierGroups: [{ id, name, modifiers: [{ id, name, price }] }] }] }
async function liveInventory() {
  const token = process.env.CLOVER_TOKEN;
  if (!token) { console.error('check-clover: set CLOVER_TOKEN (the merchant\'s private token) in the environment'); process.exit(1); }
  const api = envName === 'production' ? 'https://api.clover.com' : 'https://apisandbox.dev.clover.com';
  const base = `${api}/v3/merchants/${ids.merchantId}`;
  const getAll = async (path) => {
    let all = [];
    for (let offset = 0; ; offset += 100) {
      const res = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}limit=100&offset=${offset}`,
        { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
      if (!res.ok) { console.error(`check-clover: GET ${path} -> HTTP ${res.status}`); process.exit(1); }
      const page = (await res.json()).elements || [];
      all = all.concat(page);
      if (page.length < 100) return all;
    }
  };
  const [items, groups] = await Promise.all([
    getAll('/items?expand=tags,taxRates,modifierGroups'),
    getAll('/modifier_groups?expand=modifiers'),
  ]);
  const groupById = Object.fromEntries(groups.map((g) => [g.id, g]));
  const list = (x) => (x && x.elements) || [];
  return {
    merchantId: ids.merchantId,
    items: items.map((i) => ({
      id: i.id, name: i.name, price: i.price, hidden: !!i.hidden, available: i.available !== false,
      labels: list(i.tags).map((t) => ({ name: t.name })),
      taxRates: list(i.taxRates).map((t) => ({ name: t.name, ratePercent: t.rate / 100000 })),
      modifierGroups: list(i.modifierGroups).map((g) => ({
        id: g.id, name: (groupById[g.id] || g).name,
        modifiers: list((groupById[g.id] || {}).modifiers).map((m) => ({ id: m.id, name: m.name, price: m.price })),
      })),
    })),
  };
}

const inventory = file ? JSON.parse(readFileSync(resolve(file), 'utf8')) : await liveInventory();
if (inventory.merchantId && inventory.merchantId !== ids.merchantId) {
  console.error(`check-clover: inventory is for merchant ${inventory.merchantId}, clover-ids ${envName} is for ${ids.merchantId}`);
  process.exit(1);
}

const problems = [];
const warnings = [];
const itemById = Object.fromEntries(inventory.items.map((i) => [i.id, i]));
const money = (c) => `$${(c / 100).toFixed(2)}`;

// Items
for (const [key, w] of Object.entries(ITEMS)) {
  const c = itemById[ids.items[key]];
  if (!c) { problems.push(`${key}: Clover item ${ids.items[key]} not found`); continue; }
  const expected = key in PRICE_ON_OPTION ? 0 : w.price;
  if (c.price !== expected) problems.push(`${key}: Clover "${c.name}" is ${money(c.price)}, website expects ${money(expected)}`);
  if (c.hidden || !c.available) warnings.push(`${key}: Clover "${c.name}" is hidden or unavailable`);
  if (!c.labels.length) warnings.push(`${key}: Clover "${c.name}" has no labels (reaches no printer or KDS)`);
  if (!c.taxRates.some((t) => t.ratePercent === 13)) warnings.push(`${key}: Clover "${c.name}" has no HST 13%`);
}

// Options: name and price as sent, and in a group on every item offering it
const priceOnOption = {};
for (const [key, g] of Object.entries(PRICE_ON_OPTION)) priceOnOption[g] = ITEMS[key].price;
for (const [g, group] of Object.entries(GROUPS)) {
  const offeredBy = Object.keys(ITEMS).filter((k) => ITEMS[k].groups.includes(g));
  for (const o of group.options) {
    const key = `${g}|${o.label}`;
    const link = ids.options[key];
    if (link === null) continue; // sends nothing ("No protein")
    if (!link) { problems.push(`${key}: no ${envName} Clover modifier in clover-ids.js`); continue; }
    let found = false;
    for (const itemKey of offeredBy) {
      const c = itemById[ids.items[itemKey]];
      if (!c) continue; // reported above
      let m = null;
      for (const mg of c.modifierGroups) m = m || mg.modifiers.find((x) => x.id === link.id);
      if (!m) { problems.push(`${key}: modifier ${link.id} "${link.name}" isn't in any group on ${itemKey} (Clover "${c.name}")`); continue; }
      if (!found) {
        found = true;
        if (m.name !== link.name) problems.push(`${key}: Clover calls it "${m.name}", the Worker sends "${link.name}"`);
        if (m.price !== link.price) problems.push(`${key}: Clover price ${money(m.price)}, the Worker sends ${money(link.price)}`);
        const expected = g in priceOnOption ? priceOnOption[g] + o.price : o.price;
        if (m.price !== expected) problems.push(`${key}: Clover price ${money(m.price)}, website charges ${money(expected)}`);
      }
    }
  }
}

const source = file ? `export ${file}` : `live ${envName} inventory`;
for (const w of warnings) console.warn(`  warning: ${w}`);
if (problems.length) {
  console.error(`Clover check FAILED against the ${source} (${problems.length}):\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log(`Clover check passed against the ${source}: ${Object.keys(ITEMS).length} items and ` +
  `${Object.values(ids.options).filter(Boolean).length} modifiers match (${warnings.length} warnings).`);
