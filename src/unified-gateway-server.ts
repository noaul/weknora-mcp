import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import type {
  ClientAccessPolicy,
  McpAccessPolicyProvider,
} from "./access-policy.js";
import {
  adminToolAnnotations,
  prepareAdminToolCall,
} from "./admin-policy.js";
import {
  ALLOWED_TOOL_NAMES,
  PolicyError,
  prepareUpstreamToolCall,
} from "./policy.js";
import {
  assertReviewedToolCatalog,
  toolAccessRule,
  type ResourceScope,
  type ToolAccessRule,
} from "./tool-capabilities.js";
import type { ToolCaller } from "./upstream-client.js";

export interface UnifiedGatewayServerOptions {
  clientId: string;
  policy: McpAccessPolicyProvider;
  tools: Tool[];
  importRoot: string;
  upstream: ToolCaller;
}

const RETRIEVAL_TOOL_NAMES = new Set<string>(ALLOWED_TOOL_NAMES);
const LIST_ALLOWED_TOOL: Tool = {
  name: "list_allowed_knowledge_bases",
  title: "List allowed WeKnora knowledge bases",
  description:
    "List the knowledge bases available to this OAuth client and identify the default.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

function policyErrorResult(error: unknown): CallToolResult {
  if (error instanceof PolicyError) {
    return {
      isError: true,
      content: [{ type: "text", text: error.message }],
    };
  }
  throw error;
}

function findClient(
  policy: Awaited<ReturnType<McpAccessPolicyProvider["read"]>>,
  clientId: string,
): ClientAccessPolicy {
  const client = policy.clients.find((candidate) => candidate.clientId === clientId);
  if (!client) throw new PolicyError(`OAuth client ${clientId} is not managed`);
  return client;
}

function isAllowedKnowledgeBase(client: ClientAccessPolicy, kbId: string): boolean {
  return (
    client.accessType === "full" ||
    client.knowledgeBaseScope === "all" ||
    client.knowledgeBases.some(({ id }) => id === kbId)
  );
}

function assertAllowedKnowledgeBase(
  client: ClientAccessPolicy,
  kbId: string,
): void {
  if (!isAllowedKnowledgeBase(client, kbId)) {
    throw new PolicyError(`Knowledge base ${kbId} is not allowed`);
  }
}

function hasCapabilities(client: ClientAccessPolicy, rule: ToolAccessRule): boolean {
  if (client.accessType === "full") return true;
  if (rule.kind !== "capability") return false;
  const granted = new Set(client.capabilities);
  return rule.capabilities.every((capability) => granted.has(capability));
}

function downstreamTool(tool: Tool): Tool {
  const inputSchema = structuredClone(tool.inputSchema);
  if (RETRIEVAL_TOOL_NAMES.has(tool.name)) {
    const required = Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((name) => name !== "kb_id")
      : undefined;
    inputSchema.required = required && required.length > 0 ? required : undefined;
    inputSchema.properties = {
      ...(inputSchema.properties ?? {}),
      kb_id: {
        type: "string",
        format: "uuid",
        description: "Allowed knowledge base UUID. Omit to use the configured default.",
      },
    };
  }
  return {
    ...tool,
    inputSchema,
    annotations: adminToolAnnotations(tool.name),
  };
}

function visibleTools(client: ClientAccessPolicy, tools: Tool[]): Tool[] {
  if (client.accessType === "full") return tools.map(downstreamTool);
  return tools
    .filter((tool) => hasCapabilities(client, toolAccessRule(tool.name)))
    .map(downstreamTool);
}

function parseResultJson(result: CallToolResult): unknown {
  const text = result.content.find((item) => item.type === "text");
  if (!text || text.type !== "text") {
    throw new PolicyError("Upstream result cannot be inspected for access control");
  }
  try {
    return JSON.parse(text.text) as unknown;
  } catch {
    throw new PolicyError("Upstream result cannot be inspected for access control");
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function findKnowledgeBaseId(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findKnowledgeBaseId(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = objectRecord(value);
  if (!record) return undefined;
  for (const key of ["knowledge_base_id", "knowledgeBaseId", "kb_id"]) {
    if (typeof record[key] === "string") return record[key];
  }
  const knowledgeBase = objectRecord(record.knowledge_base);
  if (knowledgeBase && typeof knowledgeBase.id === "string") {
    return knowledgeBase.id;
  }
  for (const child of Object.values(record)) {
    const found = findKnowledgeBaseId(child);
    if (found) return found;
  }
  return undefined;
}

function extractKnowledgeBases(value: unknown): Array<{ id: string; name: string }> {
  const candidates: unknown[] = [];
  if (Array.isArray(value)) candidates.push(value);
  const record = objectRecord(value);
  if (record) {
    candidates.push(record.data, record.knowledge_bases, record.knowledgeBases);
    const data = objectRecord(record.data);
    if (data) candidates.push(data.items, data.knowledge_bases, data.knowledgeBases);
  }
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const knowledgeBases = candidate.flatMap((item) => {
      const entry = objectRecord(item);
      if (!entry || typeof entry.id !== "string" || typeof entry.name !== "string") {
        return [];
      }
      return [{ id: entry.id, name: entry.name }];
    });
    if (knowledgeBases.length > 0) return knowledgeBases;
  }
  throw new PolicyError("Upstream knowledge-base list cannot be inspected");
}

async function listAllowedKnowledgeBases(
  client: ClientAccessPolicy,
  upstream: ToolCaller,
): Promise<CallToolResult> {
  let knowledgeBases = client.knowledgeBases;
  if (client.accessType === "full" || client.knowledgeBaseScope === "all") {
    const result = await upstream.callTool({
      name: "list_knowledge_bases",
      arguments: {},
    });
    knowledgeBases = extractKnowledgeBases(parseResultJson(result));
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          default_kb_id: client.defaultKbId,
          knowledge_base_scope: client.knowledgeBaseScope,
          knowledge_bases: knowledgeBases,
        }),
      },
    ],
  };
}

