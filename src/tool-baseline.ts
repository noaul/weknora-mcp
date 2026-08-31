import type { Tool } from "@modelcontextprotocol/sdk/types.js";

interface BaselineTool {
  name: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolBaseline {
  tools: BaselineTool[];
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !new Set(["title", "description", "examples"]).has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [
        key,
        key === "required" && Array.isArray(child)
          ? [...child].sort()
          : normalize(child),
      ]),
  );
}

function stable(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function compareToolBaseline(
  baseline: ToolBaseline,
  liveTools: Tool[],
): string[] {
  const liveByName = new Map(liveTools.map((tool) => [tool.name, tool]));
  const errors: string[] = [];

  for (const expected of baseline.tools) {
    const actual = liveByName.get(expected.name);
    if (!actual) {
      errors.push(`Missing upstream tool: ${expected.name}`);
      continue;
    }
    if (stable(expected.inputSchema) !== stable(actual.inputSchema)) {
      errors.push(`Input schema changed for upstream tool: ${expected.name}`);
    }
  }

  return errors;
}
