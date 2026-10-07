import Fastify, { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

import { randomBytes } from "node:crypto";

import {
  MCP_CAPABILITIES,
  type ClientAccessPolicy,
  type ManagedAccessClient,
  type McpAccessPolicy,
  type McpClientPolicyUpdate,
} from "./access-policy.js";
import type {
  ConsoleIdentity,
  ConsoleSession,
  ConsoleSessionStore,
} from "./console-auth.js";
import { SessionAuthorizationError } from "./console-auth.js";
import type {
  ConsoleAuditWriter,
  KnowledgePolicyActor,
} from "./knowledge-policy.js";
import {
  KeycloakAdminError,
  MCP_OAUTH_SCOPE,
  OAUTH_PROVIDERS,
  type KeycloakAdminClient,
  type OAuthClientState,
  type OAuthProvider,
} from "./keycloak-admin.js";
import {
  API_KEY_CLIENT_PREFIX,
  mcpClientConfig,
  StaticTokenError,
  type FileStaticTokenStore,
  type StaticKeySummary,
} from "./static-tokens.js";
import type { WeKnoraKnowledgeBase } from "./weknora-api.js";

const SESSION_COOKIE = "weknora_console_session";
const OAUTH_STATE_COOKIE = "weknora_console_oauth_state";

const callbackSchema = z.object({
  state: z.string().min(1),
  code: z.string().min(1),
});

const clientAccessUpdateSchema = z
  .strictObject({
    accessType: z.enum(["capabilities", "full"]),
    capabilities: z.array(z.enum(MCP_CAPABILITIES)),
    knowledgeBaseScope: z.enum(["all", "selected"]),
    defaultKbId: z.string().uuid(),
    allowedKbIds: z.array(z.string().uuid()),
  })
  .superRefine((value, context) => {
    if (new Set(value.capabilities).size !== value.capabilities.length) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Capability IDs must be unique",
      });
    }
    if (new Set(value.allowedKbIds).size !== value.allowedKbIds.length) {
      context.addIssue({
        code: "custom",
        path: ["allowedKbIds"],
        message: "Knowledge base IDs must be unique",
      });
    }
    if (value.accessType === "capabilities" && value.capabilities.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Capability access must grant at least one capability",
      });
    }
    if (
      value.accessType === "full" &&
      (value.capabilities.length > 0 || value.knowledgeBaseScope !== "all")
    ) {
      context.addIssue({
        code: "custom",
        path: ["accessType"],
        message: "Full access must use all knowledge bases without overrides",
      });
    }
    if (
      value.knowledgeBaseScope === "selected" &&
      !value.allowedKbIds.includes(value.defaultKbId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultKbId"],
        message: "Default knowledge base must be allowed",
      });
    }
    if (
      (value.knowledgeBaseScope === "selected" && value.allowedKbIds.length === 0) ||
      (value.knowledgeBaseScope === "all" && value.allowedKbIds.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowedKbIds"],
        message: "Knowledge-base selection does not match its scope",
      });
    }
  });

export interface ConsoleAccessPolicyStore {
  read(): Promise<McpAccessPolicy>;
  writeClient(
    clientId: string,
    update: McpClientPolicyUpdate,
    actor: KnowledgePolicyActor,
  ): Promise<McpAccessPolicy>;
  addClients(entries: ClientAccessPolicy[], actor: KnowledgePolicyActor): Promise<McpAccessPolicy>;
  removeClients(clientIds: string[], actor: KnowledgePolicyActor): Promise<McpAccessPolicy>;
  renameClient(clientId: string, label: string, actor: KnowledgePolicyActor): Promise<McpAccessPolicy>;
  defaultAccess(client: ManagedAccessClient): ClientAccessPolicy;
  readAudit(limit: number): Promise<unknown[]>;
  appendAudit: ConsoleAuditWriter["appendAudit"];
}

