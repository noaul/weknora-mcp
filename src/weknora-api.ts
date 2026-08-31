import { z } from "zod";

const knowledgeBaseSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().default(""),
  knowledge_count: z.number().int().nonnegative().default(0),
  updated_at: z.string(),
  capabilities: z
    .object({
      keyword: z.boolean().default(false),
      vector: z.boolean().default(false),
      wiki: z.boolean().default(false),
    })
    .default({ keyword: false, vector: false, wiki: false }),
});

const listResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(knowledgeBaseSchema),
});

export interface WeKnoraKnowledgeBase {
  id: string;
  name: string;
  description: string;
  knowledgeCount: number;
  updatedAt: string;
  capabilities: { keyword: boolean; vector: boolean; wiki: boolean };
}

export class WeKnoraApiClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    baseUrl: URL;
    apiKey: string;
    fetchImpl?: typeof fetch;
  }) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listKnowledgeBases(): Promise<WeKnoraKnowledgeBase[]> {
    const response = await this.fetchImpl(new URL("knowledge-bases", this.baseUrl), {
      headers: { "X-API-Key": this.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`WeKnora knowledge-base request failed with status ${response.status}`);
    }
    const parsed = listResponseSchema.parse(await response.json());
    if (!parsed.success) throw new Error("WeKnora knowledge-base request was unsuccessful");
    return parsed.data.map((knowledgeBase) => ({
      id: knowledgeBase.id,
      name: knowledgeBase.name,
      description: knowledgeBase.description,
      knowledgeCount: knowledgeBase.knowledge_count,
      updatedAt: knowledgeBase.updated_at,
      capabilities: knowledgeBase.capabilities,
    }));
  }
}
