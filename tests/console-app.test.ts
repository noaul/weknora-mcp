import { describe, expect, it, vi } from "vitest";

import { buildConsoleApp } from "../src/console-app.js";
import { ConsoleSessionStore } from "../src/console-auth.js";

const KB_A = "51adf856-2722-4a62-be49-b7d1f2cd20b4";
const KB_B = "14f18c87-26b4-4b51-ac9f-cb57ace46df7";
const CHATGPT_CLIENT_ID = "chatgpt-weknora-read";

function createFixture() {
  const sessions = new ConsoleSessionStore({
    ttlMs: 60_000,
    secret: Buffer.alloc(32, 9),
  });
  let policy = {
    version: 2 as const,
    clients: [
      {
        clientId: CHATGPT_CLIENT_ID,
        label: "ChatGPT WeKnora",
        provider: "ChatGPT" as const,
        accessType: "capabilities" as const,
        capabilities: ["knowledge.read" as const],
        knowledgeBaseScope: "selected" as const,
        defaultKbId: KB_A,
        knowledgeBases: [{ id: KB_A, name: "镍基合金" }],
      },
      {
        clientId: "claude-weknora-read",
        label: "Claude WeKnora",
        provider: "Claude" as const,
        accessType: "capabilities" as const,
        capabilities: ["knowledge.read" as const],
        knowledgeBaseScope: "selected" as const,
        defaultKbId: KB_A,
        knowledgeBases: [{ id: KB_A, name: "镍基合金" }],
      },
    ],
  };
  const writeClient = vi.fn(async (clientId, update, actor) => {
    policy = {
      version: 2,
      clients: policy.clients.map((client) =>
        client.clientId === clientId
          ? ({ ...client, ...update } as (typeof policy.clients)[number])
          : client,
      ),
    };
    return {
      ...policy,
      updatedAt: "2026-09-01T02:00:00.000Z",
      updatedBy: actor.username,
    };
  });
  const appendAudit = vi.fn(async () => undefined);
  const oauthClientManager = {
    listManagedClients: vi.fn(async () => [
      {
        key: "chatgpt-read",
        label: "ChatGPT WeKnora",
        provider: "ChatGPT" as const,
        clientId: CHATGPT_CLIENT_ID,
        mcpUrl: "https://wek.uov.me/mcp",
        scope: "weknora:mcp",
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
      label: "ChatGPT WeKnora",
      provider: "ChatGPT" as const,
      clientId: CHATGPT_CLIENT_ID,
      mcpUrl: "https://wek.uov.me/mcp",
      scope: "weknora:mcp",
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
    accessPolicyStore: {
      read: async () => policy,
      writeClient,
      appendAudit,
      readAudit: async () => [
        {
          timestamp: "2026-09-01T01:00:00.000Z",
          actor: "aodo",
          action: "updated",
        },
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
    checkServices: async () => ({ gateway: "healthy" }),
    indexHtml: "<!doctype html><title>MCP Console</title>",
    logLevel: "silent",
  });
  return { app, writeClient, appendAudit, oauthClientManager };
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

async function csrf(app: ReturnType<typeof buildConsoleApp>, cookie: string) {
  const response = await app.inject({
    method: "GET",
    url: "/mcp-console/api/session",
    headers: { cookie },
  });
  return response.json().csrfToken as string;
}

describe("MCP console HTTP app", () => {
  it("redirects logged-out users through OIDC", async () => {
    const { app } = createFixture();
    const page = await app.inject({ method: "GET", url: "/mcp-console/" });
    const loginResponse = await app.inject({ method: "GET", url: "/mcp-console/login" });

    expect(page.statusCode).toBe(302);
    expect(loginResponse.headers.location).toContain("/oauth/login");
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

  it("returns a secret-free overview with one gateway health status", async () => {
    const { app } = createFixture();
    const cookie = await login(app);
    const overview = await app.inject({
      method: "GET",
      url: "/mcp-console/api/overview",
      headers: { cookie },
    });

    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      policy: { version: 2 },
      services: { gateway: "healthy" },
    });
    expect(overview.json().knowledgeBases).toHaveLength(2);
    expect(JSON.stringify(overview.json())).not.toMatch(/secret|api.?key/i);
    await app.close();
  });

  it("merges each OAuth client with its MCP access policy", async () => {
    const { app } = createFixture();
    const cookie = await login(app);
    const response = await app.inject({
      method: "GET",
      url: "/mcp-console/api/oauth-clients",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      capabilities: expect.arrayContaining(["knowledge.read", "models.manage"]),
      clients: [
        {
          clientId: CHATGPT_CLIENT_ID,
          scope: "weknora:mcp",
          access: {
            accessType: "capabilities",
            capabilities: ["knowledge.read"],
            knowledgeBaseScope: "selected",
            defaultKbId: KB_A,
          },
        },
      ],
    });
    expect(JSON.stringify(response.json())).not.toContain("new-one-time-secret");
    await app.close();
  });

  it("updates one managed client's capabilities and selected knowledge bases", async () => {
    const { app, writeClient } = createFixture();
    const cookie = await login(app);
    const token = await csrf(app, cookie);
    const payload = {
      accessType: "capabilities",
      capabilities: ["knowledge.read", "conversation.use"],
      knowledgeBaseScope: "selected",
      defaultKbId: KB_B,
      allowedKbIds: [KB_A, KB_B],
    };
    const rejected = await app.inject({
      method: "PUT",
      url: "/mcp-console/api/oauth-clients/chatgpt-read/access-policy",
      headers: { cookie },
      payload,
    });
    const accepted = await app.inject({
      method: "PUT",
      url: "/mcp-console/api/oauth-clients/chatgpt-read/access-policy",
      headers: { cookie, "x-csrf-token": token },
      payload,
    });

    expect(rejected.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(200);
    expect(writeClient).toHaveBeenCalledWith(
      CHATGPT_CLIENT_ID,
      {
        accessType: "capabilities",
        capabilities: ["knowledge.read", "conversation.use"],
        knowledgeBaseScope: "selected",
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

  it("normalizes full access to all knowledge bases and no capability overrides", async () => {
    const { app, writeClient } = createFixture();
    const cookie = await login(app);
    const token = await csrf(app, cookie);
    const response = await app.inject({
      method: "PUT",
      url: "/mcp-console/api/oauth-clients/chatgpt-read/access-policy",
      headers: { cookie, "x-csrf-token": token },
      payload: {
        accessType: "full",
        capabilities: [],
        knowledgeBaseScope: "all",
        defaultKbId: KB_A,
        allowedKbIds: [],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(writeClient).toHaveBeenCalledWith(
      CHATGPT_CLIENT_ID,
      expect.objectContaining({
        accessType: "full",
        capabilities: [],
        knowledgeBaseScope: "all",
        knowledgeBases: [],
      }),
      expect.anything(),
    );
    await app.close();
  });

  it("rejects unknown clients, capabilities, and knowledge bases", async () => {
    const { app, writeClient } = createFixture();
    const cookie = await login(app);
    const token = await csrf(app, cookie);
    const base = {
      accessType: "capabilities",
      capabilities: ["knowledge.read"],
      knowledgeBaseScope: "selected",
      defaultKbId: KB_A,
      allowedKbIds: [KB_A],
    };
    const unknownClient = await app.inject({
      method: "PUT",
      url: "/mcp-console/api/oauth-clients/chatgpt-admin/access-policy",
      headers: { cookie, "x-csrf-token": token },
      payload: base,
    });
    const unknownCapability = await app.inject({
      method: "PUT",
      url: "/mcp-console/api/oauth-clients/chatgpt-read/access-policy",
      headers: { cookie, "x-csrf-token": token },
      payload: { ...base, capabilities: ["tenant.root"] },
    });
    const unknownKb = await app.inject({
      method: "PUT",
      url: "/mcp-console/api/oauth-clients/chatgpt-read/access-policy",
      headers: { cookie, "x-csrf-token": token },
      payload: {
        ...base,
        defaultKbId: "0787e321-6f1e-4471-86a9-339165e51644",
        allowedKbIds: ["0787e321-6f1e-4471-86a9-339165e51644"],
      },
    });

    expect(unknownClient.statusCode).toBe(400);
    expect(unknownCapability.statusCode).toBe(400);
    expect(unknownKb.statusCode).toBe(400);
    expect(writeClient).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps OAuth configuration, secret rotation, and session revocation managed", async () => {
    const { app, appendAudit, oauthClientManager } = createFixture();
    const cookie = await login(app);
    const token = await csrf(app, cookie);
    const updated = await app.inject({
      method: "PUT",
      url: "/mcp-console/api/oauth-clients/chatgpt-read",
      headers: { cookie, "x-csrf-token": token },
      payload: {
        enabled: false,
        redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
      },
    });
    appendAudit.mockRejectedValueOnce(new Error("audit unavailable"));
    const rotated = await app.inject({
      method: "POST",
      url: "/mcp-console/api/oauth-clients/chatgpt-read/rotate-secret",
      headers: { cookie, "x-csrf-token": token },
    });
    const revoked = await app.inject({
      method: "POST",
      url: "/mcp-console/api/oauth-clients/chatgpt-read/revoke-sessions",
      headers: { cookie, "x-csrf-token": token },
    });

    expect(updated.statusCode).toBe(200);
    expect(rotated.json()).toEqual({
      secret: "new-one-time-secret",
      oldSecretInvalidated: true,
    });
    expect(revoked.json()).toEqual({ revokedSessions: 1 });
    expect(oauthClientManager.updateManagedClient).toHaveBeenCalledOnce();
    expect(appendAudit).toHaveBeenCalledTimes(3);
    await app.close();
  });
});
