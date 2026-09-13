import { readFileSync, writeFileSync } from 'node:fs';
const raw = readFileSync('bun.lock', 'utf8');
// bun.lock is JSONC-with-trailing-commas
const json = JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1'));
const pkgs = json.packages;
const roots = json.workspaces[''];

const deps = (name) => {
  const e = pkgs[name];
  if (!e) return {};
  const meta = e[2] ?? {};
  return { ...(meta.dependencies ?? {}), ...(meta.optionalDependencies ?? {}), ...(meta.peerDependencies ?? {}) };
};

const groups = {
  prod: Object.keys(roots.dependencies ?? {}),
  optional: Object.keys(roots.optionalDependencies ?? {}),
  dev: Object.keys(roots.devDependencies ?? {})
};

const attrib = new Map(); // pkg -> Set(rootLabel)
for (const [group, list] of Object.entries(groups)) {
  for (const root of list) {
    const seen = new Set();
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (!attrib.has(cur)) attrib.set(cur, new Set());
      attrib.get(cur).add(`${root} (${group})`);
      stack.push(...Object.keys(deps(cur)));
    }
  }
}

const all = Object.keys(pkgs).sort();
const unreached = all.filter((p) => !attrib.has(p));
const version = (p) => (pkgs[p]?.[0] ?? '').split('@').pop();
const hasBin = (p) => Boolean(pkgs[p]?.[2]?.bin || pkgs[p]?.[2]?.binaries);
const integrity = (p) => (pkgs[p] ?? []).find((x) => typeof x === 'string' && x.startsWith('sha512-'));

const rows = all.map((p) => ({
  pkg: p,
  version: version(p),
  roots: [...(attrib.get(p) ?? [])].sort().join(', ') || 'UNREACHABLE',
  bin: hasBin(p),
  integrity: Boolean(integrity(p))
}));

const prodOnly = rows.filter((r) => r.roots.includes('(prod)') || r.roots.includes('(optional)'));
console.log(`total packages: ${rows.length}`);
console.log(`runtime-reachable (prod+optional): ${prodOnly.length}`);
console.log(`dev-only: ${rows.length - prodOnly.length}`);
console.log(`missing integrity hash: ${rows.filter((r) => !r.integrity).map((r) => r.pkg).join(', ') || 'none'}`);
console.log(`unreachable from any root: ${unreached.join(', ') || 'none'}`);
writeFileSync(process.argv[2], JSON.stringify(rows, null, 2));
