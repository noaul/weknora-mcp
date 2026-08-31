# WeKnora MCP Access Gateway Implementation Plan

**Goal:** Expose a read-only, single-knowledge-base view of the official Tencent WeKnora MCP server to ChatGPT and Claude through OAuth 2.1 without exposing upstream credentials or private ports.

**Architecture:** A TypeScript gateway terminates OAuth and MCP, publishes only four read tools, injects the fixed `镍基合金` knowledge-base ID, and calls a dedicated stateless official MCP instance on `127.0.0.1:18193`. Keycloak issues short-lived access tokens through public `/oauth` routes; OpenResty publishes `/mcp`, protected-resource metadata, and the required Keycloak authorization endpoints.

**Tech Stack:** Node.js, TypeScript, Fastify, official Model Context Protocol TypeScript SDK, `jose`, Zod, Vitest, Keycloak, systemd, OpenResty.

---

## 1. Scope

Version 1 exposes only:

- `hybrid_search`
- `wiki_search`
- `wiki_read_page`
- `wiki_index_view`

The downstream schemas do not accept a knowledge-base identifier. The gateway always injects:

```text
51adf856-2722-4a62-be49-b7d1f2cd20b4
```

Write, delete, tenant, model, session, chat, agent, file, URL, resource, and prompt operations are not exposed.

## 2. Confirmed Environment

- WeKnora: `v0.7.2`, commit `3d5d8bfcdfeeea266b292b71cea616847af28d0f`
- REST API on host: `http://127.0.0.1:18091/api/v1`
- Official MCP package: `tencent-weknora-mcp==1.1.1`
- MCP Python SDK: `mcp==2.1.1`
- Existing MCP: `192.168.112.1:18192/mcp`, scoped read-only key, used by LobeHub
- Codex: separate local stdio MCP through an SSH tunnel
- Official HTTP server: stateless, SSE-formatted responses, no `Mcp-Session-Id`
- Public site: `https://wek.uov.me`

## 3. Network Topology

