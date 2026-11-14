// Copies the website menu's Clover items into the Clover SANDBOX, then writes
// the sandbox IDs into worker/clover-ids.js. Only for testing: the sandbox
// is a stand-in for the live account.
//
// Reads .local/clover-inventory-live.json (a read-only export of the live
// inventory) and the production section of worker/clover-ids.js. For every
// mapped item it makes sure the sandbox has an item with the same name and
// price, taxed with the sandbox's HST 13%, with the same modifier groups
// (same names, min/max, modifiers and prices) attached.
//
// Re-runnable: existing items, groups and modifiers are found by name and
// only what's missing is created (an item whose price differs is updated).
//
// SAFETY: it only ever talks to apisandbox.dev.clover.com and merchant
// 2N9FRNJANSV31, and refuses any other URL. It never reads or writes the
// live account.
//
//   CLOVER_SANDBOX_TOKEN=<sandbox private token> node scripts/sync-sandbox-menu.mjs
//   ... --dry-run   (show what it would create; writes nothing)
// The token is only read from the environment; never put it in a file.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const API = 'https://apisandbox.dev.clover.com';
const MERCHANT = '2N9FRNJANSV31';
const TAX_RATE = 'CTEF4PB5MHX8A'; // the sandbox's "HST" 13%
const BASE = `${API}/v3/merchants/${MERCHANT}`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const token = process.env.CLOVER_SANDBOX_TOKEN;
if (!token) { console.error('sync-sandbox: set CLOVER_SANDBOX_TOKEN in the environment'); process.exit(1); }

const inventory = JSON.parse(readFileSync(join(root, '.local/clover-inventory-live.json'), 'utf8'));
const { CLOVER_IDS } = await import(pathToFileURL(join(root, 'worker/clover-ids.js')).href);
const prod = CLOVER_IDS.production;

// Every request goes through here: sandbox host + sandbox merchant only
async function clover(method, path, body) {
  const url = BASE + path;
  if (!(url === BASE || url.startsWith(BASE + '/') || url.startsWith(BASE + '?')) || new URL(url).host !== 'apisandbox.dev.clover.com') {
    throw new Error(`refusing ${method} ${url}: only ${BASE} is allowed`);
  }
  if (dryRun && method !== 'GET') return { id: 'DRYRUN' };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 5) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new Error(`${method} ${path}: HTTP ${res.status} (token rejected), stopping`);
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }
}

async function getAll(path) {
  let all = [];
  for (let offset = 0; ; offset += 100) {
    const page = (await clover('GET', `${path}${path.includes('?') ? '&' : '?'}limit=100&offset=${offset}`)).elements || [];
    all = all.concat(page);
    if (page.length < 100) return all;
  }
}

const me = await clover('GET', '');
if (me.id !== MERCHANT) { console.error(`sync-sandbox: token belongs to ${me.id}, not ${MERCHANT}; refusing`); process.exit(1); }

// What the live account has, for the mapped items only
const liveById = Object.fromEntries(inventory.items.map((i) => [i.id, i]));
const wanted = Object.entries(prod.items).map(([key, id]) => {
  const item = liveById[id];
  if (!item) throw new Error(`${key}: live item ${id} isn't in the export`);
  return { key, item };
});
const groupsWanted = new Map(); // name -> live group (with modifiers)
for (const { item } of wanted) for (const g of item.modifierGroups) groupsWanted.set(g.name, inventory.modifierGroups.find((x) => x.id === g.id));
const names = wanted.map((w) => w.item.name);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length) throw new Error('two mapped live items share a name: ' + dupes.join(', '));

// What the sandbox has now
const list = (x) => (x && x.elements) || [];
let sbItems = await getAll('/items?expand=modifierGroups,taxRates');
let sbGroups = await getAll('/modifier_groups?expand=modifiers');
const byName = (arr, name) => {
  const found = arr.filter((x) => x.name === name);
  if (found.length > 1) throw new Error(`the sandbox has ${found.length} "${name}"; remove the extras first`);
  return found[0] || null;
};
const created = { items: 0, itemPrices: 0, groups: 0, modifiers: 0, attachments: 0, taxes: 0 };

