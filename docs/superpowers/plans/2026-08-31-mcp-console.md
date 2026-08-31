# WeKnora MCP Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independently deployed, Keycloak-protected management console that controls which WeKnora knowledge bases the read-only MCP gateway may access without modifying the official WeKnora image.

**Architecture:** A new Fastify sidecar listens on loopback port `18198` and is published at `/mcp-console/`. It performs an OIDC authorization-code flow against the existing Keycloak realm, requires the `weknora-admin` role, reads available knowledge bases from the loopback WeKnora REST API, and atomically writes a versioned policy file. The read gateway reads that policy for every MCP tool call, accepts an optional allow-listed `kb_id`, and defaults to the configured default knowledge base.

**Tech Stack:** TypeScript 7, Node.js 20, Fastify 5, `jose`, Zod, Vitest, vanilla HTML/CSS/JavaScript, systemd, OpenResty, Keycloak 26.

---

### Task 1: Versioned knowledge-base policy store

**Files:**
- Create: `src/knowledge-policy.ts`
- Create: `tests/knowledge-policy.test.ts`

- [ ] **Step 1: Write failing validation and atomic-store tests**

Cover a valid policy, duplicate IDs, a default outside the allow-list, fallback to the legacy fixed KB when the file is missing, atomic writes, and append-only audit records.

```ts
const fallback = { id: KB_A, name: "Alloy" };
const store = new FileKnowledgePolicyStore({ policyFile, auditFile, fallback });
expect(await store.read()).toEqual({ version: 1, defaultKbId: KB_A, knowledgeBases: [fallback] });
await store.write({ defaultKbId: KB_B, knowledgeBases: [kbA, kbB] }, actor);
expect((await store.read()).defaultKbId).toBe(KB_B);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/knowledge-policy.test.ts`

Expected: FAIL because `src/knowledge-policy.ts` does not exist.

- [ ] **Step 3: Implement the validated store**

Define `KnowledgeBaseChoice`, `KnowledgePolicy`, `KnowledgePolicyProvider`, and `FileKnowledgePolicyStore`. Validate UUIDs and uniqueness with Zod, write `policy.tmp` followed by `rename`, and append one JSON object per audit line.

- [ ] **Step 4: Run focused and full tests**

Run: `npm test -- tests/knowledge-policy.test.ts && npm test`

Expected: focused tests pass and the existing 47 tests remain green.

### Task 2: Dynamic allow-list enforcement in read MCP

