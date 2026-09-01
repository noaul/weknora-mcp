import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("console assets", () => {
  it("contains the complete accessible management surface", async () => {
    const html = await readFile("console/index.html", "utf8");
    const css = await readFile("console/app.css", "utf8");
    const script = await readFile("console/app.js", "utf8");

    expect(html).toContain("WeKnora");
    expect(html).toContain("MCP 管理");
    expect(html).toContain('id="service-status"');
    expect(html).toContain('id="audit-list"');
    expect(html).toContain('id="oauth-client-list"');
    expect(html).toContain('id="oauth-secret-dialog"');
    expect(html).toContain("OAuth 客户端");
    expect(html).toContain("按能力授权");
    expect(html).toContain("全权限");
    expect(html).toContain("知识库范围");
    expect(html).toContain('aria-live="polite"');
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).not.toMatch(/linear-gradient|radial-gradient/i);
    expect(script).toContain("/mcp-console/api/session");
    expect(script).toContain("/mcp-console/api/overview");
    expect(script).toContain("/mcp-console/api/oauth-clients");
    expect(script).toContain("access-policy");
    expect(script).toContain("knowledge.read");
    expect(script).toContain("knowledge.manage");
    expect(script).toContain("models.manage");
    expect(script).toContain("rotate-secret");
    expect(script).toContain("revoke-sessions");
    expect(script).toContain("x-csrf-token");
    expect(`${html}${script}`).not.toContain("must-not-leak");
    expect(`${html}${script}`).not.toContain("mcp-admin");
    expect(`${html}${script}`).not.toContain("profile-badge");
  });
});
