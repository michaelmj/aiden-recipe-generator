# Aiden Recipe Generator (MCP)

An MCP server that talks to your Fellow Aiden coffee machine - built entirely with Cursor.

**Send a photo or name of your coffee beans** to Claude, Cursor, or any MCP-compatible tool, and it will:

- Search the internet for brewing recommendations for that specific coffee
- Search a bundled dataset of reviewed Aiden recipes for similar origins/roasts
- Check your previous brews and feedback to learn what worked
- Look up grind settings for your specific grinder model
- Generate and push a custom brew profile directly to your Aiden

No more manually tweaking every variable in the Fellow app - just show it your coffee and let it figure out the rest.

<img width="732" height="645" alt="ss-aiden" src="https://github.com/user-attachments/assets/3e304182-d40e-4570-ae2c-406f8a140f56" />

## Origin Story

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

## Setup

```bash
# Clone this repo
git clone https://github.com/bxxf/aiden-recipe-generator.git

# Install dependencies (lockfile is authoritative; no dependency runs install scripts)
bun install --frozen-lockfile --ignore-scripts

# Add to Claude Code
claude mcp add aiden bun run /path-to-this-repo/src/index.ts
```

Dependencies are treated as attack surface — see [CONTRIBUTING.md](CONTRIBUTING.md#install-policy)
for the install policy (no lifecycle scripts, exact pins, reviewed lockfile, advisory audit in CI)
and [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) for the current audit of the tree.

## Tools

| Tool | Description |
|------|-------------|
| `auth.login` | Login to Fellow and store the session locally (keychain when available) |
| `auth.status` | Check whether a Fellow session is stored |
| `auth.logout` | Clear the stored Fellow session |
| `aiden.listDevices` | List connected Aiden brewers |
| `aiden.getDevice` | Get details for one device |
| `aiden.listProfiles` | List brew profiles on a device |
| `aiden.createProfile` | Create a new brew profile |
| `aiden.updateProfile` | Update an existing Custom profile |
| `aiden.deleteProfile` | Delete an existing Custom profile |
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

The `sheet.*` names are historical: they read the bundled dataset first and only touch a live sheet
when one is configured. See [Recipe sources](#recipe-sources).

## Recipe sources

Three different things feed a recipe, and they are not trusted alike:

| Source | Default? | Who wrote it | How it is trusted |
|---|---|---|---|
| Bundled dataset — [`data/recipes.json`](data/recipes.json) | **yes** | the operator's own brews, plus a reviewed snapshot of a credited public sheet | ships with the code, no network call, every record names its `source`; still validated and sanitized on load |
| Live community sheet — `AIDEN_AI_SHEET_CSV_URL` | no, opt-in | anyone with edit access to that sheet | treated as attacker-controlled: host-allowlisted fetch, range-checked cells, labelled `untrusted-community-sheet` and quarantined on the way to the agent |
| Web search for the specific coffee | n/a | roasters, reviewers, whoever published the page | done by the agent per [CLAUDE.md](CLAUDE.md), outside this server — the server never fetches it |

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

MIT
