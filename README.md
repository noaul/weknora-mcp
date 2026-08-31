# WeKnora MCP Access Gateway

OAuth-protected read-only and full-administration gateways for the official Tencent WeKnora MCP server.

The project runs in two isolated profiles so remote clients such as ChatGPT and Claude can choose the permission level without sharing credentials or audiences.

## Version 1 policy

- Fixed knowledge base: `镍基合金`
- Fixed KB ID: `51adf856-2722-4a62-be49-b7d1f2cd20b4`
- Required OAuth scope: `weknora:read`
- Exposed tools:
  - `hybrid_search`
  - `wiki_search`
  - `wiki_read_page`
  - `wiki_index_view`
- No client-controlled knowledge-base parameter
- No write, delete, upload, chat, agent, resource, or prompt capability

## Admin policy

- MCP URL: `https://wek.uov.me/mcp-admin`
- Required scope: `weknora:admin`
- Required Keycloak realm role: `weknora-admin`
- Exposes the reviewed 30-tool baseline from `tencent-weknora-mcp==1.1.1`
- Uses a separate full-access WeKnora key and upstream bearer secret
- Rejects future upstream tools until the checked-in baseline is updated
- Restricts `create_knowledge_from_file` to `ADMIN_IMPORT_ROOT`

## Security boundaries

1. Read and admin profiles use separate resource URLs, scopes, clients, processes, upstream secrets, and WeKnora keys.
2. The read gateway registers only four tools and injects the fixed KB ID.
3. The admin gateway exposes only the exact reviewed upstream baseline and additionally requires a realm role.
4. OAuth access tokens are verified for signature, issuer, audience, expiry, scope, and the configured role.
5. Client Authorization headers are replaced before upstream calls.
6. Raw WeKnora and MCP ports remain bound to loopback or a private bridge.

## Development

Requirements: Node.js 20.20 or newer.

```bash
npm install
npm test
npm run typecheck
npm run build
```

Run locally after creating a root-readable upstream token file:

```bash
cp .env.example .env
set -a
. ./.env
set +a
npm start
```

## Repository layout

- `src/`: gateway, OAuth validation, policy, upstream MCP client
- `tests/`: unit and in-memory MCP integration tests
- `fixtures/`: official upstream tool-schema baseline
- `scripts/`: drift checks
- `deploy/`: Keycloak, systemd, OpenResty, and installation assets
- `docs/`: implementation plan, client setup, and operations

See [the implementation plan](docs/plans/2026-08-31-weknora-mcp-access-gateway.md), [client setup](docs/client-setup.md), and [operations guide](docs/operations.md).
