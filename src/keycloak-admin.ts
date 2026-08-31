import { z } from "zod";

export interface ManagedOAuthClientDefinition {
  key: string;
  label: string;
  provider: "ChatGPT" | "Claude";
  profile: "read" | "admin";
  clientId: string;
  mcpUrl: string;
  scope: string;
  requiredRole?: string;
}

export interface ManagedOAuthClientSummary extends ManagedOAuthClientDefinition {
  enabled: boolean;
  redirectUri: string;
  sessionCount: number;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface ManagedOAuthClientUpdate {
  enabled?: boolean;
  redirectUri?: string;
}

export const MANAGED_OAUTH_CLIENTS: ManagedOAuthClientDefinition[] = [
  {
    key: "chatgpt-read",
    label: "ChatGPT 只读",
    provider: "ChatGPT",
    profile: "read",
    clientId: "chatgpt-weknora-read",
    mcpUrl: "https://wek.uov.me/mcp",
    scope: "weknora:read",
  },
  {
    key: "chatgpt-admin",
    label: "ChatGPT 管理",
    provider: "ChatGPT",
    profile: "admin",
    clientId: "chatgpt-weknora-admin",
    mcpUrl: "https://wek.uov.me/mcp-admin",
    scope: "weknora:admin",
    requiredRole: "weknora-admin",
  },
  {
    key: "claude-read",
    label: "Claude 只读",
    provider: "Claude",
    profile: "read",
    clientId: "claude-weknora-read",
    mcpUrl: "https://wek.uov.me/mcp",
    scope: "weknora:read",
  },
  {
    key: "claude-admin",
    label: "Claude 管理",
    provider: "Claude",
    profile: "admin",
    clientId: "claude-weknora-admin",
    mcpUrl: "https://wek.uov.me/mcp-admin",
    scope: "weknora:admin",
    requiredRole: "weknora-admin",
  },
];

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().default(60),
});

const clientSchema = z
  .object({
    id: z.string().min(1),
    clientId: z.string().min(1),
    enabled: z.boolean().default(true),
    redirectUris: z.array(z.string()).default([]),
  })
  .passthrough();

const sessionCountSchema = z.object({ count: z.number().int().nonnegative() });
const sessionSchema = z.object({ id: z.string().min(1) });
const secretSchema = z.object({ value: z.string().min(1) });

type ClientRepresentation = z.infer<typeof clientSchema>;

export class KeycloakAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeycloakAdminError";
  }
}

