import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, {
  LogController,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { createAdminGatewayMcpServer } from "./admin-gateway-server.js";
import {
  AuthenticationError,
  AuthorizationError,
  type AuthenticatedPrincipal,
} from "./auth.js";
import type { GatewayConfig } from "./config.js";
import { createGatewayMcpServer } from "./gateway-server.js";
import {
  buildProtectedResourceMetadata,
  buildWwwAuthenticate,
} from "./metadata.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import type { ToolCaller } from "./upstream-client.js";

export interface BuildAppOptions {
  config: GatewayConfig;
  verifyToken: (token: string) => Promise<AuthenticatedPrincipal>;
  upstream: ToolCaller;
  adminTools?: Tool[];
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1]?.trim();
}

function toolName(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const message = body as Record<string, unknown>;
  if (message.method !== "tools/call") return undefined;
  const params = message.params;
  if (!params || typeof params !== "object") return undefined;
  const name = (params as Record<string, unknown>).name;
  return typeof name === "string" ? name : undefined;
}

export function buildApp(options: BuildAppOptions) {
  if (options.config.gatewayMode === "admin" && !options.adminTools) {
    throw new Error("adminTools are required in admin mode");
  }
  const app = Fastify({
    bodyLimit: options.config.httpBodyLimitBytes,
    trustProxy: (address) => address === "127.0.0.1" || address === "::1",
    logger: {
      level: options.config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers.set-cookie",
          "*.authorization",
          "*.token",
          "*.code",
          "*.arguments",
        ],
        censor: "[REDACTED]",
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
  });
  const ipLimiter = new SlidingWindowLimiter(
    options.config.rateLimitIpPerMinute,
    60_000,
  );
  const subjectLimiter = new SlidingWindowLimiter(
    options.config.rateLimitSubjectPerMinute,
    60_000,
  );
  const metadata = buildProtectedResourceMetadata({
    resource: options.config.publicMcpUrl.toString(),
    issuer: options.config.oauthIssuer.toString(),
    scope: options.config.oauthRequiredScope,
  });
  const mcpPath = options.config.publicMcpUrl.pathname;
  const resourceMetadataPath = `/.well-known/oauth-protected-resource${mcpPath}`;

  for (const path of [
    "/.well-known/oauth-protected-resource",
    resourceMetadataPath,
  ]) {
    app.get(path, async (_request, reply) => reply.send(metadata));
  }

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await options.upstream.ping?.();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  async function authorize(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedPrincipal | undefined> {
    const origin = request.headers.origin;
    if (origin && !options.config.allowedOrigins.includes(origin)) {
      await reply.code(403).send({ error: "origin_not_allowed" });
      return undefined;
    }

    const token = bearerToken(request.headers.authorization);
    if (!token) {
      reply.header(
        "WWW-Authenticate",
        buildWwwAuthenticate(options.config.publicMcpUrl.toString()),
      );
      await reply.code(401).send({ error: "invalid_token" });
      return undefined;
    }

    try {
      const principal = await options.verifyToken(token);
      const ipLimit = ipLimiter.consume(request.ip);
      const subjectLimit = subjectLimiter.consume(principal.subject);
      if (!ipLimit.allowed || !subjectLimit.allowed) {
        const retryAfterMs = Math.max(
          ipLimit.retryAfterMs ?? 0,
          subjectLimit.retryAfterMs ?? 0,
        );
        reply.header("Retry-After", Math.max(1, Math.ceil(retryAfterMs / 1_000)));
        await reply.code(429).send({ error: "rate_limit_exceeded" });
        return undefined;
      }
      return principal;
    } catch (error) {
      if (error instanceof AuthorizationError) {
        reply.header(
          "WWW-Authenticate",
          `Bearer error="insufficient_scope", scope="${options.config.oauthRequiredScope}"`,
        );
        await reply.code(403).send({ error: "insufficient_scope" });
        return undefined;
      }
      if (error instanceof AuthenticationError) {
        reply.header(
          "WWW-Authenticate",
          buildWwwAuthenticate(options.config.publicMcpUrl.toString()),
        );
        await reply.code(401).send({ error: "invalid_token" });
        return undefined;
      }
      throw error;
    }
  }

  app.options(mcpPath, async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || !options.config.allowedOrigins.includes(origin)) {
      return reply.code(403).send({ error: "origin_not_allowed" });
    }
    return reply
      .header("Access-Control-Allow-Origin", origin)
      .header("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version")
      .header("Access-Control-Allow-Methods", "POST, OPTIONS")
      .code(204)
      .send();
  });

  app.get(mcpPath, async (request, reply) => {
    if (!(await authorize(request, reply))) return;
    return reply.header("Allow", "POST").code(405).send({ error: "method_not_allowed" });
  });

  app.delete(mcpPath, async (request, reply) => {
    if (!(await authorize(request, reply))) return;
    return reply.header("Allow", "POST").code(405).send({ error: "method_not_allowed" });
  });

  app.post(mcpPath, async (request, reply) => {
    const principal = await authorize(request, reply);
    if (!principal) return;

    const started = performance.now();
    const calledTool = toolName(request.body);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server =
      options.config.gatewayMode === "admin"
        ? createAdminGatewayMcpServer({
            tools: options.adminTools ?? [],
            importRoot: options.config.adminImportRoot ?? "",
            upstream: options.upstream,
          })
        : createGatewayMcpServer({
            fixedKbId: options.config.fixedKbId,
            fixedKbName: options.config.fixedKbName,
            upstream: options.upstream,
          });

    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
      request.log.info({
        event: "mcp_request",
        subject: principal.subject,
        clientId: principal.clientId,
        method: (request.body as Record<string, unknown> | undefined)?.method,
        tool: calledTool,
        durationMs: Math.round(performance.now() - started),
        outcome: "success",
      });
    } catch (error) {
      request.log.error({
        event: "mcp_request",
        subject: principal.subject,
        clientId: principal.clientId,
        method: (request.body as Record<string, unknown> | undefined)?.method,
        tool: calledTool,
        durationMs: Math.round(performance.now() - started),
        outcome: "error",
        error: error instanceof Error ? error.name : "UnknownError",
      });
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader("Content-Type", "application/json");
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: "Internal server error" },
          }),
        );
      }
    }
  });

  return app;
}
