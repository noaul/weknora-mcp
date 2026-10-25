import { describe, expect, it } from "vitest";

import { ConsoleSessionStore, SessionAuthorizationError } from "../src/console-auth.js";

describe("console sessions", () => {
  it("creates opaque expiring sessions and enforces CSRF", () => {
    let now = 1_000;
    const sessions = new ConsoleSessionStore({
      ttlMs: 60_000,
      now: () => now,
      secret: Buffer.alloc(32, 7),
    });
    const created = sessions.create({
      subject: "user-1",
      username: "aodo",
      roles: ["weknora-admin"],
    });

    expect(created.id).not.toContain("user-1");
    expect(sessions.get(created.id)?.username).toBe("aodo");
    expect(() => sessions.assertCsrf(created.id, "wrong")).toThrow(
      SessionAuthorizationError,
    );
    expect(() => sessions.assertCsrf(created.id, created.csrfToken)).not.toThrow();

    now += 60_001;
    expect(sessions.get(created.id)).toBeUndefined();
  });

  it("bounds authenticated sessions", () => {
    const sessions = new ConsoleSessionStore({
      ttlMs: 60_000,
      maxSessions: 1,
      secret: Buffer.alloc(32, 7),
    });
    const firstSession = sessions.create({
      subject: "user-1",
      username: "aodo",
      roles: ["weknora-admin"],
    });
    sessions.create({
      subject: "user-2",
      username: "operator",
      roles: ["weknora-admin"],
    });
    expect(sessions.get(firstSession.id)).toBeUndefined();
  });
});