function validateRedirectUri(value: string): string {
  if (value.length > 2_048 || value.includes("*")) {
    throw new KeycloakAdminError("OAuth redirect URI must be exact and contain no wildcard");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new KeycloakAdminError("OAuth redirect URI is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new KeycloakAdminError("OAuth redirect URI must be an exact HTTPS URL");
  }
  return url.toString();
}

export class KeycloakAdminClient {
  private readonly adminBaseUrl: URL;
  private readonly tokenUrl: URL;
  private readonly publicIssuer: string;
  private readonly serviceClientId: string;
  private readonly serviceClientSecret: string;
  private readonly definitions: Map<string, ManagedOAuthClientDefinition>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;

  constructor(options: {
    adminBaseUrl: URL;
    tokenUrl: URL;
    publicIssuer?: string;
    serviceClientId: string;
    serviceClientSecret: string;
    definitions?: ManagedOAuthClientDefinition[];
    fetchImpl?: typeof fetch;
    now?: () => number;
  }) {
    this.adminBaseUrl = options.adminBaseUrl;
    this.tokenUrl = options.tokenUrl;
    this.publicIssuer = (options.publicIssuer ?? "https://wek.uov.me/oauth/realms/weknora").replace(
      /\/$/,
      "",
    );
    this.serviceClientId = options.serviceClientId;
    this.serviceClientSecret = options.serviceClientSecret;
    this.definitions = new Map(
      (options.definitions ?? MANAGED_OAUTH_CLIENTS).map((definition) => [
        definition.key,
        definition,
      ]),
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async listManagedClients(): Promise<ManagedOAuthClientSummary[]> {
    return Promise.all(
      [...this.definitions.values()].map(async (definition) => {
        const client = await this.findClient(definition);
        return this.toSummary(
          definition,
          client,
          await this.sessionCount(client.id),
        );
      }),
    );
  }

  async updateManagedClient(
    key: string,
    update: ManagedOAuthClientUpdate,
  ): Promise<ManagedOAuthClientSummary> {
    if (update.enabled === undefined && update.redirectUri === undefined) {
      throw new KeycloakAdminError("OAuth client update is empty");
    }
    const definition = this.definition(key);
    const client = await this.findClient(definition);
    const { secret: _secret, registrationAccessToken: _registrationToken, ...safe } =
      client;
    const updated = {
      ...safe,
      ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
      ...(update.redirectUri === undefined
        ? {}
        : { redirectUris: [validateRedirectUri(update.redirectUri)] }),
    };
    await this.requireOk(
      await this.adminFetch(`clients/${encodeURIComponent(client.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      }),
      "Keycloak OAuth client update failed",
    );
    return this.toSummary(
      definition,
      clientSchema.parse(updated),
      await this.sessionCount(client.id),
    );
  }

  async rotateManagedClientSecret(
    key: string,
  ): Promise<{ secret: string; oldSecretInvalidated: boolean }> {
    const client = await this.findClient(this.definition(key));
    const rotated = await this.adminFetch(
      `clients/${encodeURIComponent(client.id)}/client-secret`,
      { method: "POST" },
    );
    await this.requireOk(rotated, "Keycloak client-secret rotation failed");
    const secret = secretSchema.parse(await rotated.json()).value;
    const invalidated = await this.adminFetch(
      `clients/${encodeURIComponent(client.id)}/client-secret/rotated`,
      { method: "DELETE" },
    );
    return { secret, oldSecretInvalidated: invalidated.ok };
  }

  async revokeManagedClientSessions(
    key: string,
  ): Promise<{ revokedSessions: number }> {
    const client = await this.findClient(this.definition(key));
    const response = await this.adminFetch(
      `clients/${encodeURIComponent(client.id)}/user-sessions?first=0&max=1000`,
    );
    await this.requireOk(response, "Keycloak client-session lookup failed");
    const sessions = z.array(sessionSchema).parse(await response.json());
    for (const session of sessions) {
      await this.requireOk(
        await this.adminFetch(`sessions/${encodeURIComponent(session.id)}`, {
          method: "DELETE",
        }),
        "Keycloak session revocation failed",
      );
    }
    return { revokedSessions: sessions.length };
  }

  private definition(key: string): ManagedOAuthClientDefinition {
    const definition = this.definitions.get(key);
    if (!definition) throw new KeycloakAdminError("OAuth client is not managed");
    return definition;
  }

  private async findClient(
    definition: ManagedOAuthClientDefinition,
  ): Promise<ClientRepresentation> {
    const url = new URL("clients", this.adminBaseUrl);
    url.searchParams.set("clientId", definition.clientId);
    url.searchParams.set("search", "true");
    const response = await this.adminFetch(url);
    await this.requireOk(response, "Keycloak OAuth client lookup failed");
    const clients = z.array(clientSchema).parse(await response.json());
    const client = clients.find((candidate) => candidate.clientId === definition.clientId);
    if (!client) {
      throw new KeycloakAdminError(`Managed OAuth client ${definition.clientId} is missing`);
    }
    return client;
  }

  private async sessionCount(clientId: string): Promise<number> {
    const response = await this.adminFetch(
      `clients/${encodeURIComponent(clientId)}/session-count`,
    );
    await this.requireOk(response, "Keycloak client-session count failed");
    return sessionCountSchema.parse(await response.json()).count;
  }

  private toSummary(
    definition: ManagedOAuthClientDefinition,
    client: ClientRepresentation,
    sessionCount: number,
  ): ManagedOAuthClientSummary {
    return {
      ...definition,
      enabled: client.enabled,
      redirectUri: client.redirectUris[0] ?? "",
      sessionCount,
      issuer: this.publicIssuer,
      authorizationEndpoint: `${this.publicIssuer}/protocol/openid-connect/auth`,
      tokenEndpoint: `${this.publicIssuer}/protocol/openid-connect/token`,
    };
  }

  private async adminFetch(
    path: string | URL,
    init: RequestInit = {},
  ): Promise<Response> {
    const token = await this.accessToken();
    const url = path instanceof URL ? path : new URL(path, this.adminBaseUrl);
    return this.fetchImpl(url, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(10_000),
    });
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 5_000) {
      return this.token.value;
    }
    if (!this.tokenRequest) {
      this.tokenRequest = this.fetchAccessToken().finally(() => {
        this.tokenRequest = undefined;
      });
    }
    return this.tokenRequest;
  }

  private async fetchAccessToken(): Promise<string> {
    const response = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.serviceClientId,
        client_secret: this.serviceClientSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    await this.requireOk(response, "Keycloak service-account login failed");
    const parsed = tokenSchema.parse(await response.json());
    this.token = {
      value: parsed.access_token,
      expiresAt: this.now() + parsed.expires_in * 1_000,
    };
    return this.token.value;
  }

  private async requireOk(response: Response, message: string): Promise<void> {
    if (!response.ok) {
      throw new KeycloakAdminError(`${message} with status ${response.status}`);
    }
  }
}
