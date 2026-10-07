import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AuthenticationError } from "../src/auth.js";
import {
  createCombinedTokenVerifier,
  FileStaticTokenStore,
  mcpClientConfig,
} from "../src/static-tokens.js";

function store() {
  const file = join(tmpdir(), `static-tokens-${randomUUID()}.json`);
  return { file, tokens: new FileStaticTokenStore({ file }) };
}

describe("static API key store", () => {
  it("issues each named key with its own client id and stores only hashes", async () => {
    const { file, tokens } = store();

    const phone = await tokens.createKey(" 小米手机 ");
    const codeg = await tokens.createKey("Codeg");

    expect(phone.token).toMatch(/^wkmcp_[A-Za-z0-9_-]{43}$/);
    expect(phone.key).toMatchObject({
      name: "小米手机",
      enabled: true,
      clientId: `apikey-${phone.key.id}`,
    });
    expect(codeg.key.clientId).not.toBe(phone.key.clientId);
    expect(await tokens.verify(phone.token)).toEqual({
      clientId: phone.key.clientId,
      keyId: phone.key.id,
      keyName: "小米手机",
    });
    expect(await tokens.verify(`${codeg.token}x`)).toBeUndefined();
    expect(await tokens.verify("not-a-static-token")).toBeUndefined();
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(phone.token);
    expect(text).not.toContain(codeg.token);
    expect((await tokens.listKeys()).map(({ name }) => name)).toEqual(["小米手机", "Codeg"]);
  });

  it("rotates, renames, disables, and deletes one key without affecting others", async () => {
    const { tokens } = store();
    const first = await tokens.createKey("LobeHub");
    const second = await tokens.createKey("Codeg");

    const rotated = await tokens.rotateKey(first.key.id);
    expect(rotated.key.clientId).toBe(first.key.clientId);
    expect(await tokens.verify(first.token)).toBeUndefined();
    expect(await tokens.verify(rotated.token)).toMatchObject({ clientId: first.key.clientId });

    await tokens.renameKey(first.key.id, "LobeHub 服务器");
    await tokens.setKeyEnabled(first.key.id, false);
    expect(await tokens.verify(rotated.token)).toBeUndefined();
    expect(await tokens.verify(second.token)).toBeDefined();
    await tokens.setKeyEnabled(first.key.id, true);
    expect(await tokens.verify(rotated.token)).toMatchObject({ keyName: "LobeHub 服务器" });

    expect(await tokens.deleteKey(first.key.id)).toEqual({ deleted: true });
    expect(await tokens.verify(rotated.token)).toBeUndefined();
    expect(await tokens.verify(second.token)).toBeDefined();
    expect(await tokens.deleteKey(first.key.id)).toEqual({ deleted: false });
    await expect(tokens.setKeyEnabled(first.key.id, true)).rejects.toThrow(/does not exist/);
  });

  it("reads a legacy per-app token file as named keys of the legacy client", async () => {
    const { file, tokens } = store();
    const legacyToken = "wkmcp_legacy-phone-token";
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        clients: {
          "xiaomi-weknora-token": {
            tokenSha256: createHash("sha256").update(legacyToken).digest("hex"),
            enabled: true,
            createdAt: "2026-10-07T01:11:19.467Z",
          },
        },
      }),
    );

    const [legacy] = await tokens.listKeys();
    expect(legacy).toMatchObject({ clientId: "xiaomi-weknora-token", name: "小米手机" });
    await tokens.reassignKey(legacy!.id, `apikey-${legacy!.id}`);

    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 2 });
    expect(await tokens.verify(legacyToken)).toMatchObject({
      clientId: `apikey-${legacy!.id}`,
      keyName: "小米手机",
    });
  });
});

describe("combined token verifier", () => {
  it("routes static keys to the store and others to OAuth", async () => {
    const { tokens } = store();
    const { token, key } = await tokens.createKey("小米手机");
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
      subject: `static-token:${key.clientId}:${key.id}`,
      clientId: key.clientId,
      scopes: ["weknora:mcp"],
    });
    await expect(verify("wkmcp_wrong")).rejects.toBeInstanceOf(AuthenticationError);
    await expect(verify("eyJ.jwt.token")).resolves.toMatchObject({
      clientId: "chatgpt-weknora-read",
    });
    expect(oauth).toHaveBeenCalledTimes(1);
  });

  it("builds a pasteable remote MCP configuration", () => {
    expect(mcpClientConfig("https://wek.uov.me/mcp", "wkmcp_abc")).toEqual({
      type: "http",
      url: "https://wek.uov.me/mcp",
      headers: { Authorization: "Bearer wkmcp_abc" },
    });
  });
});
