# Unified MCP Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate read/admin MCP profiles with one OAuth-protected `/mcp` endpoint whose tools and knowledge-base access are configured independently for each managed ChatGPT or Claude OAuth client.

**Architecture:** Keep the official WeKnora MCP server and Tenant API key behind the gateway. The access gateway identifies the OAuth client from the verified token `azp`/`client_id`, loads a versioned server-side client policy, exposes only the permitted reviewed tools, and rechecks both capability and knowledge-base scope for every call. The existing sidecar console manages OAuth client settings and the new access policy without modifying the official WeKnora image.

**Tech Stack:** TypeScript 7, Fastify 5, MCP SDK 1.30, Zod 4, Keycloak OAuth/OIDC, Vitest, vanilla HTML/CSS/JavaScript, systemd, OpenResty.

---

### Task 1: Versioned Per-Client Access Policy

**Files:**
- Create: `src/access-policy.ts`
- Create: `tests/access-policy.test.ts`
- Modify: `src/knowledge-policy.ts`

- [ ] **Step 1: Write failing policy parser tests**

Test a version-2 policy containing `chatgpt-weknora-read` and `claude-weknora-read`, capability access versus full-space access, unique client IDs, valid capability IDs, unique knowledge-base IDs, and a default knowledge base contained in the client allow-list.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/access-policy.test.ts`

Expected: FAIL because `src/access-policy.ts` does not exist.

- [ ] **Step 3: Implement the access-policy types and file store**

Define these capability IDs:

```ts
export const MCP_CAPABILITIES = [
  "knowledge.read",
  "conversation.use",
  "knowledge.write",
  "knowledge.manage",
  "agents.read",
  "models.manage",
] as const;
```

Define `ClientAccessPolicy` with `clientId`, `label`, `provider`, `accessType`, `capabilities`, `defaultKbId`, and `knowledgeBases`. Define `McpAccessPolicy` version 2 with a `clients` array. Implement atomic writes and audit records using the existing file permissions and write queue pattern.

- [ ] **Step 4: Support migration from the version-1 knowledge policy**

When the file contains version 1, return a version-2 in-memory policy that grants both existing read clients `knowledge.read` over the old allow-list. Do not grant write or management capabilities during migration.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run: `npx vitest run tests/access-policy.test.ts`

Expected: all access-policy tests pass.

### Task 2: Capability Catalog and Safe Tool Filtering

**Files:**
- Create: `src/tool-capabilities.ts`
- Create: `tests/tool-capabilities.test.ts`
- Modify: `src/admin-policy.ts`

- [ ] **Step 1: Write failing tool-catalog tests**

Require every tool in `fixtures/upstream-admin-tools-baseline.json` to be classified as one of:

```text
capability tool
full-space-only tool
replaced by a safer gateway tool
```

Require `hybrid_search`, `wiki_search`, `wiki_read_page`, `wiki_index_view`, `get_knowledge_base`, and `list_knowledge` to be knowledge-base scoped. Require `create_knowledge_from_file`, `create_knowledge_from_url`, and `create_knowledge_from_text` to map to `knowledge.write`. Require tenant creation/listing, agent chat, and unscoped destructive resource-ID tools to remain full-space-only unless an ownership check exists.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/tool-capabilities.test.ts`

Expected: FAIL because the capability catalog does not exist.

- [ ] **Step 3: Implement an exhaustive reviewed catalog**

Export helpers that return the required capability, whether a tool is full-space-only, annotations, and whether `kb_id` or `knowledge_base_ids` must be checked. Throw during startup if the official baseline contains an unclassified tool.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npx vitest run tests/tool-capabilities.test.ts`

Expected: every reviewed upstream tool is classified exactly once.

### Task 3: Unified MCP Server

**Files:**
- Create: `src/unified-gateway-server.ts`
- Create: `tests/unified-gateway-server.test.ts`
- Modify: `src/policy.ts`
- Delete: `src/admin-gateway-server.ts`

- [ ] **Step 1: Write failing tool-list tests**

Test that a `knowledge.read` client receives `list_allowed_knowledge_bases`, the safe read tools, and optional `kb_id` schemas, but no write/admin tools. Test that a full-space client receives the entire reviewed upstream baseline plus `list_allowed_knowledge_bases`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/unified-gateway-server.test.ts`

Expected: FAIL because the unified server does not exist.

- [ ] **Step 3: Implement dynamic tool listing**

