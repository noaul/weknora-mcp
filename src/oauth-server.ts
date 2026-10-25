import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK, type CryptoKey } from "jose";
import { z } from "zod";

import type { FileAdminUserStore, LoginThrottle } from "./admin-users.js";
import { authorizePage, errorPage } from "./login-page.js";
import {
  MCP_OAUTH_SCOPE,
  oauthEndpoints,
  type FileOAuthClientStore,
  type OAuthClientRecord,
  REFRESH_IDLE_MS,
} from "./oauth-clients.js";

export const ACCESS_TOKEN_TTL_SECONDS = 600;
const CODE_TTL_MS = 60_000;
const AUTHORIZE_FORM_TTL_MS = 15 * 60_000;
const MAX_PENDING_CODES = 256;
const SIGNING_ALG = "ES256";
/** Scopes granted when requested; weknora:mcp is always granted. */
const OPTIONAL_SCOPES = new Set(["openid", "offline_access"]);

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

const storedKeySchema = z.object({
  kid: z.string().min(1),
  privateJwk: z.record(z.string(), z.unknown()),
  publicJwk: z.record(z.string(), z.unknown()),
});

/** Loads the token signing key, generating and persisting it on first start. */
export async function loadOrCreateSigningKey(file: string): Promise<SigningKey> {
  let stored: z.infer<typeof storedKeySchema>;
  try {
    stored = storedKeySchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    const { privateKey, publicKey } = await generateKeyPair(SIGNING_ALG, { extractable: true });
    stored = {
      kid: randomUUID(),
      privateJwk: await exportJWK(privateKey),
      publicJwk: await exportJWK(publicKey),
    };
    await mkdir(dirname(file), { recursive: true, mode: 0o750 });
    await writeFile(`${file}.tmp`, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  return {
    kid: stored.kid,
    privateKey: (await importJWK(stored.privateJwk as JWK, SIGNING_ALG)) as CryptoKey,
    publicJwk: { ...(stored.publicJwk as JWK), kid: stored.kid, alg: SIGNING_ALG, use: "sig" },
  };
}

interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
  state?: string;
  nonce?: string;
  codeChallenge: string;
  issuedAt: number;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  subject: string;
  nonce?: string;
  expiresAt: number;
}

export interface OAuthServerOptions {
  issuer: string;
  /** The protected MCP resource; the audience of every access token. */
  resource: string;
  clients: FileOAuthClientStore;
  users: FileAdminUserStore;
  throttle: LoginThrottle;
  signingKey: SigningKey;
  /** Secret for tamper-proof authorize forms. */
  formSecret: Buffer;
  /** Display name of a client, e.g. its console label. */
  clientLabel?: (clientId: string) => Promise<string | undefined>;
  now?: () => number;
}

const authorizeQuerySchema = z.object({
  response_type: z.string().optional(),
  client_id: z.string().max(200).optional(),
  redirect_uri: z.string().max(2_048).optional(),
  scope: z.string().max(1_000).optional(),
  state: z.string().max(2_048).optional(),
  nonce: z.string().max(2_048).optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  prompt: z.string().optional(),
});

const authorizeFormSchema = z.object({
  request: z.string().min(1).max(16_384),
  decision: z.enum(["allow", "deny"]).default("allow"),
  username: z.string().max(100).default(""),
  password: z.string().max(256).default(""),
});

function grantedScope(requested: string | undefined): string {
  const scopes = new Set([MCP_OAUTH_SCOPE]);
  for (const scope of (requested ?? "").split(/\s+/)) {
    if (OPTIONAL_SCOPES.has(scope)) scopes.add(scope);
  }
  return [...scopes].join(" ");
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** CSP for pages whose form may redirect to the client's callback. */
function formCsp(redirectUri?: string): string {
  const target = redirectUri ? ` ${new URL(redirectUri).origin}` : "";
  return `default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'${target}; object-src 'none'`;
}

function formString(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Embedded OAuth 2.1 authorization server for the MCP clients. It keeps the
 * Keycloak realm's issuer and endpoint paths, so connectors configured with
 * the former endpoints, client ids and secrets keep working.
 */
export function registerOAuthServer(app: FastifyInstance, options: OAuthServerOptions): void {
  const endpoints = oauthEndpoints(options.issuer);
  const issuerPath = new URL(endpoints.issuer).pathname;
  const issuerOrigin = new URL(endpoints.issuer).origin;
  const now = options.now ?? Date.now;
  const codes = new Map<string, PendingCode>();

  const metadata = {
    issuer: endpoints.issuer,
    authorization_endpoint: endpoints.authorizationEndpoint,
    token_endpoint: endpoints.tokenEndpoint,
    jwks_uri: endpoints.jwksUri,
    revocation_endpoint: endpoints.revocationEndpoint,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    scopes_supported: [MCP_OAUTH_SCOPE, ...OPTIONAL_SCOPES],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [SIGNING_ALG],
    authorization_response_iss_parameter_supported: true,
  };
  for (const path of [
    `/.well-known/oauth-authorization-server${issuerPath}`,
    `/.well-known/openid-configuration${issuerPath}`,
    `${issuerPath}/.well-known/oauth-authorization-server`,
    `${issuerPath}/.well-known/openid-configuration`,
  ]) {
    app.get(path, async (_request, reply) =>
      reply.header("Access-Control-Allow-Origin", "*").send(metadata),
    );
  }

  app.get(`${issuerPath}/protocol/openid-connect/certs`, async (_request, reply) =>
    reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Cache-Control", "public, max-age=300")
      .send({ keys: [options.signingKey.publicJwk] }),
  );

  // --- authorization endpoint -------------------------------------------

  function signRequest(request: AuthorizationRequest): string {
    const payload = Buffer.from(JSON.stringify(request)).toString("base64url");
    const mac = createHmac("sha256", options.formSecret).update(payload).digest("base64url");
    return `${payload}.${mac}`;
  }

  function openRequest(value: string): AuthorizationRequest | undefined {
    const [payload, mac] = value.split(".");
    if (!payload || !mac) return undefined;
    const expected = createHmac("sha256", options.formSecret).update(payload).digest("base64url");
    if (!safeEqual(expected, mac)) return undefined;
    const request = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AuthorizationRequest;
    if (request.issuedAt + AUTHORIZE_FORM_TTL_MS < now()) return undefined;
    return request;
  }

  async function sendError(reply: FastifyReply, status: number, message: string) {
    return reply
      .code(status)
      .header("Content-Security-Policy", formCsp())
      .type("text/html; charset=utf-8")
      .send(errorPage(message));
  }

  async function renderAuthorize(
    reply: FastifyReply,
    request: AuthorizationRequest,
    client: OAuthClientRecord,
    extra: { username?: string; error?: string; status?: number } = {},
  ) {
    const label = (await options.clientLabel?.(client.clientId)) || client.label || client.clientId;
    return reply
      .code(extra.status ?? 200)
      .header("Content-Security-Policy", formCsp(request.redirectUri))
      .type("text/html; charset=utf-8")
      .send(
        authorizePage({
          action: endpoints.authorizationEndpoint,
          request: signRequest(request),
          clientLabel: label,
          redirectHost: new URL(request.redirectUri).host,
          username: extra.username,
          error: extra.error,
        }),
      );
  }

  app.get(`${issuerPath}/protocol/openid-connect/auth`, async (request, reply) => {
    const query = authorizeQuerySchema.safeParse(request.query);
    if (!query.success || !query.data.client_id || !query.data.redirect_uri) {
      return sendError(reply, 400, "授权请求缺少 client_id 或 redirect_uri。");
    }
    const params = query.data;
    const client = await options.clients.getClient(params.client_id!);
    if (!client || !client.enabled) {
      return sendError(reply, 400, "该 OAuth 客户端不存在或已停用。");
    }
    if (!client.redirectUris.includes(params.redirect_uri!)) {
      return sendError(reply, 400, "回调地址与该 OAuth 客户端登记的地址不一致。");
    }
    // From here on errors go back to the verified callback.
    const fail = (error: string, description: string) =>
      reply.redirect(
        redirectWith(params.redirect_uri!, {
          error,
          error_description: description,
          state: params.state,
          iss: endpoints.issuer,
        }),
      );
    if (params.response_type !== "code") {
      return fail("unsupported_response_type", "Only the authorization code flow is supported");
    }
    if (!params.code_challenge || params.code_challenge_method !== "S256") {
      return fail("invalid_request", "PKCE with S256 is required");
    }
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(params.code_challenge)) {
      return fail("invalid_request", "Invalid code_challenge");
    }
    if (params.prompt?.split(/\s+/).includes("none")) {
      return fail("login_required", "Interactive login is required");
    }
    return renderAuthorize(reply, {
      clientId: client.clientId,
      redirectUri: params.redirect_uri!,
      scope: grantedScope(params.scope),
      state: params.state,
      nonce: params.nonce,
      codeChallenge: params.code_challenge,
      issuedAt: now(),
    }, client);
  });

  app.post(`${issuerPath}/protocol/openid-connect/auth`, async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && origin !== issuerOrigin) {
      return sendError(reply, 403, "请求来源不受信任。");
    }
    const form = authorizeFormSchema.safeParse(request.body);
    const authorization = form.success ? openRequest(form.data.request) : undefined;
    if (!form.success || !authorization) {
      return sendError(reply, 400, "授权页面已过期，请返回应用重新发起连接。");
    }
    const client = await options.clients.getClient(authorization.clientId);
    if (!client || !client.enabled || !client.redirectUris.includes(authorization.redirectUri)) {
      return sendError(reply, 400, "该 OAuth 客户端不存在或已停用。");
    }
    if (form.data.decision === "deny") {
      return reply.redirect(
        redirectWith(authorization.redirectUri, {
          error: "access_denied",
          error_description: "The resource owner denied the request",
          state: authorization.state,
          iss: endpoints.issuer,
        }),
      );
    }
    const ip = request.ip;
    if (options.throttle.blocked(ip)) {
      return renderAuthorize(reply, authorization, client, {
        username: form.data.username,
        error: "失败次数过多，请 15 分钟后再试。",
        status: 429,
      });
    }
    const identity = await options.users.verify(form.data.username, form.data.password);
    if (!identity) {
      options.throttle.fail(ip);
      request.log.warn({ clientId: client.clientId }, "OAuth login failed");
      return renderAuthorize(reply, authorization, client, {
        username: form.data.username,
        error: "用户名或密码错误。",
        status: 401,
      });
    }
    options.throttle.reset(ip);

    for (const [key, pending] of codes) {
      if (pending.expiresAt <= now()) codes.delete(key);
    }
    while (codes.size >= MAX_PENDING_CODES) {
      const oldest = codes.keys().next().value;
      if (typeof oldest !== "string") break;
      codes.delete(oldest);
    }
    const code = randomBytes(32).toString("base64url");
    codes.set(code, {
      clientId: client.clientId,
      redirectUri: authorization.redirectUri,
      codeChallenge: authorization.codeChallenge,
      scope: authorization.scope,
      subject: identity.subject,
      nonce: authorization.nonce,
      expiresAt: now() + CODE_TTL_MS,
    });
    request.log.info({ clientId: client.clientId, username: identity.username }, "OAuth authorization granted");
    return reply.redirect(
      redirectWith(authorization.redirectUri, {
        code,
        state: authorization.state,
        iss: endpoints.issuer,
      }),
    );
  });

  // --- token endpoint ----------------------------------------------------

  async function oauthError(
    reply: FastifyReply,
    status: number,
    error: string,
    description: string,
  ) {
    if (status === 401) reply.header("WWW-Authenticate", 'Basic realm="weknora"');
    return reply.code(status).header("Pragma", "no-cache").send({ error, error_description: description });
  }

  /** Client authentication with client_secret_basic or client_secret_post. */
  async function authenticateClient(request: FastifyRequest): Promise<OAuthClientRecord | undefined> {
    let clientId = formString(request.body, "client_id");
    let secret = formString(request.body, "client_secret");
    const header = request.headers.authorization;
    if (header?.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator < 0) return undefined;
      try {
        const basicId = decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, " "));
        if (clientId && clientId !== basicId) return undefined;
        clientId = basicId;
        secret = decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, " "));
      } catch {
        return undefined;
      }
    }
    if (!clientId || !secret) return undefined;
    return options.clients.authenticateClient(clientId, secret);
  }

  async function accessToken(clientId: string, subject: string, scope: string, grantId: string) {
    const issuedAt = Math.floor(now() / 1_000);
    return new SignJWT({ scope, azp: clientId, client_id: clientId, sid: grantId })
      .setProtectedHeader({ alg: SIGNING_ALG, kid: options.signingKey.kid, typ: "JWT" })
      .setIssuer(endpoints.issuer)
      .setSubject(subject)
      .setAudience(options.resource)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
      .setJti(randomUUID())
      .sign(options.signingKey.privateKey);
  }

  async function idToken(clientId: string, subject: string, nonce?: string) {
    const issuedAt = Math.floor(now() / 1_000);
    return new SignJWT({ azp: clientId, ...(nonce ? { nonce } : {}) })
      .setProtectedHeader({ alg: SIGNING_ALG, kid: options.signingKey.kid, typ: "JWT" })
      .setIssuer(endpoints.issuer)
      .setSubject(subject)
      .setAudience(clientId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
      .sign(options.signingKey.privateKey);
  }

  app.post(`${issuerPath}/protocol/openid-connect/token`, async (request, reply) => {
    const client = await authenticateClient(request);
    if (!client) return oauthError(reply, 401, "invalid_client", "Client authentication failed");
    const grantType = formString(request.body, "grant_type");

    if (grantType === "authorization_code") {
      const code = formString(request.body, "code") ?? "";
      const pending = codes.get(code);
      codes.delete(code);
      if (!pending || pending.expiresAt <= now() || pending.clientId !== client.clientId) {
        return oauthError(reply, 400, "invalid_grant", "Authorization code is invalid or expired");
      }
      if (formString(request.body, "redirect_uri") !== pending.redirectUri) {
        return oauthError(reply, 400, "invalid_grant", "redirect_uri does not match");
      }
      const verifier = formString(request.body, "code_verifier") ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(s256(verifier), pending.codeChallenge)) {
        return oauthError(reply, 400, "invalid_grant", "PKCE verification failed");
      }
      const { grant, refreshToken } = await options.clients.createGrant({
        clientId: client.clientId,
        subject: pending.subject,
        scope: pending.scope,
      });
      const scopes = pending.scope.split(" ");
      return {
        access_token: await accessToken(client.clientId, pending.subject, pending.scope, grant.id),
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: refreshToken,
        refresh_expires_in: Math.floor(REFRESH_IDLE_MS / 1_000),
        scope: pending.scope,
        ...(scopes.includes("openid")
          ? { id_token: await idToken(client.clientId, pending.subject, pending.nonce) }
          : {}),
      };
    }

    if (grantType === "refresh_token") {
      const grant = await options.clients.useRefreshToken(
        client.clientId,
        formString(request.body, "refresh_token") ?? "",
      );
      if (!grant) {
        return oauthError(reply, 400, "invalid_grant", "Refresh token is invalid or expired");
      }
      return {
        access_token: await accessToken(client.clientId, grant.subject, grant.scope, grant.id),
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: formString(request.body, "refresh_token"),
        refresh_expires_in: Math.floor(REFRESH_IDLE_MS / 1_000),
        scope: grant.scope,
      };
    }

    return oauthError(reply, 400, "unsupported_grant_type", "Unsupported grant_type");
  });

  app.post(`${issuerPath}/protocol/openid-connect/revoke`, async (request, reply) => {
    const client = await authenticateClient(request);
    if (!client) return oauthError(reply, 401, "invalid_client", "Client authentication failed");
    const token = formString(request.body, "token");
    if (!token) return oauthError(reply, 400, "invalid_request", "token is required");
    // Access tokens are short-lived JWTs; revoking a refresh token ends the grant
    // and the gateway rejects its access tokens immediately.
    await options.clients.revokeRefreshToken(client.clientId, token);
    return reply.code(200).send();
  });

}
