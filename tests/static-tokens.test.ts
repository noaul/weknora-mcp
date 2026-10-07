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

const CLIENT = "token-weknora";

function store() {
  const file = join(tmpdir(), `static-tokens-${randomUUID()}.json`);
  return { file, tokens: new FileStaticTokenStore({ file }) };
}

describe("static API key store", () => {
  it("issues named keys, stores only hashes, and verifies each key", async () => {
    const { file, tokens } = store();

    const phone = await tokens.createKey(CLIENT, " 小米手机 ");
    const codeg = await tokens.createKey(CLIENT, "Codeg");

    expect(phone.token).toMatch(/^wkmcp_[A-Za-z0-9_-]{43}$/);
    expect(phone.key).toMatchObject({ name: "小米手机", enabled: true });
    expect(await tokens.verify(phone.token)).toEqual({
      clientId: CLIENT,
      keyId: phone.key.id,
      keyName: "小米手机",
    });
    expect(await tokens.verify(codeg.token)).toMatchObject({ keyName: "Codeg" });
    expect(await tokens.verify(`${codeg.token}x`)).toBeUndefined();
    expect(await tokens.verify("not-a-static-token")).toBeUndefined();
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(phone.token);
    expect(text).not.toContain(codeg.token);
    expect((await tokens.listKeys(CLIENT)).map(({ name }) => name)).toEqual([
      "小米手机",
      "Codeg",
    ]);
  });

  it("disables and deletes one key without affecting the others", async () => {
    const { tokens } = store();
    const first = await tokens.createKey(CLIENT, "LobeHub");
    const second = await tokens.createKey(CLIENT, "Codeg");

    await tokens.setKeyEnabled(CLIENT, first.key.id, false);
    expect(await tokens.verify(first.token)).toBeUndefined();
    expect(await tokens.verify(second.token)).toBeDefined();
    await tokens.setKeyEnabled(CLIENT, first.key.id, true);
    expect(await tokens.verify(first.token)).toBeDefined();

    expect(await tokens.deleteKey(CLIENT, first.key.id)).toEqual({ deleted: true });
    expect(await tokens.verify(first.token)).toBeUndefined();
    expect(await tokens.verify(second.token)).toBeDefined();
    expect(await tokens.deleteKey(CLIENT, first.key.id)).toEqual({ deleted: false });
    await expect(tokens.setKeyEnabled(CLIENT, first.key.id, true)).rejects.toThrow(
      /does not exist/,
    );
  });

  it("migrates a legacy per-app token file into named keys of the merged client", async () => {
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

    expect(await tokens.verify(legacyToken)).toMatchObject({
      clientId: CLIENT,
      keyName: "小米手机",
    });
    const added = await tokens.createKey(CLIENT, "Codeg");
    const persisted = JSON.parse(await readFile(file, "utf8")) as { version: number };

    expect(persisted.version).toBe(2);
    expect(await tokens.verify(legacyToken)).toMatchObject({ keyName: "小米手机" });
    expect((await tokens.listKeys(CLIENT)).map(({ name }) => name)).toEqual([
      "小米手机",
      added.key.name,
    ]);
  });
});

describe("combined token verifier", () => {
  it("routes static keys to the store and others to OAuth", async () => {
    const { tokens } = store();
    const { token, key } = await tokens.createKey(CLIENT, "小米手机");
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
      subject: `static-token:${CLIENT}:${key.id}`,
      clientId: CLIENT,
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
