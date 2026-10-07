import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { AuthenticationError, type AuthenticatedPrincipal } from "./auth.js";

/**
 * Clients that cannot run an OAuth flow (the Xiaomi phone MCP settings,
 * LobeHub connectors, Codeg and other coding agents) authenticate with named
 * static API keys. Every key is its own access-policy client
 * (`apikey-<id>`); only each key's SHA-256 hash is stored.
 */
export const API_KEY_CLIENT_PREFIX = "apikey-";

export function apiKeyClientId(keyId: string): string {
  return `${API_KEY_CLIENT_PREFIX}${keyId}`;
}

/** Former shared token clients whose keys are split into per-key clients. */
export const LEGACY_TOKEN_CLIENT_IDS = [
  "token-weknora",
  "xiaomi-weknora-token",
  "lobehub-weknora-token",
  "codeg-weknora-token",
];

/** Version-1 per-app token files are read as keys named after the app. */
const LEGACY_KEY_NAMES: Record<string, string> = {
  "xiaomi-weknora-token": "小米手机",
  "lobehub-weknora-token": "LobeHub",
  "codeg-weknora-token": "Codeg",
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

export type StaticKeySummary = Omit<KeyRecord, "tokenSha256">;

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

function newToken(): string {
  return `${STATIC_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function summary({ tokenSha256: _hash, ...key }: KeyRecord): StaticKeySummary {
  return key;
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
      return {
        // Deterministic so that every reader of the legacy file agrees.
        id: createHash("sha256").update(`${clientId}:${index}`).digest("hex").slice(0, 12),
        clientId,
        name: LEGACY_KEY_NAMES[clientId] ?? clientId,
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

  async listKeys(): Promise<StaticKeySummary[]> {
    return (await this.load()).keys.map(summary);
  }

  /** Issues a new named key with its own client id; the token is returned only here. */
  async createKey(name: string): Promise<{ key: StaticKeySummary; token: string }> {
    const token = newToken();
    const id = newKeyId();
    const record = keyRecordSchema.parse({
      id,
      clientId: apiKeyClientId(id),
      name: name.trim(),
      tokenSha256: sha256(token).toString("hex"),
      enabled: true,
      createdAt: this.now().toISOString(),
    });
    await this.update((data) => {
      if (data.keys.length >= 100) throw new StaticTokenError("Too many API keys");
      data.keys.push(record);
    });
    return { key: summary(record), token };
  }

  /** Replaces a key's token; its id, client and permissions stay the same. */
  async rotateKey(keyId: string): Promise<{ key: StaticKeySummary; token: string }> {
    const token = newToken();
    const record = await this.change(keyId, (key) => {
      key.tokenSha256 = sha256(token).toString("hex");
      key.createdAt = this.now().toISOString();
    });
    return { key: record, token };
  }

  setKeyEnabled(keyId: string, enabled: boolean): Promise<StaticKeySummary> {
    return this.change(keyId, (key) => {
      key.enabled = enabled;
    });
  }

  renameKey(keyId: string, name: string): Promise<StaticKeySummary> {
    return this.change(keyId, (key) => {
      key.name = name.trim();
    });
  }

  /** Moves a key to another access-policy client (used by migrations). */
  reassignKey(keyId: string, clientId: string): Promise<StaticKeySummary> {
    return this.change(keyId, (key) => {
      key.clientId = clientId;
    });
  }

  async deleteKey(keyId: string): Promise<{ deleted: boolean }> {
    let deleted = false;
    await this.update((data) => {
      const before = data.keys.length;
      data.keys = data.keys.filter((key) => key.id !== keyId);
      deleted = data.keys.length < before;
    });
    return { deleted };
  }

  private async change(keyId: string, mutate: (key: KeyRecord) => void): Promise<StaticKeySummary> {
    let updated: KeyRecord | undefined;
    await this.update((data) => {
      updated = data.keys.find((key) => key.id === keyId);
      if (!updated) throw new StaticTokenError("API key does not exist");
      mutate(updated);
      keyRecordSchema.parse(updated);
    });
    return summary(updated!);
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
