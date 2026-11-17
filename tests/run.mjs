// Runs the three Node test suites in separate processes (each hijacks the
// global clock/fetch, so they can't share one process) and reports the total.
// Run: node tests/run.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const suites = ['worker-tests.mjs', 'proto-tests.mjs', 'hours-tests.mjs'];

let failed = 0;
for (const suite of suites) {
  const r = spawnSync(process.execPath, [suite], { cwd: here, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const last = out.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + suite + '  — ' + last.trim());
  if (!ok) console.log(out);
}
console.log('\n' + (failed ? failed + ' suite(s) FAILED' : 'All suites passed') +
  '.\nBrowser check: start `node tests/serve.mjs`, then drive tests/browser-page-states.js with Playwright (see README).');
process.exit(failed ? 1 : 0);
