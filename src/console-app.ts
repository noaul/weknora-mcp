import Fastify, { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

import {
  MCP_CAPABILITIES,
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
import type {
  KeycloakAdminClient,
  ManagedOAuthClientUpdate,
} from "./keycloak-admin.js";
import { MANAGED_OAUTH_CLIENTS } from "./keycloak-admin.js";
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
  readAudit(limit: number): Promise<unknown[]>;
  appendAudit: ConsoleAuditWriter["appendAudit"];
}

export interface BuildConsoleAppOptions {
  publicUrl: URL;
  oidc: {
    beginLogin(): { authorizationUrl: URL; state: string };
    completeLogin(state: string, code: string): Promise<ConsoleIdentity>;
  };
  sessions: ConsoleSessionStore;
  accessPolicyStore: ConsoleAccessPolicyStore;
  oauthClientManager: Pick<
    KeycloakAdminClient,
    | "listManagedClients"
    | "updateManagedClient"
    | "rotateManagedClientSecret"
    | "revokeManagedClientSessions"
  >;
  weknora: { listKnowledgeBases(): Promise<WeKnoraKnowledgeBase[]> };
  checkServices(): Promise<Record<string, "healthy" | "unavailable">>;
  indexHtml: string;
  appCss?: string;
  appJs?: string;
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

const oauthClientParamsSchema = z.object({
  key: z.enum(["chatgpt-read", "claude-read"]),
});

const clientIdByKey = new Map(
  MANAGED_OAUTH_CLIENTS.map(({ key, clientId }) => [key, clientId]),
);

const oauthClientUpdateSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    redirectUri: z.string().url().max(2_048).optional(),
  })
  .refine(
    (value) => value.enabled !== undefined || value.redirectUri !== undefined,
    { message: "OAuth client update must not be empty" },
  );

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

  app.get("/mcp-console/api/oauth-clients", async (request, reply) => {
    if (!(await requireSession(request, reply))) return;
    try {
      const [clients, policy] = await Promise.all([
        options.oauthClientManager.listManagedClients(),
        options.accessPolicyStore.read(),
      ]);
      return {
        capabilities: MCP_CAPABILITIES,
        clients: clients.map((client) => {
          const access = policy.clients.find(
            ({ clientId }) => clientId === client.clientId,
          );
          if (!access) {
            throw new Error(`OAuth client ${client.clientId} has no access policy`);
          }
          return { ...client, access };
        }),
      };
    } catch (error) {
      request.log.warn({ error: error instanceof Error ? error.name : "UnknownError" });
      return reply.code(502).send({ error: "oauth_client_service_unavailable" });
    }
  });

  app.put(
    "/mcp-console/api/oauth-clients/:key/access-policy",
    async (request, reply) => {
      const session = await requireCsrfSession(request, reply);
      if (!session) return;
      const params = oauthClientParamsSchema.safeParse(request.params);
      const update = clientAccessUpdateSchema.safeParse(request.body);
      if (!params.success || !update.success) {
        return reply.code(400).send({ error: "invalid_client_access_policy" });
      }
      const clientId = clientIdByKey.get(params.data.key);
      if (!clientId) {
        return reply.code(400).send({ error: "invalid_oauth_client" });
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
      const knowledgeBases = update.data.allowedKbIds.map((id) => {
        const knowledgeBase = liveById.get(id);
        if (!knowledgeBase) throw new Error("Knowledge base disappeared during update");
        return { id, name: knowledgeBase.name };
      });
      const policy = await options.accessPolicyStore.writeClient(
        clientId,
        {
          accessType: update.data.accessType,
          capabilities: update.data.capabilities,
          knowledgeBaseScope: update.data.knowledgeBaseScope,
          defaultKbId: update.data.defaultKbId,
          knowledgeBases,
        },
        { subject: session.subject, username: session.username },
      );
      return {
        clientPolicy: policy.clients.find((client) => client.clientId === clientId),
      };
    },
  );

  app.put("/mcp-console/api/oauth-clients/:key", async (request, reply) => {
    const session = await requireCsrfSession(request, reply);
    if (!session) return;
    const params = oauthClientParamsSchema.safeParse(request.params);
    const update = oauthClientUpdateSchema.safeParse(request.body);
    if (!params.success || !update.success) {
      return reply.code(400).send({ error: "invalid_oauth_client_update" });
    }
    try {
      const client = await options.oauthClientManager.updateManagedClient(
        params.data.key,
        update.data as ManagedOAuthClientUpdate,
      );
      await recordAudit(
        request,
        "oauth_client.updated",
        session,
        {
          key: params.data.key,
          enabled: client.enabled,
          redirectUri: client.redirectUri,
        },
      );
      return { client };
    } catch (error) {
      request.log.warn({ error: error instanceof Error ? error.name : "UnknownError" });
      return reply.code(502).send({ error: "oauth_client_update_failed" });
    }
  });

  app.post(
    "/mcp-console/api/oauth-clients/:key/rotate-secret",
    async (request, reply) => {
      const session = await requireCsrfSession(request, reply);
      if (!session) return;
      const params = oauthClientParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid_oauth_client" });
      }
      try {
        const result = await options.oauthClientManager.rotateManagedClientSecret(
          params.data.key,
        );
        await recordAudit(
          request,
          "oauth_client.secret_rotated",
          session,
          {
            key: params.data.key,
            oldSecretInvalidated: result.oldSecretInvalidated,
          },
        );
        return result;
      } catch (error) {
        request.log.warn({ error: error instanceof Error ? error.name : "UnknownError" });
        return reply.code(502).send({ error: "oauth_client_secret_rotation_failed" });
      }
    },
  );

  app.post(
    "/mcp-console/api/oauth-clients/:key/revoke-sessions",
    async (request, reply) => {
      const session = await requireCsrfSession(request, reply);
      if (!session) return;
      const params = oauthClientParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid_oauth_client" });
      }
      try {
        const result = await options.oauthClientManager.revokeManagedClientSessions(
          params.data.key,
        );
        await recordAudit(
          request,
          "oauth_client.sessions_revoked",
          session,
          { key: params.data.key, revokedSessions: result.revokedSessions },
        );
        return result;
      } catch (error) {
        request.log.warn({ error: error instanceof Error ? error.name : "UnknownError" });
        return reply.code(502).send({ error: "oauth_client_session_revocation_failed" });
      }
    },
  );

  app.post("/mcp-console/logout", async (request, reply) => {
    const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!(await requireCsrfSession(request, reply))) return;
    options.sessions.delete(sessionId);
    return reply.header("Set-Cookie", sessionCookie("", 0)).code(204).send();
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
