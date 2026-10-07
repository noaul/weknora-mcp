import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { AuthenticationError, type AuthenticatedPrincipal } from "./auth.js";

/**
 * Clients that cannot run an OAuth flow (for example the Xiaomi phone MCP
 * settings, which only accept a URL and a fixed Bearer token) authenticate
 * with a long random static token. Only its SHA-256 hash is stored.
 */
export interface ManagedTokenClientDefinition {
  key: string;
  label: string;
  provider: "Xiaomi";
  clientId: string;
  mcpUrl: string;
}

export const MANAGED_TOKEN_CLIENTS: ManagedTokenClientDefinition[] = [
  {
    key: "xiaomi-token",
    label: "小米手机 WeKnora",
    provider: "Xiaomi",
    clientId: "xiaomi-weknora-token",
    mcpUrl: "https://wek.uov.me/mcp",
  },
];

export const STATIC_TOKEN_PREFIX = "wkmcp_";

const tokenRecordSchema = z.strictObject({
  tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
});

const tokenFileSchema = z.strictObject({
  version: z.literal(1),
  clients: z.record(z.string().min(1), tokenRecordSchema),
});

type TokenFile = z.infer<typeof tokenFileSchema>;

export interface StaticTokenStatus {
  hasToken: boolean;
  enabled: boolean;
  createdAt?: string;
}

export class StaticTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaticTokenError";
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isStaticToken(token: string): boolean {
  return token.startsWith(STATIC_TOKEN_PREFIX);
}

export class FileStaticTokenStore {
  private readonly file: string;
  private readonly now: () => Date;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: { file: string; now?: () => Date }) {
    this.file = options.file;
    this.now = options.now ?? (() => new Date());
  }

  /** Returns the client ID owning an enabled token, or undefined. */
  async verify(token: string): Promise<string | undefined> {
    if (!isStaticToken(token)) return undefined;
    const presented = sha256(token);
    let match: string | undefined;
    for (const [clientId, record] of Object.entries((await this.load()).clients)) {
      const stored = Buffer.from(record.tokenSha256, "hex");
      if (timingSafeEqual(stored, presented) && record.enabled) match = clientId;
    }
    return match;
  }

  async status(clientId: string): Promise<StaticTokenStatus> {
    const data = await this.load();
    const record = Object.hasOwn(data.clients, clientId)
      ? data.clients[clientId]
      : undefined;
    return record
      ? { hasToken: true, enabled: record.enabled, createdAt: record.createdAt }
      : { hasToken: false, enabled: false };
  }

  /** Issues a new token for the client, invalidating the previous one. */
  async rotate(clientId: string): Promise<{ token: string; replacedExisting: boolean }> {
    const token = `${STATIC_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    let replacedExisting = false;
    await this.update((data) => {
      replacedExisting = Object.hasOwn(data.clients, clientId);
      data.clients[clientId] = {
        tokenSha256: sha256(token).toString("hex"),
        enabled: true,
        createdAt: this.now().toISOString(),
      };
    });
    return { token, replacedExisting };
  }

  async setEnabled(clientId: string, enabled: boolean): Promise<StaticTokenStatus> {
    await this.update((data) => {
      if (!Object.hasOwn(data.clients, clientId)) {
        throw new StaticTokenError("Generate a token before changing its state");
      }
      data.clients[clientId]!.enabled = enabled;
    });
    return this.status(clientId);
  }

  async revoke(clientId: string): Promise<{ revoked: boolean }> {
    let revoked = false;
    await this.update((data) => {
      revoked = Object.hasOwn(data.clients, clientId);
      delete data.clients[clientId];
    });
    return { revoked };
  }

  private async load(): Promise<TokenFile> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { version: 1, clients: {} };
      }
      throw error;
    }
    const parsed = tokenFileSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) throw new StaticTokenError("Static token file is not valid");
    return parsed.data;
  }

  private update(mutate: (data: TokenFile) => void): Promise<void> {
    const pending = this.writeTail.then(async () => {
      const data = await this.load();
      mutate(data);
      const temporaryFile = `${this.file}.tmp`;
      await mkdir(dirname(this.file), { recursive: true, mode: 0o750 });
      await writeFile(temporaryFile, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o640,
      });
      await rename(temporaryFile, this.file);
    });
    this.writeTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

/**
 * Accepts static tokens and delegates every other token to the OAuth verifier.
 */
export function createCombinedTokenVerifier(options: {
  staticTokens: Pick<FileStaticTokenStore, "verify">;
  oauth: (token: string) => Promise<AuthenticatedPrincipal>;
  scope: string;
}) {
  return async (token: string): Promise<AuthenticatedPrincipal> => {
    if (!isStaticToken(token)) return options.oauth(token);
    const clientId = await options.staticTokens.verify(token);
    if (!clientId) throw new AuthenticationError("Invalid static token");
    return { subject: `static-token:${clientId}`, clientId, scopes: [options.scope] };
  };
}
