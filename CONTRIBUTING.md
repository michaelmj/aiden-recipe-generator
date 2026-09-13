# Contributing

## Install policy

This server parses attacker-controlled text (the community sheet) and holds Fellow session
credentials, so the dependency tree is treated as part of the attack surface. Three rules:

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

## Quality gates

```bash
bun run typecheck
bun test
bun run check        # biome lint + format
```

CI runs typecheck and tests. `bun run check` is not in CI yet: `src/` has pre-existing format drift
tracked in `aiden-recipe-generator-74p`; add the step to `.github/workflows/ci.yml` when that lands.
