# WeKnora MCP Dual-Access Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps follow test-driven development for runtime behavior.

**Goal:** Publish both a fixed-knowledge-base read-only WeKnora MCP connection and a separately authorized full-administration connection for ChatGPT, Claude, and other remote MCP clients.

**Architecture:** One TypeScript codebase runs in `readonly` or `admin` mode. Each mode has a separate public MCP resource URL, OAuth scope, OAuth client, Node process, official Tencent WeKnora MCP upstream, bearer secret, and WeKnora API key. The current read-only endpoint remains unchanged; the admin endpoint exposes a pinned baseline of all official `tencent-weknora-mcp==1.1.1` tools and forwards calls without accepting credentials from clients.

**Tech Stack:** Node.js, TypeScript, Fastify, official Model Context Protocol TypeScript SDK, `jose`, Zod, Vitest, Keycloak, systemd, OpenResty.

---

## 1. Product Profiles

| Profile | Public URL | OAuth scope | Gateway | Upstream | WeKnora key |
| --- | --- | --- | --- | --- | --- |
| Read-only | `https://wek.uov.me/mcp` | `weknora:read` | `127.0.0.1:18194` | `127.0.0.1:18193` | retrieve-only, fixed to `镍基合金` |
| Admin | `https://wek.uov.me/mcp-admin` | `weknora:admin` | `127.0.0.1:18197` | `127.0.0.1:18196` | full-access tenant key |

Users choose permission by adding the corresponding MCP connection. A token issued for one resource is not valid for the other because the gateway verifies both `aud` and the required scope.

## 2. Read-Only Policy

The read-only profile remains compatible with the deployed version:

- Fixed knowledge base: `镍基合金`
- Fixed KB ID: `51adf856-2722-4a62-be49-b7d1f2cd20b4`
- Exposed tools: `hybrid_search`, `wiki_search`, `wiki_read_page`, `wiki_index_view`
- Client schemas omit `kb_id`; the gateway injects the fixed UUID
- Write, delete, tenant, model, session, chat, agent, upload, resource, and prompt operations are unavailable

## 3. Admin Policy

The admin profile exposes the complete current official tool baseline:

- Tenant: `create_tenant`, `list_tenants`
- Knowledge bases: create, list, inspect, delete, search
- Knowledge: create from file, URL, or Markdown text; list, inspect, delete
- Models: create, list, inspect
- Sessions and chat: create, list, inspect, delete, `chat`, `agent_chat`
- Agents: list and inspect
- Chunks: list and delete
- Wiki: search, read, index

Admin calls retain upstream argument schemas, including client-selected KB IDs. Unknown tools and tools added by a future upstream release are denied until the checked-in baseline is reviewed and updated.

`create_knowledge_from_file` is a server-local path operation, not browser file upload. The admin gateway rejects paths outside `ADMIN_IMPORT_ROOT`, planned as `/var/lib/weknora-mcp-import`. Remote clients should normally use `create_knowledge_from_text` or `create_knowledge_from_url`.

Delete tools receive MCP annotations with `destructiveHint: true`. Annotations are UX hints only; the real authorization controls are the `weknora:admin` scope, admin audience, separate upstream bearer secret, and full-access WeKnora key.

## 4. Confirmed Environment

- WeKnora: `v0.7.2`, commit `3d5d8bfcdfeeea266b292b71cea616847af28d0f`
- REST API: `http://127.0.0.1:18091/api/v1`
- Official MCP package: `tencent-weknora-mcp==1.1.1`
- Existing LobeHub MCP: `192.168.112.1:18192/mcp`, unchanged
- Public site and OAuth issuer: `https://wek.uov.me`
- Keycloak: `127.0.0.1:18195`

## 5. Network Topology

