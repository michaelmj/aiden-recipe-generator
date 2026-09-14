# Contributing

## Install policy

This server parses text it did not write (the opt-in community sheet, and the bundled dataset when
someone refreshes it from that sheet) and holds Fellow session credentials, so the dependency tree is
treated as part of the attack surface. Three rules:

### 1. Install with scripts disabled

```bash
bun install --frozen-lockfile --ignore-scripts
```

Use this everywhere — local machines and CI. `bun.lock` pins every package by `sha512-` integrity
hash; an install script does not go through that check, it is arbitrary code with your shell's
privileges, and it can fetch a second artifact over the network that the lockfile never saw.

**`bun pm untrusted` is not sufficient on its own.** Bun ships a built-in default-trusted
allowlist, and a package on that list runs its install script with no prompt and no report. This was
measured on bun 1.4.2: a plain `bun install` ran `keytar`'s install script — which downloads a
prebuilt native binary via `prebuild-install` — while `bun pm untrusted` reported 0 untrusted
packages. Opt out explicitly instead of relying on bun's gating.

`node scripts/check-install-scripts.mjs` (`bun run deps:scripts`) enforces this: it walks
`node_modules/` and fails if any package in `bun.lock` declares `preinstall`, `install`, or
`postinstall`. `prepare` is ignored — it runs for the root package and git dependencies, never for a
registry install. Packages on disk but absent from the lockfile are reported as stale; clear them
with `rm -rf node_modules && bun install --frozen-lockfile --ignore-scripts`.

As of the `keytar` removal (see `docs/DEPENDENCIES.md`), **no package in the lockfile runs code at
install time**, and `optionalDependencies` is empty. Keeping it that way is the policy.

#### Exception process

A package that genuinely needs a lifecycle script is added only if all of these hold:

1. No script-free alternative exists, and the platform CLI cannot do the job (`keytar` was replaced
   by shelling out to `security(1)` / `secret-tool(1)`, which is the pattern to prefer).
2. The script is read and summarized in the PR: what it executes, and whether it touches the network
   or compiles native code.
3. The package is added to bun's `trustedDependencies` in `package.json` **and** to an explicit
   allowlist in `scripts/check-install-scripts.mjs`, so both the install and the check state the
   exception out loud.
4. The rationale is recorded in `docs/DEPENDENCIES.md` under the package's name.

An exception is a reviewed decision, never a side effect of running `bun add`.

### 2. `bun.lock` is authoritative and reviewed

- Pin direct dependencies to **exact** versions — no `^`, no `~`. `bun add` already writes exact
  pins for this repo; keep them.
- Every change to `bun.lock` gets read in review, not skimmed. State in the PR which packages moved,
  by how much, and why. A lockfile diff that arrives with no manifest change is a red flag.
- Never regenerate the lockfile to resolve a conflict. Rebase, then re-run the single `bun add` or
  `bun update` that caused the change.
- CI installs with `--frozen-lockfile` and then asserts `git diff --exit-code -- bun.lock
  package.json`, so a lockfile that does not match the manifest fails the build.

### 3. Advisories fail the build

`bun run audit` queries the npm advisory database for the exact versions in `bun.lock` and exits
non-zero at HIGH or above. CI runs it on every push and PR, plus daily on a schedule so a newly
published advisory turns the build red without anyone touching the code.

Run the whole policy locally in one shot:

```bash
bun run deps:verify   # frozen + no-scripts install, script check, advisory audit
```

Findings below HIGH still get triaged — they are logged in `docs/DEPENDENCIES.md` with a note on
whether the vulnerable code path is reachable from `src/`.

## Recipe sources

A change that adds recipe data has to say which of the three sources it is coming from, because they
carry different trust:

| Source | Where it lives | What a PR must show |
|---|---|---|
| Bundled dataset (**default**) | `data/recipes.json`, loaded by `src/recipes/dataset.ts` | every record has a `source.kind`; anything not `first-party` carries `credit` and, where there is one, `url` |
| Live community sheet (opt-in) | fetched only when the operator sets `AIDEN_AI_SHEET_CSV_URL` | no default URL is reintroduced, and records stay labelled `untrusted-community-sheet` |
| Web search for a specific coffee | done by the agent per `CLAUDE.md`, outside this server | nothing — the server does not fetch it |

Rules for the dataset:

- **`first-party` means someone brewed it.** Not "a recipe that looks right" — tasted and rated. It
  is the only kind with no stranger in its history, so it is the only kind that may be added without
  a credit.
- **`community-sheet` records arrive through a snapshot, never by hand.** Run `bun run
  snapshot:sheet`, read the candidates, and copy keepers into `data/recipes.json` in a commit a human
  reviewed. Update the `snapshots` entry (`takenAt`, `sha256`) in the same commit, so a later refresh
  can diff against something.
- **Loading is not trusting.** `src/recipes/dataset.ts` validates and sanitizes every record with the
  same rules the sheet cells go through, and drops what fails. Do not add a bypass for "our own"
  file — a bad edit to `data/recipes.json` is exactly the case those checks exist for.
- **Do not restore a default sheet URL.** The world-writable sheet stopped being the default in
  `aiden-recipe-generator-8z3.4`; a fetch happens only because an operator asked for it.

Trust levels and the attacks behind them: [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md); dataset
format and review checklist: [data/README.md](data/README.md).

## Quality gates

```bash
bun run typecheck   # build config, then tsconfig.test.json for test/
bun test
bun run check       # biome lint + format, over src/ and test/
```

CI runs all three. `typecheck` covers `test/` through `tsconfig.test.json`, which extends the build
config and only adds `test/` and the bun globals — `tsconfig.json` stays src-only so `dist/` output
is unchanged.
