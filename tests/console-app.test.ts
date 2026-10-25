import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FileMcpAccessPolicyStore } from "../src/access-policy.js";
import { LoginThrottle } from "../src/admin-users.js";
import { buildConsoleApp } from "../src/console-app.js";
import { ConsoleSessionStore } from "../src/console-auth.js";
import type { OAuthClientState } from "../src/oauth-clients.js";
import { MANAGED_ACCESS_CLIENTS } from "../src/managed-clients.js";
import { FileStaticTokenStore } from "../src/static-tokens.js";

const KB_A = "51adf856-2722-4a62-be49-b7d1f2cd20b4";
const KB_B = "14f18c87-26b4-4b51-ac9f-cb57ace46df7";
const CHATGPT_CLIENT_ID = "chatgpt-weknora-read";

const PASSWORD = "correct horse battery";

function fakeOAuthClients() {
  const clients = new Map<string, OAuthClientState>([
    [
      CHATGPT_CLIENT_ID,
      {
        clientId: CHATGPT_CLIENT_ID,
        exists: true,
        enabled: true,
        redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
        sessionCount: 1,
      },
    ],
    [
      "claude-weknora-read",
      {
        clientId: "claude-weknora-read",
        exists: true,
        enabled: true,
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        sessionCount: 0,
      },
    ],
  ]);
  return {
    clients,
    endpoints: () => ({
      issuer: "https://wek.uov.me/oauth/realms/weknora",
      authorizationEndpoint: "https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/auth",
      tokenEndpoint: "https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/token",
    }),
    listClients: vi.fn(async (ids: string[]) =>
      ids.map(
        (clientId) =>
          clients.get(clientId) ?? {
            clientId,
            exists: false,
            enabled: false,
            redirectUri: "",
            sessionCount: 0,
          },
      ),
    ),
    createClient: vi.fn(async (options: { clientId: string; redirectUri: string }) => {
      const state = {
        clientId: options.clientId,
        exists: true,
        enabled: true,
        redirectUri: options.redirectUri,
        sessionCount: 0,
      };
      clients.set(options.clientId, state);
      return { state, secret: "created-client-secret" };
    }),
    deleteClient: vi.fn(async (clientId: string) => ({ deleted: clients.delete(clientId) })),
    updateClient: vi.fn(async (clientId: string, update: { enabled?: boolean; redirectUri?: string }) => {
      const state = clients.get(clientId)!;
      Object.assign(state, {
        ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
        ...(update.redirectUri === undefined ? {} : { redirectUri: update.redirectUri }),
      });
      return state;
    }),
    rotateClientSecret: vi.fn(async () => ({
      secret: "new-one-time-secret",
      oldSecretInvalidated: true,
    })),
    revokeClientSessions: vi.fn(async () => ({ revokedSessions: 1 })),
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "weknora-console-"));
  const policyFile = join(root, "policy.json");
  await writeFile(
    policyFile,
    JSON.stringify({
      version: 2,
      clients: MANAGED_ACCESS_CLIENTS.map((client) => ({
        ...client,
        accessType: "capabilities",
        capabilities: ["knowledge.read"],
        knowledgeBaseScope: "selected",
        defaultKbId: KB_A,
        knowledgeBases: [{ id: KB_A, name: "镍基合金" }],
      })),
    }),
  );
  const sessions = new ConsoleSessionStore({ ttlMs: 60_000, secret: Buffer.alloc(32, 9) });
  const policyStore = new FileMcpAccessPolicyStore({
    policyFile,
    auditFile: join(root, "audit.ndjson"),
    fallbackKnowledgeBase: { id: KB_A, name: "镍基合金" },
    defaultClients: MANAGED_ACCESS_CLIENTS,
  });
  const writeClient = vi.spyOn(policyStore, "writeClient");
  const appendAudit = vi.spyOn(policyStore, "appendAudit");
  const staticTokens = new FileStaticTokenStore({ file: join(root, "tokens.json") });
  const oauthClientManager = fakeOAuthClients();
  const verify = vi.fn(async (username: string, password: string) =>
    username === "aodo" && password === PASSWORD
      ? { subject: "user-1", username: "aodo", roles: ["weknora-admin"] }
      : undefined,
  );
  const app = buildConsoleApp({
    publicUrl: new URL("https://wek.uov.me/mcp-console/"),
    login: {
      users: { verify },
      throttle: new LoginThrottle({ perIp: 3, global: 50, windowMs: 60_000 }),
      formSecret: Buffer.alloc(32, 5),
    },
    sessions,
    accessPolicyStore: policyStore,
    oauthClientManager,
    staticTokens,
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
  return { app, policyStore, writeClient, appendAudit, staticTokens, oauthClientManager, verify };
}

async function submitLogin(
  app: ReturnType<typeof buildConsoleApp>,
  fields: { username: string; password: string; form_token?: string },
  headers: Record<string, string> = {},
) {
  const page = await app.inject({ method: "GET", url: "/mcp-console/login" });
  const formToken = /name="form_token" value="([^"]+)"/.exec(page.body)?.[1];
  if (!formToken) throw new Error("Missing login form token");
  return app.inject({
    method: "POST",
    url: "/mcp-console/login",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    payload: new URLSearchParams({ form_token: formToken, ...fields }).toString(),
  });
}

