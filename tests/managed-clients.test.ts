import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileMcpAccessPolicyStore } from "../src/access-policy.js";
import { MANAGED_ACCESS_CLIENTS, migrateApiKeyClients } from "../src/managed-clients.js";
import { FileStaticTokenStore } from "../src/static-tokens.js";

const KB_A = "51adf856-2722-4a62-be49-b7d1f2cd20b4";

function access(clientId: string, label: string, provider: string, capabilities: string[]) {
  return {
    clientId,
    label,
    provider,
    accessType: "capabilities",
    capabilities,
    knowledgeBaseScope: "all",
    defaultKbId: KB_A,
    knowledgeBases: [],
  };
}

describe("API key client migration", () => {
  it("gives every legacy key its own client with the legacy access, then drops legacy entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "weknora-migration-"));
    const policyFile = join(root, "policy.json");
    const tokenFile = join(root, "tokens.json");
    const phoneToken = "wkmcp_phone-token-value";
    await writeFile(
      policyFile,
      JSON.stringify({
        version: 2,
        clients: [
          access("chatgpt-weknora-read", "ChatGPT", "ChatGPT", ["knowledge.read"]),
          access("xiaomi-weknora-token", "小米手机 WeKnora", "Xiaomi", [
            "knowledge.read",
            "agents.read",
          ]),
        ],
      }),
    );
    await writeFile(
      tokenFile,
      JSON.stringify({
        version: 1,
        clients: {
          "xiaomi-weknora-token": {
            tokenSha256: createHash("sha256").update(phoneToken).digest("hex"),
            enabled: true,
            createdAt: "2026-10-07T01:11:19.467Z",
          },
        },
      }),
    );
    const policyStore = new FileMcpAccessPolicyStore({
      policyFile,
      auditFile: join(root, "audit.ndjson"),
      fallbackKnowledgeBase: { id: KB_A, name: "镍基合金" },
      defaultClients: MANAGED_ACCESS_CLIENTS,
    });
    const tokenStore = new FileStaticTokenStore({ file: tokenFile });

    const result = await migrateApiKeyClients(policyStore, tokenStore);
    const match = await tokenStore.verify(phoneToken);
    const policy = await policyStore.read();

    expect(result).toEqual({ migratedKeys: 1, removedClients: ["xiaomi-weknora-token"] });
    expect(match?.clientId).toMatch(/^apikey-[0-9a-f]{12}$/);
    expect(policy.clients.map(({ clientId }) => clientId)).toEqual([
      "chatgpt-weknora-read",
      match!.clientId,
    ]);
    expect(policy.clients[1]).toMatchObject({
      label: "小米手机",
      provider: "Token",
      capabilities: ["knowledge.read", "agents.read"],
      knowledgeBaseScope: "all",
    });
    await expect(migrateApiKeyClients(policyStore, tokenStore)).resolves.toEqual({
      migratedKeys: 0,
      removedClients: [],
    });
  });
});
