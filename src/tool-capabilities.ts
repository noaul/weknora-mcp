import type { McpCapabilityId } from "./access-policy.js";

export type KnowledgeBaseArgument = "kb_id" | "knowledge_base_ids";
export type ResourceScope = "knowledge" | "session";

export type ToolAccessRule =
  | {
      kind: "capability";
      capabilities: McpCapabilityId[];
      kbArgument?: KnowledgeBaseArgument;
      resourceScope?: ResourceScope;
    }
  | { kind: "full" }
  | { kind: "replaced" };

const TOOL_ACCESS_RULES = {
  create_tenant: { kind: "full" },
  list_tenants: { kind: "full" },
  create_knowledge_base: {
    kind: "capability",
    capabilities: ["knowledge.manage"],
  },
  list_knowledge_bases: { kind: "replaced" },
  list_shared_knowledge_bases: { kind: "replaced" },
  get_knowledge_base: {
    kind: "capability",
    capabilities: ["knowledge.read"],
    kbArgument: "kb_id",
  },
  delete_knowledge_base: {
    kind: "capability",
    capabilities: ["knowledge.manage"],
    kbArgument: "kb_id",
  },
  hybrid_search: {
    kind: "capability",
    capabilities: ["knowledge.read"],
    kbArgument: "kb_id",
  },
  create_knowledge_from_file: {
    kind: "capability",
    capabilities: ["knowledge.write"],
    kbArgument: "kb_id",
  },
  create_knowledge_from_url: {
    kind: "capability",
    capabilities: ["knowledge.write"],
    kbArgument: "kb_id",
  },
  create_knowledge_from_text: {
    kind: "capability",
    capabilities: ["knowledge.write"],
    kbArgument: "kb_id",
  },
  list_knowledge: {
    kind: "capability",
    capabilities: ["knowledge.read"],
    kbArgument: "kb_id",
  },
  get_knowledge: {
    kind: "capability",
    capabilities: ["knowledge.read"],
    resourceScope: "knowledge",
  },
  delete_knowledge: {
    kind: "capability",
    capabilities: ["knowledge.write"],
    resourceScope: "knowledge",
  },
  create_model: {
    kind: "capability",
    capabilities: ["models.manage"],
  },
  list_models: {
    kind: "capability",
    capabilities: ["models.manage"],
  },
  get_model: {
    kind: "capability",
    capabilities: ["models.manage"],
  },
  create_session: {
    kind: "capability",
    capabilities: ["conversation.use"],
    kbArgument: "kb_id",
  },
  get_session: {
    kind: "capability",
    capabilities: ["conversation.use"],
    resourceScope: "session",
  },
  list_sessions: { kind: "full" },
  delete_session: {
    kind: "capability",
    capabilities: ["conversation.use"],
    resourceScope: "session",
  },
  chat: {
    kind: "capability",
    capabilities: ["conversation.use"],
    kbArgument: "knowledge_base_ids",
    resourceScope: "session",
  },
  agent_chat: {
    kind: "capability",
    capabilities: ["conversation.use", "agents.read"],
    kbArgument: "knowledge_base_ids",
    resourceScope: "session",
  },
  list_agents: {
    kind: "capability",
    capabilities: ["agents.read"],
  },
  get_agent: {
    kind: "capability",
    capabilities: ["agents.read"],
  },
  list_chunks: {
    kind: "capability",
    capabilities: ["knowledge.read"],
    resourceScope: "knowledge",
  },
  delete_chunk: {
    kind: "capability",
    capabilities: ["knowledge.write"],
    resourceScope: "knowledge",
  },
  wiki_search: {
    kind: "capability",
    capabilities: ["knowledge.read"],
    kbArgument: "kb_id",
  },
  wiki_read_page: {
    kind: "capability",
    capabilities: ["knowledge.read"],
    kbArgument: "kb_id",
  },
  wiki_index_view: {
    kind: "capability",
    capabilities: ["knowledge.read"],
    kbArgument: "kb_id",
  },
} satisfies Record<string, ToolAccessRule>;

export const REVIEWED_TOOL_NAMES = Object.freeze(Object.keys(TOOL_ACCESS_RULES));

export function toolAccessRule(name: string): ToolAccessRule {
  const rule = (TOOL_ACCESS_RULES as Record<string, ToolAccessRule>)[name];
  if (!rule) throw new Error(`Unclassified upstream tool: ${name}`);
  return rule;
}

export function assertReviewedToolCatalog(
  tools: ReadonlyArray<{ name: string }>,
): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate upstream tool: ${tool.name}`);
    }
    seen.add(tool.name);
    toolAccessRule(tool.name);
  }
}
