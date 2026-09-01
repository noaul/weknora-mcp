import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("unified MCP deployment", () => {
  it("publishes one 16 MB MCP endpoint and no admin endpoint", async () => {
    const config = await readFile("deploy/openresty/wek.uov.me-mcp.conf", "utf8");

    expect(config).toContain("location = /mcp {");
    expect(config).toMatch(/location = \/mcp \{[\s\S]*client_max_body_size 16m;/);
    expect(config).toContain("proxy_buffer_size 16k");
    expect(config).not.toContain("/mcp-admin");
    expect(config).not.toContain("18197");
  });

  it("uses the unified gateway environment and one upstream", async () => {
    const gateway = await readFile("deploy/systemd/gateway.env.example", "utf8");
    const upstream = await readFile(
      "deploy/systemd/weknora-mcp-gateway.env.example",
      "utf8",
    );

    expect(gateway).toContain("OAUTH_REQUIRED_SCOPE=weknora:mcp");
    expect(gateway).toContain("MCP_ACCESS_POLICY_FILE=");
    expect(gateway).toContain("MCP_AUDIT_FILE=");
    expect(gateway).toContain("ADMIN_IMPORT_ROOT=/var/lib/weknora-mcp-import");
    expect(gateway).toContain("HTTP_BODY_LIMIT_BYTES=16777216");
    expect(gateway).not.toMatch(/GATEWAY_MODE|FIXED_KB|KNOWLEDGE_POLICY_FILE/);
    expect(upstream).toContain("WEKNORA_API_KEY=replace-with-tenant-api-key");
  });

  it("contains no obsolete admin systemd assets or ports", async () => {
    const files = await readdir("deploy/systemd");
    const text = await Promise.all(
      files.map((file) => readFile(`deploy/systemd/${file}`, "utf8")),
    );

    expect(files).not.toContain("weknora-mcp-admin-gateway.service");
    expect(files).not.toContain("weknora-mcp-admin-upstream.service");
    expect(files).not.toContain("admin-gateway.env.example");
    expect(text.join("\n")).not.toMatch(/18196|18197|\/mcp-admin/);
  });

  it("configures one MCP scope for two retained OAuth clients", async () => {
    const script = await readFile("deploy/scripts/configure-keycloak.sh", "utf8");
    const env = await readFile("deploy/keycloak.env.example", "utf8");

    expect(script).toContain("'weknora:mcp' 'https://wek.uov.me/mcp'");
    expect(script).toContain("chatgpt-weknora-read");
    expect(script).toContain("claude-weknora-read");
    expect(script).toContain("remove_obsolete_client");
    expect(script).not.toMatch(/read_scope_id|admin_scope_id/);
    expect(script.match(/'weknora:read'/g)).toHaveLength(3);
    expect(script.match(/'weknora:admin'/g)).toHaveLength(1);
    expect(env).not.toMatch(/CHATGPT_ADMIN|CLAUDE_ADMIN/);
  });

  it("probes only the unified MCP endpoint", async () => {
    const probe = await readFile("deploy/scripts/probe.sh", "utf8");

    expect(probe).toContain("oauth-protected-resource/mcp");
    expect(probe).toContain('POST "$base/mcp"');
    expect(probe).not.toContain("mcp-admin");
  });
});
