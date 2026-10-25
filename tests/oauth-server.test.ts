import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileMcpAccessPolicyStore } from "../src/access-policy.js";
import { FileAdminUserStore, hashPassword, LoginThrottle } from "../src/admin-users.js";
import { AuthenticationError, createJwtAccessTokenVerifier } from "../src/auth.js";
import { buildConsoleApp } from "../src/console-app.js";
import { ConsoleSessionStore } from "../src/console-auth.js";
import { MANAGED_ACCESS_CLIENTS } from "../src/managed-clients.js";
import { FileOAuthClientStore } from "../src/oauth-clients.js";
import { loadOrCreateSigningKey } from "../src/oauth-server.js";
import { FileStaticTokenStore } from "../src/static-tokens.js";

const ISSUER = "https://wek.uov.me/oauth/realms/weknora";
const MCP_URL = "https://wek.uov.me/mcp";
const CLIENT_ID = "chatgpt-weknora-read";
const CLIENT_SECRET = "existing-keycloak-secret";
const CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";
const PASSWORD = "correct horse battery";
const AUTH_PATH = "/oauth/realms/weknora/protocol/openid-connect/auth";
const TOKEN_PATH = "/oauth/realms/weknora/protocol/openid-connect/token";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "weknora-oauth-server-"));
  const clients = new FileOAuthClientStore({ file: join(root, "oauth-clients.json"), issuer: ISSUER });
  await clients.importClient({
    clientId: CLIENT_ID,
    label: "ChatGPT WeKnora",
    secret: CLIENT_SECRET,
    enabled: true,
    redirectUris: [CALLBACK],
  });
  const users = new FileAdminUserStore({ file: join(root, "admin-users.json") });
  await users.setHash("aodo", await hashPassword(PASSWORD), "kc-user-uuid");
  const keyFile = join(root, "oauth-signing-key.json");
  const signingKey = await loadOrCreateSigningKey(keyFile);
  const policyFile = join(root, "policy.json");
  await writeFile(policyFile, JSON.stringify({ version: 2, clients: [] }));
  const throttle = new LoginThrottle({ perIp: 3, global: 50, windowMs: 60_000 });
  const app = buildConsoleApp({
    publicUrl: new URL("https://wek.uov.me/mcp-console/"),
    login: { users, throttle, formSecret: Buffer.alloc(32, 1) },
    oauthServer: {
      issuer: ISSUER,
      resource: MCP_URL,
      clients,
      users,
      throttle,
      signingKey,
      formSecret: Buffer.alloc(32, 2),
      clientLabel: async (clientId) => (clientId === CLIENT_ID ? "我的 ChatGPT" : undefined),
    },
    sessions: new ConsoleSessionStore({ ttlMs: 60_000, secret: Buffer.alloc(32, 3) }),
    accessPolicyStore: new FileMcpAccessPolicyStore({
      policyFile,
      auditFile: join(root, "audit.ndjson"),
      fallbackKnowledgeBase: { id: "51adf856-2722-4a62-be49-b7d1f2cd20b4", name: "镍基合金" },
      defaultClients: MANAGED_ACCESS_CLIENTS,
    }),
    oauthClientManager: clients,
    staticTokens: new FileStaticTokenStore({ file: join(root, "tokens.json") }),
    weknora: { listKnowledgeBases: async () => [] },
    checkServices: async () => ({}),
    indexHtml: "",
    logLevel: "silent",
  });
  // The gateway's verifier, fed with the published JWKS.
  const certs = (await app.inject({ method: "GET", url: "/oauth/realms/weknora/protocol/openid-connect/certs" })).json();
  const verifyJwt = createJwtAccessTokenVerifier({
    issuer: ISSUER,
    audience: MCP_URL,
    requiredScope: "weknora:mcp",
    jwks: async (header) => certs.keys.find((key: { kid: string }) => key.kid === header.kid),
  });
  const gatewayVerify = async (token: string) => {
    const principal = await verifyJwt(token);
    if (!(await clients.isGrantActive(principal.clientId!, principal.grantId!))) {
      throw new AuthenticationError("OAuth grant is not active");
    }
    return principal;
  };
  return { app, clients, keyFile, gatewayVerify };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeUrl(overrides: Record<string, string> = {}, challenge = pkce().challenge) {
  return `${AUTH_PATH}?${new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
    scope: "weknora:mcp openid profile",
    state: "state-xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_URL,
    ...overrides,
  })}`;
}

