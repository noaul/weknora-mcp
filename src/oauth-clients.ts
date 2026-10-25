import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

export type OAuthProvider = "ChatGPT" | "Claude" | "Gemini";

export interface ManagedOAuthClientDefinition {
  label: string;
  provider: OAuthProvider;
  clientId: string;
}

/** State of one managed OAuth client as shown in the console. */
export interface OAuthClientState {
  clientId: string;
  /** False when the policy references a client that no longer exists in the OAuth store. */
  exists: boolean;
  enabled: boolean;
  redirectUri: string;
  sessionCount: number;
}

export interface OAuthEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface ManagedOAuthClientUpdate {
  enabled?: boolean;
  redirectUri?: string;
}

export const OAUTH_PROVIDERS: Record<
  OAuthProvider,
  { clientIdPrefix: string; defaultRedirectUri: string }
> = {
  ChatGPT: {
    clientIdPrefix: "chatgpt-weknora",
    defaultRedirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
  },
  Claude: {
    clientIdPrefix: "claude-weknora",
    defaultRedirectUri: "https://claude.ai/api/mcp/auth_callback",
  },
  Gemini: {
    clientIdPrefix: "gemini-weknora",
    // Configure the exact callback from the application rather than guessing a Google URL.
    defaultRedirectUri: "",
  },
};

export const MCP_OAUTH_SCOPE = "weknora:mcp";

/** The two original OAuth clients; seeded into a new policy. */
export const MANAGED_OAUTH_CLIENTS: ManagedOAuthClientDefinition[] = [
  { label: "ChatGPT WeKnora", provider: "ChatGPT", clientId: "chatgpt-weknora-read" },
  { label: "Claude WeKnora", provider: "Claude", clientId: "claude-weknora-read" },
];

/** OAuth paths below the issuer; identical to the former Keycloak realm. */
export function oauthEndpoints(issuer: string) {
  const base = issuer.replace(/\/$/, "");
  return {
    issuer: base,
    authorizationEndpoint: `${base}/protocol/openid-connect/auth`,
    tokenEndpoint: `${base}/protocol/openid-connect/token`,
    jwksUri: `${base}/protocol/openid-connect/certs`,
    revocationEndpoint: `${base}/protocol/openid-connect/revoke`,
  };
}

export class OAuthClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthClientError";
  }
}

export function validateRedirectUri(value: string): string {
  if (value.length > 2_048 || value.includes("*")) {
    throw new OAuthClientError("OAuth redirect URI must be exact and contain no wildcard");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthClientError("OAuth redirect URI is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new OAuthClientError("OAuth redirect URI must be an exact HTTPS URL");
  }
  return url.toString();
}

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

const clientRecordSchema = z.strictObject({
  clientId: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
  label: z.string().max(200),
  secretSha256: sha256Hex,
  enabled: z.boolean(),
  redirectUris: z.array(z.string().url()).max(20),
  createdAt: z.string().datetime(),
});

/** One authorization: a refresh token and the access tokens derived from it. */
const grantRecordSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  clientId: z.string().min(1),
  subject: z.string().min(1),
  scope: z.string(),
  refreshTokenSha256: sha256Hex,
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime(),
});

const storeFileSchema = z.strictObject({
  version: z.literal(1),
  clients: z.array(clientRecordSchema),
  grants: z.array(grantRecordSchema),
});

type StoreFile = z.infer<typeof storeFileSchema>;
export type OAuthClientRecord = z.infer<typeof clientRecordSchema>;
export type OAuthGrantRecord = z.infer<typeof grantRecordSchema>;

