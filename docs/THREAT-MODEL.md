# Threat Model — Aiden Recipe Generator MCP Server

Scope: the stdio MCP server in `src/`. Tracked by epic `aiden-recipe-generator-nh5`.

## Trust boundary in one sentence

The server is trusted; the coffee machine account is trusted; **everything that arrives over the
network is not**, and the community spreadsheet in particular is editable by strangers — which is why
it is no longer the default recipe source.

## Assets

| Asset | Where | Why it matters |
|---|---|---|
| Fellow session (access + refresh JWT, email) | AES-256-GCM in `~/.aiden-ai-profile-generator/session.enc.json`, key in the OS keychain; without a keychain helper the write is **refused** unless `AIDEN_AI_ALLOW_PLAINTEXT_SESSION` is set, which downgrades it to plaintext `session.json` mode 0600 and warns on every write (`src/fellow/session.ts`, `src/fellow/keychain.ts`) | Full control of the user's Fellow account |
| The agent's context window | every tool response | Text placed here steers subsequent tool calls |
| The physical brewer | `aiden.createProfile` / `aiden.updateProfile` | Heats water; parameters come from the agent |
| Local brew history / settings | `~/.aiden-ai-profile-generator/*.json` (`src/storage/`) | Low value, but a persistence foothold |

## Recipe sources and what each is worth

Three things can supply a recipe, and the default is now the one nobody else can write:

| Source | Default? | Reaches the server how | Trust |
|---|---|---|---|
| Bundled dataset (`data/recipes.json`, `src/recipes/dataset.ts`) | **yes** | read from disk, no network | Highest available. First-party records were brewed by the operator; `community-sheet` records came through a reviewed, hash-recorded snapshot. Still validated and sanitized on load — a bad edit to our own file is in scope. Labelled `bundled-dataset`. |
| Live community sheet (`AIDEN_AI_SHEET_CSV_URL`) | no — operator opt-in | HTTPS fetch, host-allowlisted, bounded, cached | None. This is S1 below. Labelled `untrusted-community-sheet` and quarantined in tool output. |
| Web search for a specific coffee | n/a | the agent searches per `CLAUDE.md` | Outside this threat model: the server never issues the request and never parses the result. The agent's own handling of fetched pages is the host's problem, not this server's. |

The first two are the only recipe text this server produces, and a reader can always tell them apart:
every record carries a `trust` field (`src/tools/untrusted.ts`), and a response containing one live
sheet record is quarantined whole.

## Sources — network input, ranked by who controls it

### S1. Community sheet CSV — attacker-controlled content (**highest risk**)

A public Google Sheet, where anyone with edit access writes arbitrary text into any cell. Fetched
in `SheetProfileStore.sync`.

**Demoted to opt-in (`8z3.4`, implemented):** there is no longer a default sheet URL. The bundled
dataset (`data/recipes.json`, loaded by `src/recipes/dataset.ts`) is the default source, and a
server with no `AIDEN_AI_SHEET_CSV_URL` makes no sheet request at all — an operator who sets it
opts back into this source knowingly, and every record it yields is still labelled
`untrusted-community-sheet` and still quarantined on the way to the agent.

### S2. Sheet **URL** — attacker-*influenceable* target

Ways the target URL is chosen:
1. ~~`sheet.sync`'s `csvUrl` argument~~ — **removed** (`nh5.3`). The tool now takes no input; the
   fetch target is never chosen per call, so no text the model has read can steer it. The response
   still reports which URL was fetched.
2. `AIDEN_AI_SHEET_CSV_URL` env — operator-controlled, trusted, and now the only way a fetch
   happens at all.
3. ~~The hardcoded default~~ — **removed** (`8z3.4`).

**Control (`nh5.2`, implemented):** every sheet URL passes `assertAllowedSheetUrl`
(`src/sheet/url.ts`) before a request is made — https only, no credentials in the URL, hostname
must match `getSheetHostAllowlist()` (default `docs.google.com`, extended only by the operator via
`AIDEN_AI_SHEET_ALLOWED_HOSTS`). Redirects are followed manually, at most
`SHEET_MAX_REDIRECTS` hops, and **each hop is re-checked** — otherwise a 302 from an allowed host
would land anywhere.

Path 1 is the SSRF: the fetched body is parsed, cached to disk, and echoed back through
`sheet.list`, which makes it both a request primitive and a read primitive against the loopback
interface, the LAN, and cloud metadata endpoints.

### S3. Fellow API responses — third-party, mostly trusted

`FELLOW_API_BASE` (`src/config.ts`) is a **hardcoded constant with no env override**. The env vars
`src/` reads are the sheet URL and host allowlist, the data directory (`AIDEN_AI_DATA_DIR`), and the
two credential-storage switches (`AIDEN_AI_DISABLE_KEYCHAIN`, `AIDEN_AI_ALLOW_PLAINTEXT_SESSION`) —
none of them retarget the API base, and none are settable by the model. So this is **allowed egress
and stays allowed.** Any network hardening must be scoped to S2, never applied as a blanket egress
block. Response *bodies* are still foreign data; `toDevice` / `toProfile` (`src/fellow/client.ts`)
already coerce every field to a known type with fallbacks, which is the right pattern. Error bodies
are never quoted into a thrown message: a Fellow error can echo the bearer token or the submitted
password, and every thrown message reaches the agent's context, so only the status code and a fixed
hint travel (`upstreamError`).

