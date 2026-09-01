import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ClientAccessPolicy,
  McpAccessPolicyProvider,
} from "../src/access-policy.js";
import { createUnifiedGatewayMcpServer } from "../src/unified-gateway-server.js";
import type { ToolCaller } from "../src/upstream-client.js";

const KB_A = "51adf856-2722-4a62-be49-b7d1f2cd20b4";
const KB_B = "0787e321-6f1e-4471-86a9-339165e51644";
const KB_C = "14f18c87-26b4-4b51-ac9f-cb57ace46df7";
const closeables: Array<{ close(): Promise<void> }> = [];

const selectedClient: ClientAccessPolicy = {
  clientId: "chatgpt-weknora-read",
  label: "ChatGPT",
  provider: "ChatGPT",
  accessType: "capabilities",
  capabilities: ["knowledge.read"],
  knowledgeBaseScope: "selected",
  defaultKbId: KB_A,
  knowledgeBases: [
    { id: KB_A, name: "镍基合金" },
    { id: KB_B, name: "GH3539" },
  ],
};

function policyProvider(client: ClientAccessPolicy): McpAccessPolicyProvider {
  return {
    read: async () => ({ version: 2, clients: [client] }),
  };
}

function tool(
  name: string,
  properties: Record<string, object> = {},
  required: string[] = [],
): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}

const reviewedTools: Tool[] = [
  tool("list_knowledge_bases"),
  tool("get_knowledge_base", { kb_id: { type: "string" } }, ["kb_id"]),
  tool(
    "hybrid_search",
    { kb_id: { type: "string" }, query: { type: "string" } },
    ["kb_id", "query"],
  ),
  tool("list_knowledge", { kb_id: { type: "string" } }, ["kb_id"]),
  tool("get_knowledge", { knowledge_id: { type: "string" } }, ["knowledge_id"]),
  tool(
    "create_knowledge_from_text",
    {
      kb_id: { type: "string" },
      title: { type: "string" },
      content: { type: "string" },
    },
    ["kb_id", "title", "content"],
  ),
  tool(
    "create_knowledge_from_file",
    { kb_id: { type: "string" }, file_path: { type: "string" } },
    ["kb_id", "file_path"],
  ),
  tool(
    "delete_chunk",
    { knowledge_id: { type: "string" }, chunk_id: { type: "string" } },
    ["knowledge_id", "chunk_id"],
  ),
  tool("list_chunks", { knowledge_id: { type: "string" } }, ["knowledge_id"]),
  tool(
    "wiki_search",
    { kb_id: { type: "string" }, query: { type: "string" } },
    ["kb_id", "query"],
  ),
  tool(
    "wiki_read_page",
    { kb_id: { type: "string" }, slug: { type: "string" } },
    ["kb_id", "slug"],
  ),
  tool("wiki_index_view", { kb_id: { type: "string" } }, ["kb_id"]),
];

async function connect(options: {
  client?: ClientAccessPolicy;
  tools?: Tool[];
  upstream?: ToolCaller;
  importRoot?: string;
}) {
  const upstream: ToolCaller = options.upstream ?? {
    callTool: vi.fn(async () => ({ content: [] })),
  };
  const server = createUnifiedGatewayMcpServer({
    clientId: options.client?.clientId ?? selectedClient.clientId,
    policy: policyProvider(options.client ?? selectedClient),
    tools: options.tools ?? reviewedTools,
    importRoot: options.importRoot ?? (await mkdtemp(join(tmpdir(), "weknora-import-"))),
    upstream,
  });
  const client = new Client({ name: "unified-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closeables.push(client, server);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, upstream };
}

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
});

