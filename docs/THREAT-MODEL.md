# Threat Model — Aiden Recipe Generator MCP Server

Scope: the MCP server in `src/`, served only over loopback Streamable HTTP (`src/http.ts`, since
epic `aiden-recipe-generator-m6i`; the stdio entry was removed). Tracked by epic `aiden-recipe-generator-nh5`; the HTTP surface by `m6i`.

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
| HTTP bearer token | `~/.aiden-ai-profile-generator/http-token`, mode 0600, regenerated on every start (`src/httpAuth.ts`) | Anyone holding it can call every tool, including profile writes, until the server restarts |
| Local brew history / settings | `~/.aiden-ai-profile-generator/*.json` (`src/storage/`) | Low value, but a persistence foothold |

Local-store runtime validation, size limits, text neutralization, serialized atomic writes,
quarantine behavior, and file permissions are specified in [LOCAL-STORAGE.md](LOCAL-STORAGE.md).

## Credential entry boundary

The default MCP surface never accepts a Fellow password. Authentication is bootstrapped out of band
with `bun run auth:login` in the operator's local TTY; terminal echo is disabled while the password
is read, and the secret is sent only in the Fellow HTTPS request body. It is never placed in argv or
printed. The terminal process and Fellow receive the password; the MCP host, model provider, tool
transcript, and MCP telemetry do not.

The legacy `auth.login` MCP tool is absent unless the operator explicitly starts the server with
`AIDEN_AI_ENABLE_INSECURE_MCP_LOGIN=1`. That compatibility mode exposes the password to the MCP host
and potentially transcripts, telemetry, screenshots, and exports; the flag is a warning and opt-in,
not a security boundary after the tool is enabled. `auth.status`, refresh, and `auth.logout` continue
to use the locally stored session without handling the password.

Two paths let the server sign in with nobody present, and they place the password in very different
hands.

`AIDEN_AI_FELLOW_PASSWORD` takes the password from the process environment, where a secret manager
put it for this run — typically `op run --env-file`, which resolves `op://` references, exports them
for the child only, and drops them on exit. Nothing long-lived is written by us: the login stores
tokens and `remember` is forced off, so a pre-existing remembered password is cleared by the next
sign-in rather than kept beside it. The credential's lifetime and revocation belong to the vault,
not to this machine. The variable may also hold the `op://` reference *unresolved*, in which case it
is resolved through `op read` at the moment a re-login needs it: the reference is a pointer and goes
in argv, the resolved value never does, and the secret is absent from the environment — where any
child process inherits it, and `/proc/<pid>/environ` exposes it to the same uid — for all the time
it is not in use. The cost of that path is a dependency on `op` being present and non-interactive;
`op`'s own stderr is never quoted into a thrown message, because it can name the account and item.
Credentials Fellow rejects with a 4xx are latched off for the life of the process: unlike a
remembered password this server cannot delete them, and retrying operator configuration on every
tool call is how an account gets locked out. The environment is preferred over the stored password
whenever both exist, and `auth.status` distinguishes them (`autoReconnectSource`).

`bun run auth:login --remember` is the other path, and the one that keeps the password at rest. It is stored inside
the AES-256-GCM session file only — `SessionStore.write` drops it, with a warning, whenever there is
no keychain data key to encrypt it under, so it never reaches the plaintext fallback file. It raises
the value of the session file from "a session that can be revoked" to "the account password", which
is why it is opt-in, reported by `auth.status` as `autoReconnect`, and removable with
`auth:login --forget` or `auth.logout`. The client replays it at most once per dead refresh token,
and deletes it as soon as Fellow rejects it, so a stale password cannot be replayed into a lockout.
The remembered password is never returned by a tool, logged, or quoted in an error.

The login body also carries an IANA timezone, which tells Fellow where the account is being used
from. It is taken from the host running the login (`AIDEN_AI_LOGIN_TIMEZONE` or the `timezone`
argument override it) and validated as a zone name. There is no fixed regional default: an
unresolvable host zone fails the login rather than reporting an unrelated region to Fellow.

## Loopback HTTP surface