Build a low-level MCP `Server` per authenticated HTTP request. Load the client policy once, generate the allowed tool definitions, replace the four retrieval schemas with optional `kb_id`, and add the synthetic `list_allowed_knowledge_bases` tool.

- [ ] **Step 4: Write failing call-enforcement tests**

Test omitted `kb_id` defaulting, allowed explicit IDs, rejected IDs, rejected capabilities, rejected unknown clients, full-space calls, `knowledge_base_ids` array enforcement, and file imports outside `ADMIN_IMPORT_ROOT`.

- [ ] **Step 5: Run the focused call tests and verify RED**

Run: `npx vitest run tests/unified-gateway-server.test.ts`

Expected: the new call-enforcement cases fail before implementation.

- [ ] **Step 6: Implement call-time enforcement**

Recheck the tool catalog and client policy for every `tools/call`. Inject the default KB only for the safe retrieval tools. Reject disallowed KB IDs before contacting upstream. Keep the existing canonical-path import-root check. Return MCP policy errors without exposing tokens or arguments in logs.

- [ ] **Step 7: Run the focused tests and verify GREEN**

Run: `npx vitest run tests/unified-gateway-server.test.ts tests/tool-capabilities.test.ts`

Expected: all unified gateway tests pass.

### Task 4: Single Gateway Configuration and HTTP Wiring

**Files:**
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `src/app.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/app.test.ts`
- Delete: `tests/admin-gateway-server.test.ts`

- [ ] **Step 1: Write failing configuration and HTTP tests**

Require one gateway mode, one `/mcp` audience, one OAuth scope, one access-policy store, a reviewed full-tool baseline, and a mandatory absolute import root. Test that the HTTP layer passes the authenticated `clientId` to the unified server and rejects tokens without a managed client ID.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run tests/config.test.ts tests/app.test.ts`

Expected: failures reference the old `readonly/admin` branch and missing unified options.

- [ ] **Step 3: Remove gateway-mode branching**

Delete `GATEWAY_MODE`, `OAUTH_REQUIRED_ROLE`, and the separate admin-server construction. Load `fixtures/upstream-admin-tools-baseline.json` for the single official upstream. Construct `FileMcpAccessPolicyStore` and create the unified server with `principal.clientId`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/config.test.ts tests/app.test.ts`

Expected: all gateway configuration and HTTP tests pass.

### Task 5: Unified OAuth Client Management

**Files:**
- Modify: `src/keycloak-admin.ts`
- Modify: `tests/keycloak-admin.test.ts`
- Modify: `deploy/scripts/configure-keycloak.sh`
- Modify: `tests/deploy-config.test.ts`

- [ ] **Step 1: Write failing managed-client tests**

Require exactly two managed clients: ChatGPT and Claude. Preserve the deployed client IDs `chatgpt-weknora-read` and `claude-weknora-read` to avoid unnecessary secret/callback replacement, but label both as unified MCP clients and use the single `/mcp` resource.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run tests/keycloak-admin.test.ts tests/deploy-config.test.ts`

Expected: tests fail because four read/admin definitions still exist.

- [ ] **Step 3: Implement the unified definitions and Keycloak migration**

Create one `weknora:mcp` client scope/audience for `/mcp`, attach it to the two retained clients, and remove or disable the obsolete `chatgpt-weknora-admin` and `claude-weknora-admin` clients. Preserve exact redirect URIs and never print client secrets.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/keycloak-admin.test.ts tests/deploy-config.test.ts`

Expected: two managed clients and no admin profile references remain.

### Task 6: MCP Console Permission Editor

**Files:**
- Modify: `src/console-app.ts`
- Modify: `src/console-index.ts`
- Modify: `src/console-config.ts`
- Modify: `console/index.html`
- Modify: `console/app.js`
- Modify: `console/app.css`
- Modify: `tests/console-app.test.ts`
- Modify: `tests/console-assets.test.ts`
- Modify: `tests/console-config.test.ts`

- [ ] **Step 1: Write failing console API tests**

Add authenticated/CSRF-protected endpoints to read and update a specific OAuth client's `accessType`, `capabilities`, `defaultKbId`, and `allowedKbIds`. Reject unknown clients, unknown capability IDs, unknown knowledge bases, duplicate IDs, and empty capability policies.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/console-app.test.ts tests/console-config.test.ts`

Expected: the client-policy API endpoints are missing.

- [ ] **Step 3: Implement the console API**

Merge OAuth client summaries with their access policy. Write audit events containing client ID, access type, capability IDs, and knowledge-base IDs, but never secrets or tokens. Replace separate read/admin health fields with a single gateway health field.