```text
ChatGPT / Claude / MCP client
    |
    | HTTPS + profile-specific OAuth token
    v
OpenResty :443
    |-- /mcp --------------------------------> readonly gateway :18194
    |-- /mcp-admin --------------------------> admin gateway :18197
    |-- protected-resource metadata ---------> matching gateway
    `-- /oauth/* ----------------------------> Keycloak :18195

readonly gateway :18194 -> readonly official MCP :18193 -> scoped retrieve key
admin gateway    :18197 -> admin official MCP    :18196 -> full-access key
```

All four new MCP ports bind to loopback. The existing private `18192` service is not modified.

## 6. OAuth Model

- Issuer: `https://wek.uov.me/oauth/realms/weknora`
- Read resource/audience: `https://wek.uov.me/mcp`
- Admin resource/audience: `https://wek.uov.me/mcp-admin`
- Access token TTL: 10 minutes
- Required validation: signature, `kid`, `iss`, exact `aud`, `exp`, `nbf`, and exact profile scope
- Admin tokens additionally require the `weknora-admin` realm role
- Admin OAuth clients map only the `weknora-admin` role and keep Keycloak `fullScopeAllowed=false`
- Authorization Code flow with PKCE S256 for browser clients
- No anonymous Dynamic Client Registration
- Exact callback URI allow-list; no wildcard redirect URI
- Separate ChatGPT and Claude clients for each profile

Planned clients:

- `chatgpt-weknora-read`
- `chatgpt-weknora-admin`
- `claude-weknora-read`
- `claude-weknora-admin`

## 7. Runtime Design

### Shared HTTP layer

- Publish RFC 9728 protected-resource metadata for the configured resource path
- Return standards-shaped `401` and `403` challenges
- Reject unapproved browser origins
- Apply independent per-IP and per-subject rate limits
- Log correlation, subject, OAuth client, MCP method, tool name, duration, and outcome
- Redact authorization, cookies, codes, tool arguments, query text, model API keys, and upstream secrets
- Provide `/healthz` and `/readyz`

### Read-only MCP server

- Register four hand-written Zod tools
- Reject KB override attempts through strict schemas
- Inject the fixed KB UUID before forwarding

### Admin MCP server

- Load and verify the checked-in official full-tool baseline at startup
- Advertise only baseline-approved tools
- Attach explicit read/write/destructive annotations
- Validate `create_knowledge_from_file.file_path` against the configured import root
- Forward all other approved calls without mutating arguments
- Preserve useful MCP errors while hiding internal URLs and credentials

## 8. Files

- Modify `src/config.ts`: add `GATEWAY_MODE` and admin import-root validation
- Create `src/admin-policy.ts`: full-tool allow-list, annotations, and file-path guard
- Create `src/admin-gateway-server.ts`: low-level SDK handlers for dynamic JSON schemas
- Modify `src/app.ts`: select the MCP server factory by configured mode and publish path-aware metadata
- Modify `src/index.ts`: verify the correct baseline before accepting traffic
- Modify `src/tool-baseline.ts`: reusable full-baseline comparison
- Create `fixtures/upstream-admin-tools-baseline.json`: official 1.1.1 full tool schemas
- Add focused tests under `tests/`
- Add admin systemd units and environment examples under `deploy/systemd/`
- Modify Keycloak, OpenResty, operations, client setup, and README documentation

## 9. Implementation Sequence

### Task 1: Pin the official admin surface

- Capture the 1.1.1 full `tools/list` response through the existing private upstream
- Add tests proving all baseline tools are exposed and unknown/future tools are denied
- Add tests proving the four delete tools are marked destructive

### Task 2: Admin policy and server

- Add a failing test for argument-preserving passthrough
- Add a failing test for unknown tool rejection
- Add failing tests for allowed and rejected server-local file paths
- Implement the minimal admin policy and low-level MCP `tools/list`/`tools/call` handlers

### Task 3: Dual runtime configuration

- Add failing configuration tests for `readonly` and `admin` modes
- Require `ADMIN_IMPORT_ROOT` only in admin mode
- Select the read-only or admin server factory without changing the HTTP authentication path
- Verify each resource metadata document advertises its own audience and scope

### Task 4: Deployment assets

- Add `weknora-mcp-admin-upstream.service` on `18196`
- Add `weknora-mcp-admin-gateway.service` on `18197`
- Add root-readable admin environment and token file examples
- Add `/mcp-admin` and its protected-resource metadata path to OpenResty
- Add `weknora:admin` scope and audience mapper to Keycloak bootstrap
- Add the `weknora-admin` realm role and assign it only to approved operators
- Create static read/admin clients only after the exact callback URIs are known

### Task 5: Local verification

Run:

```bash
npm run clean
npm test
npm run typecheck
npm run build
npm audit --audit-level=high
```

### Task 6: Server deployment and smoke tests

- Install the admin upstream with the existing full-access key in a root-readable file
- Install the admin gateway with an independent MCP bearer secret
- Validate and reload OpenResty
- Create a temporary `weknora:admin` service-account client
- Verify admin initialize and full `tools/list`
- Execute only non-destructive admin smoke calls: `list_knowledge_bases` and `get_knowledge_base`
- Verify a read token is rejected at `/mcp-admin` and an admin token is rejected at `/mcp`
- Remove the temporary client
- Re-run the existing read-only search test and original `18192` regression

## 10. Acceptance Criteria

- `/mcp` still exposes exactly four fixed-KB read tools
- `/mcp-admin` exposes exactly the reviewed official 1.1.1 baseline
- Read and admin tokens are not interchangeable
- A user without the `weknora-admin` realm role is rejected by the admin gateway
- Admin can list all knowledge bases and inspect an explicitly selected KB
- No destructive smoke call is performed during deployment
- The local-file ingestion guard prevents access outside the import directory
- Client and upstream bearer tokens never cross trust boundaries
- Raw ports remain non-public
- Existing LobeHub and Codex paths continue to work
- Tests, type check, build, baseline checks, and high-severity audit pass

## 11. Rollback

Admin rollback is independent: remove the `/mcp-admin` OpenResty locations, disable the two admin systemd units, remove admin OAuth clients/scope mapper, and delete the admin secrets after confirming no clients depend on them. The read-only `/mcp`, existing `18192`, WeKnora REST service, LobeHub, and Codex remain available.

## 12. Limitations

- Full permission means full tenant authority; a compromised admin OAuth account can create or delete WeKnora data.
- MCP destructive annotations do not enforce confirmation in every client.
- Browser file upload is not supplied by the official local-path tool.
- End-user identity is recorded at the gateway, while WeKnora sees the shared profile API key.
- The in-memory limiter assumes one process per profile.
