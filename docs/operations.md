# Operations

## Secrets

Generate separate random values for:

- Keycloak database password
- Keycloak bootstrap administrator password
- ChatGPT OAuth client secret
- Claude OAuth client secret
- The MCP shared secret for port 18193
- A dedicated WeKnora retrieve-only API key scoped to `镍基合金`

Never commit these values. Environment files under `/etc` must be root-owned and mode `0600`; the upstream token file may be `0640` for the `weknora-gateway` group.

## Installation order

1. Build the project with `npm ci && npm run build`.
2. Copy it to `/opt/weknora-mcp-access-gateway`.
3. Create system users `weknora-mcp` and `weknora-gateway` with no login shell.
4. Install the two systemd units and their environment files.
5. Start Keycloak with `docker compose --env-file keycloak.env -f keycloak-compose.yml up -d`.
6. Run `configure-keycloak.sh` after obtaining the exact client callback URIs.
7. Install the OpenResty location file and validate with `openresty -t` inside the 1Panel container.
8. Enable and start both systemd services.
9. Run `probe.sh`, MCP Inspector, and the real-client smoke tests.

## Routine verification

```bash
systemctl status weknora-mcp-gateway --no-pager
systemctl status weknora-mcp-access-gateway --no-pager
journalctl -u weknora-mcp-access-gateway -n 100 --no-pager
curl -fsS http://127.0.0.1:18194/healthz
curl -fsS http://127.0.0.1:18194/readyz
```

Run the upstream drift check after every WeKnora or `tencent-weknora-mcp` upgrade:

```bash
set -a
. /etc/weknora-mcp-access-gateway/gateway.env
set +a
cd /opt/weknora-mcp-access-gateway
npm run check:baseline
```

## Rotation

Rotate the 18193 MCP secret by updating both `/etc/weknora-mcp-gateway.env` and `/etc/weknora-mcp-access-gateway/upstream-token`, then restart both services. Rotate OAuth client secrets in Keycloak and the corresponding client UI independently.

## Backup

- Back up the Keycloak PostgreSQL volume.
- Export the `weknora` realm after client or policy changes.
- Back up `/etc/weknora-mcp-gateway.env` and `/etc/weknora-mcp-access-gateway/` through the existing encrypted server backup process.

## Rollback

Remove the added OpenResty location file, validate and reload OpenResty, stop the two new systemd services, and stop the Keycloak Compose project. The existing WeKnora service, port 18192, LobeHub, and Codex paths are independent and remain unchanged.
