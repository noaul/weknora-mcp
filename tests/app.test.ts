import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";

import {
  AuthorizationError,
  type AuthenticatedPrincipal,
} from "../src/auth.js";
import { buildApp } from "../src/app.js";
import type { GatewayConfig } from "../src/config.js";

const config: GatewayConfig = {
  gatewayMode: "readonly",
  host: "127.0.0.1",
  port: 18194,
  publicMcpUrl: new URL("https://wek.uov.me/mcp"),
  oauthIssuer: new URL("https://wek.uov.me/oauth/realms/weknora"),
  oauthJwksUrl: new URL(
    "https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/certs",
  ),
  oauthRequiredScope: "weknora:read",
  upstreamMcpUrl: new URL("http://127.0.0.1:18193/mcp"),
  upstreamMcpTokenFile: "/run/secrets/token",
  fixedKbId: "51adf856-2722-4a62-be49-b7d1f2cd20b4",
  fixedKbName: "镍基合金",
  knowledgePolicyFile: "/var/lib/weknora-mcp-console/knowledge-policy.json",
  knowledgeAuditFile: "/var/lib/weknora-mcp-console/audit.ndjson",
  allowedOrigins: ["https://chatgpt.com", "https://claude.ai"],
  rateLimitIpPerMinute: 120,
  rateLimitSubjectPerMinute: 60,
  upstreamTimeoutMs: 30_000,
  httpBodyLimitBytes: 1_048_576,
  logLevel: "silent",
};

const principal: AuthenticatedPrincipal = {
  subject: "user-1",
  clientId: "chatgpt",
  scopes: ["weknora:read"],
};

describe("HTTP application", () => {
  it("serves both protected-resource metadata paths", async () => {
    const app = buildApp({ config, verifyToken: vi.fn(), upstream: {} as never });

    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(200);
      expect(response.json().resource).toBe("https://wek.uov.me/mcp");
    }
    await app.close();
  });

  it("returns a standards-shaped challenge when authentication is missing", async () => {
    const app = buildApp({ config, verifyToken: vi.fn(), upstream: {} as never });

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("resource_metadata=");
    await app.close();
  });

  it("rejects an unapproved Origin before processing MCP", async () => {
    const app = buildApp({
      config,
      verifyToken: vi.fn(async () => principal),
      upstream: {} as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer valid",
        origin: "https://evil.example",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "origin_not_allowed" });
    await app.close();
  });

  it("returns 403 with insufficient_scope for an authenticated under-scoped token", async () => {
    const app = buildApp({
      config,
      verifyToken: vi.fn(async () => {
        throw new AuthorizationError();
      }),
      upstream: {} as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer under-scoped" },
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["www-authenticate"]).toContain("insufficient_scope");
    expect(response.json()).toEqual({ error: "insufficient_scope" });
    await app.close();
  });

  it("uses the OpenResty forwarded client IP for rate limiting", async () => {
    const app = buildApp({
      config: { ...config, rateLimitIpPerMinute: 1 },
      verifyToken: vi.fn(async (token: string) => ({
        ...principal,
        subject: `user-${token}`,
      })),
      upstream: {} as never,
    });

    const first = await app.inject({
      method: "GET",
      url: "/mcp",
      headers: {
        authorization: "Bearer one",
        "x-forwarded-for": "198.51.100.10",
      },
    });
    const second = await app.inject({
      method: "GET",
      url: "/mcp",
      headers: {
        authorization: "Bearer two",
        "x-forwarded-for": "198.51.100.11",
      },
    });

    expect(first.statusCode).toBe(405);
    expect(second.statusCode).toBe(405);
    await app.close();
  });

  it("completes MCP initialize, tool discovery, and tool calls over HTTP", async () => {
    const upstream = {
      ping: vi.fn(async () => undefined),
      callTool: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "match" }],
      })),
    };
    const app = buildApp({
      config,
      verifyToken: vi.fn(async () => principal),
      upstream,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing test address");

    const client = new Client({ name: "http-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      { requestInit: { headers: { Authorization: "Bearer valid" } } },
    );
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toHaveLength(5);

      const result = await client.callTool({
        name: "hybrid_search",
        arguments: { query: "晶界腐蚀" },
      });
      expect(result.content).toEqual([{ type: "text", text: "match" }]);
      expect(upstream.callTool).toHaveBeenCalledWith({
        name: "hybrid_search",
        arguments: {
          kb_id: "51adf856-2722-4a62-be49-b7d1f2cd20b4",
          query: "晶界腐蚀",
        },
      });
    } finally {
      await client.close();
      await app.close();
    }
  });
});