**Files:**
- Modify: `src/gateway-server.ts`
- Modify: `src/app.ts`
- Modify: `src/index.ts`
- Modify: `src/config.ts`
- Modify: `tests/gateway-server.test.ts`
- Modify: `tests/app.test.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing MCP behavior tests**

Require five read tools, including `list_allowed_knowledge_bases`; make `kb_id` optional for the four existing tools; verify omitted `kb_id` uses the default, an allowed explicit ID is forwarded, and a disallowed ID returns an MCP policy error without calling upstream.

```ts
await client.callTool({ name: "hybrid_search", arguments: { kb_id: KB_B, query: "salt" } });
expect(upstream.callTool).toHaveBeenCalledWith({
  name: "hybrid_search",
  arguments: { kb_id: KB_B, query: "salt" },
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/gateway-server.test.ts tests/app.test.ts tests/config.test.ts`

Expected: FAIL because the current server exposes four fixed-KB tools and has no policy-file configuration.

- [ ] **Step 3: Implement policy-provider wiring**

Add `KNOWLEDGE_POLICY_FILE` and `KNOWLEDGE_AUDIT_FILE` configuration. Pass a `KnowledgePolicyProvider` into each read MCP server. Resolve and validate the selected KB inside each tool handler immediately before the upstream call.

- [ ] **Step 4: Run focused and full tests**

Run: `npm test -- tests/gateway-server.test.ts tests/app.test.ts tests/config.test.ts && npm test`

Expected: all tests pass.

### Task 3: WeKnora REST client and console OIDC/session layer

**Files:**
- Create: `src/weknora-api.ts`
- Create: `src/console-config.ts`
- Create: `src/console-auth.ts`
- Create: `tests/weknora-api.test.ts`
- Create: `tests/console-config.test.ts`
- Create: `tests/console-auth.test.ts`

- [ ] **Step 1: Write failing client/config/auth tests**

Test structured parsing of `GET /knowledge-bases`, API-key header isolation, loopback/HTTPS validation, PKCE login URL generation, state replay rejection, ID-token issuer/audience/nonce verification, required realm-role enforcement, opaque session cookies, expiry, and CSRF checks.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/weknora-api.test.ts tests/console-config.test.ts tests/console-auth.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the minimal clients**

Use `fetch` with `X-API-Key`, `createRemoteJWKSet`, `jwtVerify`, `randomBytes`, and `S256` PKCE. Keep authorization transactions and authenticated sessions in bounded in-memory maps; use `Secure`, `HttpOnly`, `SameSite=Strict`, and path-scoped cookies.

- [ ] **Step 4: Run focused and full tests**

Run: `npm test -- tests/weknora-api.test.ts tests/console-config.test.ts tests/console-auth.test.ts && npm test`

Expected: all tests pass.

### Task 4: Management API and audit-backed updates

**Files:**
- Create: `src/console-app.ts`
- Create: `src/console-index.ts`
- Create: `tests/console-app.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.build.json`

- [ ] **Step 1: Write failing HTTP API tests**

Cover login redirect, callback failure, unauthenticated API rejection, role-protected session metadata, overview data, CSRF-protected policy updates, unknown KB rejection, service-health aggregation, logout, and no secret fields in JSON responses.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/console-app.test.ts`

Expected: FAIL because the console application is missing.

- [ ] **Step 3: Implement routes**

Serve `/mcp-console/`, `/mcp-console/login`, `/mcp-console/oauth/callback`, `/mcp-console/logout`, `/mcp-console/api/session`, `/mcp-console/api/overview`, and `PUT /mcp-console/api/policy`. Resolve KB names from the live WeKnora response before storing a policy and record the authenticated subject as the audit actor.

- [ ] **Step 4: Run focused and full tests**

Run: `npm test -- tests/console-app.test.ts && npm test && npm run typecheck && npm run build`

Expected: tests, typecheck, and build all pass.

### Task 5: Functional management UI

**Files:**
- Create: `console/index.html`
- Create: `console/app.css`
- Create: `console/app.js`
- Create: `tests/console-assets.test.ts`

- [ ] **Step 1: Write failing asset contract tests**

Verify the page contains a knowledge-base table, accessible checkboxes, default-KB radio controls, service-state region, audit region, save button, logout command, empty/error/loading states, and no embedded secrets.

- [ ] **Step 2: Run the asset test and verify RED**

Run: `npm test -- tests/console-assets.test.ts`

Expected: FAIL because the assets do not exist.

- [ ] **Step 3: Build the UI**

Use a quiet WeKnora-aligned operational layout: compact header, restrained white/gray surfaces, cyan status accents, 6px radii, stable table columns, responsive mobile list layout, familiar icon buttons with tooltips, and no marketing content. Fetch overview/session data, keep local dirty state, disable save until valid, and show a confirmation dialog before applying policy changes.

- [ ] **Step 4: Run tests and browser checks**

Run: `npm test -- tests/console-assets.test.ts && npm test && npm run build`

Expected: all checks pass. Use browser screenshots at desktop and mobile widths after deployment to verify no overlap or clipped controls.

### Task 6: Upgrade-safe deployment

**Files:**
- Create: `deploy/systemd/weknora-mcp-console.service`
- Create: `deploy/systemd/console.env.example`
- Create: `deploy/scripts/install-console.sh`
- Modify: `deploy/scripts/configure-keycloak.sh`
- Modify: `deploy/openresty/wek.uov.me-mcp.conf`
- Modify: `deploy/systemd/gateway.env.example`
- Modify: `docs/operations.md`
- Modify: `README.md`

- [ ] **Step 1: Add deployment contract tests**

Extend configuration tests to require a confidential `weknora-mcp-console` client with exact callback `/mcp-console/oauth/callback`, role mapping, loopback bind, root-owned secret files, writable policy/audit directory, and OpenResty routes that do not overlap official WeKnora paths.

- [ ] **Step 2: Implement deployment assets**

Run the console as `weknora-console` on `127.0.0.1:18198`, mount no official WeKnora files, store state in `/var/lib/weknora-mcp-console`, and publish only `location ^~ /mcp-console/`. Keep `/opt/weknora`, `WeKnora-frontend`, and `WeKnora-app` untouched.

- [ ] **Step 3: Run complete verification**

Run: `npm test && npm run typecheck && npm run build && npm audit`

Expected: zero test failures, zero type errors, successful build, and zero known vulnerabilities.

- [ ] **Step 4: Deploy and smoke test nc48**

Install the release, create the console OAuth secret and session secret without printing them, initialize the policy with the existing `镍基合金` KB, configure Keycloak, reload OpenResty, start the console, and verify:

```text
GET /mcp-console/ -> 302 to Keycloak when logged out
GET /mcp-console/api/overview -> 401 when logged out
read gateway -> five tools
default search -> existing 镍基合金 ID
disallowed KB -> policy error without upstream execution
official WeKnora containers -> unchanged image IDs and healthy status
```

- [ ] **Step 5: Browser verification**

Sign in as `aodo`, verify all five current knowledge bases render, change the allow-list with a non-destructive test, confirm the read MCP immediately reflects it, restore the intended policy, and capture desktop/mobile screenshots.
