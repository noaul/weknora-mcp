#!/usr/bin/env bash
set -euo pipefail

: "${KEYCLOAK_ADMIN_USERNAME:?required}"
: "${KEYCLOAK_ADMIN_PASSWORD:?required}"

container="${KEYCLOAK_CONTAINER:-weknora-mcp-auth-keycloak-1}"
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

ensure_scope() {
  local scope_name="$1"
  local audience="$2"
  local mapper_name="$3"
  local scope_id mapper_id
  scope_id=$("${kcadm[@]}" get client-scopes -r weknora --fields id,name \
    | jq -r --arg name "$scope_name" '.[] | select(.name == $name) | .id' | head -n1)
  if [[ -z "$scope_id" ]]; then
    scope_id=$("${kcadm[@]}" create client-scopes -r weknora -i \
      -s "name=$scope_name" \
      -s protocol=openid-connect \
      -s 'attributes."include.in.token.scope"=true')
  fi

  mapper_id=$("${kcadm[@]}" get "client-scopes/$scope_id/protocol-mappers/models" \
    -r weknora \
    | jq -r --arg audience "$audience" \
      '.[] | select(.protocolMapper == "oidc-audience-mapper" and .config["included.custom.audience"] == $audience) | .id' \
    | head -n1)
  if [[ -z "$mapper_id" ]]; then
    "${kcadm[@]}" create "client-scopes/$scope_id/protocol-mappers/models" -r weknora \
      -s "name=$mapper_name" \
      -s protocol=openid-connect \
      -s protocolMapper=oidc-audience-mapper \
      -s "config.\"included.custom.audience\"=$audience" \
      -s 'config."access.token.claim"=true' \
      -s 'config."id.token.claim"=false' >/dev/null
  fi
  printf '%s\n' "$scope_id"
}

mcp_scope_id=$(ensure_scope \
  'weknora:mcp' 'https://wek.uov.me/mcp' 'weknora-mcp-audience')
console_scope_id=$(ensure_scope \
  'weknora:console' 'weknora-mcp-console' 'weknora-console-audience')

if ! "${kcadm[@]}" get roles/weknora-admin -r weknora >/dev/null 2>&1; then
  "${kcadm[@]}" create roles -r weknora \
    -s name=weknora-admin \
    -s description='May administer the WeKnora MCP management console' >/dev/null
fi

create_client() {
  local client_id="$1"
  local secret="$2"
  local redirect_uri="$3"
  local scope_id="$4"
  local required_role="$5"
  local id attached_scope mapped_role role_json
  local created=false
  id=$("${kcadm[@]}" get clients -r weknora -q "clientId=$client_id" --fields id \
    | jq -r '.[0].id // empty')
  if [[ -z "$id" ]]; then
    id=$("${kcadm[@]}" create clients -r weknora -i \
      -s "clientId=$client_id" \
      -s enabled=true)
    created=true
  fi
  if [[ "$created" == true ]]; then
    "${kcadm[@]}" update "clients/$id" -r weknora \
      -s enabled=true \
      -s publicClient=false \
      -s "secret=$secret" \
      -s standardFlowEnabled=true \
      -s directAccessGrantsEnabled=false \
      -s serviceAccountsEnabled=false \
      -s fullScopeAllowed=false \
      -s consentRequired=true \
      -s 'attributes."pkce.code.challenge.method"=S256' \
      -s "redirectUris=[\"$redirect_uri\"]" >/dev/null
  else
    "${kcadm[@]}" update "clients/$id" -r weknora \
      -s publicClient=false \
      -s standardFlowEnabled=true \
      -s directAccessGrantsEnabled=false \
      -s serviceAccountsEnabled=false \
      -s fullScopeAllowed=false \
      -s consentRequired=true \
      -s 'attributes."pkce.code.challenge.method"=S256' >/dev/null
  fi
  attached_scope=$("${kcadm[@]}" get "clients/$id/default-client-scopes" \
    -r weknora --fields id \
    | jq -r --arg id "$scope_id" '.[] | select(.id == $id) | .id' | head -n1)
  if [[ -z "$attached_scope" ]]; then
    "${kcadm[@]}" update "clients/$id/default-client-scopes/$scope_id" \
      -r weknora >/dev/null
  fi

  if [[ -n "$required_role" ]]; then
    mapped_role=$("${kcadm[@]}" get "clients/$id/scope-mappings/realm" \
      -r weknora --fields id,name \
      | jq -r --arg name "$required_role" \
        '.[] | select(.name == $name) | .id' | head -n1)
    if [[ -z "$mapped_role" ]]; then
      role_json=$("${kcadm[@]}" get "roles/$required_role" -r weknora)
      printf '[%s]\n' "$role_json" \
        | docker exec -i "$container" /opt/keycloak/bin/kcadm.sh \
            create "clients/$id/scope-mappings/realm" \
            -r weknora -f - >/dev/null
    fi
  fi
}

configure_optional_client() {
  local label="$1"
  local client_id="$2"
  local secret="$3"
  local redirect_uri="$4"
  local scope_id="$5"
  local required_role="$6"
  if [[ -z "$secret" && -z "$redirect_uri" ]]; then
    echo "Skipping $label client until its callback URI is known."
    return
  fi
  if [[ -z "$secret" || -z "$redirect_uri" ]]; then
    echo "$label requires both a client secret and redirect URI" >&2
    exit 1
  fi
  create_client "$client_id" "$secret" "$redirect_uri" "$scope_id" \
    "$required_role"
}