async function login(app: ReturnType<typeof buildConsoleApp>) {
  const response = await submitLogin(app, { username: "aodo", password: PASSWORD });
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
  it("redirects logged-out users to the password login page", async () => {
    const { app } = await createFixture();
    const page = await app.inject({ method: "GET", url: "/mcp-console/" });
    const loginPage = await app.inject({ method: "GET", url: "/mcp-console/login" });

    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe("/mcp-console/login");
    expect(loginPage.statusCode).toBe(200);
    expect(loginPage.headers["content-type"]).toContain("text/html");
    expect(loginPage.body).toContain('name="password"');
    expect(loginPage.body).toContain("/mcp-console/assets/login.css");
    // A no-referrer page would make browsers submit the form with "Origin: null".
    expect(loginPage.headers["referrer-policy"]).toBe("same-origin");
    await app.close();
  });

  it("logs in with a password and redirects to the console", async () => {
    const { app } = await createFixture();
    const opaque = await submitLogin(
      app,
      { username: "aodo", password: PASSWORD },
      { origin: "null" },
    );
    expect(opaque.statusCode).toBe(303);
    const response = await submitLogin(
      app,
      { username: "aodo", password: PASSWORD },
      { origin: "https://wek.uov.me" },
    );

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/mcp-console/");
    expect(String(response.headers["set-cookie"])).toMatch(
      /weknora_console_session=.+; Path=\/mcp-console\/;.*HttpOnly; Secure; SameSite=Strict/,
    );
    const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
    const session = await app.inject({
      method: "GET",
      url: "/mcp-console/api/session",
      headers: { cookie },
    });
    expect(session.json()).toMatchObject({ username: "aodo", roles: ["weknora-admin"] });
    await app.close();
  });

  it("rejects wrong passwords, forged forms, foreign origins, and throttles guessing", async () => {
    const { app, verify } = await createFixture();
    const wrong = await submitLogin(app, { username: "aodo", password: "wrong password" });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    expect(wrong.body).toContain("用户名或密码错误");
    expect(wrong.body).toContain('value="aodo"');

    const forged = await app.inject({
      method: "POST",
      url: "/mcp-console/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        form_token: `${Date.now()}.forged`,
        username: "aodo",
        password: PASSWORD,
      }).toString(),
    });
    expect(forged.statusCode).toBe(400);

    const foreign = await submitLogin(
      app,
      { username: "aodo", password: PASSWORD },
      { origin: "https://evil.example" },
    );
    expect(foreign.statusCode).toBe(403);

    await submitLogin(app, { username: "aodo", password: "wrong password" });
    await submitLogin(app, { username: "aodo", password: "wrong password" });
    const verifyCalls = verify.mock.calls.length;
    const blocked = await submitLogin(app, { username: "aodo", password: PASSWORD });
    expect(blocked.statusCode).toBe(429);
    expect(verify.mock.calls.length).toBe(verifyCalls);
    await app.close();
  });

  it("reserves login capacity before concurrent password checks", async () => {
    const { app, verify } = await createFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    verify.mockImplementation(async () => {
      await gate;
      return undefined;
    });
    const attempts = Array.from({ length: 8 }, () =>
      submitLogin(app, { username: "aodo", password: "wrong password" }),
    );
    try {
      await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(3));
    } finally {
      release();
    }
    const responses = await Promise.all(attempts);
    expect(responses.filter(({ statusCode }) => statusCode === 401)).toHaveLength(3);
    expect(responses.filter(({ statusCode }) => statusCode === 429)).toHaveLength(5);
    await app.close();
  });

  it("releases password-check capacity when verification fails unexpectedly", async () => {
    const { app, verify } = await createFixture();
    for (let index = 0; index < 4; index += 1) {
      verify.mockRejectedValueOnce(new Error("user store unavailable"));
      const response = await submitLogin(app, { username: "aodo", password: PASSWORD });
      expect(response.statusCode).toBe(500);
    }
    expect((await submitLogin(app, { username: "aodo", password: PASSWORD })).statusCode).toBe(303);
    await app.close();
  });

  it("returns a secret-free overview with one gateway health status", async () => {
    const { app } = await createFixture();
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
    expect(JSON.stringify(overview.json())).not.toMatch(/secret|wkmcp_/i);
    await app.close();
  });

  it("lists integrations with one credential entry per OAuth client or API key", async () => {
    const { app } = await createFixture();
    const cookie = await login(app);
    const response = await app.inject({
      method: "GET",
      url: "/mcp-console/api/integrations",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      capabilities: expect.arrayContaining(["knowledge.read", "tenants.manage"]),
      mcpUrl: "https://wek.uov.me/mcp",
      scope: "weknora:mcp",
      oauth: { issuer: "https://wek.uov.me/oauth/realms/weknora", unavailable: false },
      integrations: [
        {
          id: "chatgpt",
          kind: "oauth",
          defaultRedirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
          credentials: [
            {
              clientId: CHATGPT_CLIENT_ID,
              exists: true,
              enabled: true,
              sessionCount: 1,
              access: { capabilities: ["knowledge.read"] },
            },
          ],
        },
        { id: "claude", kind: "oauth", credentials: [{ clientId: "claude-weknora-read" }] },
        { id: "gemini", label: "Gemini", kind: "oauth", defaultRedirectUri: "", credentials: [] },
        { id: "apikey", kind: "token", credentials: [] },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("secret\":");
    await app.close();
  });

  it("requires an explicit callback for Gemini and stores its independent OAuth credential", async () => {
    const { app, policyStore } = await createFixture();
    const cookie = await login(app);
    const headers = { cookie, "x-csrf-token": await csrf(app, cookie) };
    const url = "/mcp-console/api/integrations/gemini/credentials";

    for (const redirectUri of [undefined, "", "http://example.com/callback", "https://example.com/*"]) {
      const rejected = await app.inject({
        method: "POST", url, headers, payload: { label: "Gemini 网页版", redirectUri },
      });
      expect(rejected.statusCode).toBe(400);
    }

    // A supplied exact HTTPS callback is accepted without assuming Google's callback path.
    const redirectUri = "https://example.com/gemini-callback";
    const created = await app.inject({
      method: "POST", url, headers, payload: { label: "Gemini 网页版", redirectUri },
    });
    expect(created.statusCode).toBe(200);
    const { clientId } = created.json();
    expect(clientId).toMatch(/^gemini-weknora-[0-9a-f]{6}$/);
    expect(created.json()).toMatchObject({ kind: "oauth", secret: "created-client-secret" });
    expect((await policyStore.read()).clients.find((entry) => entry.clientId === clientId)).toMatchObject({
      provider: "Gemini", label: "Gemini 网页版", capabilities: ["knowledge.read"],
      knowledgeBaseScope: "selected", defaultKbId: KB_A,
    });

    const listed = await app.inject({ method: "GET", url: "/mcp-console/api/integrations", headers: { cookie } });
    expect(listed.json().integrations.find((entry: { id: string }) => entry.id === "gemini").credentials)
      .toMatchObject([{ clientId, enabled: true, exists: true, redirectUri }]);
    expect(listed.body).not.toContain("created-client-secret");

    const rotated = await app.inject({ method: "POST", url: `/mcp-console/api/credentials/${clientId}/rotate-secret`, headers });
    expect(rotated.statusCode).toBe(200);
    const deleted = await app.inject({ method: "DELETE", url: `/mcp-console/api/credentials/${clientId}`, headers });
    expect(deleted.statusCode).toBe(200);
    expect((await policyStore.read()).clients.some((entry) => entry.clientId === clientId)).toBe(false);
    await app.close();
  });

  it("creates, updates, rotates, and deletes an OAuth credential with its own policy", async () => {
    const { app, policyStore, oauthClientManager } = await createFixture();
    const cookie = await login(app);
    const token = await csrf(app, cookie);
    const headers = { cookie, "x-csrf-token": token };

    const created = await app.inject({
      method: "POST",
      url: "/mcp-console/api/integrations/chatgpt/credentials",
      headers,
      payload: { label: "工作账号" },
    });
    expect(created.statusCode).toBe(200);
    const { clientId, secret } = created.json() as { clientId: string; secret: string };
    expect(clientId).toMatch(/^chatgpt-weknora-[0-9a-f]{6}$/);
    expect(secret).toBe("created-client-secret");
    expect(oauthClientManager.createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId,
        label: "工作账号",
        redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
      }),
    );
    expect((await policyStore.read()).clients.at(-1)).toMatchObject({
      clientId,
      label: "工作账号",
      provider: "ChatGPT",
      capabilities: ["knowledge.read"],
    });

    const path = `/mcp-console/api/credentials/${clientId}`;
    const policy = await app.inject({
      method: "PUT",
      url: `${path}/access-policy`,
      headers,
      payload: {
        accessType: "capabilities",
        capabilities: ["knowledge.read", "conversation.use"],
        knowledgeBaseScope: "selected",
        defaultKbId: KB_B,
        allowedKbIds: [KB_A, KB_B],
      },
    });
    expect(policy.statusCode).toBe(200);
    const updated = await app.inject({
      method: "PUT",
      url: path,
      headers,
      payload: { label: "工作 ChatGPT", enabled: false, redirectUri: "https://chatgpt.com/cb" },
    });
    expect(updated.statusCode).toBe(200);
    expect(oauthClientManager.updateClient).toHaveBeenCalledWith(clientId, {
      enabled: false,
      redirectUri: "https://chatgpt.com/cb",
    });
    const rotated = await app.inject({ method: "POST", url: `${path}/rotate-secret`, headers });
    expect(rotated.json()).toEqual({ secret: "new-one-time-secret", oldSecretInvalidated: true });
    const revoked = await app.inject({ method: "POST", url: `${path}/revoke-sessions`, headers });
    expect(revoked.json()).toEqual({ revokedSessions: 1 });

    const stored = (await policyStore.read()).clients.find((client) => client.clientId === clientId);
    expect(stored).toMatchObject({
      label: "工作 ChatGPT",
      capabilities: ["knowledge.read", "conversation.use"],
      defaultKbId: KB_B,
    });
    const chatgpt = (await policyStore.read()).clients.find(
      (client) => client.clientId === CHATGPT_CLIENT_ID,
    );
    expect(chatgpt?.capabilities).toEqual(["knowledge.read"]);

    const deleted = await app.inject({ method: "DELETE", url: path, headers });
    expect(deleted.json()).toEqual({ deleted: true });
    expect(oauthClientManager.deleteClient).toHaveBeenCalledWith(clientId);
    expect((await policyStore.read()).clients.map((client) => client.clientId)).not.toContain(
      clientId,
    );
    await app.close();
  });

  it("issues API keys as separate credentials with their own permissions", async () => {
    const { app, policyStore, staticTokens, appendAudit } = await createFixture();
    const cookie = await login(app);
    const token = await csrf(app, cookie);
    const headers = { cookie, "x-csrf-token": token };
    const create = (label: string) =>
      app.inject({
        method: "POST",
        url: "/mcp-console/api/integrations/apikey/credentials",
        headers,
        payload: { label },
      });

    const noCsrf = await app.inject({
      method: "POST",
      url: "/mcp-console/api/integrations/apikey/credentials",
      headers: { cookie },
      payload: { label: "Codeg" },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect((await create(" ")).statusCode).toBe(400);

    const codeg = (await create("Codeg")).json() as {
      clientId: string;
      secret: string;
      mcpConfig: unknown;
    };
    const phone = (await create("小米手机")).json() as { clientId: string; secret: string };
    expect(codeg.clientId).toMatch(/^apikey-[0-9a-f]{12}$/);
    expect(codeg.mcpConfig).toEqual({
      type: "http",
      url: "https://wek.uov.me/mcp",
      headers: { Authorization: `Bearer ${codeg.secret}` },
    });
    expect(await staticTokens.verify(codeg.secret)).toMatchObject({ clientId: codeg.clientId });

    await app.inject({
      method: "PUT",
      url: `/mcp-console/api/credentials/${codeg.clientId}/access-policy`,
      headers,
      payload: {
        accessType: "capabilities",
        capabilities: ["knowledge.read", "knowledge.write"],
        knowledgeBaseScope: "all",
        defaultKbId: KB_A,
        allowedKbIds: [],
      },
    });
    const clients = (await policyStore.read()).clients;
    expect(clients.find((client) => client.clientId === codeg.clientId)).toMatchObject({
      label: "Codeg",
      provider: "Token",
      capabilities: ["knowledge.read", "knowledge.write"],
      knowledgeBaseScope: "all",
    });
    expect(clients.find((client) => client.clientId === phone.clientId)?.capabilities).toEqual([
      "knowledge.read",
    ]);

    const listed = await app.inject({
      method: "GET",
      url: "/mcp-console/api/integrations",
      headers: { cookie },
    });
    expect(JSON.stringify(listed.json())).not.toContain(codeg.secret);
    expect(listed.json().integrations.find((entry: { id: string }) => entry.id === "apikey").credentials)
      .toHaveLength(2);

    const path = `/mcp-console/api/credentials/${codeg.clientId}`;
    await app.inject({ method: "PUT", url: path, headers, payload: { enabled: false } });
    expect(await staticTokens.verify(codeg.secret)).toBeUndefined();
    const redirect = await app.inject({
      method: "PUT",
      url: path,
      headers,
      payload: { redirectUri: "https://example.com/cb" },
    });
    expect(redirect.statusCode).toBe(400);
    const rotated = (await app.inject({ method: "POST", url: `${path}/rotate-secret`, headers })).json();
    expect(rotated.secret).toMatch(/^wkmcp_/);
    const sessions = await app.inject({ method: "POST", url: `${path}/revoke-sessions`, headers });
    expect(sessions.statusCode).toBe(400);

    expect((await app.inject({ method: "DELETE", url: path, headers })).json()).toEqual({
      deleted: true,
    });
    expect((await app.inject({ method: "DELETE", url: path, headers })).statusCode).toBe(404);
    expect(await staticTokens.verify(phone.secret)).toBeDefined();
    expect(JSON.stringify(appendAudit.mock.calls)).not.toContain(codeg.secret);
    await app.close();
  });

  it("normalizes full access to all knowledge bases and rejects invalid policies", async () => {
    const { app, writeClient } = await createFixture();
    const cookie = await login(app);
    const token = await csrf(app, cookie);
    const headers = { cookie, "x-csrf-token": token };
    const url = `/mcp-console/api/credentials/${CHATGPT_CLIENT_ID}/access-policy`;
    const base = {
      accessType: "capabilities",
      capabilities: ["knowledge.read"],
      knowledgeBaseScope: "selected",
      defaultKbId: KB_A,
      allowedKbIds: [KB_A],
    };

    const full = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: { ...base, accessType: "full", capabilities: [], knowledgeBaseScope: "all", allowedKbIds: [] },
    });
    expect(full.statusCode).toBe(200);
    expect(writeClient).toHaveBeenCalledWith(
      CHATGPT_CLIENT_ID,
      expect.objectContaining({ accessType: "full", knowledgeBases: [] }),
      { subject: "user-1", username: "aodo" },
    );
    writeClient.mockClear();

    const unknownClient = await app.inject({
      method: "PUT",
      url: "/mcp-console/api/credentials/chatgpt-admin/access-policy",
      headers,
      payload: base,
    });
    const unknownCapability = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: { ...base, capabilities: ["tenant.root"] },
    });
    const unknownKb = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: {
        ...base,
        defaultKbId: "0787e321-6f1e-4471-86a9-339165e51644",
        allowedKbIds: ["0787e321-6f1e-4471-86a9-339165e51644"],
      },
    });

    expect(unknownClient.statusCode).toBe(404);
    expect(unknownCapability.statusCode).toBe(400);
    expect(unknownKb.statusCode).toBe(400);
    expect(writeClient).not.toHaveBeenCalled();
    await app.close();
  });

  it("still lists API keys when the OAuth client store is unavailable", async () => {
    const { app, oauthClientManager } = await createFixture();
    oauthClientManager.listClients.mockRejectedValueOnce(new Error("down"));
    const cookie = await login(app);
    const response = await app.inject({
      method: "GET",
      url: "/mcp-console/api/integrations",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().oauth.unavailable).toBe(true);
    expect(response.json().integrations[0].credentials[0]).toMatchObject({ exists: false });
    await app.close();
  });
});