export const REFRESH_TOKEN_PREFIX = "wkrt_";
/** A refresh token unused for this long expires. */
export const REFRESH_IDLE_MS = 30 * 24 * 60 * 60_000;
/** A grant expires this long after its authorization regardless of use. */
export const REFRESH_MAX_MS = 180 * 24 * 60 * 60_000;
const MAX_GRANTS_PER_CLIENT = 50;
const MAX_CLIENTS = 100;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameHash(storedHex: string, presented: string): boolean {
  return timingSafeEqual(Buffer.from(storedHex, "hex"), Buffer.from(sha256(presented), "hex"));
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * OAuth clients and grants of the embedded authorization server, kept in one
 * JSON file. The console is the only writer; the gateway reads the file to
 * reject tokens of disabled clients and revoked grants immediately. Client
 * secrets and refresh tokens are stored as SHA-256 hashes only.
 */
export class FileOAuthClientStore {
  private readonly file: string;
  private readonly issuer: string;
  private readonly now: () => number;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: { file: string; issuer: string; now?: () => number }) {
    this.file = options.file;
    this.issuer = options.issuer.replace(/\/$/, "");
    this.now = options.now ?? Date.now;
  }

  endpoints(): OAuthEndpoints {
    const { issuer, authorizationEndpoint, tokenEndpoint } = oauthEndpoints(this.issuer);
    return { issuer, authorizationEndpoint, tokenEndpoint };
  }

  async listClients(clientIds: string[]): Promise<OAuthClientState[]> {
    const data = await this.load();
    return clientIds.map((clientId) => {
      const client = data.clients.find((candidate) => candidate.clientId === clientId);
      if (!client) {
        return { clientId, exists: false, enabled: false, redirectUri: "", sessionCount: 0 };
      }
      return this.toState(client, data);
    });
  }

  async getClient(clientId: string): Promise<OAuthClientRecord | undefined> {
    return (await this.load()).clients.find((client) => client.clientId === clientId);
  }

  /** Returns the enabled client whose secret matches, or undefined. */
  async authenticateClient(
    clientId: string,
    secret: string,
  ): Promise<OAuthClientRecord | undefined> {
    const client = await this.getClient(clientId);
    if (!client || !sameHash(client.secretSha256, secret) || !client.enabled) return undefined;
    return client;
  }

  /** Creates a confidential authorization-code client; the secret is returned only here. */
  async createClient(options: {
    clientId: string;
    label: string;
    redirectUri: string;
  }): Promise<{ state: OAuthClientState; secret: string }> {
    const secret = newSecret();
    const record = clientRecordSchema.parse({
      clientId: options.clientId,
      label: options.label,
      secretSha256: sha256(secret),
      enabled: true,
      redirectUris: [validateRedirectUri(options.redirectUri)],
      createdAt: new Date(this.now()).toISOString(),
    });
    let state: OAuthClientState | undefined;
    await this.update((data) => {
      if (data.clients.some(({ clientId }) => clientId === record.clientId)) {
        throw new OAuthClientError(`OAuth client ${record.clientId} already exists`);
      }
      if (data.clients.length >= MAX_CLIENTS) throw new OAuthClientError("Too many OAuth clients");
      data.clients.push(record);
      state = this.toState(record, data);
    });
    return { state: state!, secret };
  }

  /** Adds or replaces a client with a known secret (used by the Keycloak import). */
  async importClient(options: {
    clientId: string;
    label: string;
    secret: string;
    enabled: boolean;
    redirectUris: string[];
  }): Promise<void> {
    const record = clientRecordSchema.parse({
      clientId: options.clientId,
      label: options.label,
      secretSha256: sha256(options.secret),
      enabled: options.enabled,
      redirectUris: options.redirectUris.map(validateRedirectUri),
      createdAt: new Date(this.now()).toISOString(),
    });
    await this.update((data) => {
      data.clients = data.clients.filter(({ clientId }) => clientId !== record.clientId);
      data.clients.push(record);
    });
  }

  async deleteClient(clientId: string): Promise<{ deleted: boolean }> {
    let deleted = false;
    await this.update((data) => {
      const before = data.clients.length;
      data.clients = data.clients.filter((client) => client.clientId !== clientId);
      data.grants = data.grants.filter((grant) => grant.clientId !== clientId);
      deleted = data.clients.length < before;
    });
    return { deleted };
  }

  async updateClient(
    clientId: string,
    update: ManagedOAuthClientUpdate,
  ): Promise<OAuthClientState> {
    if (update.enabled === undefined && update.redirectUri === undefined) {
      throw new OAuthClientError("OAuth client update is empty");
    }
    const redirectUri =
      update.redirectUri === undefined ? undefined : validateRedirectUri(update.redirectUri);
    let state: OAuthClientState | undefined;
    await this.update((data) => {
      const client = this.find(data, clientId);
      if (update.enabled !== undefined) client.enabled = update.enabled;
      if (redirectUri !== undefined) client.redirectUris = [redirectUri];
      state = this.toState(client, data);
    });
    return state!;
  }

  async rotateClientSecret(
    clientId: string,
  ): Promise<{ secret: string; oldSecretInvalidated: boolean }> {
    const secret = newSecret();
    await this.update((data) => {
      this.find(data, clientId).secretSha256 = sha256(secret);
    });
    return { secret, oldSecretInvalidated: true };
  }

  async revokeClientSessions(clientId: string): Promise<{ revokedSessions: number }> {
    let revokedSessions = 0;
    await this.update((data) => {
      this.find(data, clientId);
      const before = data.grants.length;
      data.grants = data.grants.filter((grant) => grant.clientId !== clientId);
      revokedSessions = before - data.grants.length;
    });
    return { revokedSessions };
  }

  /** Records a new authorization and returns its one-time visible refresh token. */
  async createGrant(options: {
    clientId: string;
    subject: string;
    scope: string;
  }): Promise<{ grant: OAuthGrantRecord; refreshToken: string }> {
    const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const now = new Date(this.now()).toISOString();
    const grant = grantRecordSchema.parse({
      id: randomBytes(18).toString("base64url"),
      clientId: options.clientId,
      subject: options.subject,
      scope: options.scope,
      refreshTokenSha256: sha256(refreshToken),
      createdAt: now,
      lastUsedAt: now,
    });
    await this.update((data) => {
      this.find(data, options.clientId);
      const own = data.grants.filter((candidate) => candidate.clientId === options.clientId);
      if (own.length >= MAX_GRANTS_PER_CLIENT) {
        const oldest = own.reduce((left, right) =>
          left.lastUsedAt <= right.lastUsedAt ? left : right,
        );
        data.grants = data.grants.filter((candidate) => candidate.id !== oldest.id);
      }
      data.grants.push(grant);
    });
    return { grant, refreshToken };
  }

  /**
   * Returns the live grant of the refresh token and extends its idle lifetime.
   * The refresh token itself stays valid; the clients are confidential.
   */
  async useRefreshToken(
    clientId: string,
    refreshToken: string,
  ): Promise<OAuthGrantRecord | undefined> {
    if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return undefined;
    let found: OAuthGrantRecord | undefined;
    await this.update((data) => {
      const grant = data.grants.find(
        (candidate) =>
          candidate.clientId === clientId &&
          sameHash(candidate.refreshTokenSha256, refreshToken),
      );
      if (!grant || !this.grantLive(grant)) return;
      grant.lastUsedAt = new Date(this.now()).toISOString();
      found = { ...grant };
    });
    return found;
  }

  /** Revokes the grant of a refresh token (RFC 7009); unknown tokens are ignored. */
  async revokeRefreshToken(clientId: string, refreshToken: string): Promise<boolean> {
    let revoked = false;
    await this.update((data) => {
      const before = data.grants.length;
      data.grants = data.grants.filter(
        (grant) =>
          grant.clientId !== clientId || !sameHash(grant.refreshTokenSha256, refreshToken),
      );
      revoked = data.grants.length < before;
    });
    return revoked;
  }

  /** True while the client is enabled and the grant has not been revoked or expired. */
  async isGrantActive(clientId: string, grantId: string): Promise<boolean> {
    const data = await this.load();
    const client = data.clients.find((candidate) => candidate.clientId === clientId);
    const grant = data.grants.find(
      (candidate) => candidate.id === grantId && candidate.clientId === clientId,
    );
    return Boolean(client?.enabled && grant && this.grantLive(grant));
  }

  private grantLive(grant: OAuthGrantRecord): boolean {
    const now = this.now();
    return (
      Date.parse(grant.lastUsedAt) + REFRESH_IDLE_MS > now &&
      Date.parse(grant.createdAt) + REFRESH_MAX_MS > now
    );
  }

  private find(data: StoreFile, clientId: string): OAuthClientRecord {
    const client = data.clients.find((candidate) => candidate.clientId === clientId);
    if (!client) throw new OAuthClientError(`Managed OAuth client ${clientId} is missing`);
    return client;
  }

  private toState(client: OAuthClientRecord, data: StoreFile): OAuthClientState {
    return {
      clientId: client.clientId,
      exists: true,
      enabled: client.enabled,
      redirectUri: client.redirectUris[0] ?? "",
      sessionCount: data.grants.filter(
        (grant) => grant.clientId === client.clientId && this.grantLive(grant),
      ).length,
    };
  }

  private async load(): Promise<StoreFile> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { version: 1, clients: [], grants: [] };
      }
      throw error;
    }
    const parsed = storeFileSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) throw new OAuthClientError("OAuth client file is not valid");
    return parsed.data;
  }

  private update(mutate: (data: StoreFile) => void): Promise<void> {
    const pending = this.writeTail.then(async () => {
      const data = await this.load();
      mutate(data);
      data.grants = data.grants.filter((grant) => this.grantLive(grant));
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
