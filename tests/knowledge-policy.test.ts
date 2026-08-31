import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FileKnowledgePolicyStore,
  KnowledgePolicyError,
  parseKnowledgePolicy,
} from "../src/knowledge-policy.js";

const KB_A = "51adf856-2722-4a62-be49-b7d1f2cd20b4";
const KB_B = "14f18c87-26b4-4b51-ac9f-cb57ace46df7";

describe("knowledge policy", () => {
  it("rejects duplicate knowledge bases and a default outside the allow-list", () => {
    expect(() =>
      parseKnowledgePolicy({
        version: 1,
        defaultKbId: KB_A,
        knowledgeBases: [
          { id: KB_A, name: "Alloy" },
          { id: KB_A, name: "Duplicate" },
        ],
      }),
    ).toThrow(KnowledgePolicyError);

    expect(() =>
      parseKnowledgePolicy({
        version: 1,
        defaultKbId: KB_B,
        knowledgeBases: [{ id: KB_A, name: "Alloy" }],
      }),
    ).toThrow(/default/i);
  });

  it("falls back to the legacy fixed knowledge base when no policy file exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "weknora-policy-"));
    const store = new FileKnowledgePolicyStore({
      policyFile: join(root, "missing", "policy.json"),
      auditFile: join(root, "audit.ndjson"),
      fallback: { id: KB_A, name: "Alloy" },
    });

    await expect(store.read()).resolves.toEqual({
      version: 1,
      defaultKbId: KB_A,
      knowledgeBases: [{ id: KB_A, name: "Alloy" }],
    });
  });

  it("writes policy atomically and appends an audit record", async () => {
    const root = await mkdtemp(join(tmpdir(), "weknora-policy-"));
    const policyFile = join(root, "state", "policy.json");
    const auditFile = join(root, "state", "audit.ndjson");
    const store = new FileKnowledgePolicyStore({
      policyFile,
      auditFile,
      fallback: { id: KB_A, name: "Alloy" },
      now: () => new Date("2026-08-31T15:00:00.000Z"),
    });

    const written = await store.write(
      {
        defaultKbId: KB_B,
        knowledgeBases: [
          { id: KB_A, name: "Alloy" },
          { id: KB_B, name: "Molten Salt" },
        ],
      },
      { subject: "user-1", username: "aodo" },
    );

    expect(written).toEqual({
      version: 1,
      defaultKbId: KB_B,
      knowledgeBases: [
        { id: KB_A, name: "Alloy" },
        { id: KB_B, name: "Molten Salt" },
      ],
      updatedAt: "2026-08-31T15:00:00.000Z",
      updatedBy: "aodo",
    });
    await expect(store.read()).resolves.toEqual(written);
    await expect(readFile(`${policyFile}.tmp`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const audit = JSON.parse((await readFile(auditFile, "utf8")).trim());
    expect(audit).toMatchObject({
      action: "knowledge_policy.updated",
      actor: { subject: "user-1", username: "aodo" },
      policy: written,
      timestamp: "2026-08-31T15:00:00.000Z",
    });
    await expect(store.readAudit(10)).resolves.toEqual([audit]);
  });

  it("rejects an invalid policy already present on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "weknora-policy-"));
    const policyFile = join(root, "state", "policy.json");
    await mkdir(join(root, "state"));
    await writeFile(
      policyFile,
      JSON.stringify({ version: 1, defaultKbId: KB_B, knowledgeBases: [] }),
    );
    const store = new FileKnowledgePolicyStore({
      policyFile,
      auditFile: join(root, "state", "audit.ndjson"),
      fallback: { id: KB_A, name: "Alloy" },
    });

    await expect(store.read()).rejects.toBeInstanceOf(KnowledgePolicyError);
  });

  it("serializes concurrent policy updates without losing audit records", async () => {
    const root = await mkdtemp(join(tmpdir(), "weknora-policy-"));
    const policyFile = join(root, "state", "policy.json");
    const auditFile = join(root, "state", "audit.ndjson");
    let tick = 0;
    const store = new FileKnowledgePolicyStore({
      policyFile,
      auditFile,
      fallback: { id: KB_A, name: "Alloy" },
      now: () => new Date(1_800_000_000_000 + tick++),
    });

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.write(
          {
            defaultKbId: index % 2 === 0 ? KB_A : KB_B,
            knowledgeBases: [
              { id: KB_A, name: "Alloy" },
              { id: KB_B, name: "Molten Salt" },
            ],
          },
          { subject: `user-${index}`, username: `operator-${index}` },
        ),
      ),
    );

    expect(await store.readAudit(20)).toHaveLength(12);
    await expect(store.read()).resolves.toMatchObject({ version: 1 });
  });
});
