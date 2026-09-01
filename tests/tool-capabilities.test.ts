import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  REVIEWED_TOOL_NAMES,
  assertReviewedToolCatalog,
  toolAccessRule,
} from "../src/tool-capabilities.js";

describe("MCP tool capability catalog", () => {
  it("classifies every reviewed official tool exactly once", async () => {
    const baseline = JSON.parse(
      await readFile("fixtures/upstream-admin-tools-baseline.json", "utf8"),
    ) as { tools: Array<{ name: string }> };

    expect(() => assertReviewedToolCatalog(baseline.tools)).not.toThrow();
    expect(baseline.tools.map(({ name }) => name).sort()).toEqual(
      [...REVIEWED_TOOL_NAMES].sort(),
    );
  });

  it.each([
    "get_knowledge_base",
    "hybrid_search",
    "list_knowledge",
    "wiki_search",
    "wiki_read_page",
    "wiki_index_view",
  ])("requires knowledge.read and an allowed kb_id for %s", (name) => {
    expect(toolAccessRule(name)).toEqual({
      kind: "capability",
      capabilities: ["knowledge.read"],
      kbArgument: "kb_id",
    });
  });

  it.each([
    "create_knowledge_from_file",
    "create_knowledge_from_url",
    "create_knowledge_from_text",
  ])("requires knowledge.write and an allowed kb_id for %s", (name) => {
    expect(toolAccessRule(name)).toEqual({
      kind: "capability",
      capabilities: ["knowledge.write"],
      kbArgument: "kb_id",
    });
  });

  it("classifies resource-ID tools for ownership preflight", () => {
    expect(toolAccessRule("get_knowledge")).toEqual({
      kind: "capability",
      capabilities: ["knowledge.read"],
      resourceScope: "knowledge",
    });
    expect(toolAccessRule("delete_chunk")).toEqual({
      kind: "capability",
      capabilities: ["knowledge.write"],
      resourceScope: "knowledge",
    });
    expect(toolAccessRule("chat")).toEqual({
      kind: "capability",
      capabilities: ["conversation.use"],
      kbArgument: "knowledge_base_ids",
      resourceScope: "session",
    });
  });

  it("requires both conversation and agent-read access for agent_chat", () => {
    expect(toolAccessRule("agent_chat")).toEqual({
      kind: "capability",
      capabilities: ["conversation.use", "agents.read"],
      kbArgument: "knowledge_base_ids",
      resourceScope: "session",
    });
  });

  it("replaces unfiltered knowledge-base listing with the safe gateway tool", () => {
    expect(toolAccessRule("list_knowledge_bases")).toEqual({ kind: "replaced" });
    expect(toolAccessRule("list_shared_knowledge_bases")).toEqual({
      kind: "replaced",
    });
  });

  it.each(["create_tenant", "list_tenants", "list_sessions"])(
    "keeps %s full-space-only",
    (name) => {
      expect(toolAccessRule(name)).toEqual({ kind: "full" });
    },
  );

  it("rejects an unreviewed official tool", () => {
    expect(() =>
      assertReviewedToolCatalog([{ name: "rotate_tenant_root_secret" }]),
    ).toThrow(/Unclassified upstream tool/);
  });
});
