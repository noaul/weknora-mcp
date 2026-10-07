import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

/**
 * WeKnora sessions are not bound to a knowledge base (since v0.8), so the
 * gateway cannot scope them by knowledge base. Instead it remembers which
 * OAuth client created each session; capability-mode clients may only use
 * sessions they own.
 */
export interface SessionOwnershipStore {
  owner(sessionId: string): Promise<string | undefined>;
  owned(clientId: string): Promise<Set<string>>;
  record(sessionId: string, clientId: string): Promise<void>;
  forget(sessionId: string): Promise<void>;
}

const ownershipFileSchema = z.strictObject({
  version: z.literal(1),
  sessions: z.record(
    z.string().min(1),
    z.strictObject({
      clientId: z.string().min(1),
      createdAt: z.string().datetime(),
    }),
  ),
});

type OwnershipFile = z.infer<typeof ownershipFileSchema>;

export class FileSessionOwnershipStore implements SessionOwnershipStore {
  private readonly file: string;
  private readonly maxSessions: number;
  private readonly now: () => Date;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: { file: string; maxSessions?: number; now?: () => Date }) {
    this.file = options.file;
    this.maxSessions = options.maxSessions ?? 10_000;
    this.now = options.now ?? (() => new Date());
  }

  async owner(sessionId: string): Promise<string | undefined> {
    const data = await this.load();
    return Object.hasOwn(data.sessions, sessionId)
      ? data.sessions[sessionId]!.clientId
      : undefined;
  }

  async owned(clientId: string): Promise<Set<string>> {
    const data = await this.load();
    return new Set(
      Object.entries(data.sessions)
        .filter(([, record]) => record.clientId === clientId)
        .map(([id]) => id),
    );
  }

  record(sessionId: string, clientId: string): Promise<void> {
    return this.update((data) => {
      data.sessions[sessionId] = { clientId, createdAt: this.now().toISOString() };
      const entries = Object.entries(data.sessions);
      if (entries.length > this.maxSessions) {
        entries
          .sort(([, left], [, right]) => left.createdAt.localeCompare(right.createdAt))
          .slice(0, entries.length - this.maxSessions)
          .forEach(([id]) => delete data.sessions[id]);
      }
    });
  }

  forget(sessionId: string): Promise<void> {
    return this.update((data) => {
      delete data.sessions[sessionId];
    });
  }

  private async load(): Promise<OwnershipFile> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { version: 1, sessions: {} };
      }
      throw error;
    }
    return ownershipFileSchema.parse(JSON.parse(text) as unknown);
  }

  private update(mutate: (data: OwnershipFile) => void): Promise<void> {
    const pending = this.writeTail.then(async () => {
      const data = await this.load();
      mutate(data);
      const temporaryFile = `${this.file}.tmp`;
      await mkdir(dirname(this.file), { recursive: true, mode: 0o750 });
      await writeFile(temporaryFile, `${JSON.stringify(data)}\n`, {
        encoding: "utf8",
        mode: 0o640,
      });
      await rename(temporaryFile, this.file);
    });
    this.writeTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

export class MemorySessionOwnershipStore implements SessionOwnershipStore {
  private readonly sessions = new Map<string, string>();

  async owner(sessionId: string): Promise<string | undefined> {
    return this.sessions.get(sessionId);
  }

  async owned(clientId: string): Promise<Set<string>> {
    return new Set(
      [...this.sessions].filter(([, owner]) => owner === clientId).map(([id]) => id),
    );
  }

  async record(sessionId: string, clientId: string): Promise<void> {
    this.sessions.set(sessionId, clientId);
  }

  async forget(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
