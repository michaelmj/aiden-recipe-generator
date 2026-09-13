# Threat Model — Aiden Recipe Generator MCP Server

Scope: the stdio MCP server in `src/`. Tracked by epic `aiden-recipe-generator-nh5`.

## Trust boundary in one sentence

The server is trusted; the coffee machine account is trusted; **everything that arrives over the
network is not**, and the community spreadsheet in particular is editable by strangers.

## Assets

| Asset | Where | Why it matters |
|---|---|---|
| Fellow session (access + refresh JWT, email) | OS keychain via keytar, else `~/.aiden-ai-profile-generator/session.json` (`src/fellow/session.ts`) | Full control of the user's Fellow account |
| The agent's context window | every tool response | Text placed here steers subsequent tool calls |
| The physical brewer | `aiden.createProfile` / `aiden.updateProfile` | Heats water; parameters come from the agent |
| Local brew history / settings | `~/.aiden-ai-profile-generator/*.json` (`src/storage/`) | Low value, but a persistence foothold |

## Sources — network input, ranked by who controls it

### S1. Community sheet CSV — attacker-controlled content (**highest risk**)

`DEFAULT_SHEET_CSV_URL` (`src/config.ts:19`) is a public Google Sheet. Anyone with edit access
writes arbitrary text into any cell. Fetched in `SheetProfileStore.sync` (`src/sheet/store.ts:100`).

### S2. Sheet **URL** — attacker-*influenceable* target

Three ways the target URL is chosen (`src/sheet/store.ts:85`):
1. `sheet.sync`'s `csvUrl` argument — supplied by the **model** (`src/tools/sheet.ts:31`, only
   `z.string().url()`), so any text the model has read can talk it into a new target.
2. `AIDEN_AI_SHEET_CSV_URL` env — operator-controlled, trusted.
3. The hardcoded default — trusted.

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

`FELLOW_API_BASE` (`src/config.ts:12`) is a **hardcoded constant with no env override** — verified:
the only `process.env` read in `src/` is the sheet URL. The model cannot retarget it, so this is
**allowed egress and stays allowed.** Any network hardening must be scoped to S2, never applied as a
blanket egress block. Response *bodies* are still foreign data; `toDevice` / `toProfile`
(`src/fellow/client.ts:56,73`) already coerce every field to a known type with fallbacks, which is
the right pattern. Residual exposure: `Drops` profile titles originate with Fellow, not the user.

### S4. Tool arguments from the model

Not a source of malice on their own, but they are the relay by which S1 text becomes action —
including id strings interpolated into request paths (`src/fellow/client.ts:217`).

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
| S1 unbounded fetch (timeout, size, content-type) | `nh5.4` |
| Startup availability | `nh5.5` |
| CSV parser limits | `nh5.6` |
| Cell validation and sanitization | `nh5.7` |
| Untrusted-data framing in tool output | `nh5.8` |
| Brewer parameter ranges | `nh5.9` |
| Error-body and credential leakage | `nh5.10` |
| API path segment injection | `nh5.15` |
| Dependency tree and install policy | `nh5.11`, `nh5.12`, `nh5.13` |
| Offline regression fixtures | `nh5.14` |
