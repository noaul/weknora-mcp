import { describe, expect, it, vi } from "vitest";

import { buildConsoleApp } from "../src/console-app.js";
import { ConsoleSessionStore } from "../src/console-auth.js";

const KB_A = "51adf856-2722-4a62-be49-b7d1f2cd20b4";
const KB_B = "14f18c87-26b4-4b51-ac9f-cb57ace46df7";

function createFixture() {
  const sessions = new ConsoleSessionStore({
    ttlMs: 60_000,
    secret: Buffer.alloc(32, 9),
  });
  let policy = {
    version: 1 as const,
    defaultKbId: KB_A,
    knowledgeBases: [{ id: KB_A, name: "镍基合金" }],
  };
  const write = vi.fn(async (update, actor) => {
    policy = {
      version: 1,
      defaultKbId: update.defaultKbId,
      knowledgeBases: update.knowledgeBases,
    };
    return { ...policy, updatedAt: "2026-08-31T16:00:00.000Z", updatedBy: actor.username };
  });
  const appendAudit = vi.fn(async () => undefined);
  const oauthClientManager = {
    listManagedClients: vi.fn(async () => [
      {
        key: "chatgpt-read",
        label: "ChatGPT 只读",
        provider: "ChatGPT" as const,
        profile: "read" as const,
        clientId: "chatgpt-weknora-read",
        mcpUrl: "https://wek.uov.me/mcp",
        scope: "weknora:read",
        issuer: "https://wek.uov.me/oauth/realms/weknora",
        authorizationEndpoint:
          "https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/auth",
        tokenEndpoint:
          "https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/token",
        enabled: true,
        redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
        sessionCount: 1,
      },
    ]),
    updateManagedClient: vi.fn(async (_key, update) => ({
      key: "chatgpt-read",
      label: "ChatGPT 只读",
      provider: "ChatGPT" as const,
      profile: "read" as const,
      clientId: "chatgpt-weknora-read",
      mcpUrl: "https://wek.uov.me/mcp",
      scope: "weknora:read",
      issuer: "https://wek.uov.me/oauth/realms/weknora",
      authorizationEndpoint:
        "https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/auth",
      tokenEndpoint:
        "https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/token",
      enabled: update.enabled ?? true,
      redirectUri:
        update.redirectUri ??
        "https://chatgpt.com/connector_platform_oauth_redirect",
      sessionCount: 1,
    })),
    rotateManagedClientSecret: vi.fn(async () => ({
      secret: "new-one-time-secret",
      oldSecretInvalidated: true,
    })),
    revokeManagedClientSessions: vi.fn(async () => ({ revokedSessions: 1 })),
  };
  const app = buildConsoleApp({
    publicUrl: new URL("https://wek.uov.me/mcp-console/"),
    oidc: {
      beginLogin: () => ({
        state: "state-1",
        authorizationUrl: new URL("https://wek.uov.me/oauth/login?state=state-1"),
      }),
      completeLogin: vi.fn(async () => ({
        subject: "user-1",
        username: "aodo",
        roles: ["weknora-admin"],
      })),
    },
    sessions,
    policyStore: {
      read: async () => policy,
      write,
      appendAudit,
      readAudit: async () => [
        { timestamp: "2026-08-31T15:00:00.000Z", actor: "aodo", action: "updated" },
      ],
    },
    oauthClientManager,
    weknora: {
      listKnowledgeBases: async () => [
        {
          id: KB_A,
          name: "镍基合金",
          description: "",
          knowledgeCount: 20922,
          updatedAt: "2026-08-30T19:02:54.648139-07:00",
          capabilities: { keyword: true, vector: true, wiki: true },
        },
        {
          id: KB_B,
          name: "熔盐堆",
          description: "",
          knowledgeCount: 1,
          updatedAt: "2026-08-30T18:52:23.809222-07:00",
          capabilities: { keyword: true, vector: true, wiki: true },
        },
      ],
    },
    checkServices: async () => ({ readGateway: "healthy", adminGateway: "healthy" }),
    indexHtml: "<!doctype html><title>MCP Console</title>",
    logLevel: "silent",
  });
  return { app, write, appendAudit, oauthClientManager };
}

async function login(app: ReturnType<typeof buildConsoleApp>) {
  const start = await app.inject({ method: "GET", url: "/mcp-console/login" });
  const stateCookieHeader = start.headers["set-cookie"];
  const stateCookie = (Array.isArray(stateCookieHeader)
    ? stateCookieHeader[0]
    : stateCookieHeader
  )?.split(";")[0];
  if (!stateCookie) throw new Error("Missing OAuth state cookie");
  const response = await app.inject({
    method: "GET",
    url: "/mcp-console/oauth/callback?state=state-1&code=code-1",
    headers: { cookie: stateCookie },
  });
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
  if (!cookie) throw new Error("Missing session cookie");
  return cookie;
}

