import { z } from "zod";

export type OAuthProvider = "ChatGPT" | "Claude";

export interface ManagedOAuthClientDefinition {
  label: string;
  provider: OAuthProvider;
  clientId: string;
}

/** Live Keycloak state of one managed OAuth client. */
export interface OAuthClientState {
  clientId: string;
  /** False when the policy references a client that no longer exists in Keycloak. */
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
};

export const MCP_OAUTH_SCOPE = "weknora:mcp";

/** OAuth clients created by configure-keycloak.sh; seeded into a new policy. */
export const MANAGED_OAUTH_CLIENTS: ManagedOAuthClientDefinition[] = [
  { label: "ChatGPT WeKnora", provider: "ChatGPT", clientId: "chatgpt-weknora-read" },
  { label: "Claude WeKnora", provider: "Claude", clientId: "claude-weknora-read" },
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
const clientScopeSchema = z.object({ id: z.string().min(1), name: z.string() });

type ClientRepresentation = z.infer<typeof clientSchema>;

export class KeycloakAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeycloakAdminError";
  }
}

export function validateRedirectUri(value: string): string {
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
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  endpoints(): OAuthEndpoints {
    return {
      issuer: this.publicIssuer,
      authorizationEndpoint: `${this.publicIssuer}/protocol/openid-connect/auth`,
      tokenEndpoint: `${this.publicIssuer}/protocol/openid-connect/token`,
    };
  }

  async listClients(clientIds: string[]): Promise<OAuthClientState[]> {
    return Promise.all(
      clientIds.map(async (clientId) => {
        const client = await this.lookupClient(clientId);
        if (!client) {
          return { clientId, exists: false, enabled: false, redirectUri: "", sessionCount: 0 };
        }
        return this.toState(client, await this.sessionCount(client.id));
      }),
    );
  }

  /**
   * Creates a confidential authorization-code client with PKCE and consent,
   * matching configure-keycloak.sh, and attaches the MCP scope.
   */
  async createClient(options: {
    clientId: string;
    label: string;
    redirectUri: string;
    /** Existing managed clients used to locate the MCP scope if listing scopes is not allowed. */
    templateClientIds?: string[];
  }): Promise<{ state: OAuthClientState; secret: string }> {
    if (await this.lookupClient(options.clientId)) {
      throw new KeycloakAdminError(`OAuth client ${options.clientId} already exists`);
    }
    const scopeId = await this.mcpScopeId(options.templateClientIds ?? []);
    const created = await this.adminFetch("clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: options.clientId,
        name: options.label,
        enabled: true,
        protocol: "openid-connect",
        publicClient: false,
        clientAuthenticatorType: "client-secret",
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
        implicitFlowEnabled: false,
        fullScopeAllowed: false,
        consentRequired: true,
        attributes: { "pkce.code.challenge.method": "S256" },
        redirectUris: [validateRedirectUri(options.redirectUri)],
      }),
    });
    await this.requireOk(created, "Keycloak OAuth client creation failed");
    const client = await this.lookupClient(options.clientId);
    if (!client) throw new KeycloakAdminError("Created OAuth client is missing");
    try {
      await this.requireOk(
        await this.adminFetch(
          `clients/${encodeURIComponent(client.id)}/default-client-scopes/${encodeURIComponent(scopeId)}`,
          { method: "PUT" },
        ),
        "Keycloak MCP scope assignment failed",
      );
      const secretResponse = await this.adminFetch(
        `clients/${encodeURIComponent(client.id)}/client-secret`,
      );
      await this.requireOk(secretResponse, "Keycloak client-secret lookup failed");
      const secret = secretSchema.parse(await secretResponse.json()).value;
      return { state: this.toState(client, 0), secret };
    } catch (error) {
      await this.adminFetch(`clients/${encodeURIComponent(client.id)}`, { method: "DELETE" });
      throw error;
    }
  }

  async deleteClient(clientId: string): Promise<{ deleted: boolean }> {
    const client = await this.lookupClient(clientId);
    if (!client) return { deleted: false };
    await this.requireOk(
      await this.adminFetch(`clients/${encodeURIComponent(client.id)}`, { method: "DELETE" }),
      "Keycloak OAuth client deletion failed",
    );
    return { deleted: true };
  }

  async updateClient(
    clientId: string,
    update: ManagedOAuthClientUpdate,
  ): Promise<OAuthClientState> {
    if (update.enabled === undefined && update.redirectUri === undefined) {
      throw new KeycloakAdminError("OAuth client update is empty");
    }
    const client = await this.findClient(clientId);
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
    return this.toState(clientSchema.parse(updated), await this.sessionCount(client.id));
  }

  async rotateClientSecret(
    clientId: string,
  ): Promise<{ secret: string; oldSecretInvalidated: boolean }> {
    const client = await this.findClient(clientId);
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

  async revokeClientSessions(clientId: string): Promise<{ revokedSessions: number }> {
    const client = await this.findClient(clientId);
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

  private async mcpScopeId(templateClientIds: string[]): Promise<string> {
    const scopes = await this.adminFetch("client-scopes");
    if (scopes.ok) {
      const scope = z
        .array(clientScopeSchema)
        .parse(await scopes.json())
        .find(({ name }) => name === MCP_OAUTH_SCOPE);
      if (scope) return scope.id;
    }
    for (const templateClientId of templateClientIds) {
      const template = await this.lookupClient(templateClientId);
      if (!template) continue;
      const response = await this.adminFetch(
        `clients/${encodeURIComponent(template.id)}/default-client-scopes`,
      );
      if (!response.ok) continue;
      const scope = z
        .array(clientScopeSchema)
        .parse(await response.json())
        .find(({ name }) => name === MCP_OAUTH_SCOPE);
      if (scope) return scope.id;
    }
    throw new KeycloakAdminError(`Keycloak client scope ${MCP_OAUTH_SCOPE} was not found`);
  }

  private async lookupClient(clientId: string): Promise<ClientRepresentation | undefined> {
    const url = new URL("clients", this.adminBaseUrl);
    url.searchParams.set("clientId", clientId);
    url.searchParams.set("search", "true");
    const response = await this.adminFetch(url);
    await this.requireOk(response, "Keycloak OAuth client lookup failed");
    return z
      .array(clientSchema)
      .parse(await response.json())
      .find((candidate) => candidate.clientId === clientId);
  }

  private async findClient(clientId: string): Promise<ClientRepresentation> {
    const client = await this.lookupClient(clientId);
    if (!client) throw new KeycloakAdminError(`Managed OAuth client ${clientId} is missing`);
    return client;
  }

  private async sessionCount(id: string): Promise<number> {
    const response = await this.adminFetch(`clients/${encodeURIComponent(id)}/session-count`);
    await this.requireOk(response, "Keycloak client-session count failed");
    return sessionCountSchema.parse(await response.json()).count;
  }

  private toState(client: ClientRepresentation, sessionCount: number): OAuthClientState {
    return {
      clientId: client.clientId,
      exists: true,
      enabled: client.enabled,
      redirectUri: client.redirectUris[0] ?? "",
      sessionCount,
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
