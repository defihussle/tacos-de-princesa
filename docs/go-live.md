# Online ordering: go-live settings

Not published with the site (`docs` is in `.assetsignore`). Settings
themselves are explained at the top of `worker/index.js` and in
`wrangler.toml`.

## Before every merge to main

```sh
node scripts/check-menu.mjs
CLOVER_TOKEN=<live private token> node scripts/check-clover.mjs
```

Both must pass.

- `check-menu` (no network) compares item keys, prices, option groups,
  option labels and option prices (and the tax rate) between `js/order.js`
  and `worker/menu.js`, and checks `worker/clover-ids.js` has a production
  Clover ID for every item and option with matching prices. A difference
  means orders get rejected or charged differently from what the page shows.
- `check-clover` (read-only: GET requests only) compares
  `worker/clover-ids.js` with Clover's live inventory: every ID exists, item
  prices equal the website's, each modifier's name and price equal what the
  Worker sends, and each modifier is still in a group attached to that
  item. Type the token into the command only; never save it in a file.
  `--env sandbox` checks the sandbox section with a sandbox token;
  `--file .local/clover-inventory-live.json` checks a saved export instead.

## The menu and Clover's inventory

Clover is the master copy of the menu. Every website dish is a Clover
inventory item, and every option is a Clover modifier:

- `worker/clover-ids.js` maps each website item key (`tacos/pollo`) to its
  Clover item ID, and each option (`group|label`, e.g. `guac|Add guacamole`)
  to its Clover modifier `{ id, name, price }`. One section per Clover
  account (`production`, `sandbox`); the Worker picks it from `CLOVER_ENV`.
  Each section belongs to one merchant (One York), so a store on another
  merchant gets no IDs.
- Orders send `{ item: { id } }` per dish: Clover fills in the name, price,
  tax and labels, and the labels send it to the right printer and KDS.
  Modifiers go as `{ modifier: { id }, name, amount }` because Clover does
  not fill modifiers in from the ID. The customer's note goes on the line.
- Website prices equal Clover's. Single Taco is the exception in shape, not
  in total: the Clover item is $0 and the protein modifier carries the $7.00
  (`PRICE_ON_OPTION` in `clover-ids.js`).
- Each dish offers exactly the modifier groups attached to its Clover item
  (one website group per Clover group), with customer-friendly labels; the
  Clover name is what's sent.
