import { z, ZodError } from "zod";

export const ALLOWED_TOOL_NAMES = [
  "hybrid_search",
  "wiki_search",
  "wiki_read_page",
  "wiki_index_view",
] as const;

export type AllowedToolName = (typeof ALLOWED_TOOL_NAMES)[number];

const schemas = {
  hybrid_search: z
    .object({
      query: z.string().min(1),
      vector_threshold: z.number().min(0).max(1).optional(),
      keyword_threshold: z.number().min(0).max(1).optional(),
      match_count: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  wiki_search: z
    .object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  wiki_read_page: z.object({ slug: z.string().min(1) }).strict(),
  wiki_index_view: z
    .object({ limit: z.number().int().min(1).max(200).optional() })
    .strict(),
} satisfies Record<AllowedToolName, z.ZodType<Record<string, unknown>>>;

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

function isAllowedToolName(name: string): name is AllowedToolName {
  return (ALLOWED_TOOL_NAMES as readonly string[]).includes(name);
}

export function prepareUpstreamToolCall(
  name: string,
  args: unknown,
  fixedKbId: string,
): { name: AllowedToolName; arguments: Record<string, unknown> } {
  if (!isAllowedToolName(name)) {
    throw new PolicyError(`Tool ${name} is not allowed`);
  }

  try {
    const parsed = schemas[name].parse(args);
    return {
      name,
      arguments: { kb_id: fixedKbId, ...parsed },
    };
  } catch (error) {
    if (error instanceof ZodError) {
      throw new PolicyError(`Unexpected or invalid arguments for ${name}`);
    }
    throw error;
  }
}
