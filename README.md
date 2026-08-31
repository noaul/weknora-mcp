# WeKnora MCP Access Gateway

OAuth-protected, read-only MCP gateway for the official Tencent WeKnora MCP server.

The gateway is designed for remote clients such as ChatGPT and Claude. It exposes a deliberately small MCP surface and never sends the WeKnora API key or upstream MCP shared secret to clients.

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

## Security boundaries

1. The gateway registers only four read tools and injects the fixed KB ID.
2. A dedicated official WeKnora MCP instance uses a retrieve-only API key scoped to the same KB.
3. OAuth access tokens are verified for signature, issuer, audience, expiry, and scope.
4. Client Authorization headers are replaced before upstream calls.
5. Raw WeKnora and MCP ports remain bound to loopback or a private bridge.

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