- Fails closed: if anything in a cart has no Clover ID for the current
  environment, the Worker refuses the order ("Online payment isn't set up
  yet") and logs the missing key. `/api/health` shows `menu.ready` and lists
  `missingCloverIds`.
- `docs/clover-mapping.md` is the original mapping and its open questions;
  `.local/clover-inventory-live.json` (not committed) is a read-only export.

### The sandbox copy of the menu

Previews use the Clover sandbox test merchant (`2N9FRNJANSV31`), whose
inventory is a copy of the live menu made by

```sh
CLOVER_SANDBOX_TOKEN=<sandbox private token> node scripts/sync-sandbox-menu.mjs
```

It reads `.local/clover-inventory-live.json` and the production IDs, creates
any missing items, modifier groups and modifiers in the sandbox (same names
and prices, HST 13%), attaches the groups, and writes the sandbox section of
`worker/clover-ids.js`. It is re-runnable (it only creates what's missing;
`--dry-run` shows the plan) and refuses any host but
`apisandbox.dev.clover.com` and any merchant but `2N9FRNJANSV31`. It doesn't
copy labels (the sandbox has no printers or KDS), so `check-clover --env
sandbox` warns about labels; that's expected.

### When the owner changes the menu in Clover

1. Update both menu files the same way: `worker/menu.js` and `js/order.js`
   (prices, new dishes, option groups and labels).
2. Update `worker/clover-ids.js` (production, and sandbox if it has IDs):
   new or changed item IDs, modifier IDs, names and prices.
3. Run `node scripts/check-menu.mjs` and
   `CLOVER_TOKEN=... node scripts/check-clover.mjs`; fix until both pass.
   `check-clover` also warns about mapped items that are hidden, unlabelled
   or without HST 13%.
4. Push to `online-ordering` and test on the preview: open the changed
   dishes, place a sandbox order, check `/api/health` shows `menu.ready`.
5. Only then merge to main.

A price changed only in Clover makes Clover's total differ from the
website's; the Worker then refuses to charge ("We couldn't price your
order") rather than charging a different amount, so run `check-clover`
after every change in Clover.

## Where each deployment gets its settings

| Deployment | Worker | Settings | Private token secret |
|---|---|---|---|
| Production (main) | `tacos-de-princesa` | `[vars]` | Workers > tacos-de-princesa > Settings > Variables and Secrets |
| Previews (other branches) | `tacos-de-princesa` previews | `[previews.vars]` (sandbox only) | Settings > Previews base config, or `wrangler preview secret put` |
| Private live test | `tacos-de-princesa-livetest` | `[env.livetest.vars]` | `npx wrangler secret put CLOVER_PRIVATE_TOKEN --env livetest` |

Check any of them at `/api/health`: ordering open, enabled stores, which
settings are set, whether an order type is set, and a live Clover check of
the tax rate and order type (`ok` / `fail` / `not set`, never values).

## Private live test (`[env.livetest]`)

A separate Worker on its workers.dev address only, with the restaurant's
live Clover settings, for real low-value orders before launch.

1. Fill in `[env.livetest.vars]`: live `CLOVER_MERCHANT_ID`,
   `CLOVER_PUBLIC_KEY`, `CLOVER_TAX_RATE_ID` (HST 13%) and
   `CLOVER_ORDER_TYPE_ID` ("Online Pickup").
2. `npx wrangler secret put CLOVER_PRIVATE_TOKEN --env livetest`
3. `npx wrangler deploy --env livetest`
4. Open `https://tacos-de-princesa-livetest.<subdomain>.workers.dev/api/health`;
   every store should be `ready` with `taxRate: ok` and `orderType: ok`.
5. Set `ORDERING_OPEN = "true"` only while testing; place an order, check it
   prints in the kitchen, refund it in Clover.

Cloudflare Access will be put in front of this address later, so only the
team can open it.

## Going live (production)

1. Clover (live merchant, One York): Ecommerce API token ("Hosted iFrame +
   API/SDK") for the public and private keys; HST 13% tax rate; an "Online
   Pickup" order type. Merchant currency must be CAD. Run
   `check-clover.mjs` (above): every website dish must be linked.
2. `wrangler.toml` `[vars]`: `CLOVER_ENV = "production"`,
   `CLOVER_CURRENCY = "cad"`, live `CLOVER_MERCHANT_ID`,
   `CLOVER_PUBLIC_KEY`, `CLOVER_TAX_RATE_ID`, `CLOVER_ORDER_TYPE_ID`
   (required in production: orders are refused without it).
3. Production secret `CLOVER_PRIVATE_TOKEN` = live private token.
4. The rate-limiting rule below.
5. `ORDERING_OPEN = "true"` once `/api/health` shows `ready: true`.
6. `order.html`: remove the `noindex` robots tag.

Adding King St W later: add `king-st-w` to `STORES_ENABLED`, and if it
uses different Clover values, set the `_KING_ST_W` versions (for example
`CLOVER_ORDER_TYPE_ID_KING_ST_W`, secret `CLOVER_PRIVATE_TOKEN_KING_ST_W`).

Pausing orders: set `ORDERING_OPEN = "false"` (dashboard: Settings >
Variables, then deploy) — the Worker refuses orders and the page says
"Online ordering is paused, please call 647-298-2267."

Closed days (PATH holidays): add them to `CLOSED_DATES`, comma-separated,
e.g. `"2026-12-25,2026-12-28,2027-01-01"`.

## Rate limiting (production only, not previews)

Without it, a script can call `/api/create-order` as often as it likes
(Clover's reCAPTCHA on the card form is the only bot check). In the
Cloudflare dashboard for the site's domain: **Security > WAF > Rate limiting
rules > Create rule**:

- **If incoming requests match**: `(http.request.uri.path eq "/api/create-order" and http.request.method eq "POST")`
- **With the same characteristics**: IP
- **When rate exceeds**: 5 requests per 1 minute (on the Free plan the only
  period is 10 seconds: use 3 requests per 10 seconds)
- **Then take action**: Block, for 10 minutes if the plan allows (Free: 10 seconds)

Notes:
- WAF rules only cover traffic through the domain. The production Worker's
  `*.workers.dev` address bypasses them: turn it off (Workers >
  tacos-de-princesa > Settings > Domains & Routes > workers.dev: Disable,
  or `workers_dev = false` at the top of `wrangler.toml`) once the domain
  serves the site.
- Previews and `livetest` live on workers.dev, so the rule doesn't touch
  them (as intended).
- A real customer places 1–2 orders, plus maybe a retry after a decline, so
  5 a minute leaves room.

## Guard main (only main deploys to production)

**GitHub** (repo Settings > Rules > Rulesets > New branch ruleset; on a
private repo this needs GitHub Pro or a paid org plan):
- Target: `main`, Enforcement: Active, bypass list empty
- Restrict deletions; Block force pushes
- Require a pull request before merging (blocks direct pushes to main)
- Optional: require the menu check as a status check if it's added to CI

**Workers Builds** (Workers > tacos-de-princesa > Settings > Build):
- Branch control > Production branch: `main` (the only branch that runs
  the production deploy command, `npx wrangler deploy`)
- Non-production branch builds: enabled, with deploy command
  `sh scripts/deploy-preview.sh` (Previews only, never `wrangler deploy`)
- Don't add a production deploy for any other branch; `livetest` is
  deployed by hand with `--env livetest`, not by Builds
