import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { AuthenticationError, type AuthenticatedPrincipal } from "./auth.js";

/**
 * Clients that cannot run an OAuth flow (the Xiaomi phone MCP settings,
 * LobeHub connectors, Codeg and other coding agents) authenticate with named
 * static API keys. All keys of a token client share its access policy; only
 * each key's SHA-256 hash is stored.
 */
export interface ManagedTokenClientDefinition {
  key: string;
  label: string;
  provider: "Token";
  clientId: string;
  mcpUrl: string;
}

export const MANAGED_TOKEN_CLIENTS: ManagedTokenClientDefinition[] = [
  {
    key: "api-keys",
    label: "Key 访问",
    provider: "Token",
    clientId: "token-weknora",
    mcpUrl: "https://wek.uov.me/mcp",
  },
];

/** Per-client token clients that were merged into `token-weknora`. */
export const LEGACY_TOKEN_CLIENTS: Record<string, { clientId: string; keyName: string }> = {
  "xiaomi-weknora-token": { clientId: "token-weknora", keyName: "小米手机" },
  "lobehub-weknora-token": { clientId: "token-weknora", keyName: "LobeHub" },
  "codeg-weknora-token": { clientId: "token-weknora", keyName: "Codeg" },
};

export const STATIC_TOKEN_PREFIX = "wkmcp_";

const keyRecordSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]{8,32}$/),
  clientId: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
});

const tokenFileSchema = z.strictObject({
  version: z.literal(2),
  keys: z.array(keyRecordSchema),
});

const legacyTokenFileSchema = z.strictObject({
  version: z.literal(1),
  clients: z.record(
    z.string().min(1),
    z.strictObject({
      tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
      enabled: z.boolean(),
      createdAt: z.string().datetime(),
    }),
  ),
});

type TokenFile = z.infer<typeof tokenFileSchema>;
type KeyRecord = z.infer<typeof keyRecordSchema>;

export type StaticKeySummary = Omit<KeyRecord, "tokenSha256" | "clientId">;

export interface StaticTokenMatch {
  clientId: string;
  keyId: string;
  keyName: string;
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

function newKeyId(): string {
  return randomBytes(6).toString("hex");
}

export function isStaticToken(token: string): boolean {
  return token.startsWith(STATIC_TOKEN_PREFIX);
}

function migrateLegacy(value: z.infer<typeof legacyTokenFileSchema>): TokenFile {
  return {
    version: 2,
    keys: Object.entries(value.clients).map(([clientId, record], index) => {
      const target = LEGACY_TOKEN_CLIENTS[clientId];
      return {
        // Deterministic so that every reader of the legacy file agrees.
        id: createHash("sha256").update(`${clientId}:${index}`).digest("hex").slice(0, 12),
        clientId: target?.clientId ?? clientId,
        name: target?.keyName ?? clientId,
        tokenSha256: record.tokenSha256,
        enabled: record.enabled,
        createdAt: record.createdAt,
      };
    }),
  };
}

export class FileStaticTokenStore {
  private readonly file: string;
  private readonly now: () => Date;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: { file: string; now?: () => Date }) {
    this.file = options.file;
    this.now = options.now ?? (() => new Date());
  }

  /** Returns the enabled key matching the token, or undefined. */
  async verify(token: string): Promise<StaticTokenMatch | undefined> {
    if (!isStaticToken(token)) return undefined;
    const presented = sha256(token);
    let match: StaticTokenMatch | undefined;
    for (const record of (await this.load()).keys) {
      const stored = Buffer.from(record.tokenSha256, "hex");
      if (timingSafeEqual(stored, presented) && record.enabled) {
        match = { clientId: record.clientId, keyId: record.id, keyName: record.name };
      }
    }
    return match;
  }

  async listKeys(clientId: string): Promise<StaticKeySummary[]> {
    return (await this.load()).keys
      .filter((record) => record.clientId === clientId)
      .map(({ id, name, enabled, createdAt }) => ({ id, name, enabled, createdAt }));
  }

  /** Issues a new named key; the plaintext token is returned only here. */
  async createKey(
    clientId: string,
    name: string,
  ): Promise<{ key: StaticKeySummary; token: string }> {
    const token = `${STATIC_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const record = keyRecordSchema.parse({
      id: newKeyId(),
      clientId,
      name: name.trim(),
      tokenSha256: sha256(token).toString("hex"),
      enabled: true,
      createdAt: this.now().toISOString(),
    });
    await this.update((data) => {
      if (data.keys.filter((key) => key.clientId === clientId).length >= 50) {
        throw new StaticTokenError("Too many API keys for this client");
      }
      data.keys.push(record);
    });
    const { id, enabled, createdAt } = record;
    return { key: { id, name: record.name, enabled, createdAt }, token };
  }

  async setKeyEnabled(clientId: string, keyId: string, enabled: boolean): Promise<StaticKeySummary> {
    let updated: KeyRecord | undefined;
    await this.update((data) => {
      updated = data.keys.find((key) => key.clientId === clientId && key.id === keyId);
      if (!updated) throw new StaticTokenError("API key does not exist");
      updated.enabled = enabled;
    });
    const { id, name, createdAt } = updated!;
    return { id, name, enabled, createdAt };
  }

  async deleteKey(clientId: string, keyId: string): Promise<{ deleted: boolean }> {
    let deleted = false;
    await this.update((data) => {
      const before = data.keys.length;
      data.keys = data.keys.filter((key) => !(key.clientId === clientId && key.id === keyId));
      deleted = data.keys.length < before;
    });
    return { deleted };
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
        return { version: 2, keys: [] };
      }
      throw error;
    }
    const value = JSON.parse(text) as unknown;
    const legacy = legacyTokenFileSchema.safeParse(value);
    if (legacy.success) return migrateLegacy(legacy.data);
    const parsed = tokenFileSchema.safeParse(value);
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
    const match = await options.staticTokens.verify(token);
    if (!match) throw new AuthenticationError("Invalid static token");
    return {
      subject: `static-token:${match.clientId}:${match.keyId}`,
      clientId: match.clientId,
      scopes: [options.scope],
    };
  };
}

/** Remote MCP configuration a client can paste, e.g. into Codeg or Claude Code. */
export function mcpClientConfig(mcpUrl: string, token: string) {
  return {
    type: "http",
    url: mcpUrl,
    headers: { Authorization: `Bearer ${token}` },
  };
}
