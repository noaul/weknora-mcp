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
import type { SessionOwnershipStore } from "./session-ownership.js";
import {
  assertReviewedToolCatalog,
  toolAccessRule,
  type ToolAccessRule,
} from "./tool-capabilities.js";
import type { ToolCaller } from "./upstream-client.js";

export interface UnifiedGatewayServerOptions {
  clientId: string;
  policy: McpAccessPolicyProvider;
  tools: Tool[];
  importRoot: string;
  upstream: ToolCaller;
  sessions: SessionOwnershipStore;
}

const RETRIEVAL_TOOL_NAMES = new Set<string>(ALLOWED_TOOL_NAMES);
const LIST_ALLOWED_TOOL: Tool = {
  name: "list_allowed_knowledge_bases",
  title: "List allowed WeKnora knowledge bases",
  description:
    "List the knowledge bases available to this client and identify the default. Pass a knowledge base's complete id or exact name to other tools.",
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
        description:
          "Full knowledge base id or exact name from list_allowed_knowledge_bases. Omit to use the configured default.",
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

/** Flattens owned (`{id, name}`) and shared (`{knowledge_base: {id, name}}`) list entries. */
function knowledgeBaseEntries(value: unknown): Array<{ id: string; name: string }> {
  const record = objectRecord(value);
  let data: unknown = record ? (record.data ?? record) : value;
  const dataRecord = objectRecord(data);
  if (dataRecord) {
    data = dataRecord.items ?? dataRecord.list ?? dataRecord.knowledge_bases ?? [];
  }
  if (!Array.isArray(data)) {
    throw new PolicyError("Upstream knowledge-base list cannot be inspected");
  }
  return data.flatMap((item) => {
    const entry = objectRecord(objectRecord(item)?.knowledge_base) ?? objectRecord(item);
    return entry && typeof entry.id === "string" && typeof entry.name === "string"
      ? [{ id: entry.id, name: entry.name }]
      : [];
  });
}

async function knownKnowledgeBases(
  client: ClientAccessPolicy,
  upstream: ToolCaller,
): Promise<Array<{ id: string; name: string }>> {
  if (client.accessType !== "full" && client.knowledgeBaseScope === "selected") {
    return client.knowledgeBases;
  }
  const owned = knowledgeBaseEntries(
    parseResultJson(await upstream.callTool({ name: "list_knowledge_bases", arguments: {} })),
  );
  let shared: Array<{ id: string; name: string }> = [];
  try {
    const result = await upstream.callTool({
      name: "list_shared_knowledge_bases",
      arguments: {},
    });
    if (!result.isError) shared = knowledgeBaseEntries(parseResultJson(result));
  } catch {
    // Shared knowledge bases are optional; owned ones still resolve.
  }
  const byId = new Map(
    [...owned, ...shared].map((knowledgeBase) => [knowledgeBase.id, knowledgeBase]),
  );
  return [...byId.values()];
}

async function listAllowedKnowledgeBases(
  client: ClientAccessPolicy,
  upstream: ToolCaller,
): Promise<CallToolResult> {
  const knowledgeBases = await knownKnowledgeBases(client, upstream);
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

/**
 * Resolves a model-supplied knowledge base reference to a real id. Models
 * sometimes pass a name or a partly invented UUID; rejecting those here gives
 * them an actionable error instead of an opaque upstream 404.
 */
function resolveKnowledgeBase(
  reference: string,
  knowledgeBases: Array<{ id: string; name: string }>,
): string {
  const value = reference.trim();
  const byId = knowledgeBases.find(({ id }) => id === value.toLowerCase());
  if (byId) return byId.id;
  const byName = knowledgeBases.filter(
    ({ name }) => name.trim().toLowerCase() === value.toLowerCase(),
  );
  if (byName.length === 1) return byName[0]!.id;

  const prefix = value.toLowerCase().slice(0, 8);
  const similar = knowledgeBases.filter(
    ({ id, name }) =>
      (prefix.length === 8 && id.startsWith(prefix)) ||
      (value.length > 0 && name.toLowerCase().includes(value.toLowerCase())),
  );
  const hint =
    similar.length > 0
      ? ` Did you mean ${similar.map(({ id, name }) => `${id} (${name})`).join(", ")}?`
      : "";
  throw new PolicyError(
    `Knowledge base ${value} does not exist or is not allowed. Call list_allowed_knowledge_bases and pass the complete id or exact name.${hint}`,
  );
}

async function resolveKnowledgeBaseArguments(
  client: ClientAccessPolicy,
  name: string,
  rule: ToolAccessRule,
  args: Record<string, unknown>,
  upstream: ToolCaller,
): Promise<Record<string, unknown>> {
  const kbArgument = RETRIEVAL_TOOL_NAMES.has(name)
    ? "kb_id"
    : rule.kind === "capability"
      ? rule.kbArgument
      : name === "get_knowledge_base" || name === "delete_knowledge_base"
        ? "kb_id"
        : undefined;
  const value = kbArgument ? args[kbArgument] : undefined;
  if (kbArgument === "kb_id" && typeof value === "string") {
    const known = await knownKnowledgeBases(client, upstream);
    return { ...args, kb_id: resolveKnowledgeBase(value, known) };
  }
  if (
    kbArgument === "knowledge_base_ids" &&
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string")
  ) {
    const known = await knownKnowledgeBases(client, upstream);
    return {
      ...args,
      knowledge_base_ids: (value as string[]).map((item) => resolveKnowledgeBase(item, known)),
    };
  }
  return args;
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

function scopedConversationArguments(
  client: ClientAccessPolicy,
  rule: ToolAccessRule,
  args: Record<string, unknown>,
): Record<string, unknown> {
  // WeKnora searches agent or tenant defaults when knowledge_base_ids is
  // omitted, so a selected-scope client is pinned to its allow-list.
  if (
    client.accessType === "full" ||
    client.knowledgeBaseScope !== "selected" ||
    rule.kind !== "capability" ||
    rule.kbArgument !== "knowledge_base_ids"
  ) {
    return args;
  }
  const kbIds = args.knowledge_base_ids;
  if (Array.isArray(kbIds) && kbIds.length > 0) return args;
  return {
    ...args,
    knowledge_base_ids: client.knowledgeBases.map(({ id }) => id),
  };
}

async function preflightKnowledge(
  args: Record<string, unknown>,
  client: ClientAccessPolicy,
  upstream: ToolCaller,
): Promise<CallToolResult> {
  const knowledgeId = args.knowledge_id;
  if (typeof knowledgeId !== "string" || knowledgeId.length === 0) {
    throw new PolicyError("knowledge_id must be provided");
  }
  const result = await upstream.callTool({
    name: "get_knowledge",
    arguments: { knowledge_id: knowledgeId },
  });
  const kbId = findKnowledgeBaseId(parseResultJson(result));
  if (!kbId) {
    throw new PolicyError("Cannot determine the knowledge base of this knowledge entry");
  }
  assertAllowedKnowledgeBase(client, kbId);
  return result;
}

async function preflightSession(
  args: Record<string, unknown>,
  client: ClientAccessPolicy,
  sessions: SessionOwnershipStore,
): Promise<void> {
  const sessionId = args.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new PolicyError("session_id must be provided");
  }
  if ((await sessions.owner(sessionId)) !== client.clientId) {
    throw new PolicyError(`Session ${sessionId} was not created by this OAuth client`);
  }
}

function createdSessionId(result: CallToolResult): string | undefined {
  if (result.isError) return undefined;
  let parsed: unknown;
  try {
    parsed = parseResultJson(result);
  } catch {
    return undefined;
  }
  const record = objectRecord(parsed);
  const data = objectRecord(record?.data) ?? record;
  return typeof data?.id === "string" && data.id.length > 0 ? data.id : undefined;
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
      const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
      if (name === LIST_ALLOWED_TOOL.name) {
        return await listAllowedKnowledgeBases(client, options.upstream);
      }

      const tool = toolsByName.get(name);
      if (!tool) throw new PolicyError(`Tool ${name} is not allowed`);
      const rule = toolAccessRule(name);
      if (!hasCapabilities(client, rule)) {
        throw new PolicyError(`Tool ${name} is not allowed for this OAuth client`);
      }
      const args = await resolveKnowledgeBaseArguments(
        client,
        name,
        rule,
        rawArgs,
        options.upstream,
      );

      if (RETRIEVAL_TOOL_NAMES.has(name)) {
        const requestedKbId = typeof args.kb_id === "string" ? args.kb_id : undefined;
        const kbId = requestedKbId ?? client.defaultKbId;
        assertAllowedKnowledgeBase(client, kbId);
        return await options.upstream.callTool(
          prepareUpstreamToolCall(name, args, kbId),
        );
      }

      assertKnowledgeBaseArguments(client, rule, args);
      if (
        client.accessType !== "full" &&
        rule.kind === "capability" &&
        rule.resourceScope
      ) {
        if (rule.resourceScope === "session") {
          await preflightSession(args, client, options.sessions);
        } else {
          const inspected = await preflightKnowledge(args, client, options.upstream);
          if (name === "get_knowledge") return inspected;
        }
      }

      const allowedToolNames = new Set(visibleTools(client, options.tools).map(({ name }) => name));
      const call = await prepareAdminToolCall({
        name,
        arguments: scopedConversationArguments(client, rule, args),
        allowedToolNames,
        importRoot: options.importRoot,
      });
      const result = await options.upstream.callTool(call);
      if (name === "create_session") {
        const sessionId = createdSessionId(result);
        if (sessionId) await options.sessions.record(sessionId, client.clientId);
      }
      if (name === "delete_session" && !result.isError) {
        await options.sessions.forget(args.session_id as string);
      }
      return result;
    } catch (error) {
      return policyErrorResult(error);
    }
  });

  return server;
}
