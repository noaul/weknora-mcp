#!/usr/bin/env bash
set -euo pipefail

: "${KEYCLOAK_ADMIN_USERNAME:?required}"
: "${KEYCLOAK_ADMIN_PASSWORD:?required}"

container="${KEYCLOAK_CONTAINER:-weknora-keycloak-1}"
kcadm=(docker exec "$container" /opt/keycloak/bin/kcadm.sh)

"${kcadm[@]}" config credentials \
  --server http://127.0.0.1:8080/oauth \
  --realm master \
  --user "$KEYCLOAK_ADMIN_USERNAME" \
  --password "$KEYCLOAK_ADMIN_PASSWORD"

if ! "${kcadm[@]}" get realms/weknora >/dev/null 2>&1; then
  "${kcadm[@]}" create realms \
    -s realm=weknora \
    -s enabled=true \
    -s sslRequired=external \
    -s accessTokenLifespan=600 \
    -s revokeRefreshToken=true \
    -s refreshTokenMaxReuse=0 \
    -s registrationAllowed=false \
    -s resetPasswordAllowed=true
fi

scope_id=$("${kcadm[@]}" get client-scopes -r weknora --fields id,name \
  | jq -r '.[] | select(.name == "weknora:read") | .id' | head -n1)
if [[ -z "$scope_id" ]]; then
  scope_id=$("${kcadm[@]}" create client-scopes -r weknora -i \
    -s name='weknora:read' \
    -s protocol=openid-connect \
    -s 'attributes."include.in.token.scope"=true')
  "${kcadm[@]}" create "client-scopes/$scope_id/protocol-mappers/models" -r weknora \
    -s name='weknora-mcp-audience' \
    -s protocol=openid-connect \
    -s protocolMapper=oidc-audience-mapper \
    -s 'config."included.custom.audience"=https://wek.uov.me/mcp' \
    -s 'config."access.token.claim"=true' \
    -s 'config."id.token.claim"=false'
fi

create_client() {
  local client_id="$1"
  local secret="$2"
  local redirect_uri="$3"
  local id
  id=$("${kcadm[@]}" get clients -r weknora -q "clientId=$client_id" --fields id \
    | jq -r '.[0].id // empty')
  if [[ -z "$id" ]]; then
    id=$("${kcadm[@]}" create clients -r weknora -i \
      -s "clientId=$client_id" \
      -s enabled=true \
      -s publicClient=false \
      -s "secret=$secret" \
      -s standardFlowEnabled=true \
      -s directAccessGrantsEnabled=false \
      -s serviceAccountsEnabled=false \
      -s consentRequired=true \
      -s 'attributes."pkce.code.challenge.method"=S256' \
      -s "redirectUris=[\"$redirect_uri\"]")
    "${kcadm[@]}" update "clients/$id/default-client-scopes/$scope_id" -r weknora
  fi
}

configure_optional_client() {
  local label="$1"
  local client_id="$2"
  local secret="$3"
  local redirect_uri="$4"
  if [[ -z "$secret" && -z "$redirect_uri" ]]; then
    echo "Skipping $label client until its callback URI is known."
    return
  fi
  if [[ -z "$secret" || -z "$redirect_uri" ]]; then
    echo "$label requires both a client secret and redirect URI" >&2
    exit 1
  fi
  create_client "$client_id" "$secret" "$redirect_uri"
}

configure_optional_client ChatGPT chatgpt-weknora \
  "${CHATGPT_CLIENT_SECRET:-}" "${CHATGPT_REDIRECT_URI:-}"
configure_optional_client Claude claude-weknora \
  "${CLAUDE_CLIENT_SECRET:-}" "${CLAUDE_REDIRECT_URI:-}"

echo "Keycloak realm, scope, audience mapper, and static clients are configured."