type App = Awaited<ReturnType<typeof createFixture>>["app"];

async function authorize(app: App, challenge: string, fields: Record<string, string> = {}) {
  const page = await app.inject({ method: "GET", url: authorizeUrl({}, challenge) });
  expect(page.statusCode).toBe(200);
  const request = /name="request" value="([^"]+)"/.exec(page.body)?.[1];
  if (!request) throw new Error("Missing authorize request");
  return app.inject({
    method: "POST",
    url: AUTH_PATH,
    headers: { ...FORM, origin: "https://wek.uov.me" },
    payload: new URLSearchParams({
      request,
      decision: "allow",
      username: "aodo",
      password: PASSWORD,
      ...fields,
    }).toString(),
  });
}

function basic(id = CLIENT_ID, secret = CLIENT_SECRET) {
  return `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
}

async function exchange(app: App, code: string, verifier: string, extra: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: TOKEN_PATH,
    headers: { ...FORM, authorization: basic() },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      ...extra,
    }).toString(),
  });
}

describe("embedded OAuth authorization server", () => {
  it("publishes discovery metadata at the former Keycloak locations", async () => {
    const { app, keyFile } = await createFixture();
    for (const url of [
      "/.well-known/oauth-authorization-server/oauth/realms/weknora",
      "/.well-known/openid-configuration/oauth/realms/weknora",
      "/oauth/realms/weknora/.well-known/openid-configuration",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      });
    }
    const certs = await app.inject({ method: "GET", url: "/oauth/realms/weknora/protocol/openid-connect/certs" });
    expect(certs.json().keys).toHaveLength(1);
    expect(certs.json().keys[0]).not.toHaveProperty("d");
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    await app.close();
  });

  it("runs the authorization code flow with PKCE, refresh, and revocation", async () => {
    const { app, clients, gatewayVerify } = await createFixture();
    const { verifier, challenge } = pkce();

    const page = await app.inject({ method: "GET", url: authorizeUrl({}, challenge) });
    expect(page.body).toContain("<strong>我的 ChatGPT</strong>");
    expect(page.headers["content-security-policy"]).toContain("form-action 'self' https://chatgpt.com");
    expect(page.headers["referrer-policy"]).toBe("same-origin");

    const granted = await authorize(app, challenge);
    expect(granted.statusCode).toBe(302);
    const callback = new URL(granted.headers.location as string);
    expect(callback.origin + callback.pathname).toBe(CALLBACK);
    expect(callback.searchParams.get("state")).toBe("state-xyz");
    expect(callback.searchParams.get("iss")).toBe(ISSUER);
    const code = callback.searchParams.get("code")!;

    const tokens = await exchange(app, code, verifier);
    expect(tokens.statusCode).toBe(200);
    expect(tokens.headers["cache-control"]).toBe("no-store");
    const body = tokens.json();
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 600, scope: "weknora:mcp openid" });
    expect(body.id_token).toEqual(expect.any(String));
    expect(await gatewayVerify(body.access_token)).toMatchObject({
      subject: "kc-user-uuid",
      clientId: CLIENT_ID,
      scopes: ["weknora:mcp", "openid"],
    });

    // Codes are single-use.
    expect((await exchange(app, code, verifier)).json().error).toBe("invalid_grant");

    const refreshed = await app.inject({
      method: "POST",
      url: TOKEN_PATH,
      headers: FORM,
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: body.refresh_token,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }).toString(),
    });
    expect(refreshed.statusCode).toBe(200);
    const refreshedToken = refreshed.json().access_token;
    expect((await gatewayVerify(refreshedToken)).clientId).toBe(CLIENT_ID);

    // Disabling the client stops its tokens and refreshes immediately.
    await clients.updateClient(CLIENT_ID, { enabled: false });
    await expect(gatewayVerify(refreshedToken)).rejects.toThrow(AuthenticationError);
    const disabledRefresh = await app.inject({
      method: "POST",
      url: TOKEN_PATH,
      headers: { ...FORM, authorization: basic() },
      payload: new URLSearchParams({ grant_type: "refresh_token", refresh_token: body.refresh_token }).toString(),
    });
    expect(disabledRefresh.statusCode).toBe(401);
    await clients.updateClient(CLIENT_ID, { enabled: true });
    expect((await gatewayVerify(refreshedToken)).clientId).toBe(CLIENT_ID);

    const revoked = await app.inject({
      method: "POST",
      url: "/oauth/realms/weknora/protocol/openid-connect/revoke",
      headers: { ...FORM, authorization: basic() },
      payload: new URLSearchParams({ token: body.refresh_token }).toString(),
    });
    expect(revoked.statusCode).toBe(200);
    await expect(gatewayVerify(refreshedToken)).rejects.toThrow(AuthenticationError);
    await app.close();
  });

  it("rejects bad PKCE verifiers, redirect mismatches, and client credentials", async () => {
    const { app } = await createFixture();
    const { challenge } = pkce();
    const code = new URL((await authorize(app, challenge)).headers.location as string).searchParams.get("code")!;
    const badVerifier = await exchange(app, code, pkce().verifier);
    expect(badVerifier.json().error).toBe("invalid_grant");

    const second = pkce();
    const code2 = new URL((await authorize(app, second.challenge)).headers.location as string).searchParams.get("code")!;
    expect((await exchange(app, code2, second.verifier, { redirect_uri: "https://evil.example/cb" })).json().error).toBe(
      "invalid_grant",
    );

    const wrongSecret = await app.inject({
      method: "POST",
      url: TOKEN_PATH,
      headers: { ...FORM, authorization: basic(CLIENT_ID, "wrong") },
      payload: "grant_type=authorization_code&code=x",
    });
    expect(wrongSecret.statusCode).toBe(401);
    expect(wrongSecret.json().error).toBe("invalid_client");

    const mismatch = await app.inject({
      method: "GET",
      url: authorizeUrl({ redirect_uri: "https://evil.example/cb" }),
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.headers.location).toBeUndefined();

    const noPkce = await app.inject({ method: "GET", url: authorizeUrl({ code_challenge_method: "plain" }) });
    expect(noPkce.statusCode).toBe(302);
    expect(new URL(noPkce.headers.location as string).searchParams.get("error")).toBe("invalid_request");

    const unsupported = await app.inject({ method: "POST", url: TOKEN_PATH, headers: { ...FORM, authorization: basic() }, payload: "grant_type=password" });
    expect(unsupported.json().error).toBe("unsupported_grant_type");
    await app.close();
  });

  it("requires the password, honors denial, and rejects tampered or foreign forms", async () => {
    const { app } = await createFixture();
    const { challenge } = pkce();
    const wrong = await authorize(app, challenge, { password: "wrong password" });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toContain("用户名或密码错误");

    const opaqueOrigin = await app.inject({
      method: "POST",
      url: AUTH_PATH,
      headers: { ...FORM, origin: "null" },
      payload: new URLSearchParams({
        request: /name="request" value="([^"]+)"/.exec(
          (await app.inject({ method: "GET", url: authorizeUrl({}, challenge) })).body,
        )![1]!,
        username: "aodo",
        password: PASSWORD,
      }).toString(),
    });
    expect(opaqueOrigin.statusCode).toBe(302);
    expect(new URL(opaqueOrigin.headers.location as string).searchParams.get("code")).toBeTruthy();

    const denied = await authorize(app, challenge, { decision: "deny" });
    expect(new URL(denied.headers.location as string).searchParams.get("error")).toBe("access_denied");

    const tampered = await app.inject({
      method: "POST",
      url: AUTH_PATH,
      headers: FORM,
      payload: new URLSearchParams({ request: "eyJjbGllbnRJZCI6IngifQ.forged", username: "aodo", password: PASSWORD }).toString(),
    });
    expect(tampered.statusCode).toBe(400);

    const page = await app.inject({ method: "GET", url: authorizeUrl({}, challenge) });
    const request = /name="request" value="([^"]+)"/.exec(page.body)![1]!;
    const foreign = await app.inject({
      method: "POST",
      url: AUTH_PATH,
      headers: { ...FORM, origin: "https://evil.example" },
      payload: new URLSearchParams({ request, username: "aodo", password: PASSWORD }).toString(),
    });
    expect(foreign.statusCode).toBe(403);
    await app.close();
  });

  it("reuses the persisted signing key across restarts", async () => {
    const { keyFile } = await createFixture();
    const first = await loadOrCreateSigningKey(keyFile);
    const second = await loadOrCreateSigningKey(keyFile);
    expect(second.kid).toBe(first.kid);
    expect(second.publicJwk).toEqual(first.publicJwk);
  });
});
