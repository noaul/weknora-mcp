import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("console deployment assets", () => {
  it("runs the console as a separate hardened loopback service", async () => {
    const service = await readFile(
      "deploy/systemd/weknora-mcp-console.service",
      "utf8",
    );
    const env = await readFile("deploy/systemd/console.env.example", "utf8");

    expect(service).toContain("User=weknora-console");
    expect(service).toContain("Group=weknora-policy");
    expect(env).toContain("CONSOLE_HOST=127.0.0.1");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("ReadWritePaths=/var/lib/weknora-mcp-console");
    expect(env).toContain("CONSOLE_PORT=18198");
    expect(env).toContain("CONSOLE_PUBLIC_URL=https://wek.uov.me/mcp-console/");
    expect(env).toContain("OAUTH_ISSUER=https://wek.uov.me/oauth/realms/weknora");
    expect(env).toContain("MCP_OAUTH_CLIENT_FILE=/var/lib/weknora-mcp-console/oauth-clients.json");
    expect(env).toContain("ADMIN_USERS_FILE=/var/lib/weknora-mcp-console/admin-users.json");
    expect(env).not.toMatch(/KEYCLOAK|18195/);
    expect(env).toContain("FALLBACK_KB_ID=");
    expect(env).toContain("MCP_ACCESS_POLICY_FILE=");
    expect(env).toContain("GATEWAY_HEALTH_URL=http://127.0.0.1:18194/readyz");
    expect(env).not.toContain("ADMIN_GATEWAY_HEALTH_URL");
    expect(service).not.toContain("weknora-mcp-admin-gateway");
  });

  it("routes the console and the embedded OAuth server without Keycloak", async () => {
    const openresty = await readFile(
      "deploy/openresty/wek.uov.me-mcp.conf",
      "utf8",
    );

    expect(openresty).toContain("location ^~ /mcp-console/");
    expect(openresty).toMatch(
      /location \^~ \/oauth\/realms\/weknora\/ \{\s*proxy_pass http:\/\/127\.0\.0\.1:18198;/,
    );
    expect(openresty).toMatch(
      /location = \/\.well-known\/oauth-authorization-server\/oauth\/realms\/weknora \{\s*proxy_pass http:\/\/127\.0\.0\.1:18198;/,
    );
    expect(openresty).toContain("location ^~ /oauth/ {\n    return 404;");
    expect(openresty).not.toContain("18195");
    expect(openresty).not.toContain("sub_filter");
  });

  it("migrates Keycloak clients and administrators through stdin only", async () => {
    const exporter = await readFile("deploy/scripts/export-keycloak.sh", "utf8");

    expect(exporter).toContain("not c.public_client");
    expect(exporter).toContain("kr.name = 'weknora-admin'");
    expect(exporter).toContain("dist/scripts/import-keycloak.js");
    expect(exporter).not.toMatch(/> *\S+\.json/);
  });

  it("installs shared policy access without modifying official WeKnora", async () => {
    const installer = await readFile("deploy/scripts/install-console.sh", "utf8");
    const override = await readFile(
      "deploy/systemd/weknora-mcp-access-gateway-policy.conf",
      "utf8",
    );

    expect(installer).toContain("weknora-policy");
    expect(installer).toContain('chmod -R a+rX "$repo_root"');
    expect(installer).toContain("/var/lib/weknora-mcp-console");
    expect(installer).toContain("/etc/weknora-mcp-console");
    expect(installer).toContain("install -o root -g root -m 0600");
    expect(installer).toContain("ensure_env_setting MCP_OAUTH_CLIENT_FILE");
    expect(installer).toContain("set-admin-password.js");
    expect(installer).not.toMatch(/KEYCLOAK/);
    expect(installer).not.toMatch(/\/opt\/weknora(?:\/|\s)/);
    expect(installer).not.toMatch(/WeKnora-frontend|WeKnora-app/);
    expect(override).toContain("SupplementaryGroups=weknora-policy");
    expect(override).toContain("/opt/weknora-mcp-console/dist/src/index.js");
  });
});
