import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import type { McpAccessPolicyProvider } from "../src/access-policy.js";
import {
  AuthorizationError,
  type AuthenticatedPrincipal,
} from "../src/auth.js";
import { buildApp } from "../src/app.js";
import type { GatewayConfig } from "../src/config.js";

const KB_ID = "51adf856-2722-4a62-be49-b7d1f2cd20b4";
const CLIENT_ID = "chatgpt-weknora-read";
const config: GatewayConfig = {
  host: "127.0.0.1",
  port: 18194,
  publicMcpUrl: new URL("https://wek.uov.me/mcp"),
  oauthIssuer: new URL("https://wek.uov.me/oauth/realms/weknora"),
  oauthJwksUrl: new URL(
    "https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/certs",
  ),
  oauthRequiredScope: "weknora:mcp",
  upstreamMcpUrl: new URL("http://127.0.0.1:18193/mcp"),
  upstreamMcpTokenFile: "/run/secrets/token",
  fallbackKbId: KB_ID,
  fallbackKbName: "镍基合金",
  accessPolicyFile: "/var/lib/weknora-mcp-console/access-policy.json",
  auditFile: "/var/lib/weknora-mcp-console/audit.ndjson",
  importRoot: "C:\\weknora-import",
  allowedOrigins: ["https://chatgpt.com", "https://claude.ai"],
  rateLimitIpPerMinute: 120,
  rateLimitSubjectPerMinute: 60,
  upstreamTimeoutMs: 30_000,
  httpBodyLimitBytes: 16_777_216,
  logLevel: "silent",
};

const principal: AuthenticatedPrincipal = {
  subject: "user-1",
  clientId: CLIENT_ID,
  scopes: ["weknora:mcp"],
};

const accessPolicy: McpAccessPolicyProvider = {
  read: async () => ({
    version: 2,
    clients: [
      {
        clientId: CLIENT_ID,
        label: "ChatGPT",
        provider: "ChatGPT",
        accessType: "capabilities",
        capabilities: ["knowledge.read"],
        knowledgeBaseScope: "selected",
        defaultKbId: KB_ID,
        knowledgeBases: [{ id: KB_ID, name: "镍基合金" }],
      },
    ],
  }),
};

const tools: Tool[] = [
  {
    name: "hybrid_search",
    inputSchema: {
      type: "object",
      properties: { kb_id: { type: "string" }, query: { type: "string" } },
      required: ["kb_id", "query"],
    },
  },
  {
    name: "wiki_search",
    inputSchema: {
      type: "object",
      properties: { kb_id: { type: "string" }, query: { type: "string" } },
      required: ["kb_id", "query"],
    },
  },
  {
    name: "wiki_read_page",
    inputSchema: {
      type: "object",
      properties: { kb_id: { type: "string" }, slug: { type: "string" } },
      required: ["kb_id", "slug"],
    },
  },
  {
    name: "wiki_index_view",
    inputSchema: {
      type: "object",
      properties: { kb_id: { type: "string" } },
      required: ["kb_id"],
    },
  },
];

function options(overrides: Partial<Parameters<typeof buildApp>[0]> = {}) {
  return {
    config,
    verifyToken: vi.fn(async () => principal),
    upstream: {} as never,
    tools,
    accessPolicy,
    ...overrides,
  };
}

describe("HTTP application", () => {
  it("serves both protected-resource metadata paths", async () => {
    const app = buildApp(options());

    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(200);
      expect(response.json().resource).toBe("https://wek.uov.me/mcp");
      expect(response.json().scopes_supported).toEqual(["weknora:mcp"]);
    }
    await app.close();
  });

  it("returns a standards-shaped challenge when authentication is missing", async () => {
    const app = buildApp(options({ verifyToken: vi.fn() }));

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
    const app = buildApp(options());

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
    const app = buildApp(
      options({
        verifyToken: vi.fn(async () => {
          throw new AuthorizationError();
        }),
      }),
    );

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

  it("rejects a token without an OAuth client identity", async () => {
    const app = buildApp(
      options({
        verifyToken: vi.fn(async () => ({
          subject: "user-1",
          scopes: ["weknora:mcp"],
        })),
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer no-client" },
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "unmanaged_client" });
    await app.close();
  });

  it("rejects an OAuth client missing from the server-side access policy", async () => {
    const app = buildApp(
      options({
        verifyToken: vi.fn(async () => ({
          ...principal,
          clientId: "unknown-client",
        })),
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer unknown-client" },
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "unmanaged_client" });
    await app.close();
  });

  it("uses the OpenResty forwarded client IP for rate limiting", async () => {
    const app = buildApp(
      options({
        config: { ...config, rateLimitIpPerMinute: 1 },
        verifyToken: vi.fn(async (token: string) => ({
          ...principal,
          subject: `user-${token}`,
        })),
      }),
    );

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
    const app = buildApp(options({ upstream }));
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
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toHaveLength(5);

      const result = await client.callTool({
        name: "hybrid_search",
        arguments: { query: "晶界腐蚀" },
      });
      expect(result.content).toEqual([{ type: "text", text: "match" }]);
      expect(upstream.callTool).toHaveBeenCalledWith({
        name: "hybrid_search",
        arguments: {
          kb_id: KB_ID,
          query: "晶界腐蚀",
        },
      });
    } finally {
      await client.close();
      await app.close();
    }
  });
});
