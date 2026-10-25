import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface ConsoleIdentity {
  subject: string;
  username: string;
  roles: string[];
}

function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
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
