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

## Hours, cutoff and holidays

`worker/hours.js` (and the same section "0b" in `js/order.js`; `check-menu`
fails if they differ):

- Both stores Mon-Fri 10:30-18:00. Online orders from 10:30 until 17:30;
  from 17:31 the Worker refuses them ("Online ordering closes at 5:30 pm.
  Please call 647-298-2267."), even if the page was left open.
- Pickup the same day: ASAP (about 20 minutes) or a 15-minute slot from 20
  minutes from now up to 17:45.
- Closed on New Year's Day, Family Day, Good Friday, Victoria Day, Canada
  Day, Civic Holiday, Labour Day, Thanksgiving, Christmas Day and Boxing
  Day, worked out for every year in code. A holiday on a weekend closes the
  next free weekday. The page says "Closed today for <holiday>".
- `CLOSED_DATES` (comma-separated `YYYY-MM-DD`) adds one-off closures.

## Printing checks and "didn't print" emails

After the customer has their answer, the Worker sends the order to the
kitchen printer, retries once after ~5 s if Clover refuses, then checks the
print job ~15 s and ~26 s later (Clover's states: CREATED, PRINTING, FAILED;
a printed job disappears). If it failed or hasn't printed, ONE email goes to
every address in `ALERT_EMAILS` with the order, store, pickup time, customer
and items, and "Print it from the Clover Orders app." No card details.

The last check can't be later than ~26 s: Cloudflare cancels background work
(`ctx.waitUntil`) 30 s after the response. A check at 60 s or later would
need a Cloudflare Queue with a delay (consumer Worker), which previews can't
run.

### Setting up the emails (once, in the Cloudflare dashboard)

1. **Email Routing on tacosprincesa.ca**: Websites > tacosprincesa.ca >
   Email > Email Routing > Enable. Cloudflare adds its MX and SPF records
   (the domain has no mail records today, so nothing else is affected).
2. **Verify each recipient**: Email Routing > Destination addresses > Add
   `omer@narcostacos.ca`, then click the link in the verification email.
   Every address added to `ALERT_EMAILS` later must be verified the same way.
3. The sender `alerts@tacosprincesa.ca` (`ALERT_FROM`) needs no mailbox.
4. Redeploy (push to the branch for previews). `/api/health` shows
   `alerts: { recipients, sender, binding }`.

Adding a recipient: verify the address (step 2), then add it to
`ALERT_EMAILS` in `wrangler.toml` (`[vars]`, `[previews.vars]`,
`[env.livetest.vars]`), comma-separated, and deploy. No code change.

## Where each deployment gets its settings

| Deployment | Worker | Settings | Private token secret |
|---|---|---|---|
| Production (main; tacosprincesa.ca only, `workers_dev = false`) | `tacos-de-princesa` | `[vars]` | Workers > tacos-de-princesa > Settings > Variables and Secrets |
| Previews (other branches) | `tacos-de-princesa` previews | `[previews.vars]` (sandbox only) | Settings > Previews base config, or `wrangler preview secret put` |
| Private live test | `tacos-de-princesa-livetest` | `[env.livetest.vars]` | `npx wrangler secret put CLOVER_PRIVATE_TOKEN --env livetest` |

Check any of them at `/api/health`: ordering open, enabled stores, which
settings are set, whether an order type is set, and a live Clover check of
the tax rate and order type (`ok` / `fail` / `not set`, never values).

## Private live test (`[env.livetest]`)

A separate Worker on its workers.dev address only, with the restaurant's
live Clover settings, for real low-value orders before launch.

1. Fill in `[env.livetest.vars]`: live `CLOVER_MERCHANT_ID`,
   `CLOVER_PUBLIC_KEY`, `CLOVER_TAX_RATE_ID` (HST 13%),
   `CLOVER_ORDER_TYPE_ID` (order type "Website Pick Up 1 York",
   `DR9JRZ31WB6Y4`), and `TURNSTILE_SITE_KEY` (real Turnstile site key — the
   widget's hostnames must include this workers.dev host).
2. Secrets: `npx wrangler secret put CLOVER_PRIVATE_TOKEN --env livetest`, and
   `npx wrangler secret put TURNSTILE_SECRET --env livetest`.
3. `npx wrangler deploy --env livetest`
4. Open `https://tacos-de-princesa-livetest.<subdomain>.workers.dev/api/health`;
   every store should be `ready` with `taxRate: ok` and `orderType: ok`.
5. Set `ORDERING_OPEN = "true"` only while testing; place an order, check it
   prints in the kitchen, refund it in Clover.

Cloudflare Access will be put in front of this address later, so only the
team can open it.

## Going live (production)

1. Clover (live merchant, One York): Ecommerce API token ("Hosted iFrame +
   API/SDK") for the public and private keys; HST 13% tax rate
   (`SCA3PKB974QJJ`); order type "Website Pick Up 1 York" (`DR9JRZ31WB6Y4`).
   Merchant currency must be CAD. Run
   `check-clover.mjs` (above): every website dish must be linked.
2. `wrangler.toml` `[vars]`: `CLOVER_ENV = "production"`,
   `CLOVER_CURRENCY = "cad"`, live `CLOVER_MERCHANT_ID`,
   `CLOVER_PUBLIC_KEY`, `CLOVER_TAX_RATE_ID`, `CLOVER_ORDER_TYPE_ID`
   (required in production: orders are refused without it), and the real
   `TURNSTILE_SITE_KEY`.
3. Production secrets (Settings > Variables and Secrets): `CLOVER_PRIVATE_TOKEN`
   (live private token), `TURNSTILE_SECRET` (real Turnstile secret), and
   optionally `HEALTH_TOKEN` (to read the detailed `/api/health` in production
   via the `x-health-token` header; otherwise production shows only
   `ready` + `commit`).
4. Turnstile, the per-IP rate limits and Clover's fraud tools — see "Bots and
   card testers" below. Confirm `/api/health` shows `turnstile: true` and
   `rateLimiter: true`.
5. Security headers / CSP — see "Security headers and CSP": confirm **no CSP
   errors** on the livetest order page's console.
6. `ORDERING_OPEN = "true"` once `/api/health` shows `ready: true`.
7. `order.html`: remove the `noindex` robots tag.

Adding King St W later: add `king-st-w` to `STORES_ENABLED`, and if it
uses different Clover values, set the `_KING_ST_W` versions (for example
`CLOVER_ORDER_TYPE_ID_KING_ST_W`, secret `CLOVER_PRIVATE_TOKEN_KING_ST_W`).

Pausing orders: set `ORDERING_OPEN = "false"` (dashboard: Settings >
Variables, then deploy) — the Worker refuses orders and the page says
"Online ordering is paused, please call 647-298-2267."

Closed days (PATH holidays): add them to `CLOSED_DATES`, comma-separated,
e.g. `"2026-12-25,2026-12-28,2027-01-01"`.

## Bots and card testers

Three layers guard `/api/create-order` (the only place a charge happens):

1. **Turnstile** — our own check on the endpoint, fail-closed in production.
   Create the widget in the Cloudflare dashboard > **Turnstile > Add widget**:
   - Hostnames: `tacosprincesa.ca`, `www.tacosprincesa.ca`, and the livetest
     `*.workers.dev` host.
   - Mode: Managed (invisible works too).
   - Put the **Site key** in `[vars]` `TURNSTILE_SITE_KEY` (and
     `[env.livetest.vars]`). Put the **Secret key** in the dashboard as the
     secret `TURNSTILE_SECRET` (Settings > Variables and Secrets), never in
     `wrangler.toml`. Production refuses Cloudflare's test keys, so real keys
     are required; `/api/health` shows `turnstile: true` only when real-ready.

2. **Per-IP rate limits** in the Worker — the `RATE_LIMITER` Durable Object
   (bound in `wrangler.toml`, SQLite-backed so it runs on the Free plan). Keyed
   by the IPv4 address or the IPv6 /64, and tunable via `[vars]` in every
   environment:
   - `RATE_ORDER_LIMIT` (20) / `RATE_ORDER_WINDOW_S` (60): generous — PATH
     offices share one IP.
   - `RATE_FAIL_LIMIT` (5) / `RATE_FAIL_WINDOW_S` (600): strict — failed
     payments (card testing). Over the limit the Worker answers "Too many
     attempts…" and emails staff once per IP per window. `/api/health` shows
     `rateLimiter: true` when bound. (A Cloudflare WAF rate-limiting rule on the
     domain is optional belt-and-suspenders; the Worker's own limits are the
     primary defense and cover every environment, including workers.dev.)

3. **Clover's own fraud tools** on the live merchant (Clover Merchant Dashboard
   > Settings > View all settings > **Ecommerce**):
   - **Ecommerce API Tokens > reCAPTCHA Settings**: tick "Use reCAPTCHA for all
     transactions made through iFrame embedded page".
   - **Fraud Tools > Edit**: Risk score threshold **Medium**; turn on the
     **AVS postal-code** block; **velocity limit** ~5 failed attempts;
     **Transaction Limits** ~5 per card/day and ~15 per IP/day; keep block lists
     ready (consider blocking non-CA/US countries). Note: Clover's reCAPTCHA is
     a client-side measure on the card form and is **not** documented to gate
     token minting, so Turnstile on our endpoint (layer 1) is the real guard.

## Security headers and CSP

The static pages carry security headers and a per-page Content-Security-Policy
from `_headers` (X-Content-Type-Options nosniff, Referrer-Policy, X-Frame-Options
DENY, Permissions-Policy off for camera/mic/geolocation, HSTS 6 months); the
Worker's API responses carry the same basics. The CSP is **enforced** — the
sandbox Clover hosts, all four card iframes, the reCAPTCHA badge, Turnstile and
Google Fonts loaded with zero violations on the preview.

- **Phase 5 check (livetest, real Clover):** open the livetest order page, reach
  the payment step, and confirm the browser console shows **no CSP errors**.
  This is the only way to prove the production Clover hosts (`checkout.clover.com`,
  `api.clover.com`, `scl.clover.com`), which are already allow-listed in
  `_headers`. If a resource is blocked, add its host to the right directive.
- HSTS has **no** `includeSubDomains` (it would affect every subdomain of
  tacosprincesa.ca). Add it only after confirming no subdomain needs plain HTTP.

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