configure_retained_client() {
  local label="$1"
  local client_id="$2"
  local secret="$3"
  local redirect_uri="$4"
  local scope_id="$5"
  local id
  id=$("${kcadm[@]}" get clients -r weknora -q "clientId=$client_id" --fields id \
    | jq -r '.[0].id // empty')
  if [[ -z "$id" && ( -z "$secret" || -z "$redirect_uri" ) ]]; then
    echo "$label is missing; creation requires both a client secret and redirect URI" >&2
    exit 1
  fi
  create_client "$client_id" "$secret" "$redirect_uri" "$scope_id" ''
}

detach_client_scope() {
  local client_id="$1"
  local scope_name="$2"
  local client_uuid scope_id
  client_uuid=$("${kcadm[@]}" get clients -r weknora -q "clientId=$client_id" --fields id \
    | jq -r '.[0].id // empty')
  scope_id=$("${kcadm[@]}" get client-scopes -r weknora --fields id,name \
    | jq -r --arg name "$scope_name" '.[] | select(.name == $name) | .id' | head -n1)
  if [[ -z "$client_uuid" || -z "$scope_id" ]]; then
    return
  fi
  "${kcadm[@]}" delete "clients/$client_uuid/default-client-scopes/$scope_id" \
    -r weknora >/dev/null 2>&1 || true
  "${kcadm[@]}" delete "clients/$client_uuid/optional-client-scopes/$scope_id" \
    -r weknora >/dev/null 2>&1 || true
}

remove_obsolete_client() {
  local client_id="$1"
  local id
  id=$("${kcadm[@]}" get clients -r weknora -q "clientId=$client_id" --fields id \
    | jq -r '.[0].id // empty')
  if [[ -n "$id" ]]; then
    "${kcadm[@]}" delete "clients/$id" -r weknora >/dev/null
  fi
}

remove_obsolete_scope() {
  local scope_name="$1"
  local id
  id=$("${kcadm[@]}" get client-scopes -r weknora --fields id,name \
    | jq -r --arg name "$scope_name" '.[] | select(.name == $name) | .id' | head -n1)
  if [[ -n "$id" ]]; then
    "${kcadm[@]}" delete "client-scopes/$id" -r weknora >/dev/null
  fi
}

configure_console_service_client() {
  local secret="$1"
  local client_id=weknora-mcp-console-admin
  local id service_user_id realm_management_id role role_json
  if [[ -z "$secret" ]]; then
    echo "Skipping MCP-console service client until its secret is configured."
    return
  fi
  id=$("${kcadm[@]}" get clients -r weknora -q "clientId=$client_id" --fields id \
    | jq -r '.[0].id // empty')
  if [[ -z "$id" ]]; then
    id=$("${kcadm[@]}" create clients -r weknora -i \
      -s "clientId=$client_id" \
      -s enabled=true)
  fi
  "${kcadm[@]}" update "clients/$id" -r weknora \
    -s enabled=true \
    -s publicClient=false \
    -s "secret=$secret" \
    -s standardFlowEnabled=false \
    -s directAccessGrantsEnabled=false \
    -s serviceAccountsEnabled=true \
    -s fullScopeAllowed=false >/dev/null

  service_user_id=$("${kcadm[@]}" get "clients/$id/service-account-user" \
    -r weknora --fields id | jq -r '.id')
  realm_management_id=$("${kcadm[@]}" get clients -r weknora \
    -q clientId=realm-management --fields id | jq -r '.[0].id')
  for role in view-clients query-clients manage-clients view-users query-users manage-users; do
    role_json=$("${kcadm[@]}" get \
      "clients/$realm_management_id/roles/$role" -r weknora)
    printf '[%s]\n' "$role_json" \
      | docker exec -i "$container" /opt/keycloak/bin/kcadm.sh \
          create "users/$service_user_id/role-mappings/clients/$realm_management_id" \
          -r weknora -f - >/dev/null
    printf '[%s]\n' "$role_json" \
      | docker exec -i "$container" /opt/keycloak/bin/kcadm.sh \
          create "clients/$id/scope-mappings/clients/$realm_management_id" \
          -r weknora -f - >/dev/null
  done
}

configure_retained_client ChatGPT chatgpt-weknora-read \
  "${CHATGPT_READ_CLIENT_SECRET:-${CHATGPT_CLIENT_SECRET:-}}" \
  "${CHATGPT_READ_REDIRECT_URI:-${CHATGPT_REDIRECT_URI:-}}" \
  "$mcp_scope_id"
configure_retained_client Claude claude-weknora-read \
  "${CLAUDE_READ_CLIENT_SECRET:-${CLAUDE_CLIENT_SECRET:-}}" \
  "${CLAUDE_READ_REDIRECT_URI:-${CLAUDE_REDIRECT_URI:-}}" \
  "$mcp_scope_id"
configure_optional_client MCP-console weknora-mcp-console \
  "${MCP_CONSOLE_CLIENT_SECRET:-}" "${MCP_CONSOLE_REDIRECT_URI:-}" \
  "$console_scope_id" weknora-admin
configure_console_service_client "${MCP_CONSOLE_ADMIN_CLIENT_SECRET:-}"

detach_client_scope chatgpt-weknora-read 'weknora:read'
detach_client_scope claude-weknora-read 'weknora:read'
remove_obsolete_client chatgpt-weknora-admin
remove_obsolete_client claude-weknora-admin
remove_obsolete_scope 'weknora:read'
remove_obsolete_scope 'weknora:admin'

echo "Keycloak realm, unified MCP/console scopes, audiences, role, and static clients are configured."
