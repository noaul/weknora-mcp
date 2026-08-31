import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

export interface ConsoleIdentity {
  subject: string;
  username: string;
  roles: string[];
}

export interface OidcTransaction {
  verifier: string;
  nonce: string;
  expiresAt: number;
}

interface OidcTokens {
  accessToken: string;
  idToken: string;
}

export function validateOidcTokenClaims(options: {
  idToken: Record<string, unknown>;
  accessToken: Record<string, unknown>;
  nonce: string;
  clientId: string;
  requiredRole: string;
}): ConsoleIdentity {
  if (options.idToken.nonce !== options.nonce) {
    throw new SessionAuthorizationError("OIDC nonce mismatch");
  }
  if (options.accessToken.azp !== options.clientId) {
    throw new SessionAuthorizationError("OIDC authorized party mismatch");
  }
  const subject = options.idToken.sub;
  if (typeof subject !== "string" || !subject) {
    throw new SessionAuthorizationError("OIDC subject is missing");
  }
  if (options.accessToken.sub !== subject) {
    throw new SessionAuthorizationError("OIDC token subject mismatch");
  }
  const realmAccess = options.accessToken.realm_access;
  const roles =
    realmAccess && typeof realmAccess === "object"
      ? (realmAccess as Record<string, unknown>).roles
      : undefined;
  const normalizedRoles = Array.isArray(roles)
    ? roles.filter((role): role is string => typeof role === "string")
    : [];
  if (!normalizedRoles.includes(options.requiredRole)) {
    throw new SessionAuthorizationError("Required realm role is missing");
  }
  const preferredUsername = options.idToken.preferred_username;
  const email = options.idToken.email;
  return {
    subject,
    username:
      typeof preferredUsername === "string"
        ? preferredUsername
        : typeof email === "string"
          ? email
          : subject,
    roles: normalizedRoles,
  };
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1),
});

function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export class ConsoleOidcClient {
  private readonly options: {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    requiredRole: string;
    fetchImpl: typeof fetch;
    verifyTokens: (
      tokens: OidcTokens,
      transaction: OidcTransaction,
    ) => Promise<ConsoleIdentity>;
    now: () => number;
    maxTransactions: number;
  };
  private readonly transactions = new Map<string, OidcTransaction>();

  constructor(options: {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    jwksUrl?: string;
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    requiredRole: string;
    fetchImpl?: typeof fetch;
    verifyTokens?: (
      tokens: OidcTokens,
      transaction: OidcTransaction,
    ) => Promise<ConsoleIdentity>;
    now?: () => number;
    maxTransactions?: number;
  }) {
    const maxTransactions = options.maxTransactions ?? 256;
    if (!Number.isSafeInteger(maxTransactions) || maxTransactions < 1) {
      throw new Error("maxTransactions must be a positive integer");
    }
    const verifyTokens =
      options.verifyTokens ??
      this.defaultTokenVerifier({
        issuer: options.issuer,
        jwksUrl: options.jwksUrl,
        clientId: options.clientId,
        requiredRole: options.requiredRole,
      });
    this.options = {
      issuer: options.issuer,
      authorizationEndpoint: options.authorizationEndpoint,
      tokenEndpoint: options.tokenEndpoint,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      callbackUrl: options.callbackUrl,
      requiredRole: options.requiredRole,
      fetchImpl: options.fetchImpl ?? fetch,
      verifyTokens,
      now: options.now ?? Date.now,
      maxTransactions,
    };
  }

  beginLogin(): { authorizationUrl: URL; state: string } {
    this.deleteExpiredTransactions();
    while (this.transactions.size >= this.options.maxTransactions) {
      const oldestState = this.transactions.keys().next().value;
      if (typeof oldestState !== "string") break;
      this.transactions.delete(oldestState);
    }
    const state = randomUrlSafe();
    const verifier = randomUrlSafe(48);
    const nonce = randomUrlSafe();
    this.transactions.set(state, {
      verifier,
      nonce,
      expiresAt: this.options.now() + 5 * 60_000,
    });
    const authorizationUrl = new URL(this.options.authorizationEndpoint);
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: this.options.clientId,
      redirect_uri: this.options.callbackUrl,
      scope: "openid profile email roles",
      state,
      nonce,
      code_challenge: codeChallenge(verifier),
      code_challenge_method: "S256",
    }).toString();
    return { authorizationUrl, state };
  }

  async completeLogin(state: string, code: string): Promise<ConsoleIdentity> {
    const transaction = this.transactions.get(state);
    this.transactions.delete(state);
    if (!transaction || transaction.expiresAt <= this.options.now()) {
      throw new SessionAuthorizationError("OAuth state is missing or expired");
    }
    const response = await this.options.fetchImpl(this.options.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        redirect_uri: this.options.callbackUrl,
        code,
        code_verifier: transaction.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new SessionAuthorizationError("OAuth token exchange failed");
    const parsed = tokenResponseSchema.parse(await response.json());
    return this.options.verifyTokens(
      { accessToken: parsed.access_token, idToken: parsed.id_token },
      transaction,
    );
  }

  private deleteExpiredTransactions(): void {
    const now = this.options.now();
    for (const [state, transaction] of this.transactions) {
      if (transaction.expiresAt <= now) this.transactions.delete(state);
    }
  }

  private defaultTokenVerifier(options: {
    issuer: string;
    jwksUrl?: string;
    clientId: string;
    requiredRole: string;
  }) {
    if (!options.jwksUrl) throw new Error("jwksUrl is required without verifyTokens");
    const jwks = createRemoteJWKSet(new URL(options.jwksUrl));
    return async (
      tokens: OidcTokens,
      transaction: OidcTransaction,
    ): Promise<ConsoleIdentity> => {
      const idToken = await jwtVerify(tokens.idToken, jwks, {
        issuer: options.issuer,
        audience: options.clientId,
      });
      if (idToken.payload.nonce !== transaction.nonce) {
        throw new SessionAuthorizationError("OIDC nonce mismatch");
      }
      const accessToken = await jwtVerify(tokens.accessToken, jwks, {
        issuer: options.issuer,
        audience: options.clientId,
      });
      return validateOidcTokenClaims({
        idToken: idToken.payload,
        accessToken: accessToken.payload,
        nonce: transaction.nonce,
        clientId: options.clientId,
        requiredRole: options.requiredRole,
      });
    };
  }
}