export interface BuildConsoleAppOptions {
  publicUrl: URL;
  /** Public MCP endpoint shown in connection details; defaults to /mcp on the console host. */
  mcpUrl?: URL;
  oidc: {
    beginLogin(): { authorizationUrl: URL; state: string };
    completeLogin(state: string, code: string): Promise<ConsoleIdentity>;
  };
  sessions: ConsoleSessionStore;
  accessPolicyStore: ConsoleAccessPolicyStore;
  oauthClientManager: Pick<
    KeycloakAdminClient,
    | "endpoints"
    | "listClients"
    | "createClient"
    | "deleteClient"
    | "updateClient"
    | "rotateClientSecret"
    | "revokeClientSessions"
  >;
  staticTokens: Pick<
    FileStaticTokenStore,
    "listKeys" | "createKey" | "rotateKey" | "setKeyEnabled" | "renameKey" | "deleteKey"
  >;
  weknora: { listKnowledgeBases(): Promise<WeKnoraKnowledgeBase[]> };
  checkServices(): Promise<Record<string, "healthy" | "unavailable">>;
  indexHtml: string;
  appCss?: string;
  appJs?: string;
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

type IntegrationId = "chatgpt" | "claude" | "apikey";

const INTEGRATIONS: Array<{
  id: IntegrationId;
  label: string;
  provider: OAuthProvider | "Token";
}> = [
  { id: "chatgpt", label: "ChatGPT", provider: "ChatGPT" },
  { id: "claude", label: "Claude", provider: "Claude" },
  { id: "apikey", label: "API Key", provider: "Token" },
];

const integrationParamsSchema = z.object({
  integration: z.enum(["chatgpt", "claude", "apikey"]),
});
const credentialParamsSchema = z.object({
  clientId: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
});
const labelSchema = z.string().trim().min(1).max(60);
const credentialCreateSchema = z.strictObject({
  label: labelSchema,
  redirectUri: z.string().url().max(2_048).optional(),
});
const credentialUpdateSchema = z
  .strictObject({
    label: labelSchema.optional(),
    enabled: z.boolean().optional(),
    redirectUri: z.string().url().max(2_048).optional(),
  })
  .refine(
    (value) =>
      value.label !== undefined || value.enabled !== undefined || value.redirectUri !== undefined,
    { message: "Credential update must not be empty" },
  );

function isApiKeyClient(clientId: string): boolean {
  return clientId.startsWith(API_KEY_CLIENT_PREFIX);
}

function apiKeyId(clientId: string): string {
  return clientId.slice(API_KEY_CLIENT_PREFIX.length);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function sessionCookie(sessionId: string, maxAgeSeconds = 28_800): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/mcp-console/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

function oauthStateCookie(state: string, maxAgeSeconds = 300): string {
  return `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/mcp-console/oauth/callback; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function buildConsoleApp(options: BuildConsoleAppOptions) {
  const app = Fastify({
    logger: {
      level: options.logLevel ?? "info",
      redact: {
        paths: ["req.headers.cookie", "req.headers.authorization", "req.headers.x-csrf-token"],
        censor: "[REDACTED]",
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply
      .header("Content-Security-Policy", "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Cache-Control", "no-store");
    return payload;
  });

  function requestSession(request: FastifyRequest): ConsoleSession | undefined {
    const id = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    return options.sessions.get(id);
  }

  async function requireSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ConsoleSession | undefined> {
    const session = requestSession(request);
    if (!session) {
      await reply.code(401).send({ error: "authentication_required" });
      return undefined;
    }
    return session;
  }

  async function requireCsrfSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ConsoleSession | undefined> {
    const session = await requireSession(request, reply);
    if (!session) return undefined;
    const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    try {
      options.sessions.assertCsrf(
        sessionId,
        typeof request.headers["x-csrf-token"] === "string"
          ? request.headers["x-csrf-token"]
          : undefined,
      );
    } catch (error) {
      if (error instanceof SessionAuthorizationError) {
        await reply.code(403).send({ error: "csrf_failed" });
        return undefined;
      }
      throw error;
    }
    return session;
  }

  async function recordAudit(
    request: FastifyRequest,
    action: string,
    session: ConsoleSession,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await options.accessPolicyStore.appendAudit(
        action,
        { subject: session.subject, username: session.username },
        details,
      );
    } catch (error) {
      request.log.error(
        { error: error instanceof Error ? error.name : "UnknownError", action },
        "console audit write failed after operation completed",
      );
    }
  }

  app.get("/mcp-console/", async (request, reply) => {
    if (!requestSession(request)) return reply.redirect("/mcp-console/login");
    return reply.type("text/html; charset=utf-8").send(options.indexHtml);
  });

  app.get("/mcp-console/assets/app.css", async (_request, reply) =>
    reply.type("text/css; charset=utf-8").send(options.appCss ?? ""),
  );
  app.get("/mcp-console/assets/app.js", async (_request, reply) =>
    reply.type("text/javascript; charset=utf-8").send(options.appJs ?? ""),
  );

  app.get("/mcp-console/login", async (_request, reply) => {
    const login = options.oidc.beginLogin();
    return reply
      .header("Set-Cookie", oauthStateCookie(login.state))
      .redirect(login.authorizationUrl.toString());
  });

  app.get("/mcp-console/oauth/callback", async (request, reply) => {
    const parsed = callbackSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_oauth_callback" });
    const browserState = parseCookies(request.headers.cookie)[OAUTH_STATE_COOKIE];
    if (browserState !== parsed.data.state) {
      return reply
        .header("Set-Cookie", oauthStateCookie("", 0))
        .code(403)
        .send({ error: "oauth_state_mismatch" });
    }
    try {
      const identity = await options.oidc.completeLogin(
        parsed.data.state,
        parsed.data.code,
      );
      const session = options.sessions.create(identity);
      return reply
        .header("Set-Cookie", [
          sessionCookie(session.id),
          oauthStateCookie("", 0),
        ])
        .redirect(options.publicUrl.pathname);
    } catch (error) {
      request.log.warn({ error: error instanceof Error ? error.name : "UnknownError" });
      return reply.code(403).send({ error: "oauth_login_failed" });
    }
  });

  app.get("/mcp-console/api/session", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    return {
      username: session.username,
      roles: session.roles,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    };
  });

  app.get("/mcp-console/api/overview", async (request, reply) => {
    if (!(await requireSession(request, reply))) return;
    const [policy, knowledgeBases, services, audit] = await Promise.all([
      options.accessPolicyStore.read(),
      options.weknora.listKnowledgeBases(),
      options.checkServices(),
      options.accessPolicyStore.readAudit(30),
    ]);
    return { policy, knowledgeBases, services, audit };
  });

  const mcpUrl = (options.mcpUrl ?? new URL("/mcp", options.publicUrl)).toString();
  const actorOf = (session: ConsoleSession) => ({
    subject: session.subject,
    username: session.username,
  });

  async function findCredential(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ClientAccessPolicy | undefined> {
    const params = credentialParamsSchema.safeParse(request.params);
    const policy = params.success ? await options.accessPolicyStore.read() : undefined;
    const client = policy?.clients.find(({ clientId }) => clientId === params.data?.clientId);
    if (!client) {
      await reply.code(404).send({ error: "credential_not_found" });
      return undefined;
    }
    return client;
  }

  app.get("/mcp-console/api/integrations", async (request, reply) => {
    if (!(await requireSession(request, reply))) return;
    const [policy, keys] = await Promise.all([
      options.accessPolicyStore.read(),
      options.staticTokens.listKeys(),
    ]);
    const oauthClients = policy.clients.filter(({ provider }) => provider in OAUTH_PROVIDERS);
    let states = new Map<string, OAuthClientState>();
    let oauthError = false;
    try {
      states = new Map(
        (await options.oauthClientManager.listClients(oauthClients.map(({ clientId }) => clientId)))
          .map((state) => [state.clientId, state]),
      );
    } catch (error) {
      oauthError = true;
      request.log.warn({ error: error instanceof Error ? error.name : "UnknownError" });
    }
    const keysByClient = new Map<string, StaticKeySummary>(keys.map((key) => [key.clientId, key]));

    return {
      capabilities: MCP_CAPABILITIES,
      mcpUrl,
      scope: MCP_OAUTH_SCOPE,
      oauth: { ...options.oauthClientManager.endpoints(), unavailable: oauthError },
      integrations: INTEGRATIONS.map((integration) => {
        const entries = policy.clients.filter(({ provider }) => provider === integration.provider);
        if (integration.provider === "Token") {
          return {
            ...integration,
            kind: "token" as const,
            credentials: entries.map((access) => {
              const key = keysByClient.get(access.clientId);
              return {
                clientId: access.clientId,
                label: access.label,
                kind: "token" as const,
                exists: Boolean(key),
                enabled: key?.enabled ?? false,
                createdAt: key?.createdAt ?? null,
                access,
              };
            }),
          };
        }
        return {
          ...integration,
          kind: "oauth" as const,
          defaultRedirectUri: OAUTH_PROVIDERS[integration.provider].defaultRedirectUri,
          credentials: entries.map((access) => {
            const state = states.get(access.clientId);
            return {
              clientId: access.clientId,
              label: access.label,
              kind: "oauth" as const,
              exists: state?.exists ?? !oauthError,
              enabled: state?.enabled ?? false,
              redirectUri: state?.redirectUri ?? "",
              sessionCount: state?.sessionCount ?? 0,
              access,
            };
          }),
        };
      }),
    };
  });

  app.post("/mcp-console/api/integrations/:integration/credentials", async (request, reply) => {
    const session = await requireCsrfSession(request, reply);
    if (!session) return;
    const params = integrationParamsSchema.safeParse(request.params);
    const body = credentialCreateSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "invalid_credential_request" });
    }
    const integration = INTEGRATIONS.find(({ id }) => id === params.data.integration)!;
    const actor = actorOf(session);

    if (integration.provider === "Token") {
      let created: Awaited<ReturnType<typeof options.staticTokens.createKey>>;
      try {
        created = await options.staticTokens.createKey(body.data.label);
      } catch (error) {
        if (error instanceof StaticTokenError) {
          return reply.code(409).send({ error: "api_key_limit_reached" });
        }
        throw error;
      }
      try {
        await options.accessPolicyStore.addClients(
          [
            options.accessPolicyStore.defaultAccess({
              clientId: created.key.clientId,
              label: body.data.label,
              provider: "Token",
            }),
          ],
          actor,
        );
      } catch (error) {
        await options.staticTokens.deleteKey(created.key.id);
        throw error;
      }
      await recordAudit(request, "api_key.created", session, {
        clientId: created.key.clientId,
        label: body.data.label,
      });
      return {
        clientId: created.key.clientId,
        kind: "token",
        secret: created.token,
        mcpConfig: mcpClientConfig(mcpUrl, created.token),
      };
    }

    const provider = integration.provider;
    const existing = (await options.accessPolicyStore.read()).clients;
    const clientId = `${OAUTH_PROVIDERS[provider].clientIdPrefix}-${randomBytes(3).toString("hex")}`;
    let created: Awaited<ReturnType<typeof options.oauthClientManager.createClient>>;
    try {
      created = await options.oauthClientManager.createClient({
        clientId,
        label: body.data.label,
        redirectUri: body.data.redirectUri ?? OAUTH_PROVIDERS[provider].defaultRedirectUri,
        templateClientIds: existing
          .filter((client) => client.provider in OAUTH_PROVIDERS)
          .map((client) => client.clientId),
      });
    } catch (error) {
      request.log.warn({ error: error instanceof Error ? error.message : "UnknownError" });
      return reply.code(error instanceof KeycloakAdminError ? 502 : 500).send({
        error: "oauth_client_creation_failed",
      });
    }
    try {
      await options.accessPolicyStore.addClients(
        [options.accessPolicyStore.defaultAccess({ clientId, label: body.data.label, provider })],
        actor,
      );
    } catch (error) {
      await options.oauthClientManager.deleteClient(clientId);
      throw error;
    }
    await recordAudit(request, "oauth_client.created", session, {
      clientId,
      label: body.data.label,
      redirectUri: created.state.redirectUri,
    });
    return { clientId, kind: "oauth", secret: created.secret };
  });

  app.put("/mcp-console/api/credentials/:clientId/access-policy", async (request, reply) => {
    const session = await requireCsrfSession(request, reply);
    if (!session) return;
    const client = await findCredential(request, reply);
    if (!client) return;
    const update = clientAccessUpdateSchema.safeParse(request.body);
    if (!update.success) {
      return reply.code(400).send({ error: "invalid_client_access_policy" });
    }

    const liveKnowledgeBases = await options.weknora.listKnowledgeBases();
    const liveById = new Map(
      liveKnowledgeBases.map((knowledgeBase) => [knowledgeBase.id, knowledgeBase]),
    );
    if (!liveById.has(update.data.defaultKbId)) {
      return reply.code(400).send({
        error: "unknown_knowledge_base",
        id: update.data.defaultKbId,
      });
    }
    const unknown = update.data.allowedKbIds.find((id) => !liveById.has(id));
    if (unknown) {
      return reply.code(400).send({ error: "unknown_knowledge_base", id: unknown });
    }
    const knowledgeBases = update.data.allowedKbIds.map((id) => ({
      id,
      name: liveById.get(id)!.name,
    }));
    const policy = await options.accessPolicyStore.writeClient(
      client.clientId,
      {
        accessType: update.data.accessType,
        capabilities: update.data.capabilities,
        knowledgeBaseScope: update.data.knowledgeBaseScope,
        defaultKbId: update.data.defaultKbId,
        knowledgeBases,
      },
      actorOf(session),
    );
    return {
      clientPolicy: policy.clients.find(({ clientId }) => clientId === client.clientId),
    };
  });

  app.put("/mcp-console/api/credentials/:clientId", async (request, reply) => {
    const session = await requireCsrfSession(request, reply);
    if (!session) return;
    const client = await findCredential(request, reply);
    if (!client) return;
    const update = credentialUpdateSchema.safeParse(request.body);
    if (!update.success) {
      return reply.code(400).send({ error: "invalid_credential_update" });
    }
    const apiKey = isApiKeyClient(client.clientId);
    if (apiKey && update.data.redirectUri !== undefined) {
      return reply.code(400).send({ error: "invalid_credential_update" });
    }
    try {
      if (update.data.label !== undefined) {
        await options.accessPolicyStore.renameClient(
          client.clientId,
          update.data.label,
          actorOf(session),
        );
        if (apiKey) await options.staticTokens.renameKey(apiKeyId(client.clientId), update.data.label);
      }
      if (update.data.enabled !== undefined || update.data.redirectUri !== undefined) {
        if (apiKey) {
          await options.staticTokens.setKeyEnabled(apiKeyId(client.clientId), update.data.enabled!);
        } else {
          await options.oauthClientManager.updateClient(client.clientId, {
            enabled: update.data.enabled,
            redirectUri: update.data.redirectUri,
          });
        }
      }
    } catch (error) {
      if (error instanceof StaticTokenError) {
        return reply.code(404).send({ error: "api_key_not_found" });
      }
      if (error instanceof KeycloakAdminError) {
        request.log.warn({ error: error.message });
        return reply.code(502).send({ error: "oauth_client_update_failed" });
      }
      throw error;
    }
    await recordAudit(request, apiKey ? "api_key.updated" : "oauth_client.updated", session, {
      clientId: client.clientId,
      ...update.data,
    });
    return { updated: true };
  });

  app.post("/mcp-console/api/credentials/:clientId/rotate-secret", async (request, reply) => {
    const session = await requireCsrfSession(request, reply);
    if (!session) return;
    const client = await findCredential(request, reply);
    if (!client) return;
    try {
      if (isApiKeyClient(client.clientId)) {
        const { token } = await options.staticTokens.rotateKey(apiKeyId(client.clientId));
        await recordAudit(request, "api_key.rotated", session, { clientId: client.clientId });
        return {
          secret: token,
          oldSecretInvalidated: true,
          mcpConfig: mcpClientConfig(mcpUrl, token),
        };
      }
      const result = await options.oauthClientManager.rotateClientSecret(client.clientId);
      await recordAudit(request, "oauth_client.secret_rotated", session, {
        clientId: client.clientId,
        oldSecretInvalidated: result.oldSecretInvalidated,
      });
      return result;
    } catch (error) {
      if (error instanceof StaticTokenError) {
        return reply.code(404).send({ error: "api_key_not_found" });
      }
      request.log.warn({ error: error instanceof Error ? error.name : "UnknownError" });
      return reply.code(502).send({ error: "secret_rotation_failed" });
    }
  });

  app.post("/mcp-console/api/credentials/:clientId/revoke-sessions", async (request, reply) => {
    const session = await requireCsrfSession(request, reply);
    if (!session) return;
    const client = await findCredential(request, reply);
    if (!client) return;
    if (isApiKeyClient(client.clientId)) {
      return reply.code(400).send({ error: "api_keys_have_no_sessions" });
    }
    try {
      const result = await options.oauthClientManager.revokeClientSessions(client.clientId);
      await recordAudit(request, "oauth_client.sessions_revoked", session, {
        clientId: client.clientId,
        revokedSessions: result.revokedSessions,
      });
      return result;
    } catch (error) {
      request.log.warn({ error: error instanceof Error ? error.name : "UnknownError" });
      return reply.code(502).send({ error: "oauth_client_session_revocation_failed" });
    }
  });

  app.delete("/mcp-console/api/credentials/:clientId", async (request, reply) => {
    const session = await requireCsrfSession(request, reply);
    if (!session) return;
    const client = await findCredential(request, reply);
    if (!client) return;
    try {
      if (isApiKeyClient(client.clientId)) {
        await options.staticTokens.deleteKey(apiKeyId(client.clientId));
      } else {
        await options.oauthClientManager.deleteClient(client.clientId);
      }
    } catch (error) {
      request.log.warn({ error: error instanceof Error ? error.name : "UnknownError" });
      return reply.code(502).send({ error: "credential_deletion_failed" });
    }
    await options.accessPolicyStore.removeClients([client.clientId], actorOf(session));
    await recordAudit(request, "credential.deleted", session, {
      clientId: client.clientId,
      label: client.label,
    });
    return { deleted: true };
  });

  app.post("/mcp-console/logout", async (request, reply) => {
    const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!(await requireCsrfSession(request, reply))) return;
    options.sessions.delete(sessionId);
    return reply.header("Set-Cookie", sessionCookie("", 0)).code(204).send();
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
