import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import {
  parseKnowledgePolicy,
  type KnowledgeBaseChoice,
  type KnowledgePolicyActor,
} from "./knowledge-policy.js";

export const MCP_CAPABILITIES = [
  "knowledge.read",
  "conversation.use",
  "knowledge.write",
  "knowledge.manage",
  "agents.read",
  "models.manage",
  "tenants.manage",
] as const;

const capabilitySchema = z.enum(MCP_CAPABILITIES);
const knowledgeBaseChoiceSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
});
const managedClientSchema = z.strictObject({
  clientId: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  // Xiaomi, LobeHub and Codeg are legacy per-app token clients kept parseable.
  provider: z.enum(["ChatGPT", "Claude", "Token", "Xiaomi", "LobeHub", "Codeg"]),
});

const clientAccessPolicySchema = managedClientSchema
  .extend({
    accessType: z.enum(["capabilities", "full"]),
    capabilities: z.array(capabilitySchema),
    knowledgeBaseScope: z.enum(["all", "selected"]),
    defaultKbId: z.string().uuid(),
    knowledgeBases: z.array(knowledgeBaseChoiceSchema),
  })
  .superRefine((client, context) => {
    const capabilityIds = new Set(client.capabilities);
    if (capabilityIds.size !== client.capabilities.length) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Capability IDs must be unique",
      });
    }

    const knowledgeBaseIds = client.knowledgeBases.map(({ id }) => id);
    if (new Set(knowledgeBaseIds).size !== knowledgeBaseIds.length) {
      context.addIssue({
        code: "custom",
        path: ["knowledgeBases"],
        message: "Knowledge base IDs must be unique",
      });
    }

    if (client.accessType === "capabilities" && client.capabilities.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Capability access must grant at least one capability",
      });
    }
    if (client.accessType === "full" && client.knowledgeBaseScope !== "all") {
      context.addIssue({
        code: "custom",
        path: ["knowledgeBaseScope"],
        message: "Full access must use all knowledge bases",
      });
    }
    if (client.accessType === "full" && client.capabilities.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Full access must not contain capability overrides",
      });
    }
    if (
      client.knowledgeBaseScope === "selected" &&
      !knowledgeBaseIds.includes(client.defaultKbId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultKbId"],
        message: "Default knowledge base must be in the client allow-list",
      });
    }
    if (
      client.knowledgeBaseScope === "selected" &&
      client.knowledgeBases.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["knowledgeBases"],
        message: "Selected knowledge-base scope must not be empty",
      });
    }
  });

const mcpAccessPolicySchema = z
  .strictObject({
    version: z.literal(2),
    clients: z.array(clientAccessPolicySchema),
    updatedAt: z.string().datetime().optional(),
    updatedBy: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((policy, context) => {
    const clientIds = policy.clients.map(({ clientId }) => clientId);
    if (new Set(clientIds).size !== clientIds.length) {
      context.addIssue({
        code: "custom",
        path: ["clients"],
        message: "OAuth client IDs must be unique",
      });
    }
  });

export type McpCapabilityId = z.infer<typeof capabilitySchema>;
export type ManagedAccessClient = z.infer<typeof managedClientSchema>;
export type ClientAccessPolicy = z.infer<typeof clientAccessPolicySchema>;
export type McpAccessPolicy = z.infer<typeof mcpAccessPolicySchema>;
export type McpClientPolicyUpdate = Pick<
  ClientAccessPolicy,
  | "accessType"
  | "capabilities"
  | "knowledgeBaseScope"
  | "defaultKbId"
  | "knowledgeBases"
>;

export interface McpAccessPolicyProvider {
  read(): Promise<McpAccessPolicy>;
}

export class McpAccessPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAccessPolicyError";
  }
}

