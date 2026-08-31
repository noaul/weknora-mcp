import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { prepareUpstreamToolCall } from "./policy.js";
import type { ToolCaller } from "./upstream-client.js";

export interface GatewayServerOptions {
  fixedKbId: string;
  fixedKbName: string;
  upstream: ToolCaller;
}

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function asToolResult(result: CallToolResult): CallToolResult {
  return result;
}

export function createGatewayMcpServer(options: GatewayServerOptions): McpServer {
  const server = new McpServer({
    name: "weknora-mcp-access-gateway",
    version: "0.1.0",
  });

  server.registerTool(
    "hybrid_search",
    {
      title: `Search ${options.fixedKbName}`,
      description: `Run hybrid vector and keyword search in the fixed ${options.fixedKbName} knowledge base.`,
      inputSchema: z.strictObject({
        query: z.string().min(1).describe("Search query"),
        vector_threshold: z.number().min(0).max(1).optional(),
        keyword_threshold: z.number().min(0).max(1).optional(),
        match_count: z.number().int().min(1).max(100).optional(),
      }),
      annotations,
    },
    async (args) =>
      asToolResult(
        await options.upstream.callTool(
          prepareUpstreamToolCall("hybrid_search", args, options.fixedKbId),
        ),
      ),
  );

  server.registerTool(
    "wiki_search",
    {
      title: `Search ${options.fixedKbName} wiki`,
      description: `Search wiki pages generated for the fixed ${options.fixedKbName} knowledge base.`,
      inputSchema: z.strictObject({
        query: z.string().min(1).describe("Wiki search query"),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations,
    },
    async (args) =>
      asToolResult(
        await options.upstream.callTool(
          prepareUpstreamToolCall("wiki_search", args, options.fixedKbId),
        ),
      ),
  );

  server.registerTool(
    "wiki_read_page",
    {
      title: `Read ${options.fixedKbName} wiki page`,
      description: `Read one wiki page from the fixed ${options.fixedKbName} knowledge base.`,
      inputSchema: z.strictObject({
        slug: z.string().min(1).describe("Wiki page slug"),
      }),
      annotations,
    },
    async (args) =>
      asToolResult(
        await options.upstream.callTool(
          prepareUpstreamToolCall("wiki_read_page", args, options.fixedKbId),
        ),
      ),
  );

  server.registerTool(
    "wiki_index_view",
    {
      title: `List ${options.fixedKbName} wiki pages`,
      description: `List the wiki index for the fixed ${options.fixedKbName} knowledge base.`,
      inputSchema: z.strictObject({
        limit: z.number().int().min(1).max(200).optional(),
      }),
      annotations,
    },
    async (args) =>
      asToolResult(
        await options.upstream.callTool(
          prepareUpstreamToolCall("wiki_index_view", args, options.fixedKbId),
        ),
      ),
  );

  return server;
}
