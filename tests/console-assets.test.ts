import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("console assets", () => {
  it("contains the complete accessible management surface", async () => {
    const html = await readFile("console/index.html", "utf8");
    const css = await readFile("console/app.css", "utf8");
    const script = await readFile("console/app.js", "utf8");

    expect(html).toContain("WeKnora");
    expect(html).toContain("MCP 管理");
    expect(html).toContain('id="knowledge-list"');
    expect(html).toContain('id="service-status"');
    expect(html).toContain('id="audit-list"');
    expect(html).toContain('id="save-policy"');
    expect(html).toContain('id="confirm-dialog"');
    expect(html).toContain('aria-live="polite"');
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).not.toMatch(/linear-gradient|radial-gradient/i);
    expect(script).toContain("/mcp-console/api/session");
    expect(script).toContain("/mcp-console/api/overview");
    expect(script).toContain("/mcp-console/api/policy");
    expect(script).toContain("x-csrf-token");
    expect(`${html}${script}`).not.toMatch(/client.?secret|api.?key/i);
  });
});
