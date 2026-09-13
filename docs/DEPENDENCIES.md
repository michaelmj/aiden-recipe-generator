# Dependency Vetting — `bun.lock`

Issue `aiden-recipe-generator-nh5.11`. Audited 2026-09-13 against the versions pinned in `bun.lock`.
Attribution is reproducible: `node scripts/dep-attribution.mjs /tmp/attrib.json`.

## Shape of the tree

137 packages resolve from 4 direct dependencies. Attribution by root:

| Root | Transitive packages | Group |
|---|---|---|
| `@modelcontextprotocol/sdk` | 90 | prod |
| `keytar` | 37 | optional |
| `@biomejs/biome` | 9 | dev |
| `@types/node` | 2 | dev |
| `csv-parse` | 1 | prod |
| `zod` | 1 | prod |
| `typescript` | 1 | dev |

125 packages are reachable at runtime (prod + optional); 12 are dev-only. Every entry carries a
`sha512-` integrity hash and every package is reachable from a declared root — no orphans.

**The tree is really two dependencies.** `@modelcontextprotocol/sdk` brings a full HTTP server stack
(`express`, `hono`, `@hono/node-server`, `cors`, `express-rate-limit`, `body-parser`, `qs`,
`path-to-regexp`, `router`, `send`, `serve-static`, …) for its SSE and Streamable-HTTP transports.
`src/index.ts` uses `StdioServerTransport` only, so none of that code is reached — but it is
installed, it is what the advisories below live in, and it is on disk for anything else to load.

`keytar` accounts for 37 packages, all of them install-time machinery.

## Advisories against pinned versions

Queried from the npm advisory database (`registry.npmjs.org/-/npm/v1/security/advisories/bulk`).
`bun audit` could not be run: bun is not installed on this machine and no `node_modules` exists.

### Reachable in this server's own code paths

| Package | Pinned | Severity | Advisory |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.25.3 | **HIGH** | Cross-client data leak via shared server/transport instance reuse — GHSA-345p-7cg4-v4c7 (affects `>=1.10.0 <=1.25.3`; latest is 1.30.0) |
| `csv-parse` | 5.6.0 | **MODERATE** | Prototype replacement reachable via the `columns` path — GHSA-8cw4-87c7-c6xx (fixed in 7.0.2) |

`csv-parse` is the parser that eats the untrusted community CSV (`src/sheet/store.ts:52`), which
makes it the one advisory sitting directly on the attack path this epic is about. Current call site
passes `relax_quotes`, `relax_column_count`, `skip_empty_lines` and takes array output — it does not
use the `columns` option the advisory names — so exploitability today looks low, but the upgrade is
cheap insurance and 5.x will not receive the fix.

### Present but not executed (HTTP transport stack)

`hono@4.11.7` (~30 advisories), `@hono/node-server@1.19.9` (1 high, 2 moderate), `qs@6.14.1`,
`path-to-regexp@8.3.0` (1 high), `ajv@8.17.1`, `body-parser@2.2.2`, and `fast-uri@3.1.0` (several
high host-confusion/SSRF issues). All arrive through `@modelcontextprotocol/sdk` and all of them are
HTTP-serving or URI-parsing code that a stdio-only server never invokes. They are not an active
exposure, but they are why the SDK upgrade matters: 1.30.0 pulls newer pins across this stack.

## Install-time behaviour

The lockfile does not record install scripts. The one package known to run code at install is
**`keytar`**, whose install invokes `prebuild-install` to **download a prebuilt native binary over
the network** (`prebuild-install` → `simple-get`, `tar-fs@2.1.4`, `tunnel-agent`, `rc`, `minimist`).
That is a second, unpinned-by-hash artifact entering the machine at install time.

`keytar` is also **archived upstream** (github.com/atom/node-keytar, archived, last commit
2022-12-12) and its latest release **7.9.0 was published 2022-02-17** — no maintenance for ~4 years.

`@biomejs/biome` resolves 8 platform-specific CLI binaries as optional dependencies; only the
matching one installs. Dev-only.

Verifying the full install-script set requires an actual install; do it with scripts disabled and
then inspect (`bun pm untrusted`, or `npm ls --parseable` + `npm rebuild --dry-run`). Tracked in
`nh5.13`.

## Recommendations

1. Upgrade `@modelcontextprotocol/sdk` to 1.30.0 — closes the one HIGH that is in our own runtime,
   and refreshes the vulnerable HTTP stack. (`nh5.16`)
2. Upgrade `csv-parse` 5.6.0 → 7.0.2 — it parses attacker-controlled input. Major bump; verify the
   `csv-parse/sync` import and the option names still hold. (`nh5.17`)
3. Resolve `keytar`: archived, unmaintained, and the sole source of install-time network fetch and
   37 packages. (`nh5.12`)
4. Install with scripts disabled by default and add the advisory query to CI. (`nh5.13`)

## Remediation status (2026-09-13)

`bun run audit` → **0 advisories across 0 packages.**

| Package | Was | Now | Why |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.25.3 | 1.30.0 | GHSA-345p-7cg4-v4c7 (HIGH), `nh5.16` |
| `csv-parse` | 5.6.0 | 7.0.2 | GHSA-8cw4-87c7-c6xx, `nh5.17` |
| `hono` | 4.11.7 | 4.13.7 | transitive, ~30 advisories |
| `@hono/node-server` | 1.19.9 | 2.1.1 | transitive, 1 HIGH |
| `path-to-regexp` | 8.3.0 | 8.4.2 | transitive, 1 HIGH |
| `fast-uri` | 3.1.0 | 3.1.7 | transitive, 7 HIGH (4.x available but outside ajv's range) |
| `qs` | 6.14.1 | 6.16.0 | transitive |
| `ajv` | 8.17.1 | 8.20.0 | transitive |
| `body-parser` | 2.2.2 | 2.3.0 | transitive, 1 LOW |

Package count went 137 → 133. `bun add` wrote **exact** pins for the two direct upgrades
(`"1.30.0"`, `"7.0.2"`) rather than caret ranges; that is the desired behaviour for this repo and
should stay that way — see `nh5.13`.

`csv-parse` 5 → 7 is a major bump but the call site is unchanged: the `csv-parse/sync` subpath still
exists in 7.x, and `relax_quotes` / `relax_column_count` / `skip_empty_lines` still behave the same.
Verified by diffing `parseProfiles` output over `test/fixtures/sheet-sample.csv` before and after the
upgrade — byte-identical. That comparison is now a standing test (`test/sheet-parse.test.ts`), run
with `bun test`; it stubs `fetch` and redirects `HOME` to a temp dir, so it makes no network call and
never touches the real `~/.aiden-ai-profile-generator` cache.

Re-run the audit any time with `bun run audit` (exits non-zero at HIGH or above).
