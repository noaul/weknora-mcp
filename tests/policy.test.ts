import { describe, expect, it } from "vitest";

import {
  ALLOWED_TOOL_NAMES,
  prepareUpstreamToolCall,
} from "../src/policy.js";

const kbId = "51adf856-2722-4a62-be49-b7d1f2cd20b4";

describe("read-only single-KB tool policy", () => {
  it("exposes only the four approved read tools", () => {
    expect(ALLOWED_TOOL_NAMES).toEqual([
      "hybrid_search",
      "wiki_search",
      "wiki_read_page",
      "wiki_index_view",
    ]);
  });

  it("injects the fixed KB into hybrid_search", () => {
    expect(
      prepareUpstreamToolCall(
        "hybrid_search",
        { query: "晶界腐蚀", match_count: 8 },
        kbId,
      ),
    ).toEqual({
      name: "hybrid_search",
      arguments: { kb_id: kbId, query: "晶界腐蚀", match_count: 8 },
    });
  });

  it.each(["kb_id", "knowledge_base_id", "knowledge_base_ids"])(
    "rejects client-controlled %s",
    (field) => {
      expect(() =>
        prepareUpstreamToolCall(
          "hybrid_search",
          { query: "test", [field]: "attacker-controlled" },
          kbId,
        ),
      ).toThrow(/unexpected|knowledge-base/i);
    },
  );

  it("rejects write and unknown tools", () => {
    expect(() =>
      prepareUpstreamToolCall("delete_knowledge_base", { kb_id: kbId }, kbId),
    ).toThrow(/not allowed/i);
  });

  it("rejects unknown arguments instead of silently dropping them", () => {
    expect(() =>
      prepareUpstreamToolCall(
        "wiki_search",
        { query: "alloy", limit: 5, extra: true },
        kbId,
      ),
    ).toThrow(/unexpected/i);
  });
});
