# Tests

Offline tests for the online-ordering Worker (`worker/`) and the payment page
(`order.html` + `js/order.js`). No network, no secrets, no real Clover calls:
Clover, the Turnstile siteverify, email, the rate-limiter Durable Object and the
clock are all simulated. These files are excluded from the published site
(`.assetsignore` lists `tests`).

## Run all the Node suites

```
node tests/run.mjs
```

Runs, in separate processes:

- `worker-tests.mjs` — the main Worker suite: pricing/validation, money, hours,
  payment outcomes (declines, unclear/reconcile, retries), printing/alerts,
  Turnstile, per-IP rate limits, `/api/config` and `/api/health`.
- `proto-tests.mjs` — prototype-pollution / type-confusion probes.
- `hours-tests.mjs` — hours, cutoff, holidays, and the print retry/check/alert.

All suites must pass.

## Browser page-state check (Playwright)

Loads the **real** `order.html` + `js/order.js` with Clover, Turnstile and
`/api/*` stubbed, and checks: the four reply states (decline, unconfirmed,
lost-connection, non-JSON), that a Turnstile token is sent and a full order
confirms, and that the closed-hours message shows in the cart.

1. Start the static server (serves the repo root):

   ```
   node tests/serve.mjs
   ```

2. Drive `tests/browser-page-states.js` with a Playwright browser — e.g. the
   Claude Code Playwright MCP:
   `browser_run_code_unsafe { filename: "tests/browser-page-states.js" }`.

## Harness

`worker-harness.mjs` imports `worker/index.js` and exports the mocks and
drivers (`post`, `get`, `makeEnv`, `goodBody`, the fake Clover/Turnstile/DO,
`setNow`, `setAdvanceClock`). It imports the Worker by a path relative to this
folder, so the suite is portable.
