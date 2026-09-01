# WeKnora MCP Access Gateway

OAuth-protected gateway for the official Tencent WeKnora MCP server. ChatGPT
and Claude use one `/mcp` endpoint, while the server assigns each OAuth client
its own tool capabilities and knowledge-base scope.

## Access model

- MCP URL: `https://mcp.example.com/mcp`
- OAuth scope: `weknora:mcp`
- Retained client IDs: `chatgpt-weknora-read` and `claude-weknora-read`
- Access type: 按能力授权 or 全权限
- Knowledge-base scope: all or an explicit allow-list with one default
- Future upstream tools are rejected until their schemas and permissions are reviewed

Available capability groups are:

- `knowledge.read`
- `conversation.use`
- `knowledge.write`
- `knowledge.manage`
- `agents.read`
- `models.manage`

The existing `*-read` client IDs are kept only to preserve installed connector
settings. They are not permanently read-only. Their effective permissions come
from the server-side access policy.

## Management console

The sidecar console at `https://mcp.example.com/mcp-console/` manages both OAuth
and MCP access without modifying the official WeKnora frontend or images. For
each ChatGPT or Claude client it provides:

- enable/disable and exact callback URI management;
- Client ID and OAuth endpoint reference data;
- one-time Client Secret rotation results;
- active-session revocation;
- 按能力 or 全权限 selection;
- capability checkboxes and knowledge-base selection;
- default knowledge-base selection and append-only audit records.

Existing Client Secrets are not readable. A replacement is shown only once
after rotation. Official MCP currently has no API-key or tenant-member
management tools, so the console displays those categories as unavailable.

## Security boundary

The Tenant API Key is stored only on the server and is used by the official
WeKnora upstream and the console's internal REST client. ChatGPT and Claude
receive OAuth access tokens, never the Tenant API Key.

The gateway verifies token signature, issuer, audience, expiry, scope, and
OAuth client identity. It exposes only reviewed tools, rechecks permissions on
every call, rejects unauthorized knowledge-base IDs before contacting WeKnora,
and restricts server-local file imports to `ADMIN_IMPORT_ROOT`.

## Development

Requires Node.js 20.20 or newer.

```bash
npm install
npm test
npm run typecheck
npm run build
```

Repository layout:

- `src/`: gateway, policy, OAuth validation, console, and upstream clients
- `console/`: independent management UI
- `fixtures/`: reviewed official MCP tool-schema baselines
- `deploy/`: Keycloak, systemd, OpenResty, and installation assets
- `docs/`: client setup and operations

See [client setup](docs/client-setup.md) and [operations](docs/operations.md).
