import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { GatewayConfig } from "../src/config.js";

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
});

const adminTools: Tool[] = [
  {
    name: "list_knowledge_bases",
    description: "List all knowledge bases.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "delete_knowledge",
    description: "Delete a knowledge entry.",
    inputSchema: {
      type: "object",
      properties: { knowledge_id: { type: "string" } },
      required: ["knowledge_id"],
    },
  },
  {
    name: "create_knowledge_from_file",
    description: "Create knowledge from a server-local file.",
    inputSchema: {
      type: "object",
      properties: {
        kb_id: { type: "string" },
        file_path: { type: "string" },
      },
      required: ["kb_id", "file_path"],
    },
  },
  {
    name: "create_knowledge_from_text",
    description: "Create knowledge from Markdown text.",
    inputSchema: {
      type: "object",
      properties: {
        kb_id: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
      },
      required: ["kb_id", "title", "content"],
    },
  },
];

async function connectAdmin(
  upstream: { callTool: ReturnType<typeof vi.fn> },
  importRoot: string,
) {
  const config = {
    gatewayMode: "admin",
    host: "127.0.0.1",
    port: 18197,
    publicMcpUrl: new URL("https://wek.uov.me/mcp-admin"),
    oauthIssuer: new URL("https://wek.uov.me/oauth/realms/weknora"),
    oauthJwksUrl: new URL(
      "https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/certs",
    ),
    oauthRequiredScope: "weknora:admin",
    upstreamMcpUrl: new URL("http://127.0.0.1:18196/mcp"),
    upstreamMcpTokenFile: "/run/secrets/admin-token",
    fixedKbId: "51adf856-2722-4a62-be49-b7d1f2cd20b4",
    fixedKbName: "镍基合金",
    knowledgePolicyFile: "/var/lib/weknora-mcp-console/knowledge-policy.json",
    knowledgeAuditFile: "/var/lib/weknora-mcp-console/audit.ndjson",
    adminImportRoot: importRoot,
    allowedOrigins: [],
    rateLimitIpPerMinute: 120,
    rateLimitSubjectPerMinute: 60,
    upstreamTimeoutMs: 30_000,
    httpBodyLimitBytes: 2_097_152,
    logLevel: "silent",
  } as GatewayConfig;

  const app = buildApp({
    config,
    verifyToken: vi.fn(async () => ({
      subject: "admin-1",
      clientId: "admin-client",
      scopes: ["weknora:admin"],
    })),
    upstream,
    adminTools,
  } as Parameters<typeof buildApp>[0]);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");

  const client = new Client({ name: "admin-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp-admin`),
    { requestInit: { headers: { Authorization: "Bearer valid-admin" } } },
  );
  await client.connect(transport);
  closeables.push(client, app);
  return client;
}

describe("admin MCP gateway", () => {
  it("advertises the reviewed admin tools with destructive annotations", async () => {
    const root = await mkdtemp(join(tmpdir(), "weknora-admin-"));
    const client = await connectAdmin({ callTool: vi.fn() }, root);

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual(
      adminTools.map((tool) => tool.name),
    );
    expect(
      tools.tools.find((tool) => tool.name === "delete_knowledge")?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("forwards approved admin calls without changing their arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "weknora-admin-"));
    const callTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "[]" }],
    }));
    const client = await connectAdmin({ callTool }, root);

    await client.callTool({ name: "list_knowledge_bases", arguments: {} });

    expect(callTool).toHaveBeenCalledWith({
      name: "list_knowledge_bases",
      arguments: {},
    });
  });

  it("allows local-file ingestion only inside the configured import root", async () => {
    const root = await mkdtemp(join(tmpdir(), "weknora-admin-"));
    const allowedFile = join(root, "paper.pdf");
    await writeFile(allowedFile, "test");
    const callTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "created" }],
    }));
    const client = await connectAdmin({ callTool }, root);

    const allowed = await client.callTool({
      name: "create_knowledge_from_file",
      arguments: { kb_id: "kb-1", file_path: allowedFile },
    });
    const rejected = await client.callTool({
      name: "create_knowledge_from_file",
      arguments: { kb_id: "kb-1", file_path: join(root, "..", "secret.txt") },
    });

    expect(allowed.isError).not.toBe(true);
    expect(rejected.isError).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("does not execute tools outside the reviewed admin baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "weknora-admin-"));
    const callTool = vi.fn();
    const client = await connectAdmin({ callTool }, root);

    const result = await client.callTool({
      name: "future_unreviewed_tool",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("accepts large Markdown payloads up to the configured admin limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "weknora-admin-"));
    const callTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "created" }],
    }));
    const client = await connectAdmin({ callTool }, root);
    const content = "x".repeat(1_100_000);

    const result = await client.callTool({
      name: "create_knowledge_from_text",
      arguments: { kb_id: "kb-1", title: "large", content },
    });

    expect(result.isError).not.toBe(true);
    expect(callTool).toHaveBeenCalledWith({
      name: "create_knowledge_from_text",
      arguments: { kb_id: "kb-1", title: "large", content },
    });
  });
});
