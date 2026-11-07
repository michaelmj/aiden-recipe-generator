#!/usr/bin/env bash
# headersHelper for .mcp.json: print the Authorization header for the local aiden HTTP server.
#
# The server writes a fresh bearer token to <data dir>/http-token every time it starts
# (src/httpAuth.ts). Claude runs this before connecting, so the token never sits in any Claude
# config. If the file is missing the server has not been started: exit non-zero so Claude shows
# the server as failed rather than connecting without credentials.
set -euo pipefail

data_dir="${AIDEN_AI_DATA_DIR:-$HOME/.aiden-ai-profile-generator}"
token_file="$data_dir/http-token"

if [[ ! -r "$token_file" ]]; then
  printf 'aiden: no token at %s. Start the server first: bun run serve\n' "$token_file" >&2
  exit 1
fi

IFS= read -r token <"$token_file" || true
# Tokens are base64url (src/httpAuth.ts); anything else is not ours and must not reach the JSON.
if [[ ! "$token" =~ ^[A-Za-z0-9_-]{20,}$ ]]; then
  printf 'aiden: %s does not hold a valid token. Restart the server: bun run serve\n' "$token_file" >&2
  exit 1
fi

printf '{"Authorization":"Bearer %s"}\n' "$token"