export class SessionAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionAuthorizationError";
  }
}

export interface ConsoleSession extends ConsoleIdentity {
  id: string;
  csrfToken: string;
  expiresAt: number;
}

export class ConsoleSessionStore {
  private readonly sessions = new Map<string, Omit<ConsoleSession, "id">>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly secret: Buffer;
  private readonly maxSessions: number;

  constructor(options: {
    ttlMs: number;
    secret: Buffer;
    now?: () => number;
    maxSessions?: number;
  }) {
    if (options.secret.length < 32) throw new Error("Session secret must be at least 32 bytes");
    const maxSessions = options.maxSessions ?? 1_024;
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) {
      throw new Error("maxSessions must be a positive integer");
    }
    this.ttlMs = options.ttlMs;
    this.secret = options.secret;
    this.now = options.now ?? Date.now;
    this.maxSessions = maxSessions;
  }

  create(identity: ConsoleIdentity): ConsoleSession {
    this.deleteExpiredSessions();
    while (this.sessions.size >= this.maxSessions) {
      const oldestId = this.sessions.keys().next().value;
      if (typeof oldestId !== "string") break;
      this.sessions.delete(oldestId);
    }
    const rawId = randomUrlSafe();
    const id = this.sign(rawId);
    const session = {
      ...identity,
      csrfToken: randomUrlSafe(),
      expiresAt: this.now() + this.ttlMs,
    };
    this.sessions.set(rawId, session);
    return { id, ...session };
  }

  get(id: string | undefined): ConsoleSession | undefined {
    const rawId = this.verify(id);
    if (!rawId) return undefined;
    const session = this.sessions.get(rawId);
    if (!session) return undefined;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(rawId);
      return undefined;
    }
    return { id: id as string, ...session };
  }

  delete(id: string | undefined): void {
    const rawId = this.verify(id);
    if (rawId) this.sessions.delete(rawId);
  }

  assertCsrf(id: string | undefined, csrfToken: string | undefined): void {
    const session = this.get(id);
    if (!session || !csrfToken || !safeEqual(session.csrfToken, csrfToken)) {
      throw new SessionAuthorizationError("CSRF token is invalid");
    }
  }

  private sign(rawId: string): string {
    const signature = createHmac("sha256", this.secret).update(rawId).digest("base64url");
    return `${rawId}.${signature}`;
  }

  private deleteExpiredSessions(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  private verify(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const separator = value.lastIndexOf(".");
    if (separator <= 0) return undefined;
    const rawId = value.slice(0, separator);
    return safeEqual(this.sign(rawId), value) ? rawId : undefined;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
  );
}
