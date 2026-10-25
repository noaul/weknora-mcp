# Operations

## Service map

| Port | Service | Exposure |
| --- | --- | --- |
| `18091` | WeKnora REST API | loopback |
| `18192` | Existing LobeHub MCP | private bridge, unchanged |
| `18193` | Official WeKnora MCP upstream | loopback |
| `18194` | Unified OAuth gateway | loopback, published as `/mcp` |
| `18198` | MCP management console and OAuth server | loopback, published as `/mcp-console/` and `/oauth/realms/weknora/` |

The official WeKnora files and images under `/opt/weknora` are not modified.
The gateway and console use independent release, configuration, and state paths.

## Secrets and state

- Upstream environment: `/etc/weknora-mcp-gateway.env`
- Gateway environment/token: `/etc/weknora-mcp-access-gateway/`
- Console environment/secrets: `/etc/weknora-mcp-console/`
- Access policy, audit, and static-token hashes: `/var/lib/weknora-mcp-console/`
- OAuth clients and grants (`oauth-clients.json`, mode `0640`, readable by the
  gateway), token signing key (`oauth-signing-key.json`, `0600`), and
  administrator password hashes (`admin-users.json`, `0600`):
  `/var/lib/weknora-mcp-console/`
- Gateway session ownership: `/var/lib/weknora-mcp-access-gateway/` (systemd
  `StateDirectory`)
- Approved server-local imports: `/var/lib/weknora-mcp-import/`

Environment and secret files are root-owned and never committed. The official
upstream and console REST client both use the same Tenant API Key. The gateway's
separate upstream bearer token protects the loopback MCP transport.

## Installation and migration

1. Run `npm ci`, `npm test`, `npm run typecheck`, and `npm run build`.
2. Back up systemd units, OpenResty configuration, gateway and console
   environment files, and `/var/lib/weknora-mcp-console/`.
3. Copy the release to `/opt/weknora-mcp-console` and run
   `deploy/scripts/install-console.sh`.
4. Update `/etc/weknora-mcp-access-gateway/gateway.env` from
   `deploy/systemd/gateway.env.example` without replacing real secrets.
5. Update `/etc/weknora-mcp-console/console.env` from
   `deploy/systemd/console.env.example`.
6. Install the upstream, gateway, and console systemd units.
7. Create the console administrator:
   `sudo -u weknora-console node dist/scripts/set-admin-password.js <username>`
   (the password is read from stdin).
8. Install the OpenResty fragment, validate configuration, and reload.
9. Restart the upstream, gateway, and console, then run `probe.sh`.

The policy reader automatically migrates a version-1 knowledge policy to
version 2 in memory. Both retained clients initially receive `knowledge.read`
over the prior allow-list. The next console update persists version 2.

## Migrating from Keycloak

Earlier releases used a separate Keycloak and PostgreSQL deployment
(about 470 MB of memory). The embedded server keeps the issuer
`https://wek.uov.me/oauth/realms/weknora` and the realm's endpoint paths, so
ChatGPT, Claude, and Gemini connectors keep their URL, Client ID, and Client
Secret. Their Keycloak-issued refresh tokens end with the cutover, so each
connector asks to sign in once more.

1. Stop the console, then import the OAuth clients (secret, callbacks, enabled
   state) and the `weknora-admin` users (argon2 password hash and subject id)
   while Keycloak still runs. Nothing is written to disk in plain text:

   ```bash
   deploy/scripts/export-keycloak.sh | sudo -u weknora-console \
     node /opt/weknora-mcp-console/dist/scripts/import-keycloak.js
   ```

2. Point the gateway's `OAUTH_JWKS_URL` at
   `http://127.0.0.1:18198/oauth/realms/weknora/protocol/openid-connect/certs`
   and add `MCP_OAUTH_CLIENT_FILE`.
3. Remove the `OAUTH_JWKS_URL`, `OAUTH_TOKEN_URL`, `OAUTH_CLIENT_*`,
   `OAUTH_REQUIRED_ROLE`, and `KEYCLOAK_*` lines from `console.env` and delete
   the `oauth-client-secret` and `keycloak-admin-client-secret` files.
4. Install the new OpenResty fragment, restart the console and gateway, and run
   `probe.sh`.
5. Stop Keycloak with `docker compose -f deploy/keycloak-compose.yml down`
   from the previous release. Keep its database volume until every connector
   has signed in again; afterwards remove it with `down -v`.

## Console and authorization server

The console login page is:

```text
https://wek.uov.me/mcp-console/login
```

The same administrator account signs in to the console and authorizes the
ChatGPT, Claude, and Gemini connectors. Failed logins are limited to 10 per
address and 50 overall per 15 minutes.

The embedded OAuth 2.1 server supports the authorization-code flow with
mandatory S256 PKCE, confidential clients (`client_secret_basic` or
`client_secret_post`), refresh tokens, and RFC 7009 revocation. Access tokens
are ES256 JWTs valid for ten minutes with audience `https://wek.uov.me/mcp` and
scope `weknora:mcp`. Refresh tokens expire after 30 days without use and at the
latest 180 days after the authorization. The signing key is created on first
start; deleting `oauth-signing-key.json` and restarting the console invalidates
every issued access token.

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
check. At startup the gateway hides every upstream tool that is missing, has a
changed input schema, or is not in the reviewed baseline, and logs one
`Upstream tool baseline mismatch` warning per tool. The other reviewed tools
remain available. Review the warnings, then update the baseline and capability
catalog together.

The baseline describes the `mcp-server` source of Tencent/WeKnora v0.8.2. It
also accepts the older schemas published as `tencent-weknora-mcp` 1.1.1 on
PyPI, so the gateway works with either upstream. `update_knowledge_from_text`
exists only in the newer source.

```bash
journalctl -u weknora-mcp-access-gateway -b | grep 'baseline mismatch'
```

## Rotation

Rotate the upstream bearer token by updating the official MCP environment and
gateway token file together, then restart both services. Rotate ChatGPT or
Claude Client Secrets through the console and immediately update the matching
web connector with the one-time value.

Create, rotate, disable, or delete credentials in the console. The gateway
reads the policy and key files on every request, so changes apply
immediately. On start the console migrates keys of the former shared token
clients (`token-weknora`, `xiaomi-weknora-token`, …) into per-key
`apikey-<id>` clients that keep the shared client's access, then removes the
legacy policy entries.

Disabling a client, deleting it, or revoking its sessions takes effect
immediately: the gateway checks every OAuth access token against the client
and grant state in `oauth-clients.json`.

Reset a forgotten administrator password with
`sudo -u weknora-console node dist/scripts/set-admin-password.js <username>`.

## Rollback

Keep a pre-cutover release directory, a backup of
`/var/lib/weknora-mcp-console/`, the environment files, the OpenResty fragment,
and a git tag. Roll back the three sidecar services and configuration as
one unit; the official WeKnora deployment and the existing service on port
`18192` remain unchanged.
