import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { prepareUpstreamToolCall } from "./policy.js";
import { PolicyError } from "./policy.js";
import type { KnowledgePolicyProvider } from "./knowledge-policy.js";
import type { ToolCaller } from "./upstream-client.js";

export interface GatewayServerOptions {
  policy: KnowledgePolicyProvider;
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

function policyError(error: unknown): CallToolResult {
  if (error instanceof PolicyError) {
    return {
      isError: true,
      content: [{ type: "text", text: error.message }],
    };
  }
  throw error;
}

async function resolveKnowledgeBaseId(
  policyProvider: KnowledgePolicyProvider,
  requestedKbId?: string,
): Promise<string> {
  const policy = await policyProvider.read();
  const selectedKbId = requestedKbId ?? policy.defaultKbId;
  if (!policy.knowledgeBases.some((knowledgeBase) => knowledgeBase.id === selectedKbId)) {
    throw new PolicyError(`Knowledge base ${selectedKbId} is not allowed`);
  }
  return selectedKbId;
}

function selectableKbId() {
  return z
    .string()
    .uuid()
    .optional()
    .describe("Allowed knowledge base UUID. Omit to use the configured default.");
}

export function createGatewayMcpServer(options: GatewayServerOptions): McpServer {
  const server = new McpServer({
    name: "weknora-mcp-access-gateway",
    version: "0.1.0",
  });

  server.registerTool(
    "list_allowed_knowledge_bases",
    {
      title: "List allowed WeKnora knowledge bases",
      description:
        "List the knowledge bases the read-only gateway permits and identify the default.",
      inputSchema: z.strictObject({}),
      annotations,
    },
    async () => {
      const policy = await options.policy.read();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              default_kb_id: policy.defaultKbId,
              knowledge_bases: policy.knowledgeBases,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "hybrid_search",
    {
      title: "Search an allowed WeKnora knowledge base",
      description:
        "Run hybrid vector and keyword search in an allow-listed knowledge base.",
      inputSchema: z.strictObject({
        kb_id: selectableKbId(),
        query: z.string().min(1).describe("Search query"),
        vector_threshold: z.number().min(0).max(1).optional(),
        keyword_threshold: z.number().min(0).max(1).optional(),
        match_count: z.number().int().min(1).max(100).optional(),
      }),
      annotations,
    },
    async (args) => {
      try {
        const kbId = await resolveKnowledgeBaseId(options.policy, args.kb_id);
        return asToolResult(
          await options.upstream.callTool(
            prepareUpstreamToolCall("hybrid_search", args, kbId),
          ),
        );
      } catch (error) {
        return policyError(error);
      }
    },
  );

  server.registerTool(
    "wiki_search",
    {
      title: "Search an allowed WeKnora wiki",
      description: "Search wiki pages generated for an allow-listed knowledge base.",
      inputSchema: z.strictObject({
        kb_id: selectableKbId(),
        query: z.string().min(1).describe("Wiki search query"),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations,
    },
    async (args) => {
      try {
        const kbId = await resolveKnowledgeBaseId(options.policy, args.kb_id);
        return asToolResult(
          await options.upstream.callTool(
            prepareUpstreamToolCall("wiki_search", args, kbId),
          ),
        );
      } catch (error) {
        return policyError(error);
      }
    },
  );

  server.registerTool(
    "wiki_read_page",
    {
      title: "Read an allowed WeKnora wiki page",
      description: "Read one wiki page from an allow-listed knowledge base.",
      inputSchema: z.strictObject({
        kb_id: selectableKbId(),
        slug: z.string().min(1).describe("Wiki page slug"),
      }),
      annotations,
    },
    async (args) => {
      try {
        const kbId = await resolveKnowledgeBaseId(options.policy, args.kb_id);
        return asToolResult(
          await options.upstream.callTool(
            prepareUpstreamToolCall("wiki_read_page", args, kbId),
          ),
        );
      } catch (error) {
        return policyError(error);
      }
    },
  );

  server.registerTool(
    "wiki_index_view",
    {
      title: "List an allowed WeKnora wiki index",
      description: "List the wiki index for an allow-listed knowledge base.",
      inputSchema: z.strictObject({
        kb_id: selectableKbId(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      annotations,
    },
    async (args) => {
      try {
        const kbId = await resolveKnowledgeBaseId(options.policy, args.kb_id);
        return asToolResult(
          await options.upstream.callTool(
            prepareUpstreamToolCall("wiki_index_view", args, kbId),
          ),
        );
      } catch (error) {
        return policyError(error);
      }
    },
  );

  return server;
}
