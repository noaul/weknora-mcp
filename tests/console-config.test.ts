import { describe, expect, it } from "vitest";

import { parseConsoleConfig } from "../src/console-config.js";

const validEnv = {
  CONSOLE_HOST: "127.0.0.1",
  CONSOLE_PORT: "18198",
  CONSOLE_PUBLIC_URL: "https://wek.uov.me/mcp-console/",
  OAUTH_ISSUER: "https://wek.uov.me/oauth/realms/weknora",
  SESSION_SECRET_FILE: "/run/secrets/session",
  MCP_ACCESS_POLICY_FILE: "/var/lib/weknora-mcp-console/access-policy.json",
  MCP_AUDIT_FILE: "/var/lib/weknora-mcp-console/audit.ndjson",
  FALLBACK_KB_ID: "51adf856-2722-4a62-be49-b7d1f2cd20b4",
  FALLBACK_KB_NAME: "镍基合金",
  WEKNORA_API_URL: "http://127.0.0.1:18091/api/v1/",
  WEKNORA_API_KEY_FILE: "/run/secrets/weknora-key",
  GATEWAY_HEALTH_URL: "http://127.0.0.1:18194/readyz",
};

describe("console configuration", () => {
  it("parses the production sidecar configuration", () => {
    const config = parseConsoleConfig(validEnv);

    expect(config.port).toBe(18198);
    expect(config.publicUrl.href).toBe("https://wek.uov.me/mcp-console/");
    expect(config.issuer.href).toBe("https://wek.uov.me/oauth/realms/weknora");
    expect(config.mcpUrl.href).toBe("https://wek.uov.me/mcp");
    expect(config.oauthClientFile).toBe("/var/lib/weknora-mcp-console/oauth-clients.json");
    expect(config.signingKeyFile).toBe("/var/lib/weknora-mcp-console/oauth-signing-key.json");
    expect(config.adminUsersFile).toBe("/var/lib/weknora-mcp-console/admin-users.json");
    expect(config.fallbackKnowledgeBase.name).toBe("镍基合金");
    expect(config.policyFile).toContain("access-policy.json");
    expect(config.gatewayHealthUrl.href).toBe("http://127.0.0.1:18194/readyz");
  });

  it("ignores the settings of the former Keycloak deployment", () => {
    const config = parseConsoleConfig({
      ...validEnv,
      OAUTH_JWKS_URL: "http://127.0.0.1:18195/oauth/realms/weknora/protocol/openid-connect/certs",
      OAUTH_CLIENT_ID: "weknora-mcp-console",
      KEYCLOAK_ADMIN_URL: "http://127.0.0.1:18195/oauth/admin/realms/weknora/",
    });
    expect(config.issuer.href).toBe("https://wek.uov.me/oauth/realms/weknora");
  });

  it("rejects public HTTP and non-loopback internal services", () => {
    expect(() =>
      parseConsoleConfig({
        ...validEnv,
        CONSOLE_PUBLIC_URL: "http://wek.uov.me/mcp-console/",
      }),
    ).toThrow(/HTTPS/i);
    expect(() =>
      parseConsoleConfig({
        ...validEnv,
        OAUTH_ISSUER: "http://wek.uov.me/oauth/realms/weknora",
      }),
    ).toThrow(/HTTPS/i);
    expect(() =>
      parseConsoleConfig({
        ...validEnv,
        WEKNORA_API_URL: "http://10.0.0.4:18091/api/v1/",
      }),
    ).toThrow(/loopback/i);
  });
});
