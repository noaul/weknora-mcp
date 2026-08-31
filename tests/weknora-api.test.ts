import { describe, expect, it, vi } from "vitest";

import { WeKnoraApiClient } from "../src/weknora-api.js";

describe("WeKnora API client", () => {
  it("returns only management-safe knowledge base fields", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-API-Key")).toBe("secret-key");
      return new Response(
        JSON.stringify({
          success: true,
          data: [
            {
              id: "51adf856-2722-4a62-be49-b7d1f2cd20b4",
              name: "镍基合金",
              description: "materials",
              knowledge_count: 20922,
              updated_at: "2026-08-30T19:02:54.648139-07:00",
              capabilities: { keyword: true, vector: true, wiki: true },
              storage_config: { secret_key: "must-not-leak" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const client = new WeKnoraApiClient({
      baseUrl: new URL("http://127.0.0.1:18091/api/v1/"),
      apiKey: "secret-key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.listKnowledgeBases()).resolves.toEqual([
      {
        id: "51adf856-2722-4a62-be49-b7d1f2cd20b4",
        name: "镍基合金",
        description: "materials",
        knowledgeCount: 20922,
        updatedAt: "2026-08-30T19:02:54.648139-07:00",
        capabilities: { keyword: true, vector: true, wiki: true },
      },
    ]);
  });

  it("does not expose the API key in upstream errors", async () => {
    const client = new WeKnoraApiClient({
      baseUrl: new URL("http://127.0.0.1:18091/api/v1/"),
      apiKey: "super-secret",
      fetchImpl: vi.fn(async () => new Response("bad", { status: 500 })) as typeof fetch,
    });

    await expect(client.listKnowledgeBases()).rejects.toThrow(/status 500/i);
    await expect(client.listKnowledgeBases()).rejects.not.toThrow(/super-secret/);
  });
});
