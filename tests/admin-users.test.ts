import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { argon2id } from "hash-wasm";
import { describe, expect, it } from "vitest";

import {
  AdminUserError,
  FileAdminUserStore,
  keycloakArgon2ToPhc,
  LoginThrottle,
} from "../src/admin-users.js";
import { importKeycloakExport } from "../src/keycloak-import.js";
import { FileOAuthClientStore } from "../src/oauth-clients.js";

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "weknora-admin-users-"));
  const file = join(root, "admin-users.json");
  return { root, file, store: new FileAdminUserStore({ file }) };
}

/** A password credential as Keycloak 26 stores it with its default argon2 policy. */
async function keycloakCredential(password: string) {
  const salt = randomBytes(16);
  const hash = await argon2id({
    password,
    salt,
    iterations: 5,
    memorySize: 7_168,
    parallelism: 1,
    hashLength: 32,
    outputType: "binary",
  });
  return {
    credentialData: {
      hashIterations: 5,
      algorithm: "argon2",
      additionalParameters: {
        hashLength: ["32"],
        memory: ["7168"],
        type: ["id"],
        version: ["1.3"],
        parallelism: ["1"],
      },
    },
    secretData: {
      value: Buffer.from(hash).toString("base64"),
      salt: salt.toString("base64"),
      additionalParameters: {},
    },
  };
}

describe("console administrators", () => {
  it("stores argon2id hashes privately and verifies passwords", async () => {
    const { store, file } = await createStore();
    expect(await store.hasUsers()).toBe(false);
    await store.setPassword("aodo", "correct horse battery");

    const text = await readFile(file, "utf8");
    expect(text).toContain("$argon2id$");
    expect(text).not.toContain("correct horse battery");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const identity = await store.verify("aodo", "correct horse battery");
    expect(identity).toMatchObject({ username: "aodo", roles: ["weknora-admin"] });
    expect(await store.verify("aodo", "wrong password")).toBeUndefined();
    expect(await store.verify("nobody", "correct horse battery")).toBeUndefined();

    await store.setPassword("aodo", "another long password");
    expect((await store.verify("aodo", "another long password"))?.subject).toBe(identity?.subject);
    await expect(store.setPassword("aodo", "short")).rejects.toThrow(AdminUserError);
  });

  it("keeps Keycloak passwords and subjects working after the import", async () => {
    const { store } = await createStore();
    const credential = await keycloakCredential("keycloak password");
    expect(keycloakArgon2ToPhc(credential.credentialData, credential.secretData)).toMatch(
      /^\$argon2id\$v=19\$m=7168,t=5,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/,
    );
    expect(() => keycloakArgon2ToPhc({ algorithm: "pbkdf2-sha512" }, {})).toThrow(AdminUserError);

    const root = await mkdtemp(join(tmpdir(), "weknora-import-"));
    const clients = new FileOAuthClientStore({
      file: join(root, "oauth-clients.json"),
      issuer: "https://wek.uov.me/oauth/realms/weknora",
    });
    const result = await importKeycloakExport(
      {
        clients: [
          {
            clientId: "chatgpt-weknora-read",
            name: "ChatGPT WeKnora",
            secret: "chatgpt-secret",
            enabled: true,
            redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
          },
          {
            clientId: "gemini-weknora-571f26",
            name: null,
            secret: "gemini-secret",
            enabled: false,
            redirectUris: ["https://gemini.google.com/oauth/callback"],
          },
          { clientId: "weknora-mcp-console", secret: "internal", enabled: true },
          { clientId: "admin-cli", secret: "internal", enabled: true },
        ],
        users: [{ id: "kc-user-uuid", username: "aodo", ...credential }],
      },
      { clients, users: store },
    );

    expect(result).toEqual({
      clients: ["chatgpt-weknora-read", "gemini-weknora-571f26"],
      users: ["aodo"],
    });
    expect(await store.verify("aodo", "keycloak password")).toEqual({
      subject: "kc-user-uuid",
      username: "aodo",
      roles: ["weknora-admin"],
    });
    expect(await clients.authenticateClient("chatgpt-weknora-read", "chatgpt-secret")).toBeDefined();
    expect(await clients.listClients(["gemini-weknora-571f26", "weknora-mcp-console"])).toEqual([
      expect.objectContaining({ exists: true, enabled: false }),
      expect.objectContaining({ exists: false }),
    ]);
  });
});

describe("login throttle", () => {
  it("counts in-flight checks across addresses until each reservation is released", () => {
    let now = 0;
    const throttle = new LoginThrottle({ perIp: 1, global: 2, windowMs: 1_000, now: () => now });
    const releaseA = throttle.reserve("a");
    const releaseB = throttle.reserve("b");
    expect(releaseA).toEqual(expect.any(Function));
    expect(releaseB).toEqual(expect.any(Function));
    expect(throttle.reserve("a")).toBeUndefined();
    expect(throttle.reserve("c")).toBeUndefined();
    now = 1_001;
    expect(throttle.blocked("a")).toBe(true);
    releaseA!();
    releaseA!(); // A release is idempotent and cannot free another check's slot.
    expect(throttle.blocked("a")).toBe(false);
    expect(throttle.blocked("b")).toBe(true);
    const releaseC = throttle.reserve("c");
    expect(throttle.blocked("d")).toBe(true);
    throttle.fail("b");
    releaseB!();
    expect(throttle.blocked("b")).toBe(true);
    releaseC!();
    throttle.reset("b");
    expect(throttle.blocked("b")).toBe(false);
  });

  it("caps expensive password checks independently of the failure budget", () => {
    const throttle = new LoginThrottle({ perIp: 10, global: 50, windowMs: 60_000 });
    const releases = Array.from({ length: 4 }, (_, index) => throttle.reserve(`ip-${index}`));
    expect(releases.every((release) => typeof release === "function")).toBe(true);
    expect(throttle.reserve("another-ip")).toBeUndefined();
    releases[0]!();
    expect(throttle.reserve("another-ip")).toEqual(expect.any(Function));
  });

  it("limits failures per address and globally within a window", () => {
    let now = 0;
    const throttle = new LoginThrottle({ perIp: 2, global: 3, windowMs: 1_000, now: () => now });
    throttle.fail("a");
    expect(throttle.blocked("a")).toBe(false);
    throttle.fail("a");
    expect(throttle.blocked("a")).toBe(true);
    expect(throttle.blocked("b")).toBe(false);
    throttle.fail("b");
    expect(throttle.blocked("c")).toBe(true);
    now = 1_001;
    expect(throttle.blocked("a")).toBe(false);
    throttle.fail("a");
    throttle.reset("a");
    expect(throttle.blocked("a")).toBe(false);
  });
});
