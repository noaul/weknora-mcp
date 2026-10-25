import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { argon2id, argon2Verify } from "hash-wasm";
import { z } from "zod";

import type { ConsoleIdentity } from "./console-auth.js";

/** The single role of a console administrator. */
export const ADMIN_ROLE = "weknora-admin";
export const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 256;

/** OWASP-recommended argon2id parameters (19 MiB, 2 passes). */
const ARGON2 = { memorySize: 19_456, iterations: 2, parallelism: 1, hashLength: 32 };

const userSchema = z.strictObject({
  id: z.string().min(1).max(200),
  username: z.string().trim().min(1).max(100),
  /** PHC-encoded argon2 hash. */
  passwordHash: z.string().regex(/^\$argon2(id|i|d)\$/),
  updatedAt: z.string().datetime(),
});

const usersFileSchema = z.strictObject({
  version: z.literal(1),
  users: z.array(userSchema),
});

type UsersFile = z.infer<typeof usersFileSchema>;

export class AdminUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminUserError";
  }
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new AdminUserError(
      `Password must contain ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`,
    );
  }
  return argon2id({
    password,
    salt: randomBytes(16),
    ...ARGON2,
    outputType: "encoded",
  });
}

const keycloakArgon2Schema = z.object({
  credentialData: z.object({
    algorithm: z.literal("argon2"),
    hashIterations: z.number().int().positive(),
    additionalParameters: z.object({
      type: z.tuple([z.enum(["id", "i", "d"])]),
      version: z.tuple([z.enum(["1.3", "1.0"])]),
      memory: z.tuple([z.string().regex(/^\d+$/)]),
      parallelism: z.tuple([z.string().regex(/^\d+$/)]),
    }),
  }),
  secretData: z.object({ value: z.string().min(1), salt: z.string().min(1) }),
});

/**
 * Converts a Keycloak argon2 password credential (its credential_data and
 * secret_data JSON) into a PHC string, so that the password keeps working.
 */
export function keycloakArgon2ToPhc(credentialData: unknown, secretData: unknown): string {
  const parsed = keycloakArgon2Schema.safeParse({ credentialData, secretData });
  if (!parsed.success) throw new AdminUserError("Unsupported Keycloak password credential");
  const { additionalParameters: params, hashIterations } = parsed.data.credentialData;
  const unpadded = (value: string) =>
    Buffer.from(value, "base64").toString("base64").replace(/=+$/, "");
  const version = params.version[0] === "1.3" ? 19 : 16;
  return [
    "",
    `argon2${params.type[0]}`,
    `v=${version}`,
    `m=${params.memory[0]},t=${hashIterations},p=${params.parallelism[0]}`,
    unpadded(parsed.data.secretData.salt),
    unpadded(parsed.data.secretData.value),
  ].join("$");
}

/** Console administrators; also the resource owners of the OAuth server. */
export class FileAdminUserStore {
  private readonly file: string;
  private readonly now: () => Date;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: { file: string; now?: () => Date }) {
    this.file = options.file;
    this.now = options.now ?? (() => new Date());
  }

  async hasUsers(): Promise<boolean> {
    return (await this.load()).users.length > 0;
  }

  /** Returns the identity for valid credentials, or undefined. */
  async verify(username: string, password: string): Promise<ConsoleIdentity | undefined> {
    if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return undefined;
    const user = (await this.load()).users.find(
      (candidate) => candidate.username === username.trim(),
    );
    // Hash anyway so that unknown usernames take as long as wrong passwords.
    const hash = user?.passwordHash ?? (await this.dummyHash());
    let valid = false;
    try {
      valid = await argon2Verify({ password, hash });
    } catch {
      valid = false;
    }
    if (!user || !valid) return undefined;
    return { subject: user.id, username: user.username, roles: [ADMIN_ROLE] };
  }

  /** Creates the user or replaces its password. */
  async setPassword(username: string, password: string): Promise<void> {
    await this.setHash(username, await hashPassword(password));
  }

  /** Stores an existing PHC hash, keeping a given subject id (used by imports). */
  async setHash(username: string, passwordHash: string, id?: string): Promise<void> {
    const name = username.trim();
    await this.update((data) => {
      const existing = data.users.find((user) => user.username === name);
      const record = userSchema.parse({
        id: id ?? existing?.id ?? randomUUID(),
        username: name,
        passwordHash,
        updatedAt: this.now().toISOString(),
      });
      data.users = data.users.filter((user) => user.username !== name);
      data.users.push(record);
    });
  }

  private dummy?: Promise<string>;

  private dummyHash(): Promise<string> {
    this.dummy ??= hashPassword(randomBytes(24).toString("base64url"));
    return this.dummy;
  }

  private async load(): Promise<UsersFile> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { version: 1, users: [] };
      }
      throw error;
    }
    const parsed = usersFileSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) throw new AdminUserError("Admin user file is not valid");
    return parsed.data;
  }

  private update(mutate: (data: UsersFile) => void): Promise<void> {
    const pending = this.writeTail.then(async () => {
      const data = await this.load();
      mutate(data);
      const temporaryFile = `${this.file}.tmp`;
      await mkdir(dirname(this.file), { recursive: true, mode: 0o750 });
      await writeFile(temporaryFile, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
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

/**
 * Failed-login throttle: a per-IP limit and a global limit that together slow
 * down password guessing from one or many addresses.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  private global: number[] = [];

  constructor(
    private readonly options: {
      perIp: number;
      global: number;
      windowMs: number;
      now?: () => number;
    } = { perIp: 10, global: 50, windowMs: 15 * 60_000 },
  ) {}

  blocked(ip: string): boolean {
    this.prune();
    return (
      (this.failures.get(ip)?.length ?? 0) >= this.options.perIp ||
      this.global.length >= this.options.global
    );
  }

  fail(ip: string): void {
    const now = this.now();
    this.failures.set(ip, [...(this.failures.get(ip) ?? []), now]);
    this.global.push(now);
  }

  reset(ip: string): void {
    this.failures.delete(ip);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private prune(): void {
    const cutoff = this.now() - this.options.windowMs;
    this.global = this.global.filter((time) => time > cutoff);
    for (const [ip, times] of this.failures) {
      const recent = times.filter((time) => time > cutoff);
      if (recent.length === 0) this.failures.delete(ip);
      else this.failures.set(ip, recent);
    }
  }
}
