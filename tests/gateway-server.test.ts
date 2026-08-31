import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGatewayMcpServer } from "../src/gateway-server.js";
import type { KnowledgePolicyProvider } from "../src/knowledge-policy.js";

const closeables: Array<{ close(): Promise<void> }> = [];
const KB_A = "51adf856-2722-4a62-be49-b7d1f2cd20b4";
const KB_B = "14f18c87-26b4-4b51-ac9f-cb57ace46df7";

function policyProvider(): KnowledgePolicyProvider {
  return {
    read: async () => ({
      version: 1,
      defaultKbId: KB_A,
      knowledgeBases: [
        { id: KB_A, name: "镍基合金" },
        { id: KB_B, name: "熔盐堆" },
      ],
    }),
  };
}

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
});

describe("gateway MCP server", () => {
  it("advertises only the approved read tools", async () => {
    const upstream = { callTool: vi.fn() };
    const server = createGatewayMcpServer({
      policy: policyProvider(),
      upstream,
    });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "list_allowed_knowledge_bases",
      "hybrid_search",
      "wiki_search",
      "wiki_read_page",
      "wiki_index_view",
    ]);
    expect(tools.tools[1]?.inputSchema.properties).toHaveProperty("kb_id");
  });

  it("uses the default KB when a downstream client omits kb_id", async () => {
    const upstream = {
      callTool: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "result" }],
      })),
    };
    const server = createGatewayMcpServer({
      policy: policyProvider(),
      upstream,
    });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "hybrid_search",
      arguments: { query: "晶界腐蚀", match_count: 5 },
    });

    expect(result.content).toEqual([{ type: "text", text: "result" }]);
    expect(upstream.callTool).toHaveBeenCalledWith({
      name: "hybrid_search",
      arguments: {
        kb_id: KB_A,
        query: "晶界腐蚀",
        match_count: 5,
      },
    });
  });

  it("forwards an explicitly selected allow-listed knowledge base", async () => {
    const upstream = {
      callTool: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "result" }],
      })),
    };
    const server = createGatewayMcpServer({ policy: policyProvider(), upstream });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.callTool({
      name: "hybrid_search",
      arguments: { kb_id: KB_B, query: "熔盐腐蚀" },
    });

    expect(upstream.callTool).toHaveBeenCalledWith({
      name: "hybrid_search",
      arguments: { kb_id: KB_B, query: "熔盐腐蚀" },
    });
  });

  it("lists allowed knowledge bases without calling upstream", async () => {
    const upstream = { callTool: vi.fn() };
    const server = createGatewayMcpServer({ policy: policyProvider(), upstream });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "list_allowed_knowledge_bases",
      arguments: {},
    });

    expect(JSON.stringify(result.content)).toContain("熔盐堆");
    expect(JSON.stringify(result.content)).toContain(KB_A);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it("rejects a knowledge base outside the allow-list", async () => {
    const upstream = { callTool: vi.fn() };
    const server = createGatewayMcpServer({ policy: policyProvider(), upstream });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "hybrid_search",
      arguments: {
        kb_id: "0787e321-6f1e-4471-86a9-339165e51644",
        query: "GH3539",
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/not allowed/i);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it("does not expose or execute an upstream delete tool", async () => {
    const upstream = { callTool: vi.fn() };
    const server = createGatewayMcpServer({
      policy: policyProvider(),
      upstream,
    });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "delete_knowledge_base",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/not found/i);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });
});
