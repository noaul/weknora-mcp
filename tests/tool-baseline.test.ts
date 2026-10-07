import { readFile } from "node:fs/promises";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import {
  compareToolBaseline,
  selectBaselineTools,
  type ToolBaseline,
} from "../src/tool-baseline.js";
import { assertReviewedToolCatalog } from "../src/tool-capabilities.js";

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

describe("tool baseline selection", () => {
  const legacySchema = {
    type: "object",
    properties: { kb_id: { type: "string" } },
    required: ["kb_id"],
  };
  const currentSchema = {
    type: "object",
    properties: {
      kb_id: { type: "string" },
      folder_path: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
    },
    required: ["kb_id"],
  };
  const versioned = {
    tools: [
      {
        name: "list_knowledge",
        inputSchema: currentSchema,
        legacyInputSchemas: [legacySchema],
      },
      {
        name: "update_knowledge_from_text",
        inputSchema: { type: "object", properties: {} },
        optional: true,
      },
      baseline.tools[0]!,
    ],
  };

  it("accepts current and legacy upstream schemas and optional new tools", () => {
    for (const inputSchema of [currentSchema, legacySchema]) {
      const selection = selectBaselineTools(versioned, [
        { name: "list_knowledge", inputSchema: inputSchema as Tool["inputSchema"] },
        {
          name: "hybrid_search",
          inputSchema: baseline.tools[0]!.inputSchema as Tool["inputSchema"],
        },
      ]);
      expect(selection.errors).toEqual([]);
      expect(selection.tools.map(({ name }) => name)).toEqual([
        "list_knowledge",
        "hybrid_search",
      ]);
    }
  });

  it("drops only changed or unreviewed tools instead of failing the gateway", () => {
    const selection = selectBaselineTools(versioned, [
      {
        name: "list_knowledge",
        inputSchema: { type: "object", properties: { other: { type: "string" } } },
      },
      {
        name: "hybrid_search",
        inputSchema: baseline.tools[0]!.inputSchema as Tool["inputSchema"],
      },
      { name: "future_admin_tool", inputSchema: { type: "object", properties: {} } },
    ]);

    expect(selection.tools.map(({ name }) => name)).toEqual(["hybrid_search"]);
    expect(selection.errors).toEqual([
      "Input schema changed for upstream tool: list_knowledge",
      "Unexpected upstream tool: future_admin_tool",
    ]);
  });

  it("matches the committed baseline fixture against itself", async () => {
    const fixture = JSON.parse(
      await readFile("fixtures/upstream-admin-tools-baseline.json", "utf8"),
    ) as ToolBaseline;
    const live = fixture.tools.map(({ name, inputSchema }) => ({
      name,
      inputSchema: inputSchema as Tool["inputSchema"],
    }));
    const selection = selectBaselineTools(fixture, live);

    expect(selection.errors).toEqual([]);
    expect(() => assertReviewedToolCatalog(selection.tools)).not.toThrow();
  });
});
