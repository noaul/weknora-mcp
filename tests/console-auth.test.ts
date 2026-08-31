import { describe, expect, it, vi } from "vitest";

import {
  ConsoleOidcClient,
  ConsoleSessionStore,
  SessionAuthorizationError,
  validateOidcTokenClaims,
} from "../src/console-auth.js";

describe("console OIDC and sessions", () => {
  it("generates PKCE login state and rejects callback replay", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "access-token",
          id_token: "id-token",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = new ConsoleOidcClient({
      issuer: "https://wek.uov.me/oauth/realms/weknora",
      authorizationEndpoint:
        "https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/auth",
      tokenEndpoint:
        "https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/token",
      clientId: "weknora-mcp-console",
      clientSecret: "client-secret",
      callbackUrl: "https://wek.uov.me/mcp-console/oauth/callback",
      requiredRole: "weknora-admin",
      fetchImpl: fetchImpl as typeof fetch,
      verifyTokens: vi.fn(async (_tokens, transaction) => ({
        subject: "user-1",
        username: "aodo",
        roles: ["weknora-admin"],
        nonce: transaction.nonce,
      })),
    });

    const login = client.beginLogin();
    expect(login.authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(login.authorizationUrl.searchParams.get("state")).toBe(login.state);

    await expect(client.completeLogin(login.state, "code-1")).resolves.toMatchObject({
      subject: "user-1",
      username: "aodo",
    });
    await expect(client.completeLogin(login.state, "code-2")).rejects.toThrow(/state/i);
  });

  it("creates opaque expiring sessions and enforces CSRF", () => {
    let now = 1_000;
    const sessions = new ConsoleSessionStore({
      ttlMs: 60_000,
      now: () => now,
      secret: Buffer.alloc(32, 7),
    });
    const created = sessions.create({
      subject: "user-1",
      username: "aodo",
      roles: ["weknora-admin"],
    });

    expect(created.id).not.toContain("user-1");
    expect(sessions.get(created.id)?.username).toBe("aodo");
    expect(() => sessions.assertCsrf(created.id, "wrong")).toThrow(
      SessionAuthorizationError,
    );
    expect(() => sessions.assertCsrf(created.id, created.csrfToken)).not.toThrow();

    now += 60_001;
    expect(sessions.get(created.id)).toBeUndefined();
  });

  it("binds access-token identity and authorized party to the ID token", () => {
    const valid = {
      idToken: {
        sub: "user-1",
        nonce: "nonce-1",
        preferred_username: "aodo",
      },
      accessToken: {
        sub: "user-1",
        azp: "weknora-mcp-console",
        realm_access: { roles: ["weknora-admin"] },
      },
      nonce: "nonce-1",
      clientId: "weknora-mcp-console",
      requiredRole: "weknora-admin",
    };

    expect(validateOidcTokenClaims(valid)).toMatchObject({
      subject: "user-1",
      username: "aodo",
    });
    expect(() =>
      validateOidcTokenClaims({
        ...valid,
        accessToken: { ...valid.accessToken, azp: "another-client" },
      }),
    ).toThrow(/authorized party/i);
    expect(() =>
      validateOidcTokenClaims({
        ...valid,
        accessToken: { ...valid.accessToken, sub: "user-2" },
      }),
    ).toThrow(/subject/i);
  });

  it("bounds pending OAuth transactions and authenticated sessions", async () => {
    const client = new ConsoleOidcClient({
      issuer: "https://wek.uov.me/oauth/realms/weknora",
      authorizationEndpoint:
        "https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/auth",
      tokenEndpoint:
        "https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/token",
      clientId: "weknora-mcp-console",
      clientSecret: "client-secret",
      callbackUrl: "https://wek.uov.me/mcp-console/oauth/callback",
      requiredRole: "weknora-admin",
      maxTransactions: 1,
      verifyTokens: vi.fn(),
    });
    const firstLogin = client.beginLogin();
    client.beginLogin();
    await expect(client.completeLogin(firstLogin.state, "code")).rejects.toThrow(/state/i);

    const sessions = new ConsoleSessionStore({
      ttlMs: 60_000,
      maxSessions: 1,
      secret: Buffer.alloc(32, 7),
    });
    const firstSession = sessions.create({
      subject: "user-1",
      username: "aodo",
      roles: ["weknora-admin"],
    });
    sessions.create({
      subject: "user-2",
      username: "operator",
      roles: ["weknora-admin"],
    });
    expect(sessions.get(firstSession.id)).toBeUndefined();
  });
});
