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
    expect(env).toContain(
      "OAUTH_TOKEN_URL=http://127.0.0.1:18195/oauth/realms/weknora/protocol/openid-connect/token",
    );
    expect(env).toContain("FALLBACK_KB_ID=");
    expect(env).toContain("MCP_ACCESS_POLICY_FILE=");
    expect(env).toContain("GATEWAY_HEALTH_URL=http://127.0.0.1:18194/readyz");
    expect(env).not.toContain("ADMIN_GATEWAY_HEALTH_URL");
    expect(service).not.toContain("weknora-mcp-admin-gateway");
    expect(env).toContain(
      "KEYCLOAK_SERVICE_CLIENT_SECRET_FILE=/etc/weknora-mcp-console/keycloak-admin-client-secret",
    );
  });

  it("publishes only the sidecar path and creates a static Keycloak client", async () => {
    const openresty = await readFile(
      "deploy/openresty/wek.uov.me-mcp.conf",
      "utf8",
    );
    const keycloak = await readFile(
      "deploy/scripts/configure-keycloak.sh",
      "utf8",
    );
    const keycloakEnv = await readFile("deploy/keycloak.env.example", "utf8");

    expect(openresty).toContain("location ^~ /mcp-console/");
    expect(openresty).toContain("proxy_pass http://127.0.0.1:18198");
    expect(openresty).not.toContain("sub_filter");
    expect(keycloak).toContain("weknora-mcp-console");
    expect(keycloak).toContain("'weknora:console' 'weknora-mcp-console'");
    expect(keycloak).toMatch(
      /configure_optional_client MCP-console[\s\S]*\$console_scope_id[\s\S]*weknora-admin/,
    );
    expect(keycloak).toContain("MCP_CONSOLE_CLIENT_SECRET");
    expect(keycloak).toContain("MCP_CONSOLE_ADMIN_CLIENT_SECRET");
    expect(keycloak).toContain("weknora-mcp-console-admin");
    expect(keycloak).toContain("manage-clients");
    expect(keycloak).toContain("manage-users");
    expect(keycloak).toContain("local created=false");
    expect(keycloak).toContain('if [[ "$created" == true ]]');
    expect(keycloak).toContain(
      'clients/$id/scope-mappings/clients/$realm_management_id',
    );
    expect(keycloakEnv).toContain(
      "MCP_CONSOLE_REDIRECT_URI=https://wek.uov.me/mcp-console/oauth/callback",
    );
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
    expect(installer).toContain("ensure_env_setting KEYCLOAK_ADMIN_URL");
    expect(installer).toContain(
      "ensure_env_setting KEYCLOAK_SERVICE_CLIENT_SECRET_FILE",
    );
    expect(installer).not.toMatch(/\/opt\/weknora(?:\/|\s)/);
    expect(installer).not.toMatch(/WeKnora-frontend|WeKnora-app/);
    expect(override).toContain("SupplementaryGroups=weknora-policy");
    expect(override).toContain("/opt/weknora-mcp-console/dist/src/index.js");
  });

  it("ships the WeKnora Keycloak login theme and selects it for the realm", async () => {
    const compose = await readFile("deploy/keycloak-compose.yml", "utf8");
    const script = await readFile("deploy/scripts/configure-keycloak.sh", "utf8");
    const properties = await readFile(
      "deploy/keycloak/themes/weknora/login/theme.properties",
      "utf8",
    );
    const css = await readFile(
      "deploy/keycloak/themes/weknora/login/resources/css/weknora.css",
      "utf8",
    );
    const messages = await readFile(
      "deploy/keycloak/themes/weknora/login/messages/messages_en.properties",
      "utf8",
    );

    expect(compose).toContain(
      "./keycloak/themes/weknora:/opt/keycloak/themes/weknora:ro",
    );
    expect(script).toContain("-s loginTheme=weknora");
    expect(properties).toContain("parent=keycloak.v2");
    expect(properties).toContain("styles=css/styles.css css/weknora.css");
    expect(css).toContain(".pf-v5-c-login");
    expect(messages).toContain("loginAccountTitle=欢迎回来");
  });
});
