import { describe, expect, it, vi } from "vitest";

import { KeycloakAdminClient, MANAGED_OAUTH_CLIENTS } from "../src/keycloak-admin.js";

const definition = { clientId: "chatgpt-weknora-read" };

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
    fetchImpl,
  });
}

describe("Keycloak Admin client", () => {
  it("seeds the retained ChatGPT and Claude unified clients", () => {
    expect(MANAGED_OAUTH_CLIENTS).toEqual([
      expect.objectContaining({ provider: "ChatGPT", clientId: "chatgpt-weknora-read" }),
      expect.objectContaining({ provider: "Claude", clientId: "claude-weknora-read" }),
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

    const result = await client.listClients([definition.clientId]);

    expect(result).toEqual([
      {
        clientId: definition.clientId,
        exists: true,
        enabled: true,
        redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
        sessionCount: 2,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(tokenRequests).toBe(1);
  });

  it("shares one service-account token request across parallel client lookups", async () => {
    let tokenRequests = 0;
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
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.listClients([definition.clientId, "claude-weknora-read"]),
    ).resolves.toHaveLength(2);
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

    const updated = await client.updateClient(definition.clientId, {
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
      client.updateClient(definition.clientId, {
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

    await expect(client.rotateClientSecret(definition.clientId)).resolves.toEqual({
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

    await expect(client.revokeClientSessions(definition.clientId)).resolves.toEqual({
      revokedSessions: 2,
    });
    expect(deleted).toEqual(["session-1", "session-2"]);
    await expect(client.revokeClientSessions("unknown")).rejects.toThrow(
      /managed/i,
    );
  });

  it("reports clients missing from Keycloak instead of failing the listing", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/token")) {
        return Response.json({ access_token: "admin-token", expires_in: 60 });
      }
      if (url.pathname.endsWith("/clients")) return Response.json([]);
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = createClient(fetchImpl as typeof fetch);

    await expect(client.listClients(["chatgpt-weknora-gone"])).resolves.toEqual([
      {
        clientId: "chatgpt-weknora-gone",
        exists: false,
        enabled: false,
        redirectUri: "",
        sessionCount: 0,
      },
    ]);
  });

  it("creates a confidential PKCE client with the MCP scope and returns its secret", async () => {
    const created: Array<Record<string, unknown>> = [];
    const assignedScopes: string[] = [];
    let exists = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/token")) {
        return Response.json({ access_token: "admin-token", expires_in: 60 });
      }
      if (url.pathname.endsWith("/client-scopes")) {
        return Response.json([
          { id: "profile-id", name: "profile" },
          { id: "mcp-scope-id", name: "weknora:mcp" },
        ]);
      }
      if (url.pathname.endsWith("/clients") && init?.method === "POST") {
        created.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        exists = true;
        return new Response(null, { status: 201 });
      }
      if (url.pathname.endsWith("/clients")) {
        return Response.json(
          exists
            ? [
                {
                  id: "new-uuid",
                  clientId: "chatgpt-weknora-abc123",
                  enabled: true,
                  redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
                },
              ]
            : [],
        );
      }
      if (url.pathname.includes("/clients/new-uuid/default-client-scopes/") && init?.method === "PUT") {
        assignedScopes.push(url.pathname.split("/").at(-1) ?? "");
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/clients/new-uuid/client-secret")) {
        return Response.json({ type: "secret", value: "generated-secret" });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    const client = createClient(fetchImpl as typeof fetch);

    const result = await client.createClient({
      clientId: "chatgpt-weknora-abc123",
      label: "工作账号",
      redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
    });

    expect(result.secret).toBe("generated-secret");
    expect(result.state).toMatchObject({ clientId: "chatgpt-weknora-abc123", exists: true });
    expect(created[0]).toMatchObject({
      clientId: "chatgpt-weknora-abc123",
      name: "工作账号",
      publicClient: false,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      fullScopeAllowed: false,
      consentRequired: true,
      attributes: { "pkce.code.challenge.method": "S256" },
      redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    });
    expect(assignedScopes).toEqual(["mcp-scope-id"]);
    await expect(
      client.createClient({
        clientId: "chatgpt-weknora-abc123",
        label: "重复",
        redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("deletes a client by clientId and reports missing clients", async () => {
    const deleted: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/token")) {
        return Response.json({ access_token: "admin-token", expires_in: 60 });
      }
      if (url.pathname.endsWith("/clients")) {
        const clientId = url.searchParams.get("clientId");
        return Response.json(
          clientId === definition.clientId ? [{ id: "client-uuid", clientId }] : [],
        );
      }
      if (url.pathname.endsWith("/clients/client-uuid") && init?.method === "DELETE") {
        deleted.push("client-uuid");
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = createClient(fetchImpl as typeof fetch);

    await expect(client.deleteClient(definition.clientId)).resolves.toEqual({ deleted: true });
    await expect(client.deleteClient("missing")).resolves.toEqual({ deleted: false });
    expect(deleted).toEqual(["client-uuid"]);
  });
});
