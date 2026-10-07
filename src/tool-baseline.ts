import type { Tool } from "@modelcontextprotocol/sdk/types.js";

interface BaselineTool {
  name: string;
  inputSchema: Record<string, unknown>;
  /** Older upstream releases whose schema is still accepted for this tool. */
  legacyInputSchemas?: Record<string, unknown>[];
  /** Tool added by a newer upstream release; its absence is not an error. */
  optional?: boolean;
}

export interface ToolBaseline {
  tools: BaselineTool[];
}

export interface CompareToolBaselineOptions {
  rejectUnexpected?: boolean;
}

export interface ToolBaselineSelection {
  /** Live tools that match the reviewed baseline, in baseline order. */
  tools: Tool[];
  /** Mismatches; affected tools are excluded from `tools`. */
  errors: string[];
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

function schemaMatches(expected: BaselineTool, actual: Tool): boolean {
  const live = stable(actual.inputSchema);
  return [expected.inputSchema, ...(expected.legacyInputSchemas ?? [])].some(
    (schema) => stable(schema) === live,
  );
}

/**
 * Select the live upstream tools that match the reviewed baseline. Tools whose
 * schema changed or that are not in the baseline fail closed: they are left out
 * and reported, while the remaining reviewed tools stay available.
 */
export function selectBaselineTools(
  baseline: ToolBaseline,
  liveTools: Tool[],
): ToolBaselineSelection {
  const liveByName = new Map(liveTools.map((tool) => [tool.name, tool]));
  const tools: Tool[] = [];
  const errors: string[] = [];

  for (const expected of baseline.tools) {
    const actual = liveByName.get(expected.name);
    if (!actual) {
      if (!expected.optional) errors.push(`Missing upstream tool: ${expected.name}`);
      continue;
    }
    if (!schemaMatches(expected, actual)) {
      errors.push(`Input schema changed for upstream tool: ${expected.name}`);
      continue;
    }
    tools.push(actual);
  }

  const expectedNames = new Set(baseline.tools.map((tool) => tool.name));
  for (const actual of liveTools) {
    if (!expectedNames.has(actual.name)) {
      errors.push(`Unexpected upstream tool: ${actual.name}`);
    }
  }

  return { tools, errors };
}

export function compareToolBaseline(
  baseline: ToolBaseline,
  liveTools: Tool[],
  options: CompareToolBaselineOptions = {},
): string[] {
  const { errors } = selectBaselineTools(baseline, liveTools);
  return options.rejectUnexpected
    ? errors
    : errors.filter((error) => !error.startsWith("Unexpected upstream tool:"));
}