The default launch is a long-lived process started by the operator (`bun run serve`, which wraps
`src/http.ts` in `op run`) that MCP clients connect to at `http://127.0.0.1:<port>/mcp`. That
splits secret handling from the client: 1Password is consulted once, in a terminal the operator
chose, and the MCP host never holds or launches anything with Fellow credentials. The price is a
listening socket, which the removed stdio entry never had. Anything on the machine can open a TCP connection to it,
and so can a web page, by rebinding its own hostname to 127.0.0.1.

Controls, all in `src/httpServer.ts` and `src/httpAuth.ts`, applied to every request on every
path before any MCP handling:

| Threat | Control |
|---|---|
| LAN or remote clients | Listener binds `127.0.0.1` only; `MCP_HTTP_HOST` is a constant with no env override |
| DNS rebinding from a browser page | `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>`, and any `Origin` must be the same loopback origin, else 403. Checked before the token, so a rebinding page gets 403 with or without a guess |
| Other local processes and users | `Authorization: Bearer <token>`, 256 random bits per start, compared in constant time (via SHA-256 digests, so length does not leak), else 401. The token file is 0600 in a 0700 directory, written to a temp file and renamed so it is never briefly readable or half-written, and only written after the port binds, so a failed second start cannot overwrite a running server's token |
| Token in client config | Never stored there. Claude Code's `.mcp.json` names a `headersHelper` (`scripts/mcp-headers.sh`) that reads the token file at connect time and refuses to emit anything that is not a base64url token |
| Token in logs | Only the token file's path is logged; request logs carry the path, never headers |
| Oversized or malformed requests | Bodies over 1 MB get 413 before parsing; non-JSON gets 400; unknown session ids get 404 |
| Cross-session interference | Sessions are independent MCP servers over one shared `Services` object. Token refresh and cold-start login are single-flight, local stores are serialized and atomically replaced, and the sheet cache now is too (`m6i.5`). Proposal approvals are shared state on purpose: a proposal previewed in one session can be applied from another, still bound to its content hash |

What it does not cover: a process running as the same user can read the token file, exactly as
it can read the session file and the keychain-backed key — that is the hostile local operator
non-goal below, not a new hole. Locks are per process, so two servers started against one data dir can still race a token
refresh; the port bind makes a second server on the same port fail, so run one. Sessions
are not yet reaped when a client vanishes without `DELETE` (`m6i.8`), which costs memory, not
access.

## Recipe sources and what each is worth

Three things can supply a recipe, and the default is now the one nobody else can write:

| Source | Default? | Reaches the server how | Trust |
|---|---|---|---|
| Bundled dataset (`data/recipes.json`, `src/recipes/dataset.ts`) | **yes** | read from disk, no network | Highest available. First-party records were brewed by the operator; `community-sheet` records came through a reviewed, hash-recorded snapshot. Still validated and sanitized on load — a bad edit to our own file is in scope. Labelled `bundled-dataset`. |
| Live community sheet (`AIDEN_AI_SHEET_CSV_URL`) | no — operator opt-in | HTTPS fetch, host-allowlisted, bounded, cached | None. This is S1 below. Labelled `untrusted-community-sheet` and quarantined in tool output. |
| Web search for a specific coffee | n/a | the agent searches per `AGENTS.md` | Outside this threat model: the server never issues the request and never parses the result. The agent's own handling of fetched pages is the host's problem, not this server's. |

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
| Local HTTP listener | `127.0.0.1:<port>/mcp` (`src/httpServer.ts`) | Every tool, reachable by any local process or rebinding page that gets past Host/Origin and the bearer token |
| Process availability | `warmUp()` after `server.connect()` (`src/server.ts`) | Mitigated: the sheet warm-up is never awaited, so a stalling sheet host can no longer block startup |

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
- Defending against a hostile local operator, or against Fellow itself. That includes other
  processes running as the operator's uid: they can read the HTTP token, the session file and
  the keychain alike.
- Claude Desktop over HTTP. It does not connect to a local plain-HTTP server directly; bridging
  it with `mcp-remote` or similar is possible but untested here and out of scope.
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
| Loopback-only HTTP transport | `m6i.1` |
| HTTP bearer token, Host/Origin (DNS rebinding) | `m6i.2` |
| Concurrent-session state (refresh, stores, sheet cache) | `m6i.5` |
| HTTP contract and rejection tests | `m6i.6` |
| Idle HTTP session reaping | `m6i.8` |
