#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

if [[ $(id -u) -ne 0 ]]; then
  echo "install-console.sh must run as root" >&2
  exit 1
fi

chmod -R a+rX "$repo_root"

getent group weknora-policy >/dev/null || groupadd --system weknora-policy
getent group weknora-import >/dev/null || groupadd --system weknora-import
if ! id weknora-console >/dev/null 2>&1; then
  useradd --system --gid weknora-policy --home-dir /nonexistent \
    --shell /usr/sbin/nologin weknora-console
fi
usermod -a -G weknora-policy weknora-gateway
usermod -a -G weknora-import weknora-gateway
usermod -a -G weknora-import weknora-mcp

install -d -o weknora-console -g weknora-policy -m 0750 \
  /var/lib/weknora-mcp-console
install -d -o root -g weknora-policy -m 0710 \
  /etc/weknora-mcp-console
install -d -o root -g weknora-import -m 0750 \
  /var/lib/weknora-mcp-import
install -o root -g root -m 0644 \
  "$repo_root/deploy/systemd/weknora-mcp-console.service" \
  /etc/systemd/system/weknora-mcp-console.service
install -d -o root -g root -m 0755 \
  /etc/systemd/system/weknora-mcp-access-gateway.service.d
install -o root -g root -m 0644 \
  "$repo_root/deploy/systemd/weknora-mcp-access-gateway-policy.conf" \
  /etc/systemd/system/weknora-mcp-access-gateway.service.d/policy.conf

if [[ ! -f /etc/weknora-mcp-console/console.env ]]; then
  install -o root -g root -m 0600 \
    "$repo_root/deploy/systemd/console.env.example" \
    /etc/weknora-mcp-console/console.env
fi

ensure_env_setting() {
  local key="$1"
  local value="$2"
  if ! grep -q "^${key}=" /etc/weknora-mcp-console/console.env; then
    printf '%s=%s\n' "$key" "$value" >> /etc/weknora-mcp-console/console.env
  fi
}

ensure_env_setting KEYCLOAK_ADMIN_URL \
  http://127.0.0.1:18195/oauth/admin/realms/weknora/
ensure_env_setting KEYCLOAK_SERVICE_CLIENT_ID weknora-mcp-console-admin
ensure_env_setting KEYCLOAK_SERVICE_CLIENT_SECRET_FILE \
  /etc/weknora-mcp-console/keycloak-admin-client-secret
ensure_env_setting MCP_ACCESS_POLICY_FILE \
  /var/lib/weknora-mcp-console/access-policy.json
ensure_env_setting MCP_AUDIT_FILE \
  /var/lib/weknora-mcp-console/audit.ndjson
ensure_env_setting GATEWAY_HEALTH_URL http://127.0.0.1:18194/readyz

systemctl daemon-reload
echo "Unified MCP console, policy, and import directories installed. Add the four secret files before starting the service."
