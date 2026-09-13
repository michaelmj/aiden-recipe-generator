/**
 * Fail if any installed package can run code at install time.
 * Usage: node scripts/check-install-scripts.mjs
 *
 * `bun pm untrusted` only reports packages bun considers untrusted; bun ships a
 * built-in default-trusted allowlist, so a package on that list runs its install
 * script with no prompt and no report. This walks node_modules directly instead.
 *
 * Only preinstall/install/postinstall are checked: `prepare` runs for the root
 * package and git dependencies, never for a package installed from the registry.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const LIFECYCLE = ['preinstall', 'install', 'postinstall'];

const lock = JSON.parse(readFileSync('bun.lock', 'utf8').replace(/,(\s*[}\]])/g, '$1'));
const locked = new Set(Object.keys(lock.packages));

const withScripts = [];
const stale = [];
let scanned = 0;

function walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.name.startsWith('@')) {
      walk(path);
      continue;
    }
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(`${path}/package.json`, 'utf8'));
    } catch {
      continue;
    }
    scanned += 1;
    const name = pkg.name ?? entry.name;
    if (!locked.has(name)) stale.push(`${name} (${path})`);
    const hooks = LIFECYCLE.filter((hook) => pkg.scripts?.[hook]);
    for (const hook of hooks) {
      withScripts.push({ name, hook, script: pkg.scripts[hook], inLock: locked.has(name) });
    }
    walk(`${path}/node_modules`);
  }
}

walk('node_modules');

if (!scanned) {
  console.error('no packages found under node_modules/ — run `bun install --ignore-scripts` first');
  process.exit(2);
}

if (stale.length) {
  console.warn(`${stale.length} package(s) on disk but not in bun.lock (stale install):`);
  for (const s of stale) console.warn(`  ${s}`);
  console.warn('remove node_modules and reinstall to clear them.\n');
}

console.log(`scanned ${scanned} package(s) under node_modules/ (${locked.size} in bun.lock).`);

const blocking = withScripts.filter((r) => r.inLock);
for (const r of withScripts) {
  const tag = r.inLock ? 'LOCKED ' : 'STALE  ';
  console.log(`${tag} ${r.name} :: ${r.hook} :: ${r.script}`);
}

if (blocking.length) {
  console.error(
    `\n${blocking.length} locked package(s) run code at install time. ` +
      'Remove the dependency, or record the exception in CONTRIBUTING.md and allowlist it here.'
  );
  process.exit(1);
}

console.log('\nNo locked package runs an install script.');
