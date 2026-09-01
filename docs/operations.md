# Operations

## Service map

| Port | Service | Exposure |
| --- | --- | --- |
| `18091` | WeKnora REST API | loopback |
| `18192` | Existing LobeHub MCP | private bridge, unchanged |
| `18193` | Official WeKnora MCP upstream | loopback |
| `18194` | Unified OAuth gateway | loopback, published as `/mcp` |
| `18195` | Keycloak | loopback, selected `/oauth` routes published |
| `18198` | MCP management console | loopback, published as `/mcp-console/` |

The official WeKnora files and images under `/opt/weknora` are not modified.
The gateway and console use independent release, configuration, and state paths.

## Secrets and state

- Upstream environment: `/etc/weknora-mcp-gateway.env`
- Gateway environment/token: `/etc/weknora-mcp-access-gateway/`
- Keycloak environment: `/opt/weknora-mcp-access-gateway/deploy/keycloak.env`
- Console environment/secrets: `/etc/weknora-mcp-console/`
- Access policy and audit state: `/var/lib/weknora-mcp-console/`
- Approved server-local imports: `/var/lib/weknora-mcp-import/`

Environment and secret files are root-owned and never committed. The official
upstream and console REST client both use the same Tenant API Key. The gateway's
separate upstream bearer token protects the loopback MCP transport.

## Installation and migration

1. Run `npm ci`, `npm test`, `npm run typecheck`, and `npm run build`.
2. Back up systemd units, OpenResty configuration, Keycloak realm/client data,
   gateway environment files, and the current policy file.
3. Copy the release to `/opt/weknora-mcp-console` and run
   `deploy/scripts/install-console.sh`.
4. Update `/etc/weknora-mcp-access-gateway/gateway.env` from
   `deploy/systemd/gateway.env.example` without replacing real secrets.
5. Update `/etc/weknora-mcp-console/console.env` from
   `deploy/systemd/console.env.example`.
6. Install the upstream, gateway, and console systemd units.
7. Run `deploy/scripts/configure-keycloak.sh`.
8. Install the OpenResty fragment, validate configuration, and reload.
9. Restart the upstream, gateway, and console, then run `probe.sh`.

The policy reader automatically migrates a version-1 knowledge policy to
version 2 in memory. Both retained clients initially receive `knowledge.read`
over the prior allow-list. The next console update persists version 2.

The Keycloak migration preserves the existing `chatgpt-weknora-read` and
`claude-weknora-read` secrets and callback URIs. It attaches `weknora:mcp`
before removing obsolete clients and scopes.

## Console sidecar

The console callback is:

```text
https://wek.uov.me/mcp-console/oauth/callback
```

The console login client uses the `weknora-admin` realm role. This role controls
access to the management UI, not the MCP client's effective permissions.

The `weknora-mcp-console-admin` service account has only the Keycloak client and
user management roles needed to manage the two allow-listed external clients,
rotate their secrets, and revoke sessions. Existing secrets are never returned.

The console can edit OAuth settings, access type, capabilities, knowledge-base
scope, and default knowledge base. API Key and tenant-member management remain
unavailable because the reviewed official MCP exposes no corresponding tools.

## Import directory

Create `/var/lib/weknora-mcp-import` as `root:weknora-import` mode `0750`. Add
the `weknora-mcp` and `weknora-gateway` service users to that group. Staged files
should normally be `root:weknora-import` mode `0640`.

The gateway resolves both the configured root and requested file path before
forwarding a file-ingestion call. The official upstream has read-only access to
the same directory.

## Routine verification

```bash
systemctl status weknora-mcp-gateway --no-pager
systemctl status weknora-mcp-access-gateway --no-pager
systemctl status weknora-mcp-console --no-pager
curl -fsS http://127.0.0.1:18194/readyz
curl -fsS http://127.0.0.1:18198/healthz
deploy/scripts/probe.sh
```

After every official MCP or WeKnora upgrade, rerun the full tests and baseline
check. The gateway rejects missing, changed, or newly added upstream tools until
the reviewed baseline and capability catalog are updated together.

## Rotation

Rotate the upstream bearer token by updating the official MCP environment and
gateway token file together, then restart both services. Rotate ChatGPT or
Claude Client Secrets through the console and immediately update the matching
web connector with the one-time value.

Disabling a client or revoking its Keycloak sessions does not invalidate an
already issued JWT until that token expires. The current realm access-token
lifetime is ten minutes.

## Rollback

Keep a pre-cutover release directory, policy backup, Keycloak export, OpenResty
fragment, and git tag. Roll back the three sidecar services and configuration as
one unit; the official WeKnora deployment and the existing service on port
`18192` remain unchanged.
