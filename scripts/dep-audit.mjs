/**
 * Query the npm advisory database for the exact versions pinned in bun.lock.
 * Usage: node scripts/dep-audit.mjs [--fail-on=low|moderate|high|critical]
 * Sends package names and versions (public data) to registry.npmjs.org; downloads nothing.
 */
import { readFileSync } from 'node:fs';

const RANK = { low: 0, moderate: 1, high: 2, critical: 3 };
const failOn = (process.argv.find((a) => a.startsWith('--fail-on=')) ?? '--fail-on=high').split('=')[1];

const lock = JSON.parse(readFileSync('bun.lock', 'utf8').replace(/,(\s*[}\]])/g, '$1'));
const body = {};
for (const [name, entry] of Object.entries(lock.packages)) {
  body[name] = [String(entry[0]).split('@').pop()];
}

const res = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
if (!res.ok) {
  console.error(`advisory query failed: ${res.status}`);
  process.exit(2);
}

const found = await res.json();
const rows = Object.entries(found).flatMap(([pkg, list]) =>
  list.map((a) => ({ pkg, severity: a.severity, title: a.title, url: a.url }))
);
rows.sort((a, b) => RANK[b.severity] - RANK[a.severity]);

for (const r of rows) console.log(`${r.severity.toUpperCase().padEnd(8)} ${r.pkg} :: ${r.title} :: ${r.url}`);
console.log(`\n${rows.length} advisories across ${Object.keys(found).length} packages.`);

const blocking = rows.filter((r) => RANK[r.severity] >= RANK[failOn]);
if (blocking.length) {
  console.error(`\n${blocking.length} at or above ${failOn}.`);
  process.exit(1);
}
