import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileSessionOwnershipStore } from "../src/session-ownership.js";

describe("file session ownership store", () => {
  it("records, persists, and forgets session owners", async () => {
    const file = join(tmpdir(), `sessions-${randomUUID()}.json`);
    const store = new FileSessionOwnershipStore({ file });

    expect(await store.owner("s1")).toBeUndefined();
    await Promise.all([store.record("s1", "client-a"), store.record("s2", "client-b")]);

    const reopened = new FileSessionOwnershipStore({ file });
    expect(await reopened.owner("s1")).toBe("client-a");
    expect(await reopened.owner("s2")).toBe("client-b");
    expect(await reopened.owner("__proto__")).toBeUndefined();

    await reopened.forget("s1");
    expect(await store.owner("s1")).toBeUndefined();
  });

  it("drops the oldest sessions beyond the retention limit", async () => {
    let tick = 0;
    const store = new FileSessionOwnershipStore({
      file: join(tmpdir(), `sessions-${randomUUID()}.json`),
      maxSessions: 2,
      now: () => new Date(Date.UTC(2026, 9, 7, 0, 0, tick++)),
    });

    for (const id of ["s1", "s2", "s3"]) await store.record(id, "client-a");

    expect(await store.owner("s1")).toBeUndefined();
    expect(await store.owner("s3")).toBe("client-a");
  });
});
