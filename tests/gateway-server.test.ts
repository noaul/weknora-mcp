import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGatewayMcpServer } from "../src/gateway-server.js";

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
});

describe("gateway MCP server", () => {
  it("advertises only the approved read tools", async () => {
    const upstream = { callTool: vi.fn() };
    const server = createGatewayMcpServer({
      fixedKbId: "51adf856-2722-4a62-be49-b7d1f2cd20b4",
      fixedKbName: "镍基合金",
      upstream,
    });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "hybrid_search",
      "wiki_search",
      "wiki_read_page",
      "wiki_index_view",
    ]);
    expect(tools.tools[0]?.inputSchema.properties).not.toHaveProperty("kb_id");
  });

  it("injects the fixed KB when a downstream client calls a tool", async () => {
    const upstream = {
      callTool: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "result" }],
      })),
    };
    const server = createGatewayMcpServer({
      fixedKbId: "51adf856-2722-4a62-be49-b7d1f2cd20b4",
      fixedKbName: "镍基合金",
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
        kb_id: "51adf856-2722-4a62-be49-b7d1f2cd20b4",
        query: "晶界腐蚀",
        match_count: 5,
      },
    });
  });

  it("does not expose or execute an upstream delete tool", async () => {
    const upstream = { callTool: vi.fn() };
    const server = createGatewayMcpServer({
      fixedKbId: "51adf856-2722-4a62-be49-b7d1f2cd20b4",
      fixedKbName: "镍基合金",
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
