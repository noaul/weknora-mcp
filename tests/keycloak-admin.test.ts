import { describe, expect, it, vi } from "vitest";

import {
  KeycloakAdminClient,
  MANAGED_OAUTH_CLIENTS,
  type ManagedOAuthClientDefinition,
} from "../src/keycloak-admin.js";

const definition: ManagedOAuthClientDefinition = {
  key: "chatgpt-read",
  label: "ChatGPT WeKnora",
  provider: "ChatGPT",
  clientId: "chatgpt-weknora-read",
  mcpUrl: "https://wek.uov.me/mcp",
  scope: "weknora:mcp",
};

function createClient(fetchImpl: typeof fetch) {
  return new KeycloakAdminClient({
    adminBaseUrl: new URL(
      "http://127.0.0.1:18195/oauth/admin/realms/weknora/",
    ),
    tokenUrl: new URL(
      "http://127.0.0.1:18195/oauth/realms/weknora/protocol/openid-connect/token",
    ),
    serviceClientId: "weknora-mcp-console-admin",
    serviceClientSecret: "service-secret",
    definitions: [definition],
    fetchImpl,
  });
}

describe("Keycloak Admin client", () => {
  it("manages exactly the retained ChatGPT and Claude unified clients", () => {
    expect(MANAGED_OAUTH_CLIENTS).toEqual([
      expect.objectContaining({
        key: "chatgpt-read",
        clientId: "chatgpt-weknora-read",
        mcpUrl: "https://wek.uov.me/mcp",
        scope: "weknora:mcp",
      }),
      expect.objectContaining({
        key: "claude-read",
        clientId: "claude-weknora-read",
        mcpUrl: "https://wek.uov.me/mcp",
        scope: "weknora:mcp",
      }),
    ]);
    expect(JSON.stringify(MANAGED_OAUTH_CLIENTS)).not.toContain("mcp-admin");
    expect(JSON.stringify(MANAGED_OAUTH_CLIENTS)).not.toContain("weknora:admin");
  });

  it("lists only managed OAuth clients without exposing their secrets", async () => {
    let tokenRequests = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/token")) {
        tokenRequests += 1;
        return Response.json({ access_token: "admin-token", expires_in: 60 });
      }
      if (url.pathname.endsWith("/clients")) {
        return Response.json([
          {
            id: "client-uuid",
            clientId: definition.clientId,
            enabled: true,
            redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
            standardFlowEnabled: true,
            publicClient: false,
            secret: "must-not-leak",
          },
        ]);
      }
      if (url.pathname.endsWith("/clients/client-uuid/session-count")) {
        return Response.json({ count: 2 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = createClient(fetchImpl as typeof fetch);

    const result = await client.listManagedClients();

    expect(result).toEqual([
      expect.objectContaining({
        key: "chatgpt-read",
        clientId: definition.clientId,
        enabled: true,
        sessionCount: 2,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(tokenRequests).toBe(1);
  });

  it("shares one service-account token request across parallel client lookups", async () => {
    let tokenRequests = 0;
    const second = {
      ...definition,
      key: "claude-read",
      label: "Claude 只读",
      provider: "Claude" as const,
      clientId: "claude-weknora-read",
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/token")) {
        tokenRequests += 1;
        return Response.json({ access_token: "admin-token", expires_in: 60 });
      }
      if (url.pathname.endsWith("/clients")) {
        const clientId = url.searchParams.get("clientId") ?? "";
        return Response.json([
          { id: `${clientId}-uuid`, clientId, enabled: true, redirectUris: [] },
        ]);
      }
      if (url.pathname.endsWith("/session-count")) {
        return Response.json({ count: 0 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new KeycloakAdminClient({
      adminBaseUrl: new URL(
        "http://127.0.0.1:18195/oauth/admin/realms/weknora/",
      ),
      tokenUrl: new URL(
        "http://127.0.0.1:18195/oauth/realms/weknora/protocol/openid-connect/token",
      ),
      serviceClientId: "weknora-mcp-console-admin",
      serviceClientSecret: "service-secret",
      definitions: [definition, second],
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.listManagedClients()).resolves.toHaveLength(2);
    expect(tokenRequests).toBe(1);
  });

  it("updates an exact redirect URI while preserving unrelated client settings", async () => {
    let updatedBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/token")) {
        return Response.json({ access_token: "admin-token", expires_in: 60 });
      }
      if (url.pathname.endsWith("/clients") && init?.method !== "PUT") {
        return Response.json([
          {
            id: "client-uuid",
            clientId: definition.clientId,
            enabled: true,
            redirectUris: ["https://old.example/callback"],
            protocol: "openid-connect",
            customSetting: { preserved: true },
          },
        ]);
      }
      if (url.pathname.endsWith("/clients/client-uuid") && init?.method === "PUT") {
        updatedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/clients/client-uuid/session-count")) {
        return Response.json({ count: 0 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = createClient(fetchImpl as typeof fetch);

    const updated = await client.updateManagedClient("chatgpt-read", {
      enabled: false,
      redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
    });

    expect(updated.enabled).toBe(false);
    expect(updated.redirectUri).toBe(
      "https://chatgpt.com/connector_platform_oauth_redirect",
    );
    expect(updatedBody).toMatchObject({
      enabled: false,
      redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      customSetting: { preserved: true },
    });
    await expect(
      client.updateManagedClient("chatgpt-read", {
        redirectUri: "https://chatgpt.com/*",
      }),
    ).rejects.toThrow(/redirect/i);
  });

  it("rotates a client secret and removes the old rotated secret", async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/token")) {
        return Response.json({ access_token: "admin-token", expires_in: 60 });
      }
      if (url.pathname.endsWith("/clients")) {
        return Response.json([{ id: "client-uuid", clientId: definition.clientId }]);
      }
      if (url.pathname.endsWith("/client-secret") && init?.method === "POST") {
        methods.push("rotate");
        return Response.json({ type: "secret", value: "new-one-time-secret" });
      }
      if (url.pathname.endsWith("/client-secret/rotated") && init?.method === "DELETE") {
        methods.push("invalidate-old");
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = createClient(fetchImpl as typeof fetch);

    await expect(client.rotateManagedClientSecret("chatgpt-read")).resolves.toEqual({
      secret: "new-one-time-secret",
      oldSecretInvalidated: true,
    });
    expect(methods).toEqual(["rotate", "invalidate-old"]);
  });

  it("revokes every active session for one managed client", async () => {
    const deleted: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/token")) {
        return Response.json({ access_token: "admin-token", expires_in: 60 });
      }
      if (url.pathname.endsWith("/clients")) {
        return Response.json([{ id: "client-uuid", clientId: definition.clientId }]);
      }
      if (url.pathname.endsWith("/clients/client-uuid/user-sessions")) {
        return Response.json([{ id: "session-1" }, { id: "session-2" }]);
      }
      if (url.pathname.includes("/sessions/") && init?.method === "DELETE") {
        deleted.push(url.pathname.split("/").at(-1) ?? "");
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = createClient(fetchImpl as typeof fetch);

    await expect(client.revokeManagedClientSessions("chatgpt-read")).resolves.toEqual({
      revokedSessions: 2,
    });
    expect(deleted).toEqual(["session-1", "session-2"]);
    await expect(client.revokeManagedClientSessions("unknown")).rejects.toThrow(
      /managed/i,
    );
  });
});