// 1. Modifier groups and their modifiers
const sbGroupByName = {};
for (const [name, live] of groupsWanted) {
  let g = byName(sbGroups, name);
  if (!g) {
    const body = { name };
    if (live.minRequired != null) body.minRequired = live.minRequired;
    if (live.maxAllowed != null) body.maxAllowed = live.maxAllowed;
    g = { ...(await clover('POST', '/modifier_groups', body)), modifiers: { elements: [] } };
    created.groups++;
  }
  const mods = list(g.modifiers);
  for (const m of live.modifiers) {
    if (!mods.some((x) => x.name === m.name)) {
      mods.push({ name: m.name, price: m.price, ...(await clover('POST', `/modifier_groups/${g.id}/modifiers`, { name: m.name, price: m.price })) });
      created.modifiers++;
    }
  }
  sbGroupByName[name] = { id: g.id, modifiers: mods };
}

// 2. Items, their tax rate and their groups
const sbItemByKey = {};
for (const { key, item } of wanted) {
  let sb = byName(sbItems, item.name);
  if (!sb) {
    sb = await clover('POST', '/items', { name: item.name, price: item.price, priceType: 'FIXED', defaultTaxRates: false });
    sb.modifierGroups = { elements: [] };
    sb.taxRates = { elements: [] };
    created.items++;
  } else if (sb.price !== item.price) {
    await clover('POST', `/items/${sb.id}`, { price: item.price });
    created.itemPrices++;
  }
  if (!list(sb.taxRates).some((t) => t.id === TAX_RATE)) {
    await clover('POST', '/tax_rate_items', { elements: [{ item: { id: sb.id }, taxRate: { id: TAX_RATE } }] });
    created.taxes++;
  }
  const has = new Set(list(sb.modifierGroups).map((g) => g.id));
  for (const g of item.modifierGroups) {
    const sg = sbGroupByName[g.name];
    if (!has.has(sg.id)) {
      await clover('POST', '/item_modifier_groups', { elements: [{ item: { id: sb.id }, modifierGroup: { id: sg.id } }] });
      created.attachments++;
    }
  }
  sbItemByKey[key] = sb.id;
}

// 3. The sandbox section of worker/clover-ids.js
const liveModifier = {}; // live modifier id -> { group name, name }
for (const g of inventory.modifierGroups) for (const m of g.modifiers) liveModifier[m.id] = { group: g.name, name: m.name };
const options = {};
for (const [key, link] of Object.entries(prod.options)) {
  if (link === null) { options[key] = null; continue; }
  const lm = liveModifier[link.id];
  const sm = lm && sbGroupByName[lm.group] && sbGroupByName[lm.group].modifiers.find((m) => m.name === lm.name);
  if (!sm) throw new Error(`${key}: no sandbox modifier for ${link.name}`);
  options[key] = { id: sm.id, name: sm.name, price: sm.price };
}

console.log(`sync-sandbox${dryRun ? ' (dry run)' : ''}: created ${created.items} items, ${created.groups} modifier groups, ` +
  `${created.modifiers} modifiers, ${created.attachments} group attachments, ${created.taxes} tax assignments; ` +
  `updated ${created.itemPrices} item prices. Sandbox now covers ${Object.keys(sbItemByKey).length} items and ` +
  `${Object.values(options).filter(Boolean).length} modifiers.`);
if (dryRun) process.exit(0);

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const section = `  sandbox: {
    merchantId: '${MERCHANT}', // Clover sandbox test merchant (scripts/sync-sandbox-menu.mjs)
    items: {
${Object.entries(sbItemByKey).map(([k, v]) => `      ${q(k)}: ${q(v)},`).join('\n')}
    },
    options: {
${Object.entries(options).map(([k, v]) => `      ${q(k)}: ${v === null ? 'null' : `{ id: ${q(v.id)}, name: ${q(v.name)}, price: ${v.price} }`},`).join('\n')}
    },
  },
};
`;
const file = join(root, 'worker/clover-ids.js');
const raw = readFileSync(file, 'utf8');
const crlf = raw.includes('\r\n');
const src = raw.replace(/\r\n/g, '\n');
const start = src.search(/\n(  \/\/[^\n]*\n)*  sandbox: \{/);
if (start < 0) throw new Error('worker/clover-ids.js: no sandbox section found');
const out = src.slice(0, start + 1) + section;
writeFileSync(file, crlf ? out.replace(/\n/g, '\r\n') : out);
console.log('wrote the sandbox section of worker/clover-ids.js');
