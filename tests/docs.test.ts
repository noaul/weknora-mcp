import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("unified MCP documentation", () => {
  it("documents one endpoint with per-client permissions and an internal Tenant API key", async () => {
    const files = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/client-setup.md", "utf8"),
      readFile("docs/operations.md", "utf8"),
    ]);
    const text = files.join("\n");

    expect(text).toContain("weknora:mcp");
    expect(text).toContain("Tenant API Key");
    expect(text).toContain("按能力");
    expect(text).toContain("全权限");
    expect(text).toContain("chatgpt-weknora-read");
    expect(text).toContain("claude-weknora-read");
    expect(text).not.toMatch(/\/mcp-admin|weknora:read|weknora:admin|18196|18197/);
  });
});