`Drops` profile titles originate with Fellow, not the user, so the read path is bounded the same way
the write path is: `toProfile` neutralizes the title through `sanitizeText` (`src/text.ts`), caps it,
range-checks every number against `AIDEN_LIMITS`, truncates pulse-temperature lists to one entry per
possible pulse, and lists whatever it would not vouch for in an `anomalies` array on the profile.
Out-of-range numbers are reported as the device sent them — clamping would describe a profile that
does not exist — but the anomaly note tells the model not to read them as brewing advice. An unrecognized
`folder` becomes `Unknown` rather than falling back to `Custom`, which is the one label that makes
`updateProfile` and `deleteProfile` willing to write.

### S4. Tool arguments from the model

Not a source of malice on their own, but they are the relay by which S1 text becomes action —
including id strings interpolated into request paths (`src/fellow/client.ts:217`).

The write schemas are strict objects, so a profile payload may carry only fields this server means
to send. Two fields are deliberately not writable: `duration`, which the reference client lists in
`SERVER_SIDE_PROFILE_FIELDS` and strips before POST and PATCH (Fellow computes it), and
`profileType`, which is pinned to 0 — the only value any reference usage sends, with nothing
documenting what another would mean. Both were previously bounded by guesses (`profileType` 0–10,
`duration` 0–3600) rather than by anything observed.

## Sinks — where untrusted data lands

| Sink | Path | Exposure |
|---|---|---|
| Agent context | `sheet.list` / `sheet.search` → `toolResponse` (`src/tools/sheet.ts`, `src/tools/response.ts`) | Indirect prompt injection: a cell reading "ignore previous instructions…" is byte-identical to legitimate tool output |
| Disk cache | `~/.aiden-ai-profile-generator/sheetProfiles.json` (`src/sheet/store.ts:107`) | Poisoned rows persist for the 6 h TTL and across restarts |
| The brewer | `aiden.createProfile` / `updateProfile` → `src/schemas.ts` | Schema accepts any positive `bloomTemperature` and unbounded pulse arrays |
| Fellow API path | `new URL(FELLOW_API_BASE + path)` (`src/fellow/client.ts:217`) | `deviceId` / `profileId` interpolated raw; `..`, `?`, `#` reshape the authenticated request |
| stderr / error strings | `text.slice(0, 500)` and `slice(0, 1000)` (`src/fellow/client.ts:118,241`) | Upstream body returned into agent context |
| Process availability | `await ensureCached()` before `server.connect()` (`src/index.ts:35`) | A stalling sheet host prevents the server from starting |

## The two attacks worth defending

**A1 — Indirect prompt injection via sheet cell.** Attacker edits the public sheet. The agent runs
`sheet.search`, reads the cell as if it were instruction, and calls a write tool. Defense is layered,
because no single layer holds: sanitize and range-check values (`.7`), quarantine the text with
explicit untrusted-data framing (`.8`), and make the dangerous sink refuse bad values regardless of
what the agent believes (`.9`).

**A2 — Attacker-chosen parameters reaching hardware.** Whether via A1 or model error, the numbers
that reach `aiden.createProfile` are currently bounded only by `z.number().positive()`. Validation at
the sink (`.9`) is the control that does not depend on the agent behaving.

## Non-goals

- Blocking egress to the Fellow API (S3) — required for the product to work.
- Defending against a hostile local operator, or against Fellow itself.
- Verifying JWT signatures; `decodeJwtExpMs` (`src/fellow/session.ts`) reads `exp` for scheduling
  only and is documented as unverified.

## Coverage map

| Source / sink | Issue |
|---|---|
| S2 SSRF, off-host redirect | `nh5.2` (scoped to `SheetProfileStore.sync`; Fellow API stays allowed) |
| S2 model-settable `csvUrl` | `nh5.3` |
| S1 replaced as the default recipe source | `8z3` (`8z3.1` dataset, `8z3.2` snapshot, `8z3.4` default switch) |
| S1 unbounded fetch (timeout, size, content-type) | `nh5.4` |
| Startup availability | `nh5.5` |
| CSV parser limits | `nh5.6` |
| Cell validation and sanitization | `nh5.7` |
| Untrusted-data framing in tool output | `nh5.8` |
| Brewer parameter ranges (write path) | `nh5.9` |
| Device response bounds and title neutralization (read path) | `6ic` |
| Unverified write bounds (`profileType`, `duration`) | `iaf` |
| Error-body and credential leakage | `nh5.10` |
| API path segment injection | `nh5.15` |
| Dependency tree and install policy | `nh5.11`, `nh5.12`, `nh5.13` |
| Offline regression fixtures | `nh5.14` |
