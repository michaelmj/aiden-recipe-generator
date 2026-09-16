# Aiden Recipe Generator (MCP)

An MCP server that talks to your Fellow Aiden coffee machine - built entirely with Cursor.

Fork of [bxxf/aiden-recipe-generator](https://github.com/bxxf/aiden-recipe-generator) by
[Filip Brebera](https://github.com/bxxf), who wrote the Fellow API client, the MCP server and the
original README. This fork adds the bundled recipe dataset, the threat model and the hardening
work on the sheet ingest path.

**Send a photo or name of your coffee beans** to Claude, Cursor, or any MCP-compatible tool, and it will:

- Search the internet for brewing recommendations for that specific coffee
- Search a bundled dataset of reviewed Aiden recipes for similar origins/roasts
- Check your previous brews and feedback to learn what worked
- Look up grind settings for your specific grinder model
- Generate and push a custom brew profile directly to your Aiden

No more manually tweaking every variable in the Fellow app - just show it your coffee and let it figure out the rest.

<img width="732" height="645" alt="ss-aiden" src="https://github.com/user-attachments/assets/3e304182-d40e-4570-ae2c-406f8a140f56" />

## Origin Story

By Filip Brebera, from the upstream README:

While at the Cafe Cursor event in Prague, I was thinking about what to build with Cursor. Until now I mostly used Claude Code, so I wanted a project from scratch where I could really test Cursor's capabilities.

Then I noticed something in the room that instantly made me happy: they had their own coffee bean bags there from [Terminal](https://terminal.shop).

I'm a bit of a coffee nerd, and I've wanted to try their coffee for a while, but it's basically impossible to get in Europe since they only ship to the US. Turns out they collaborated with Cursor, so I managed to grab a bag of "Cafe Cursor" beans at the event. Instant win.

Then the obvious question hit: **how do I brew this properly?**

There's a recipe on the back of the bag, sure - but if you're into coffee, you know the real fun is dialing in your own recipe. Temps, pours, bloom time, ratios… all the little details.

I use a Fellow Aiden coffee machine, which lets you build fully custom recipes via their mobile app. Super powerful, but it can get pretty time-consuming as you're basically hand-tuning every variable.

So I thought… **what if I let Cursor decide how to brew their coffee?**

What if I used Cursor to build an MCP that talks to my coffee machine (via Cursor) and figures out the best recipe for this "Cafe Cursor" coffee?

So I reverse-engineered the API requests the Fellow mobile app sends to the machine, wrapped it into this MCP server and now I can use Cursor (or Claude) to generate and push custom coffee recipes straight to my brewer.

**Full circle: Cafe Cursor coffee → Cursor → MCP (built by Cursor) → happiness**

## What It Does

- **Web research** - Searches for brewing recommendations for your specific coffee
- **Recipe lookup** - Searches the bundled recipe dataset for similar coffees (see [Recipe sources](#recipe-sources))
- **Grind settings** - Looks up recommended grind settings for your specific grinder
- **Profile creation** - Creates and pushes custom brew profiles to your Aiden
- **Memory** - Logs brews and feedback to learn from past attempts
- **User settings** - Remembers your grinder etc.

## Getting started

### 1. Prerequisites

- **[Bun](https://bun.sh) 1.4 or newer** (`bun --version`) — the server runs as TypeScript, there is
  no build step for normal use.
- **macOS or Linux.** The session is encrypted under a key in the OS keychain: macOS uses the
  built-in `security`, Linux uses `secret-tool` (`libsecret-tools`). Elsewhere, see
  [Storage and environment](#storage-and-environment) before logging in.
- **A Fellow account** with an Aiden already set up and on Wi-Fi in the Fellow mobile app. This
  server talks to Fellow's cloud API, not to the brewer directly.
- **An MCP client** — Claude Code, Claude Desktop, Cursor, or anything else that speaks MCP.

### 2. Install

```bash
git clone https://github.com/michaelmj/aiden-recipe-generator.git
cd aiden-recipe-generator

# The lockfile is authoritative and no dependency is allowed to run install scripts
bun install --frozen-lockfile --ignore-scripts
```

Dependencies are treated as attack surface — see [CONTRIBUTING.md](CONTRIBUTING.md#install-policy)
for the install policy (no lifecycle scripts, exact pins, reviewed lockfile, advisory audit in CI)
and [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) for the current audit of the tree.

### 3. Log in to Fellow

Do this in your own terminal, before wiring up any MCP client:

```bash
bun run auth:login
```

It prompts for your Fellow email and password. The password is read from the TTY with echo
disabled, sent only in the Fellow HTTPS request body, and never written to argv, output, or disk —
only the resulting session is stored. Your MCP client and the model never see it. Log in once; the
session is reused until you run `auth.logout`.

The session keeps itself alive: the access token is refreshed before it expires and again if Fellow
rejects it early, refreshes are single-flight so parallel tool calls cannot spend a rotating refresh
token twice, and a refresh that fails on a network error is retried instead of being reported as an
expired session.

That lasts as long as Fellow's refresh token does. To stay signed in past that without a prompt:

```bash
bun run auth:login --remember   # also store the password, encrypted, for automatic re-login
bun run auth:login --forget     # discard a remembered password, keep the session
```

`--remember` writes your Fellow password into the AES-256-GCM session file so the server can sign in
again by itself when the refresh token dies. That is a long-lived credential at rest rather than a
revocable one: anyone who gets both the file and your keychain data key gets the password, not just a
session. It is refused outright when there is no OS keychain to encrypt it under, and it is never
sent to the MCP host or the model. `auth.status` reports whether it is armed (`autoReconnect`).

### 4. Connect your MCP client

**Claude Code** — the `--` matters, everything after it is the command to run:

```bash
claude mcp add aiden -- bun run /absolute/path/to/aiden-recipe-generator/src/index.ts
```

Add `-s user` to make it available in every project instead of just the current one. Restart
Claude Code, then `claude mcp list` should show `aiden` connected.

**Claude Desktop, Cursor, or any client with a JSON config** — add a stdio server. Claude Desktop
reads `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and Cursor reads
`~/.cursor/mcp.json` or `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "aiden": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/aiden-recipe-generator/src/index.ts"]
    }
  }
}
```

Use an absolute path to `bun` (`which bun`, often `/opt/homebrew/bin/bun`) if the client starts
with a minimal `PATH` and reports that the command was not found. Environment overrides from
[Storage and environment](#storage-and-environment) go in an `"env": { ... }` object here, or after
`-e` on the `claude mcp add` line.

### 5. Verify it works

Ask your client something that needs the server, for example *"list my Aiden devices"*, and it
should call `aiden.listDevices` and name your brewer. To check the server itself without a client,
speak MCP to it directly:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"auth.status","arguments":{}}}' \
  | bun run src/index.ts
```

It prints `aiden-ai-profile-generator running (stdio)` plus the bundled recipe count on stderr, and
a JSON response with `"loggedIn": true` once step 3 succeeded. The process stays attached to stdio —
press Ctrl-C to exit.

### 6. First brew

Show your client a photo of a coffee bag, or just name the coffee, and ask it to build a recipe.
It follows the workflow in [AGENTS.md](AGENTS.md): research first, then a profile. Profile writes
are not silent — a recipe is proposed, previewed against a specific device, and only written after
you approve that exact preview (see [docs/RECIPE-PROPOSALS.md](docs/RECIPE-PROPOSALS.md)). Then
press the button on the machine: the Fellow API has no remote start (see [Limitations](#limitations)).

After tasting, tell it what you thought — feedback is logged and used to rank future recipes.

### Storage and environment

Everything local lives in `~/.aiden-ai-profile-generator`: the encrypted session
(`session.enc.json`), brew log, user settings, cached sheet profiles, and pending proposal
approvals. Details in [docs/LOCAL-STORAGE.md](docs/LOCAL-STORAGE.md).

| Variable | Effect |
|---|---|
| `AIDEN_AI_DATA_DIR` | Move that directory somewhere else |
| `AIDEN_AI_LOGIN_TIMEZONE` | Send an explicit IANA zone at login instead of the host's |
| `AIDEN_AI_SHEET_CSV_URL` | Opt into a live community sheet (see [Recipe sources](#recipe-sources)) |
| `AIDEN_AI_SHEET_ALLOWED_HOSTS` | Allow sheet hosts other than `docs.google.com` |
| `AIDEN_AI_DISABLE_KEYCHAIN=1` | Skip the OS keychain |
| `AIDEN_AI_ALLOW_PLAINTEXT_SESSION=1` | Permit a `0600` plaintext session file when no keychain is available — tokens on disk in the clear, so it warns on every write |
| `AIDEN_AI_ENABLE_INSECURE_MCP_LOGIN=1` | Expose the legacy `auth.login` tool; see [Tools](#tools) |

Without a keychain backend, login fails rather than quietly writing credentials in plaintext. That
is deliberate: install `secret-tool` on Linux if you can, and reach for
`AIDEN_AI_ALLOW_PLAINTEXT_SESSION` only when you understand that your Fellow access and refresh
tokens end up readable in a file.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Client shows the server as failed or disconnected | `bun` not on the client's `PATH`, or a relative path in the config — use absolute paths for both |
| `auth.status` reports `loggedIn: false` | `bun run auth:login` has not run, or it ran with a different `AIDEN_AI_DATA_DIR` than the server sees |
| `A local interactive TTY is required` | `auth:login` was piped or run inside an agent session; run it in a real terminal |
| `The Fellow session expired and could not be refreshed` | Fellow rejected the refresh token itself (password change, revoked session, or a very old session); log in again, with `--remember` to avoid repeats |
| `Could not reach Fellow to refresh the session` | Network or Fellow outage, not a credential problem — the stored session is intact, so retry |
| `Login failed (401)` | Wrong email or password — the same credentials as the Fellow mobile app |
| `Could not determine the local IANA timezone` | Set `AIDEN_AI_LOGIN_TIMEZONE`, e.g. `America/Detroit` |
| No devices listed after a successful login | The Aiden is not registered to that Fellow account, or is offline in the mobile app |
| `Failed to load community sheet` on startup | Only possible when `AIDEN_AI_SHEET_CSV_URL` is set; it is a warning, the bundled dataset still loads |

Run `bun test` and `bun run typecheck` to confirm a clean checkout before reporting a bug.


## Tools

| Tool | Description |
|------|-------------|
| `auth.status` | Check whether a Fellow session is stored |
| `auth.logout` | Clear the stored Fellow session |
| `aiden.listDevices` | List connected Aiden brewers |
| `aiden.getDevice` | Get details for one device |
| `aiden.listProfiles` | List brew profiles on a device |
| `aiden.createProfile` | Create a new brew profile |
| `aiden.updateProfile` | Update an existing Custom profile |
| `aiden.deleteProfile` | Delete an existing Custom profile |
| `recipe.validateProposal` | Validate local proposal JSON and compute its content hash |
| `recipe.previewProposal` | Preview exact device and profile changes before a write |
| `recipe.applyProposal` | Apply one reviewed, hash-bound proposal |
| `recipe.cancelProposalReview` | Cancel a pending local proposal review |
| `sheet.search` | Search recipes by origin/roast/processing (bundled dataset, plus the opt-in sheet) |
| `sheet.list` | List every known recipe from both sources |
| `sheet.sync` | Refresh the cached community sheet — a no-op unless an operator opted in |
| `storage.logBrew` | Log a brew attempt |
| `storage.addFeedback` | Add taste feedback to a logged brew (rating, notes) |
| `storage.getHistory` | Get recent brew history with feedback |
| `storage.search` | Search brew history by coffee name, roaster, or origin |
| `storage.findSimilar` | Find past brews with similar coffee characteristics |
| `user.getSettings` | Get saved preferences (grinder, default device) |
| `user.updateSettings` | Save preferences (grinder, device, etc.) |

`auth.login` is disabled by default because its password argument is visible to the MCP host and may
enter model transcripts, telemetry, screenshots, or exports. The supported login path is the local
`bun run auth:login` command above: it requires a TTY, reads the password with echo disabled, passes
it to Fellow only in the HTTPS request body, and stores only the resulting session. The shell argv
and command output contain no password. For legacy compatibility only, an operator can expose the
unsafe tool by starting the server with `AIDEN_AI_ENABLE_INSECURE_MCP_LOGIN=1`.

Fellow's login request carries an IANA timezone. Both login paths send the timezone of the machine
they run on (`Intl.DateTimeFormat().resolvedOptions().timeZone`) — there is no fixed regional
default. Override it with `AIDEN_AI_LOGIN_TIMEZONE=America/Detroit` for `bun run auth:login`, or with
the `timezone` argument of `auth.login`. A value that is not an IANA zone name is rejected, and if
the host cannot report its own zone the login fails asking for an explicit one rather than guessing a
region.

The `sheet.*` names are historical: they read the bundled dataset first and only touch a live sheet
when one is configured. See [Recipe sources](#recipe-sources).

## Recipe sources

Three different things feed a recipe, and they are not trusted alike:

| Source | Default? | Who wrote it | How it is trusted |
|---|---|---|---|
| Bundled dataset — [`data/recipes.json`](data/recipes.json) | **yes** | the operator's own brews, plus a reviewed snapshot of a credited public sheet | ships with the code, no network call, every record names its `source`; still validated and sanitized on load |
| Live community sheet — `AIDEN_AI_SHEET_CSV_URL` | no, opt-in | anyone with edit access to that sheet | treated as attacker-controlled: host-allowlisted fetch, range-checked cells, labelled `untrusted-community-sheet` and quarantined on the way to the agent |
| Web search for the specific coffee | n/a | roasters, reviewers, whoever published the page | done by the agent per [AGENTS.md](AGENTS.md), outside this server — the server never fetches it |

Set no env var and the server makes no recipe request at all: the dataset is read from disk and that
is the whole source list. Records from either source carry a `trust` field in the tool response, so
a reviewed bundled recipe is never confused with a line a stranger typed into a public sheet five
minutes ago. Details in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

### The bundled dataset

Part of it is a reviewed snapshot of the public [Fellow Aiden community recipe sheet][sheet] — thanks
to everyone who fills it in. Each of those records is credited in `source`, and the snapshot it came
from (date and digest) is recorded in the file.

Refreshing that snapshot is deliberate, never automatic:

```bash
bun run snapshot:sheet          # writes candidates to data/community-snapshot.json (git-ignored)
```

Then read the candidates, fix what the sanitizer could not (the sheet writes ratios as `1:16` and
temperatures in Fahrenheit), and copy the keepers into `data/recipes.json` as a commit someone
reviewed. See [data/README.md](data/README.md) for the format and the review checklist.

### Opting into the live sheet

```bash
AIDEN_AI_SHEET_CSV_URL="https://docs.google.com/.../pub?output=csv"   # opt in
AIDEN_AI_SHEET_ALLOWED_HOSTS="sheets.example.com"                     # only if the host is not docs.google.com
```

Point it at a sheet only you can write and it is as trustworthy as you are; point it at the public
community sheet and you are reading text strangers can edit. Either way it stays labelled untrusted,
because the server cannot tell the two apart.

[sheet]: https://docs.google.com/spreadsheets/d/1mi-YS6JYfbX3wN1kZd6iu_q6mFlWM4Ah6N3Ox8eqRCA

## How It Works

When you ask to brew a coffee:

1. Checks your saved settings (grinder, default device)
2. Searches the bundled recipe dataset for similar coffees
3. Checks your brew history for past attempts
4. Searches the web for this specific coffee's recommendations
5. Looks up grind settings for your grinder
6. Creates a profile based on all the research
7. Logs the brew for future learning

After you taste it, give feedback and it remembers what worked.

## Limitations

**Can't start brewing remotely** - The Fellow API doesn't expose an endpoint to actually start a brew. The mobile app has the same limitation - you can create and manage profiles, but you have to physically press the button on the machine to start. This is probably intentional (safety, ensuring water/basket are in place, etc.).

Potential workaround: Fellow does support scheduled brews. If the API exposes schedule management, you could theoretically schedule a brew for "1 minute from now". Haven't explored this yet.

## License

MIT — see [LICENSE](LICENSE). Upstream declared MIT in `package.json` but shipped no license
file; this fork adds the text, keeping Filip Brebera's copyright.
