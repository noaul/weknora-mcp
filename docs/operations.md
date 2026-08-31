# Operations

## Service map

| Port | Service | Exposure |
| --- | --- | --- |
| `18091` | WeKnora REST API | loopback |
| `18192` | Existing LobeHub MCP | private bridge, unchanged |
| `18193` | Read-only official MCP upstream | loopback |
| `18194` | Read-only OAuth gateway | loopback, published as `/mcp` |
| `18195` | Keycloak | loopback, selected `/oauth` routes published |
| `18196` | Full-access official MCP upstream | loopback |
| `18197` | Admin OAuth gateway | loopback, published as `/mcp-admin` |
| `18198` | MCP management console | loopback, published as `/mcp-console/` |

## Secrets

Generate independent random values for the Keycloak database/admin credentials, every OAuth client secret, and each MCP upstream bearer secret.

- Read upstream environment: `/etc/weknora-mcp-gateway.env`
- Read gateway environment/token: `/etc/weknora-mcp-access-gateway/`
- Admin upstream environment: `/etc/weknora-mcp-admin-upstream.env`
- Admin gateway environment/token: `/etc/weknora-mcp-admin-gateway/`
- Keycloak environment: `/opt/weknora-mcp-access-gateway/deploy/keycloak.env`
- Console environment/secrets: `/etc/weknora-mcp-console/`
- Console policy/audit state: `/var/lib/weknora-mcp-console/`

Environment files are root-owned mode `0600`. Upstream token files may be `0640` for the matching gateway group. Never commit real keys.

The admin gateway directory is `root:weknora-gateway-admin` mode `0750`; otherwise the service user cannot traverse the directory to read its group-readable token file.

Files staged under `/var/lib/weknora-mcp-import` should be owned by `root:weknora-import` and mode `0640` so both admin services can resolve/read them without gaining directory write access.

## Installation order

1. Run `npm ci`, tests, type check, and build.
2. Copy the release to `/opt/weknora-mcp-access-gateway`.
3. Create service users `weknora-mcp-admin` and `weknora-gateway-admin` with no login shell.
4. Create group `weknora-import`, add both admin users, and create `/var/lib/weknora-mcp-import` owned by `root:weknora-import` mode `0750`. Files are staged by an operator, not written by either service.
5. Install the two admin systemd units and root-readable environment files.
6. Run `configure-keycloak.sh` to create both scopes/audiences and the `weknora-admin` role.
7. Install the OpenResty location file, validate, and reload.
8. Enable and start the admin upstream and gateway.
9. Run `probe.sh`, temporary OAuth smoke tests, and real-client tests.

### Console sidecar

The console can be installed in an independent release directory such as
`/opt/weknora-mcp-console`. Run `deploy/scripts/install-console.sh`, then create
the following root-managed files with group `weknora-policy` and mode `0640`:

- `/etc/weknora-mcp-console/oauth-client-secret`
- `/etc/weknora-mcp-console/session-secret`
- `/etc/weknora-mcp-console/weknora-api-key`
- `/etc/weknora-mcp-console/keycloak-admin-client-secret`

Set the matching `MCP_CONSOLE_CLIENT_SECRET` in the Keycloak environment and
run `configure-keycloak.sh`. The exact callback is:

```text
https://wek.uov.me/mcp-console/oauth/callback
```

The browser authorization endpoint uses the public issuer. The console exchanges
the authorization code through loopback port `18195`, which is compatible with
the service's `IPAddressDeny=any` systemd network sandbox.

The console has a dedicated `weknora:console` client scope and
`weknora-mcp-console` audience. It does not receive the `weknora:admin` scope or
the `/mcp-admin` audience.

OAuth client management uses a second confidential service client,
`weknora-mcp-console-admin`. Its secret remains server-side. The service account
has the `view/query/manage-clients` and `view/query/manage-users` roles needed to
manage the four allow-listed external clients and revoke their sessions; the
application rejects every other client key.

The console supports enabling/disabling clients, changing one exact HTTPS
callback URI, revoking active sessions, and rotating secrets. A rotated secret
is returned to the authenticated browser once and is never written to the audit
log. Disabling or revoking a client does not invalidate an already issued JWT
inside the gateways, so allow up to the realm's 10-minute access-token lifetime.

The systemd drop-in in `deploy/systemd/weknora-mcp-access-gateway-policy.conf`
makes the read gateway run the console release and adds the shared policy group.
It does not modify `/opt/weknora` or either official WeKnora container.

## Routine verification

```bash
systemctl status weknora-mcp-gateway --no-pager
systemctl status weknora-mcp-access-gateway --no-pager
systemctl status weknora-mcp-admin-upstream --no-pager
systemctl status weknora-mcp-admin-gateway --no-pager
systemctl status weknora-mcp-console --no-pager
curl -fsS http://127.0.0.1:18194/readyz
curl -fsS http://127.0.0.1:18197/readyz
curl -fsS http://127.0.0.1:18198/healthz
```

Check the reviewed schemas after every official MCP or WeKnora upgrade:

```bash
set -a
. /etc/weknora-mcp-access-gateway/gateway.env
set +a
cd /opt/weknora-mcp-access-gateway
npm run check:baseline

set -a
. /etc/weknora-mcp-admin-gateway/gateway.env
set +a
npm run check:baseline
```

Admin mode rejects missing, changed, or newly added upstream tools until `fixtures/upstream-admin-tools-baseline.json` is reviewed and updated.

## Role assignment

Assign the `weknora-admin` realm role only to users who need full tenant authority. Removing the role blocks new admin requests as soon as the current access token expires; the configured token lifetime is 10 minutes.

All OAuth clients keep Keycloak `fullScopeAllowed=false`. Admin clients receive a client scope mapping for only the `weknora-admin` realm role, so an assigned operator role is emitted in `realm_access.roles` without exposing unrelated realm roles. The gateway still requires the exact admin audience, `weknora:admin` scope, and `weknora-admin` role.

## Rotation

Rotate each upstream bearer secret by updating the corresponding official MCP environment and gateway token file together, then restart that profile's two services. Rotate OAuth client secrets independently in Keycloak and the client UI.

## Rollback

The admin profile is independent. Remove `/mcp-admin` OpenResty locations, disable `weknora-mcp-admin-gateway` and `weknora-mcp-admin-upstream`, and remove admin OAuth clients or role assignments. The read-only `/mcp`, existing `18192`, LobeHub, Codex, and WeKnora remain unchanged.
