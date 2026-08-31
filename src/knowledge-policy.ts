import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

const knowledgeBaseChoiceSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
});

const knowledgePolicySchema = z
  .strictObject({
    version: z.literal(1),
    defaultKbId: z.string().uuid(),
    knowledgeBases: z.array(knowledgeBaseChoiceSchema).min(1),
    updatedAt: z.string().datetime().optional(),
    updatedBy: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((policy, context) => {
    const ids = policy.knowledgeBases.map((knowledgeBase) => knowledgeBase.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["knowledgeBases"],
        message: "Knowledge base IDs must be unique",
      });
    }
    if (!ids.includes(policy.defaultKbId)) {
      context.addIssue({
        code: "custom",
        path: ["defaultKbId"],
        message: "Default knowledge base must be in the allow-list",
      });
    }
  });

export type KnowledgeBaseChoice = z.infer<typeof knowledgeBaseChoiceSchema>;
export type KnowledgePolicy = z.infer<typeof knowledgePolicySchema>;

export interface KnowledgePolicyProvider {
  read(): Promise<KnowledgePolicy>;
}

export interface KnowledgePolicyActor {
  subject: string;
  username: string;
}

export interface KnowledgePolicyUpdate {
  defaultKbId: string;
  knowledgeBases: KnowledgeBaseChoice[];
}

export class KnowledgePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgePolicyError";
  }
}

export function parseKnowledgePolicy(value: unknown): KnowledgePolicy {
  const parsed = knowledgePolicySchema.safeParse(value);
  if (!parsed.success) {
    throw new KnowledgePolicyError(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

export class FileKnowledgePolicyStore implements KnowledgePolicyProvider {
  private readonly policyFile: string;
  private readonly auditFile: string;
  private readonly fallback: KnowledgeBaseChoice;
  private readonly now: () => Date;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: {
    policyFile: string;
    auditFile: string;
    fallback: KnowledgeBaseChoice;
    now?: () => Date;
  }) {
    this.policyFile = options.policyFile;
    this.auditFile = options.auditFile;
    this.fallback = knowledgeBaseChoiceSchema.parse(options.fallback);
    this.now = options.now ?? (() => new Date());
  }

  async read(): Promise<KnowledgePolicy> {
    try {
      return parseKnowledgePolicy(
        JSON.parse(await readFile(this.policyFile, "utf8")) as unknown,
      );
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return {
          version: 1,
          defaultKbId: this.fallback.id,
          knowledgeBases: [this.fallback],
        };
      }
      if (error instanceof KnowledgePolicyError) throw error;
      throw new KnowledgePolicyError("Knowledge policy file is not valid JSON");
    }
  }

  async write(
    update: KnowledgePolicyUpdate,
    actor: KnowledgePolicyActor,
  ): Promise<KnowledgePolicy> {
    const pending = this.writeTail.then(() => this.persist(update, actor));
    this.writeTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async persist(
    update: KnowledgePolicyUpdate,
    actor: KnowledgePolicyActor,
  ): Promise<KnowledgePolicy> {
    const timestamp = this.now().toISOString();
    const policy = parseKnowledgePolicy({
      version: 1,
      defaultKbId: update.defaultKbId,
      knowledgeBases: update.knowledgeBases,
      updatedAt: timestamp,
      updatedBy: actor.username,
    });
    const temporaryFile = `${this.policyFile}.tmp`;

    await mkdir(dirname(this.policyFile), { recursive: true, mode: 0o750 });
    await mkdir(dirname(this.auditFile), { recursive: true, mode: 0o750 });
    await writeFile(temporaryFile, `${JSON.stringify(policy, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o640,
    });
    await rename(temporaryFile, this.policyFile);
    await appendFile(
      this.auditFile,
      `${JSON.stringify({
        timestamp,
        action: "knowledge_policy.updated",
        actor,
        policy,
      })}\n`,
      { encoding: "utf8", mode: 0o640 },
    );
    return policy;
  }

  async readAudit(limit: number): Promise<unknown[]> {
    try {
      const lines = (await readFile(this.auditFile, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      return lines
        .slice(-Math.max(0, limit))
        .reverse()
        .map((line) => JSON.parse(line) as unknown);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw new KnowledgePolicyError("Knowledge policy audit file is not valid");
    }
  }
}
