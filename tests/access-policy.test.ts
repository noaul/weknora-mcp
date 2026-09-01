import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FileMcpAccessPolicyStore,
  McpAccessPolicyError,
  parseMcpAccessPolicy,
} from "../src/access-policy.js";

const KB_A = "51adf856-2722-4a62-be49-b7d1f2cd20b4";
const KB_B = "0787e321-6f1e-4471-86a9-339165e51644";

const defaultClients = [
  {
    clientId: "chatgpt-weknora-read",
    label: "ChatGPT",
    provider: "ChatGPT" as const,
  },
  {
    clientId: "claude-weknora-read",
    label: "Claude",
    provider: "Claude" as const,
  },
];

function granularPolicy() {
  return {
    version: 2,
    clients: [
      {
        clientId: "chatgpt-weknora-read",
        label: "ChatGPT",
        provider: "ChatGPT",
        accessType: "capabilities",
        capabilities: ["knowledge.read", "agents.read"],
        knowledgeBaseScope: "selected",
        defaultKbId: KB_A,
        knowledgeBases: [
          { id: KB_A, name: "镍基合金" },
          { id: KB_B, name: "GH3539" },
        ],
      },
    ],
  };
}

describe("MCP access policy", () => {
  it("parses a selected knowledge-base capability policy", () => {
    expect(parseMcpAccessPolicy(granularPolicy())).toMatchObject({
      version: 2,
      clients: [
        {
          accessType: "capabilities",
          capabilities: ["knowledge.read", "agents.read"],
          knowledgeBaseScope: "selected",
          defaultKbId: KB_A,
        },
      ],
    });
  });

  it("parses full-space access only with all knowledge bases", () => {
    expect(
      parseMcpAccessPolicy({
        version: 2,
        clients: [
          {
            clientId: "chatgpt-weknora-read",
            label: "ChatGPT",
            provider: "ChatGPT",
            accessType: "full",
            capabilities: [],
            knowledgeBaseScope: "all",
            defaultKbId: KB_A,
            knowledgeBases: [],
          },
        ],
      }).clients[0],
    ).toMatchObject({ accessType: "full", knowledgeBaseScope: "all" });
  });

  it("rejects duplicate clients and unsupported capabilities", () => {
    const duplicate = granularPolicy();
    const firstClient = duplicate.clients[0]!;
    duplicate.clients.push({
      clientId: firstClient.clientId,
      label: firstClient.label,
      provider: firstClient.provider,
      accessType: firstClient.accessType,
      capabilities: [...firstClient.capabilities],
      knowledgeBaseScope: firstClient.knowledgeBaseScope,
      defaultKbId: firstClient.defaultKbId,
      knowledgeBases: firstClient.knowledgeBases.map((knowledgeBase) => ({
        ...knowledgeBase,
      })),
    });
    expect(() => parseMcpAccessPolicy(duplicate)).toThrow(McpAccessPolicyError);

    const unsupported = granularPolicy();
    unsupported.clients[0]!.capabilities = ["knowledge.read", "members.manage"];
    expect(() => parseMcpAccessPolicy(unsupported)).toThrow(
      McpAccessPolicyError,
    );
  });

  it("requires a selected default knowledge base to be allowed", () => {
    const policy = granularPolicy();
    policy.clients[0]!.defaultKbId = "14f18c87-26b4-4b51-ac9f-cb57ace46df7";
    expect(() => parseMcpAccessPolicy(policy)).toThrow(
      /Default knowledge base must be in the client allow-list/,
    );
  });

  it("rejects full-space access with a selected knowledge-base scope", () => {
    const policy = granularPolicy();
    policy.clients[0]!.accessType = "full";
    policy.clients[0]!.capabilities = [];
    expect(() => parseMcpAccessPolicy(policy)).toThrow(
      /Full access must use all knowledge bases/,
    );
  });

  it("migrates the version-1 knowledge policy without granting write access", async () => {
    const root = await mkdtemp(join(tmpdir(), "weknora-access-policy-"));
    const policyFile = join(root, "policy.json");
    const auditFile = join(root, "audit.ndjson");
    await writeFile(
      policyFile,
      JSON.stringify({
        version: 1,
        defaultKbId: KB_A,
        knowledgeBases: [
          { id: KB_A, name: "镍基合金" },
          { id: KB_B, name: "GH3539" },
        ],
      }),
    );
    const store = new FileMcpAccessPolicyStore({
      policyFile,
      auditFile,
      fallbackKnowledgeBase: { id: KB_A, name: "镍基合金" },
      defaultClients,
    });

    const policy = await store.read();

    expect(policy.version).toBe(2);
    expect(policy.clients).toHaveLength(2);
    expect(policy.clients.map((client) => client.capabilities)).toEqual([
      ["knowledge.read"],
      ["knowledge.read"],
    ]);
    expect(policy.clients.every((client) => client.accessType === "capabilities"))
      .toBe(true);
  });

  it("atomically updates one client and writes a secret-free audit record", async () => {
    const root = await mkdtemp(join(tmpdir(), "weknora-access-policy-"));
    const policyFile = join(root, "policy.json");
    const auditFile = join(root, "audit.ndjson");
    const store = new FileMcpAccessPolicyStore({
      policyFile,
      auditFile,
      fallbackKnowledgeBase: { id: KB_A, name: "镍基合金" },
      defaultClients,
      now: () => new Date("2026-09-01T12:00:00.000Z"),
    });

    const updated = await store.writeClient(
      "chatgpt-weknora-read",
      {
        accessType: "capabilities",
        capabilities: ["knowledge.read", "knowledge.write"],
        knowledgeBaseScope: "selected",
        defaultKbId: KB_B,
        knowledgeBases: [{ id: KB_B, name: "GH3539" }],
      },
      { subject: "admin-1", username: "owner@example.com" },
    );

    expect(updated.clients[0]).toMatchObject({
      clientId: "chatgpt-weknora-read",
      capabilities: ["knowledge.read", "knowledge.write"],
      defaultKbId: KB_B,
    });
    expect(JSON.parse(await readFile(policyFile, "utf8"))).toMatchObject({
      version: 2,
      updatedBy: "owner@example.com",
    });
    const audit = await readFile(auditFile, "utf8");
    expect(audit).toContain("mcp_client_policy.updated");
    expect(audit).toContain("chatgpt-weknora-read");
    expect(audit).not.toContain("secret");
  });

  it("rejects updates for unmanaged OAuth clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "weknora-access-policy-"));
    const store = new FileMcpAccessPolicyStore({
      policyFile: join(root, "policy.json"),
      auditFile: join(root, "audit.ndjson"),
      fallbackKnowledgeBase: { id: KB_A, name: "镍基合金" },
      defaultClients,
    });

    await expect(
      store.writeClient(
        "unknown-client",
        {
          accessType: "full",
          capabilities: [],
          knowledgeBaseScope: "all",
          defaultKbId: KB_A,
          knowledgeBases: [],
        },
        { subject: "admin-1", username: "owner@example.com" },
      ),
    ).rejects.toThrow(/not managed/);
  });
});
