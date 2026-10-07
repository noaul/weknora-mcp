import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AuthenticationError } from "../src/auth.js";
import {
  createCombinedTokenVerifier,
  FileStaticTokenStore,
} from "../src/static-tokens.js";

function store() {
  const file = join(tmpdir(), `static-tokens-${randomUUID()}.json`);
  return { file, tokens: new FileStaticTokenStore({ file }) };
}

describe("static token store", () => {
  it("stores only a hash and verifies the issued token", async () => {
    const { file, tokens } = store();

    const { token, replacedExisting } = await tokens.rotate("xiaomi-weknora-token");

    expect(replacedExisting).toBe(false);
    expect(await tokens.verify(token)).toBe("xiaomi-weknora-token");
    expect(await tokens.verify(`${token}x`)).toBeUndefined();
    expect(await tokens.verify("not-a-static-token")).toBeUndefined();
    expect(await readFile(file, "utf8")).not.toContain(token);
  });

  it("invalidates the previous token on rotation and honours disable/revoke", async () => {
    const { tokens } = store();
    const first = await tokens.rotate("xiaomi-weknora-token");
    const second = await tokens.rotate("xiaomi-weknora-token");

    expect(second.replacedExisting).toBe(true);
    expect(await tokens.verify(first.token)).toBeUndefined();
    expect(await tokens.verify(second.token)).toBe("xiaomi-weknora-token");

    await tokens.setEnabled("xiaomi-weknora-token", false);
    expect(await tokens.verify(second.token)).toBeUndefined();
    await tokens.setEnabled("xiaomi-weknora-token", true);
    expect(await tokens.verify(second.token)).toBe("xiaomi-weknora-token");

    expect(await tokens.revoke("xiaomi-weknora-token")).toEqual({ revoked: true });
    expect(await tokens.verify(second.token)).toBeUndefined();
  });

  it("refuses to toggle a client without a token", async () => {
    const { tokens } = store();
    await expect(tokens.setEnabled("xiaomi-weknora-token", true)).rejects.toThrow(
      /Generate a token/,
    );
  });
});

describe("combined token verifier", () => {
  it("routes static tokens to the store and others to OAuth", async () => {
    const { tokens } = store();
    const { token } = await tokens.rotate("xiaomi-weknora-token");
    const oauth = vi.fn(async () => ({
      subject: "user",
      clientId: "chatgpt-weknora-read",
      scopes: ["weknora:mcp"],
    }));
    const verify = createCombinedTokenVerifier({
      staticTokens: tokens,
      oauth,
      scope: "weknora:mcp",
    });

    await expect(verify(token)).resolves.toEqual({
      subject: "static-token:xiaomi-weknora-token",
      clientId: "xiaomi-weknora-token",
      scopes: ["weknora:mcp"],
    });
    await expect(verify("wkmcp_wrong")).rejects.toBeInstanceOf(AuthenticationError);
    await expect(verify("eyJ.jwt.token")).resolves.toMatchObject({
      clientId: "chatgpt-weknora-read",
    });
    expect(oauth).toHaveBeenCalledTimes(1);
  });
});