export function parseMcpAccessPolicy(value: unknown): McpAccessPolicy {
  const parsed = mcpAccessPolicySchema.safeParse(value);
  if (!parsed.success) {
    throw new McpAccessPolicyError(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

function migratedClient(
  client: ManagedAccessClient,
  defaultKbId: string,
  knowledgeBases: KnowledgeBaseChoice[],
): ClientAccessPolicy {
  return clientAccessPolicySchema.parse({
    ...client,
    accessType: "capabilities",
    capabilities: ["knowledge.read"],
    knowledgeBaseScope: "selected",
    defaultKbId,
    knowledgeBases,
  });
}

export type NewClientAccessPolicy = ClientAccessPolicy;

export class FileMcpAccessPolicyStore implements McpAccessPolicyProvider {
  private readonly policyFile: string;
  private readonly auditFile: string;
  private readonly fallbackKnowledgeBase: KnowledgeBaseChoice;
  private readonly defaultClients: ManagedAccessClient[];
  private readonly now: () => Date;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: {
    policyFile: string;
    auditFile: string;
    fallbackKnowledgeBase: KnowledgeBaseChoice;
    /** Clients created when migrating a version-1 policy or a missing file. */
    defaultClients: ManagedAccessClient[];
    now?: () => Date;
  }) {
    this.policyFile = options.policyFile;
    this.auditFile = options.auditFile;
    this.fallbackKnowledgeBase = knowledgeBaseChoiceSchema.parse(
      options.fallbackKnowledgeBase,
    );
    this.defaultClients = z.array(managedClientSchema).parse(options.defaultClients);
    this.now = options.now ?? (() => new Date());
  }

  get fallback(): KnowledgeBaseChoice {
    return this.fallbackKnowledgeBase;
  }

  async read(): Promise<McpAccessPolicy> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.policyFile, "utf8")) as unknown;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return this.migrate({
          version: 1,
          defaultKbId: this.fallbackKnowledgeBase.id,
          knowledgeBases: [this.fallbackKnowledgeBase],
        });
      }
      if (error instanceof SyntaxError) {
        throw new McpAccessPolicyError("MCP access policy file is not valid JSON");
      }
      throw error;
    }

    if (
      value &&
      typeof value === "object" &&
      "version" in value &&
      value.version === 1
    ) {
      return this.migrate(value);
    }
    return parseMcpAccessPolicy(value);
  }

  /** Read-only default access for a newly created client. */
  defaultAccess(client: ManagedAccessClient): ClientAccessPolicy {
    return migratedClient(client, this.fallbackKnowledgeBase.id, [this.fallbackKnowledgeBase]);
  }

  writeClient(
    clientId: string,
    update: McpClientPolicyUpdate,
    actor: KnowledgePolicyActor,
  ): Promise<McpAccessPolicy> {
    return this.mutate(actor, (clients) => {
      const index = clients.findIndex((client) => client.clientId === clientId);
      if (index < 0) {
        throw new McpAccessPolicyError(`OAuth client ${clientId} is not managed`);
      }
      const current = clients[index]!;
      clients[index] = clientAccessPolicySchema.parse({
        clientId: current.clientId,
        label: current.label,
        provider: current.provider,
        ...update,
      });
      return {
        action: "mcp_client_policy.updated",
        details: {
          clientId,
          accessType: clients[index]!.accessType,
          capabilities: clients[index]!.capabilities,
          knowledgeBaseScope: clients[index]!.knowledgeBaseScope,
          defaultKbId: clients[index]!.defaultKbId,
          knowledgeBaseIds: clients[index]!.knowledgeBases.map(({ id }) => id),
        },
      };
    });
  }

  addClients(
    entries: NewClientAccessPolicy[],
    actor: KnowledgePolicyActor,
  ): Promise<McpAccessPolicy> {
    return this.mutate(actor, (clients) => {
      for (const entry of entries) {
        if (clients.some(({ clientId }) => clientId === entry.clientId)) {
          throw new McpAccessPolicyError(`Client ${entry.clientId} already exists`);
        }
        clients.push(clientAccessPolicySchema.parse(entry));
      }
      return {
        action: "mcp_client.created",
        details: { clientIds: entries.map(({ clientId }) => clientId) },
      };
    });
  }

  removeClients(clientIds: string[], actor: KnowledgePolicyActor): Promise<McpAccessPolicy> {
    return this.mutate(actor, (clients) => {
      const removed = clients.filter(({ clientId }) => clientIds.includes(clientId));
      clients.splice(0, clients.length, ...clients.filter(({ clientId }) => !clientIds.includes(clientId)));
      return {
        action: "mcp_client.deleted",
        details: { clientIds: removed.map(({ clientId }) => clientId) },
      };
    });
  }

  renameClient(
    clientId: string,
    label: string,
    actor: KnowledgePolicyActor,
  ): Promise<McpAccessPolicy> {
    return this.mutate(actor, (clients) => {
      const client = clients.find((candidate) => candidate.clientId === clientId);
      if (!client) throw new McpAccessPolicyError(`OAuth client ${clientId} is not managed`);
      client.label = label.trim();
      return { action: "mcp_client.renamed", details: { clientId, label: client.label } };
    });
  }

  async appendAudit(
    action: string,
    actor: KnowledgePolicyActor,
    details: Record<string, unknown>,
  ): Promise<void> {
    const pending = this.writeTail.then(() =>
      this.appendAuditRecord({
        timestamp: this.now().toISOString(),
        action,
        actor,
        details,
      }),
    );
    this.writeTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
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
      throw new McpAccessPolicyError("MCP access-policy audit file is not valid");
    }
  }

  private migrate(value: unknown): McpAccessPolicy {
    const legacy = parseKnowledgePolicy(value);
    return parseMcpAccessPolicy({
      version: 2,
      clients: this.defaultClients.map((client) =>
        migratedClient(client, legacy.defaultKbId, legacy.knowledgeBases),
      ),
    });
  }

  private mutate(
    actor: KnowledgePolicyActor,
    change: (
      clients: ClientAccessPolicy[],
    ) => { action: string; details: Record<string, unknown> },
  ): Promise<McpAccessPolicy> {
    const pending = this.writeTail.then(async () => {
      const current = await this.read();
      const clients = current.clients.map((client) => ({ ...client }));
      const audit = change(clients);
      const timestamp = this.now().toISOString();
      const policy = parseMcpAccessPolicy({
        version: 2,
        clients,
        updatedAt: timestamp,
        updatedBy: actor.username,
      });
      const temporaryFile = `${this.policyFile}.tmp`;
      await mkdir(dirname(this.policyFile), { recursive: true, mode: 0o750 });
      await writeFile(temporaryFile, `${JSON.stringify(policy, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o640,
      });
      await rename(temporaryFile, this.policyFile);
      await this.appendAuditRecord({ timestamp, action: audit.action, actor, details: audit.details });
      return policy;
    });
    this.writeTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async appendAuditRecord(record: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.auditFile), { recursive: true, mode: 0o750 });
    await appendFile(this.auditFile, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o640,
    });
  }
}
