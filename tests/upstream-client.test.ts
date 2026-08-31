import { describe, expect, it, vi } from "vitest";

import { createCredentialIsolatingFetch } from "../src/upstream-client.js";

describe("upstream credential isolation", () => {
  it("replaces client credentials with the internal upstream token", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer internal-secret");
      expect(headers.has("x-mcp-auth-token")).toBe(false);
      return new Response("ok");
    });
    const isolatedFetch = createCredentialIsolatingFetch({
      upstreamToken: "internal-secret",
      timeoutMs: 1_000,
      fetchImpl: fetchMock,
    });

    await isolatedFetch("http://127.0.0.1:18193/mcp", {
      headers: {
        Authorization: "Bearer client-token",
        "X-MCP-Auth-Token": "client-token-two",
      },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