```text
ChatGPT / Claude
    |
    | HTTPS + OAuth access token
    v
OpenResty :443
    |-- /mcp --------------------------------> gateway :18194
    |-- /.well-known/oauth-protected-resource* -> gateway :18194
    `-- /oauth/* ----------------------------> Keycloak :18195

gateway :18194 (systemd, 127.0.0.1)
    |
    | independent MCP shared secret
    v
official WeKnora MCP :18193 (systemd, 127.0.0.1)
    |
    | dedicated scoped WeKnora API key
    v
WeKnora REST :18091 (127.0.0.1)
```

The Node gateway runs directly under systemd. This avoids the invalid assumption that a bridge-mode container can reach the host's loopback interface.

## 4. OAuth Model

- Resource: `https://wek.uov.me/mcp`
- Issuer: `https://wek.uov.me/oauth/realms/weknora`
- Required scope: `weknora:read`
- Access token TTL: 10 minutes
- Refresh tokens: enabled and revocable
- Token validation: signature, `kid`, `iss`, `aud`, `exp`, `nbf`, and scope
- Client tokens are stripped before upstream calls
- Upstream shared secret and WeKnora API key exist only in root-readable environment files

Public Keycloak routes must include realm discovery, authorization, token, JWKS, login assets, logout, and the exact endpoints required by the clients. `/oauth/admin`, the master realm, metrics, and management ports remain private.

Create separate confidential clients for ChatGPT and Claude. Register only the exact callback URIs displayed by each client UI; wildcard callbacks are forbidden. Require Authorization Code flow and PKCE S256.

## 5. Authorization Policy

The gateway is a new MCP server, not a byte-transparent proxy.

- It advertises only tool capability.
- It registers only the four allowed tools.
- It accepts no `kb_id` or `knowledge_base_id` from clients.
- Each handler injects the fixed KB UUID before calling upstream.
- Any unknown tool or MCP method is rejected by the SDK/server capability surface.
- The upstream instance independently uses a retrieve-only key scoped to the same KB.

This provides two independent controls: downstream tool exposure and upstream REST authorization.

## 6. Project Structure

```text
src/
  app.ts                 Fastify routes, authentication, origin checks, audit hooks
  auth.ts                JWT/JWKS verification and authorization errors
  config.ts              validated environment configuration
  gateway-server.ts      downstream MCP server and four fixed-KB tools
  policy.ts              fixed tool schemas and argument normalization
  rate-limit.ts          subject and IP sliding-window limiters
  upstream-client.ts     official MCP client and credential isolation
  index.ts               process startup and graceful shutdown
tests/
  auth.test.ts
  config.test.ts
  metadata.test.ts
  policy.test.ts
  rate-limit.test.ts
  upstream-client.test.ts
  app.test.ts
deploy/
  keycloak-compose.yml
  keycloak/
  systemd/
  openresty/
  scripts/
fixtures/
  upstream-tools-baseline.json
docs/
  operations.md
  client-setup.md
```

## 7. Implementation Tasks

### Task 1: Repository and configuration

- Create strict TypeScript, Vitest, build, and runtime configuration.
- Validate every required environment variable with Zod.
- Reject insecure public HTTP URLs, malformed KB UUIDs, empty secrets, and identical upstream/downstream bearer tokens.
- Provide `.env.example` with no real secrets.

### Task 2: OAuth resource server

- Publish both protected-resource metadata paths.
- Return standards-shaped `401` responses with `resource_metadata`.
- Verify Keycloak JWTs using cached remote JWKS.
- Distinguish missing/invalid token (`401`) from missing scope (`403`).
- Validate `Origin` when present and reject unconfigured origins.

### Task 3: Protocol-aware MCP gateway

- Use the official TypeScript SDK server transport.
- Advertise tools only; do not forward upstream resource/prompt capabilities.
- Register four tools without KB parameters.
- Use the official SDK client to call the upstream stateless Streamable HTTP server.
- Replace client Authorization with the dedicated upstream bearer token.
- Preserve useful upstream MCP errors while hiding credentials and internal URLs.

### Task 4: Operational controls

- Apply independent per-IP and per-subject limits.
- Log correlation ID, subject, OAuth client, tool name, duration, and outcome.
- Never log query text, tool arguments, Authorization, cookies, authorization codes, or secrets.
- Add `/healthz` and `/readyz`; readiness includes an upstream MCP ping.
- Add graceful startup/shutdown.

### Task 5: Drift and security tests

- Capture the official 1.1.1 tool schemas as a baseline fixture.
- Fail drift checks when an allowed upstream tool disappears or its required/schema fields change.
- Test direct attempts to call write tools.
- Test that downstream tools cannot supply or override a KB ID.
- Test wrong issuer, audience, scope, expired tokens, unknown signing keys, and malformed tokens.
- Test that upstream requests never receive the client token.

### Task 6: Deployment assets

- Add a dedicated `weknora-mcp-gateway.service` for port 18193.
- Add `weknora-mcp-access-gateway.service` for port 18194.
- Add Keycloak and PostgreSQL Compose configuration bound to `127.0.0.1:18195`.
- Add realm/client bootstrap scripts that read secrets from environment files.
- Add OpenResty locations for MCP, PRM, and required `/oauth` paths with buffering disabled for MCP.
- Keep management and raw service ports off the public interface.

### Task 7: Client smoke tests

- Verify MCP Inspector authentication and tool discovery.
- Add the connector in Claude using its exact callback URI and dedicated client.
- Add the connector in ChatGPT developer mode using its exact callback URI and dedicated client.
- Verify `hybrid_search` returns known `镍基合金` content.
- Verify a constructed `delete_knowledge_base` call is unavailable.

## 8. Verification Commands

```bash
npm test
npm run typecheck
npm run build
npm run check:baseline
```

Deployment verification additionally checks:

```bash
systemctl is-active weknora-mcp-gateway
systemctl is-active weknora-mcp-access-gateway
curl -i https://wek.uov.me/.well-known/oauth-protected-resource/mcp
curl -i https://wek.uov.me/mcp
ss -lntp | grep -E ':(18091|18192|18193|18194|18195) '
```

Expected public behavior:

- PRM returns `200` with the configured resource and issuer.
- Unauthenticated `/mcp` returns `401` with `resource_metadata`.
- Raw ports 18091 through 18195 are not publicly reachable.
- LobeHub and Codex continue to work unchanged.

## 9. Rollback

- Remove the two added OpenResty location files and reload OpenResty.
- Stop and disable the two new systemd services.
- Stop the Keycloak Compose project.
- Existing 18192, LobeHub, Codex, WeKnora, and its frontend are untouched.

## 10. Explicit Limitations

- End-user identity exists only in gateway audit logs; upstream sees one API-key principal.
- Revoked users retain access until their current short-lived access token expires.
- The in-memory limiter is correct only for the single gateway instance in version 1.
- Supporting additional knowledge bases does not require a new OAuth audience while the MCP resource URL remains unchanged, but it does require a new authorization policy.
