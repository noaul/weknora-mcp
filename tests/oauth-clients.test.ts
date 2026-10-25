import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FileOAuthClientStore,
  OAuthClientError,
  REFRESH_IDLE_MS,
} from "../src/oauth-clients.js";

const ISSUER = "https://wek.uov.me/oauth/realms/weknora";
const CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "weknora-oauth-clients-"));
  let now = Date.parse("2026-10-25T00:00:00Z");
  const file = join(root, "oauth-clients.json");
  const store = new FileOAuthClientStore({ file, issuer: `${ISSUER}/`, now: () => now });
  return { store, file, advance: (ms: number) => (now += ms) };
}

describe("OAuth client store", () => {
  it("keeps the former Keycloak endpoint paths", async () => {
    const { store } = await createStore();
    expect(store.endpoints()).toEqual({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/protocol/openid-connect/auth`,
      tokenEndpoint: `${ISSUER}/protocol/openid-connect/token`,
    });
  });

  it("creates clients with hashed one-time secrets and manages them", async () => {
    const { store, file } = await createStore();
    const created = await store.createClient({
      clientId: "chatgpt-weknora-abc123",
      label: "工作账号",
      redirectUri: CALLBACK,
    });
    expect(created.state).toEqual({
      clientId: "chatgpt-weknora-abc123",
      exists: true,
      enabled: true,
      redirectUri: CALLBACK,
      sessionCount: 0,
    });
    expect(await readFile(file, "utf8")).not.toContain(created.secret);
    expect(await store.authenticateClient("chatgpt-weknora-abc123", created.secret)).toBeDefined();
    expect(await store.authenticateClient("chatgpt-weknora-abc123", "wrong")).toBeUndefined();
    await expect(
      store.createClient({ clientId: "chatgpt-weknora-abc123", label: "x", redirectUri: CALLBACK }),
    ).rejects.toThrow(OAuthClientError);

    const rotated = await store.rotateClientSecret("chatgpt-weknora-abc123");
    expect(rotated.oldSecretInvalidated).toBe(true);
    expect(await store.authenticateClient("chatgpt-weknora-abc123", created.secret)).toBeUndefined();
    expect(await store.authenticateClient("chatgpt-weknora-abc123", rotated.secret)).toBeDefined();

    await store.updateClient("chatgpt-weknora-abc123", { enabled: false });
    expect(await store.authenticateClient("chatgpt-weknora-abc123", rotated.secret)).toBeUndefined();
    await expect(
      store.updateClient("chatgpt-weknora-abc123", { redirectUri: "http://insecure.example/cb" }),
    ).rejects.toThrow(/HTTPS/);

    expect(await store.listClients(["chatgpt-weknora-abc123", "missing"])).toEqual([
      expect.objectContaining({ exists: true, enabled: false }),
      { clientId: "missing", exists: false, enabled: false, redirectUri: "", sessionCount: 0 },
    ]);
    expect(await store.deleteClient("chatgpt-weknora-abc123")).toEqual({ deleted: true });
    await expect(store.rotateClientSecret("chatgpt-weknora-abc123")).rejects.toThrow(/missing/);
  });

  it("tracks grants, revocation, client state, and idle expiry", async () => {
    const { store, advance } = await createStore();
    await store.importClient({
      clientId: "claude-weknora-read",
      label: "Claude WeKnora",
      secret: "imported-secret",
      enabled: true,
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    expect(await store.authenticateClient("claude-weknora-read", "imported-secret")).toBeDefined();

    const first = await store.createGrant({
      clientId: "claude-weknora-read",
      subject: "user-1",
      scope: "weknora:mcp",
    });
    const second = await store.createGrant({
      clientId: "claude-weknora-read",
      subject: "user-1",
      scope: "weknora:mcp",
    });
    expect((await store.listClients(["claude-weknora-read"]))[0]?.sessionCount).toBe(2);
    expect(await store.isGrantActive("claude-weknora-read", first.grant.id)).toBe(true);
    expect(await store.isGrantActive("chatgpt-weknora-read", first.grant.id)).toBe(false);

    expect(await store.useRefreshToken("claude-weknora-read", first.refreshToken)).toMatchObject({
      id: first.grant.id,
      subject: "user-1",
    });
    expect(await store.useRefreshToken("other-client", first.refreshToken)).toBeUndefined();

    expect(await store.revokeRefreshToken("claude-weknora-read", first.refreshToken)).toBe(true);
    expect(await store.isGrantActive("claude-weknora-read", first.grant.id)).toBe(false);
    expect(await store.useRefreshToken("claude-weknora-read", first.refreshToken)).toBeUndefined();

    await store.updateClient("claude-weknora-read", { enabled: false });
    expect(await store.isGrantActive("claude-weknora-read", second.grant.id)).toBe(false);
    await store.updateClient("claude-weknora-read", { enabled: true });
    expect(await store.isGrantActive("claude-weknora-read", second.grant.id)).toBe(true);

    advance(REFRESH_IDLE_MS + 1);
    expect(await store.isGrantActive("claude-weknora-read", second.grant.id)).toBe(false);
    expect(await store.useRefreshToken("claude-weknora-read", second.refreshToken)).toBeUndefined();

    const third = await store.createGrant({
      clientId: "claude-weknora-read",
      subject: "user-1",
      scope: "weknora:mcp",
    });
    expect(await store.revokeClientSessions("claude-weknora-read")).toEqual({ revokedSessions: 1 });
    expect(await store.isGrantActive("claude-weknora-read", third.grant.id)).toBe(false);
  });
});
