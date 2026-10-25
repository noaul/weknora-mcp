#!/usr/bin/env bash
set -euo pipefail

base="${PUBLIC_BASE_URL:-https://wek.uov.me}"

curl --fail --silent --show-error \
  "$base/.well-known/oauth-protected-resource/mcp" | jq .

curl --fail --silent --show-error \
  "$base/.well-known/oauth-authorization-server/oauth/realms/weknora" | jq .issuer

curl --fail --silent --show-error \
  "$base/oauth/realms/weknora/protocol/openid-connect/certs" | jq '.keys | length'

status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST "$base/mcp" \
  --header 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"ping"}')

test "$status" = "401"

echo "Unified MCP metadata is available and the unauthenticated endpoint returns 401."