describe("MCP console HTTP app", () => {
  it("redirects logged-out users through OIDC", async () => {
    const { app } = createFixture();
    const page = await app.inject({ method: "GET", url: "/mcp-console/" });
    const loginResponse = await app.inject({ method: "GET", url: "/mcp-console/login" });

    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe("/mcp-console/login");
    expect(loginResponse.statusCode).toBe(302);
    expect(loginResponse.headers.location).toContain("/oauth/login");
    await app.close();
  });

  it("creates a secure session after the OAuth callback", async () => {
    const { app } = createFixture();
    const start = await app.inject({ method: "GET", url: "/mcp-console/login" });
    const stateCookieHeader = start.headers["set-cookie"];
    const stateCookie = (Array.isArray(stateCookieHeader)
      ? stateCookieHeader[0]
      : stateCookieHeader
    )?.split(";")[0];
    const callback = await app.inject({
      method: "GET",
      url: "/mcp-console/oauth/callback?state=state-1&code=code-1",
      headers: { cookie: stateCookie },
    });

    expect(callback.statusCode).toBe(302);
    const cookies = String(callback.headers["set-cookie"]);
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("Secure");
    expect(cookies).toContain("SameSite=Strict");
    await app.close();
  });

  it("rejects an OAuth callback that is not bound to the initiating browser", async () => {
    const { app } = createFixture();
    const callback = await app.inject({
      method: "GET",
      url: "/mcp-console/oauth/callback?state=state-1&code=code-1",
    });

    expect(callback.statusCode).toBe(403);
    await app.close();
  });

  it("returns a secret-free overview for an authenticated administrator", async () => {
    const { app } = createFixture();
    const cookie = await login(app);
    const session = await app.inject({
      method: "GET",
      url: "/mcp-console/api/session",
      headers: { cookie },
    });
    const overview = await app.inject({
      method: "GET",
      url: "/mcp-console/api/overview",
      headers: { cookie },
    });

    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ username: "aodo" });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      policy: { defaultKbId: KB_A },
      services: { readGateway: "healthy", adminGateway: "healthy" },
    });
    expect(overview.json().knowledgeBases).toHaveLength(2);
    expect(JSON.stringify(overview.json())).not.toMatch(/secret|api.?key/i);
    await app.close();
  });

  it("requires CSRF and resolves selected IDs against live knowledge bases", async () => {
    const { app, write } = createFixture();
    const cookie = await login(app);
    const session = await app.inject({
      method: "GET",
      url: "/mcp-console/api/session",
      headers: { cookie },
    });
    const csrf = session.json().csrfToken as string;

    const rejected = await app.inject({
      method: "PUT",
      url: "/mcp-console/api/policy",
      headers: { cookie },
      payload: { defaultKbId: KB_B, allowedKbIds: [KB_A, KB_B] },
    });
    const accepted = await app.inject({
      method: "PUT",
      url: "/mcp-console/api/policy",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { defaultKbId: KB_B, allowedKbIds: [KB_A, KB_B] },
    });

    expect(rejected.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(200);
    expect(write).toHaveBeenCalledWith(
      {
        defaultKbId: KB_B,
        knowledgeBases: [
          { id: KB_A, name: "镍基合金" },
          { id: KB_B, name: "熔盐堆" },
        ],
      },
      { subject: "user-1", username: "aodo" },
    );
    await app.close();
  });

  it("rejects unknown knowledge-base IDs", async () => {
    const { app, write } = createFixture();
    const cookie = await login(app);
    const session = await app.inject({
      method: "GET",
      url: "/mcp-console/api/session",
      headers: { cookie },
    });
    const response = await app.inject({
      method: "PUT",
      url: "/mcp-console/api/policy",
      headers: { cookie, "x-csrf-token": session.json().csrfToken },
      payload: {
        defaultKbId: "0787e321-6f1e-4471-86a9-339165e51644",
        allowedKbIds: ["0787e321-6f1e-4471-86a9-339165e51644"],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(write).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires CSRF for logout", async () => {
    const { app } = createFixture();
    const cookie = await login(app);
    const session = await app.inject({
      method: "GET",
      url: "/mcp-console/api/session",
      headers: { cookie },
    });

    const rejected = await app.inject({
      method: "POST",
      url: "/mcp-console/logout",
      headers: { cookie },
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/mcp-console/logout",
      headers: { cookie, "x-csrf-token": session.json().csrfToken },
    });

    expect(rejected.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(204);
    expect(String(accepted.headers["set-cookie"])).toContain("Max-Age=0");
    await app.close();
  });

  it("manages allow-listed OAuth clients with CSRF and audit records", async () => {
    const { app, appendAudit, oauthClientManager } = createFixture();
    const cookie = await login(app);
    const session = await app.inject({
      method: "GET",
      url: "/mcp-console/api/session",
      headers: { cookie },
    });
    const csrf = session.json().csrfToken as string;

    const list = await app.inject({
      method: "GET",
      url: "/mcp-console/api/oauth-clients",
      headers: { cookie },
    });
    const rejected = await app.inject({
      method: "PUT",
      url: "/mcp-console/api/oauth-clients/chatgpt-read",
      headers: { cookie },
      payload: { enabled: false },
    });
    const updated = await app.inject({
      method: "PUT",
      url: "/mcp-console/api/oauth-clients/chatgpt-read",
      headers: { cookie, "x-csrf-token": csrf },
      payload: {
        enabled: false,
        redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
      },
    });
    appendAudit.mockRejectedValueOnce(new Error("audit unavailable"));
    const rotated = await app.inject({
      method: "POST",
      url: "/mcp-console/api/oauth-clients/chatgpt-read/rotate-secret",
      headers: { cookie, "x-csrf-token": csrf },
    });
    const revoked = await app.inject({
      method: "POST",
      url: "/mcp-console/api/oauth-clients/chatgpt-read/revoke-sessions",
      headers: { cookie, "x-csrf-token": csrf },
    });

    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain("new-one-time-secret");
    expect(rejected.statusCode).toBe(403);
    expect(updated.statusCode).toBe(200);
    expect(rotated.json()).toEqual({
      secret: "new-one-time-secret",
      oldSecretInvalidated: true,
    });
    expect(revoked.json()).toEqual({ revokedSessions: 1 });
    expect(oauthClientManager.updateManagedClient).toHaveBeenCalledWith(
      "chatgpt-read",
      {
        enabled: false,
        redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
      },
    );
    expect(appendAudit).toHaveBeenCalledTimes(3);
    await app.close();
  });
});
