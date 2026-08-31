import Fastify, { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

import type {
  ConsoleIdentity,
  ConsoleSession,
  ConsoleSessionStore,
} from "./console-auth.js";
import { SessionAuthorizationError } from "./console-auth.js";
import type {
  KnowledgePolicy,
  KnowledgePolicyActor,
  KnowledgePolicyUpdate,
} from "./knowledge-policy.js";
import type { WeKnoraKnowledgeBase } from "./weknora-api.js";

const SESSION_COOKIE = "weknora_console_session";
const OAUTH_STATE_COOKIE = "weknora_console_oauth_state";

const callbackSchema = z.object({
  state: z.string().min(1),
  code: z.string().min(1),
});

const policyUpdateSchema = z
  .strictObject({
    defaultKbId: z.string().uuid(),
    allowedKbIds: z.array(z.string().uuid()).min(1),
  })
  .superRefine((value, context) => {
    if (new Set(value.allowedKbIds).size !== value.allowedKbIds.length) {
      context.addIssue({
        code: "custom",
        path: ["allowedKbIds"],
        message: "Knowledge base IDs must be unique",
      });
    }
    if (!value.allowedKbIds.includes(value.defaultKbId)) {
      context.addIssue({
        code: "custom",
        path: ["defaultKbId"],
        message: "Default knowledge base must be allowed",
      });
    }
  });

export interface ConsolePolicyStore {
  read(): Promise<KnowledgePolicy>;
  write(update: KnowledgePolicyUpdate, actor: KnowledgePolicyActor): Promise<KnowledgePolicy>;
  readAudit(limit: number): Promise<unknown[]>;
}

export interface BuildConsoleAppOptions {
  publicUrl: URL;
  oidc: {
    beginLogin(): { authorizationUrl: URL; state: string };
    completeLogin(state: string, code: string): Promise<ConsoleIdentity>;
  };
  sessions: ConsoleSessionStore;
  policyStore: ConsolePolicyStore;
  weknora: { listKnowledgeBases(): Promise<WeKnoraKnowledgeBase[]> };
  checkServices(): Promise<Record<string, "healthy" | "unavailable">>;
  indexHtml: string;
  appCss?: string;
  appJs?: string;
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
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
      options.policyStore.read(),
      options.weknora.listKnowledgeBases(),
      options.checkServices(),
      options.policyStore.readAudit(30),
    ]);
    return { policy, knowledgeBases, services, audit };
  });

  app.put("/mcp-console/api/policy", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
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
        return reply.code(403).send({ error: "csrf_failed" });
      }
      throw error;
    }

    const parsed = policyUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_policy" });
    const liveKnowledgeBases = await options.weknora.listKnowledgeBases();
    const liveById = new Map(liveKnowledgeBases.map((knowledgeBase) => [knowledgeBase.id, knowledgeBase]));
    const unknown = parsed.data.allowedKbIds.find((id) => !liveById.has(id));
    if (unknown) {
      return reply.code(400).send({ error: "unknown_knowledge_base", id: unknown });
    }
    const knowledgeBases = parsed.data.allowedKbIds.map((id) => {
      const knowledgeBase = liveById.get(id);
      if (!knowledgeBase) throw new Error("Knowledge base disappeared during update");
      return { id, name: knowledgeBase.name };
    });
    const policy = await options.policyStore.write(
      { defaultKbId: parsed.data.defaultKbId, knowledgeBases },
      { subject: session.subject, username: session.username },
    );
    return { policy };
  });

  app.post("/mcp-console/logout", async (request, reply) => {
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
        return reply.code(403).send({ error: "csrf_failed" });
      }
      throw error;
    }
    options.sessions.delete(sessionId);
    return reply.header("Set-Cookie", sessionCookie("", 0)).code(204).send();
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
