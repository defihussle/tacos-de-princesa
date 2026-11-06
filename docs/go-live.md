# Online ordering: go-live settings

Not published with the site (`docs` is in `.assetsignore`). Settings
themselves are explained at the top of `worker/index.js` and in
`wrangler.toml`.

## Before every merge to main

```sh
node scripts/check-menu.mjs
```

It must print `Menu check passed`. It compares item keys, prices, option
groups, option labels and option prices (and the tax rate) between
`js/order.js` and `worker/menu.js`. A difference means orders get rejected
or charged differently from what the page shows.

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
   Pickup" order type. Merchant currency must be CAD.
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
