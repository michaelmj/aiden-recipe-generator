#!/usr/bin/env bash
# Start the aiden MCP server over loopback HTTP with the Fellow credentials supplied by 1Password.
#
# Run this in a terminal that the 1Password CLI can use, before launching Claude. Claude then
# connects to http://127.0.0.1:<port>/mcp (see .mcp.json) and never needs 1Password itself.
#
#   bun run serve           # op run --env-file=fellow.env -- bun src/http.ts
#   bun run serve:plain     # no op: session from `bun run auth:login`, or env vars you export
#
# Environment:
#   AIDEN_AI_ENV_FILE   env file of op:// references (default: <repo>/fellow.env)
#   AIDEN_AI_MCP_PORT   port to listen on (default 47831)
#   OP_BIN              path to the op binary, when it is not on PATH
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${AIDEN_AI_ENV_FILE:-$repo/fellow.env}"

die() {
  printf 'serve: %s\n' "$1" >&2
  exit 1
}

# Find op: OP_BIN, then PATH, then the usual install locations (a GUI-launched shell may have a
# minimal PATH).
op_bin="${OP_BIN:-}"
if [[ -z "$op_bin" ]]; then
  op_bin="$(command -v op 2>/dev/null || true)"
fi
if [[ -z "$op_bin" ]]; then
  for candidate in /opt/homebrew/bin/op /usr/local/bin/op /usr/bin/op; do
    if [[ -x "$candidate" ]]; then
      op_bin="$candidate"
      break
    fi
  done
fi
[[ -n "$op_bin" && -x "$op_bin" ]] ||
  die "1Password CLI (op) not found. Install it, set OP_BIN, or use 'bun run serve:plain'."

[[ -f "$env_file" ]] ||
  die "env file not found: $env_file (copy fellow.env.example to fellow.env, or set AIDEN_AI_ENV_FILE)."

bun_bin="$(command -v bun 2>/dev/null || true)"
[[ -n "$bun_bin" ]] || die "bun not found on PATH."

# Resolve every reference once, discarding the values, so a signed-out or blocked op fails here
# with a readable message instead of somewhere inside the server's startup. This is also what
# triggers the 1Password approval prompt; the real run below reuses that authorization.
if ! op_err="$("$op_bin" run --env-file="$env_file" -- true 2>&1 >/dev/null)"; then
  {
    printf 'serve: 1Password could not resolve the references in %s\n' "$env_file"
    printf '       op said: %s\n' "${op_err:-<no output>}"
    printf '       Check that op is signed in from this terminal (op vault list), that the\n'
    printf '       1Password app has "Integrate with 1Password CLI" enabled, and that every\n'
    printf '       op:// reference in the env file exists. If this terminal cannot reach\n'
    printf '       the 1Password app, sign op in manually first:\n'
    printf '         eval $(op signin --account <account>)\n'
    printf '       or run this script from another terminal (e.g. Terminal.app).\n'
  } >&2
  exit 1
fi

cd "$repo"
exec "$op_bin" run --env-file="$env_file" -- "$bun_bin" "$repo/src/http.ts"
