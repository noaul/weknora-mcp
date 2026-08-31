import { describe, expect, it } from "vitest";

import { compareToolBaseline } from "../src/tool-baseline.js";

const baseline = {
  tools: [
    {
      name: "hybrid_search",
      inputSchema: {
        type: "object",
        properties: {
          kb_id: { type: "string" },
          query: { type: "string" },
        },
        required: ["kb_id", "query"],
      },
    },
  ],
};

describe("tool baseline comparison", () => {
  it("ignores descriptions and schema titles", () => {
    expect(
      compareToolBaseline(baseline, [
        {
          name: "hybrid_search",
          description: "new wording",
          inputSchema: {
            title: "Changed title",
            type: "object",
            properties: {
              kb_id: { type: "string", title: "KB" },
              query: { type: "string", title: "Query" },
            },
            required: ["kb_id", "query"],
          },
        },
      ]),
    ).toEqual([]);
  });

  it("reports missing tools and changed input fields", () => {
    expect(compareToolBaseline(baseline, [])).toEqual([
      "Missing upstream tool: hybrid_search",
    ]);
    expect(
      compareToolBaseline(baseline, [
        {
          name: "hybrid_search",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ]),
    ).toContain("Input schema changed for upstream tool: hybrid_search");
  });

  it("can reject tools that are not in an exact admin baseline", () => {
    expect(
      compareToolBaseline(
        baseline,
        [
          {
            name: "hybrid_search",
            inputSchema: baseline.tools[0]!.inputSchema as {
              type: "object";
              properties?: Record<string, object>;
              required?: string[];
            },
          },
          {
            name: "future_admin_tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        { rejectUnexpected: true },
      ),
    ).toEqual(["Unexpected upstream tool: future_admin_tool"]);
  });
});
