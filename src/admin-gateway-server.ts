import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  adminToolAnnotations,
  prepareAdminToolCall,
} from "./admin-policy.js";
import { PolicyError } from "./policy.js";
import type { ToolCaller } from "./upstream-client.js";

export interface AdminGatewayServerOptions {
  tools: Tool[];
  importRoot: string;
  upstream: ToolCaller;
}

export function createAdminGatewayMcpServer(
  options: AdminGatewayServerOptions,
): Server {
  const server = new Server(
    { name: "weknora-mcp-admin-gateway", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const allowedToolNames = new Set(options.tools.map((tool) => tool.name));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map((tool) => ({
      ...tool,
      annotations: adminToolAnnotations(tool.name),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const call = await prepareAdminToolCall({
        name: request.params.name,
        arguments: request.params.arguments ?? {},
        allowedToolNames,
        importRoot: options.importRoot,
      });
      return await options.upstream.callTool(call);
    } catch (error) {
      if (error instanceof PolicyError) {
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
        };
      }
      throw error;
    }
  });

  return server;
}