- [ ] **Step 4: Write failing console asset tests**

Require the UI to contain an access-type segmented control, capability checkboxes grouped by domain, knowledge-base selection, full-space warning, OAuth client ID/secret rotation/session revocation controls, and no read/admin profile cards.

- [ ] **Step 5: Run asset tests and verify RED**

Run: `npx vitest run tests/console-assets.test.ts`

Expected: old read/admin markup remains and the capability editor is absent.

- [ ] **Step 6: Implement the permission editor UI**

Render one card per ChatGPT/Claude client. Use checkboxes for capabilities, a segmented access-type control, and a knowledge-base selector. Keep unsupported official API-key categories disabled and labelled `当前官方 MCP 无对应工具` rather than granting unenforceable access.

- [ ] **Step 7: Run console tests and verify GREEN**

Run: `npx vitest run tests/console-app.test.ts tests/console-assets.test.ts tests/console-config.test.ts`

Expected: console API and UI tests pass.

### Task 7: Remove the `/mcp-admin` Deployment Surface

**Files:**
- Modify: `deploy/openresty/wek.uov.me-mcp.conf`
- Modify: `deploy/systemd/weknora-mcp-access-gateway.service`
- Modify: `deploy/systemd/gateway.env.example`
- Modify: `deploy/systemd/console.env.example`
- Modify: `deploy/scripts/probe.sh`
- Modify: `deploy/scripts/install-console.sh`
- Delete: `deploy/systemd/weknora-mcp-admin-gateway.service`
- Delete: `deploy/systemd/weknora-mcp-admin-upstream.service`
- Delete: `deploy/systemd/admin-gateway.env.example`
- Modify: `README.md`
- Modify: `docs/client-setup.md`
- Modify: `docs/operations.md`

- [ ] **Step 1: Write failing deployment assertions**

Update deployment tests to reject `/mcp-admin`, ports 18196/18197, read/admin client names, and separate gateway health variables. Require `/mcp` to allow the larger reviewed request size and the OpenResty OAuth header buffers.

- [ ] **Step 2: Run deployment tests and verify RED**

Run: `npx vitest run tests/deploy-config.test.ts tests/docs.test.ts`

Expected: old admin service and proxy references are detected.

- [ ] **Step 3: Remove obsolete files and references**

Keep one official upstream process, one access gateway, one console, one `/mcp` protected-resource metadata endpoint, and one `/mcp` OpenResty route. Document the unified capability model and Tenant API key trust boundary.

- [ ] **Step 4: Run deployment tests and verify GREEN**

Run: `npx vitest run tests/deploy-config.test.ts tests/docs.test.ts`

Expected: no `/mcp-admin` deployment references remain.

### Task 8: Full Verification, Deployment, and Cutover

**Files:**
- Modify only if verification exposes a tested defect.

- [ ] **Step 1: Run complete local verification**

Run:

```powershell
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all tests, typecheck, build, and whitespace checks pass.

- [ ] **Step 2: Back up live configuration and policy**

Create timestamped backups of the live systemd units, Keycloak realm/client configuration, OpenResty fragment, and access-policy file without copying secrets into the repository or command output.

- [ ] **Step 3: Deploy the unified gateway and console**

Install the built application, migrate the policy to version 2, point the single gateway at the existing official upstream using the Tenant API key, reload systemd, test OpenResty configuration, and hot reload OpenResty.

- [ ] **Step 4: Migrate OAuth clients**

Preserve callback URIs and existing retained client secrets. Attach the unified scope, revoke stale sessions if required, and remove the two obsolete admin clients only after the retained clients authenticate successfully.

- [ ] **Step 5: Run live probes**

Verify protected-resource metadata, unauthenticated 401 behavior, gateway and console health, two-client policy reads, allowed/disallowed tool lists, allowed/disallowed KB calls, full-space tool access, audit logging, and absence of `/mcp-admin`.

- [ ] **Step 6: Refresh and test ChatGPT**

In ChatGPT workspace management, refresh WeKnora actions. Verify the default granular profile only exposes its configured tools, can list the five permitted knowledge bases, can search GH3539, and cannot invoke a disabled write or management tool. Then temporarily grant one non-destructive extra capability, refresh, verify its tools appear, and restore the intended policy.

- [ ] **Step 7: Commit, merge, and push**

Commit the feature branch, merge it into `main` only after live verification, push `main`, confirm the worktree is clean, and preserve a rollback tag or branch at the pre-cutover commit.