function assertKnowledgeBaseArguments(
  client: ClientAccessPolicy,
  rule: ToolAccessRule,
  args: Record<string, unknown>,
): void {
  if (client.accessType === "full" || rule.kind !== "capability") return;
  if (rule.kbArgument === "kb_id") {
    const kbId = args.kb_id;
    if (typeof kbId !== "string") {
      throw new PolicyError("kb_id must be provided");
    }
    assertAllowedKnowledgeBase(client, kbId);
  }
  if (rule.kbArgument === "knowledge_base_ids") {
    const kbIds = args.knowledge_base_ids;
    if (kbIds === undefined || kbIds === null) return;
    if (!Array.isArray(kbIds) || kbIds.some((kbId) => typeof kbId !== "string")) {
      throw new PolicyError("knowledge_base_ids must be an array of UUIDs");
    }
    for (const kbId of kbIds as string[]) assertAllowedKnowledgeBase(client, kbId);
  }
}

async function preflightResource(
  scope: ResourceScope,
  args: Record<string, unknown>,
  client: ClientAccessPolicy,
  upstream: ToolCaller,
): Promise<CallToolResult> {
  const resourceArgument = scope === "knowledge" ? "knowledge_id" : "session_id";
  const resourceId = args[resourceArgument];
  if (typeof resourceId !== "string" || resourceId.length === 0) {
    throw new PolicyError(`${resourceArgument} must be provided`);
  }
  const inspectionTool = scope === "knowledge" ? "get_knowledge" : "get_session";
  const result = await upstream.callTool({
    name: inspectionTool,
    arguments: { [resourceArgument]: resourceId },
  });
  const kbId = findKnowledgeBaseId(parseResultJson(result));
  if (!kbId) {
    throw new PolicyError(`Cannot determine the ${scope} knowledge base`);
  }
  assertAllowedKnowledgeBase(client, kbId);
  return result;
}

export function createUnifiedGatewayMcpServer(
  options: UnifiedGatewayServerOptions,
): Server {
  assertReviewedToolCatalog(options.tools);
  const server = new Server(
    { name: "weknora-mcp-unified-gateway", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const client = findClient(await options.policy.read(), options.clientId);
    return { tools: [LIST_ALLOWED_TOOL, ...visibleTools(client, options.tools)] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const client = findClient(await options.policy.read(), options.clientId);
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      if (name === LIST_ALLOWED_TOOL.name) {
        return await listAllowedKnowledgeBases(client, options.upstream);
      }

      const tool = toolsByName.get(name);
      if (!tool) throw new PolicyError(`Tool ${name} is not allowed`);
      const rule = toolAccessRule(name);
      if (!hasCapabilities(client, rule)) {
        throw new PolicyError(`Tool ${name} is not allowed for this OAuth client`);
      }

      if (RETRIEVAL_TOOL_NAMES.has(name)) {
        const requestedKbId = typeof args.kb_id === "string" ? args.kb_id : undefined;
        const kbId = requestedKbId ?? client.defaultKbId;
        assertAllowedKnowledgeBase(client, kbId);
        return await options.upstream.callTool(
          prepareUpstreamToolCall(name, args, kbId),
        );
      }

      assertKnowledgeBaseArguments(client, rule, args);
      let inspected: CallToolResult | undefined;
      if (
        client.accessType !== "full" &&
        rule.kind === "capability" &&
        rule.resourceScope
      ) {
        inspected = await preflightResource(
          rule.resourceScope,
          args,
          client,
          options.upstream,
        );
        if (
          (rule.resourceScope === "knowledge" && name === "get_knowledge") ||
          (rule.resourceScope === "session" && name === "get_session")
        ) {
          return inspected;
        }
      }

      const allowedToolNames = new Set(visibleTools(client, options.tools).map(({ name }) => name));
      const call = await prepareAdminToolCall({
        name,
        arguments: args,
        allowedToolNames,
        importRoot: options.importRoot,
      });
      return await options.upstream.callTool(call);
    } catch (error) {
      return policyErrorResult(error);
    }
  });

  return server;
}