describe("unified MCP gateway", () => {
  it("advertises only tools granted to a granular client", async () => {
    const { client } = await connect({});

    const listed = await client.listTools();
    const names = listed.tools.map(({ name }) => name);

    expect(names).toContain("list_allowed_knowledge_bases");
    expect(names).toContain("hybrid_search");
    expect(names).toContain("get_knowledge");
    expect(names).toContain("list_chunks");
    expect(names).not.toContain("list_knowledge_bases");
    expect(names).not.toContain("create_knowledge_from_text");
    expect(names).not.toContain("delete_chunk");
    expect(
      listed.tools.find(({ name }) => name === "hybrid_search")?.inputSchema
        .required,
    ).toEqual(["query"]);
  });

  it("advertises the complete reviewed baseline to a full-space client", async () => {
    const baseline = JSON.parse(
      await readFile("fixtures/upstream-admin-tools-baseline.json", "utf8"),
    ) as { tools: Tool[] };
    const fullClient: ClientAccessPolicy = {
      ...selectedClient,
      accessType: "full",
      capabilities: [],
      knowledgeBaseScope: "all",
      knowledgeBases: [],
    };
    const { client } = await connect({ client: fullClient, tools: baseline.tools });

    const listed = await client.listTools();

    expect(listed.tools.map(({ name }) => name)).toEqual([
      "list_allowed_knowledge_bases",
      ...baseline.tools.map(({ name }) => name),
    ]);
  });

  it("injects the configured default for optional retrieval kb_id", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "result" }],
    }));
    const { client } = await connect({ upstream: { callTool } });

    await client.callTool({
      name: "hybrid_search",
      arguments: { query: "GH3539" },
    });

    expect(callTool).toHaveBeenCalledWith({
      name: "hybrid_search",
      arguments: { kb_id: KB_A, query: "GH3539" },
    });
  });

  it("rejects a selected knowledge base outside the client scope", async () => {
    const callTool = vi.fn();
    const { client } = await connect({ upstream: { callTool } });

    const result = await client.callTool({
      name: "hybrid_search",
      arguments: { kb_id: KB_C, query: "salt" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/not allowed/i);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("rejects a tool when the client lacks its capability", async () => {
    const callTool = vi.fn();
    const { client } = await connect({ upstream: { callTool } });

    const result = await client.callTool({
      name: "create_knowledge_from_text",
      arguments: { kb_id: KB_A, title: "test", content: "content" },
    });

    expect(result.isError).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("preflights resource-ID tools against the allowed knowledge bases", async () => {
    const writer: ClientAccessPolicy = {
      ...selectedClient,
      capabilities: ["knowledge.write"],
    };
    const callTool = vi.fn(async ({ name }): Promise<CallToolResult> => {
      if (name === "get_knowledge") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ data: { knowledge_base_id: KB_C } }),
            },
          ],
        };
      }
      return { content: [{ type: "text", text: "deleted" }] };
    });
    const { client } = await connect({ client: writer, upstream: { callTool } });

    const result = await client.callTool({
      name: "delete_chunk",
      arguments: { knowledge_id: "knowledge-1", chunk_id: "chunk-1" },
    });

    expect(result.isError).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith({
      name: "get_knowledge",
      arguments: { knowledge_id: "knowledge-1" },
    });
  });

  it("allows every reviewed tool for full-space access without resource preflight", async () => {
    const fullClient: ClientAccessPolicy = {
      ...selectedClient,
      accessType: "full",
      capabilities: [],
      knowledgeBaseScope: "all",
      knowledgeBases: [],
    };
    const callTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "deleted" }],
    }));
    const { client } = await connect({ client: fullClient, upstream: { callTool } });

    const result = await client.callTool({
      name: "delete_chunk",
      arguments: { knowledge_id: "knowledge-1", chunk_id: "chunk-1" },
    });

    expect(result.isError).not.toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith({
      name: "delete_chunk",
      arguments: { knowledge_id: "knowledge-1", chunk_id: "chunk-1" },
    });
  });

  it("lists live knowledge bases for an all-scope client", async () => {
    const allClient: ClientAccessPolicy = {
      ...selectedClient,
      knowledgeBaseScope: "all",
      knowledgeBases: [],
    };
    const callTool = vi.fn(async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            data: [
              { id: KB_A, name: "镍基合金" },
              { id: KB_C, name: "熔盐堆" },
            ],
          }),
        },
      ],
    }));
    const { client } = await connect({ client: allClient, upstream: { callTool } });

    const result = await client.callTool({
      name: "list_allowed_knowledge_bases",
      arguments: {},
    });

    expect(JSON.stringify(result.content)).toContain("熔盐堆");
    expect(callTool).toHaveBeenCalledWith({
      name: "list_knowledge_bases",
      arguments: {},
    });
  });

  it("allows server-local file ingestion only inside the import root", async () => {
    const root = await mkdtemp(join(tmpdir(), "weknora-import-"));
    const allowedFile = join(root, "paper.pdf");
    await writeFile(allowedFile, "test");
    const writer: ClientAccessPolicy = {
      ...selectedClient,
      capabilities: ["knowledge.write"],
    };
    const callTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "created" }],
    }));
    const { client } = await connect({
      client: writer,
      upstream: { callTool },
      importRoot: root,
    });

    const allowed = await client.callTool({
      name: "create_knowledge_from_file",
      arguments: { kb_id: KB_A, file_path: allowedFile },
    });
    const rejected = await client.callTool({
      name: "create_knowledge_from_file",
      arguments: { kb_id: KB_A, file_path: join(root, "..", "secret.txt") },
    });

    expect(allowed.isError).not.toBe(true);
    expect(rejected.isError).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
