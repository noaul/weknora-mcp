import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import { PolicyError } from "./policy.js";
import type { ToolCall } from "./upstream-client.js";

const DESTRUCTIVE_TOOLS = new Set([
  "delete_knowledge_base",
  "delete_knowledge",
  "delete_session",
  "delete_chunk",
]);

const READ_ONLY_TOOLS = new Set([
  "list_tenants",
  "list_knowledge_bases",
  "list_shared_knowledge_bases",
  "get_knowledge_base",
  "hybrid_search",
  "list_knowledge",
  "get_knowledge",
  "list_models",
  "get_model",
  "get_session",
  "list_sessions",
  "list_agents",
  "get_agent",
  "list_chunks",
  "wiki_search",
  "wiki_read_page",
  "wiki_index_view",
]);

export function adminToolAnnotations(name: string): ToolAnnotations {
  const readOnly = READ_ONLY_TOOLS.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: readOnly,
    openWorldHint:
      name === "create_knowledge_from_url" ||
      name === "chat" ||
      name === "agent_chat",
  };
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

export async function prepareAdminToolCall(options: {
  name: string;
  arguments: Record<string, unknown>;
  allowedToolNames: ReadonlySet<string>;
  importRoot: string;
}): Promise<ToolCall> {
  if (!options.allowedToolNames.has(options.name)) {
    throw new PolicyError(`Tool ${options.name} is not allowed`);
  }

  if (options.name === "create_knowledge_from_file") {
    const filePath = options.arguments.file_path;
    if (typeof filePath !== "string" || !isAbsolute(filePath)) {
      throw new PolicyError("file_path must be an absolute path");
    }

    let root: string;
    let candidate: string;
    try {
      [root, candidate] = await Promise.all([
        realpath(options.importRoot),
        realpath(filePath),
      ]);
    } catch {
      throw new PolicyError("file_path must resolve inside the admin import root");
    }
    if (!isInside(root, candidate)) {
      throw new PolicyError("file_path is outside the admin import root");
    }
  }

  return { name: options.name, arguments: options.arguments };
}
