import { describe, expect, it } from "vitest";

import { parseConsoleConfig } from "../src/console-config.js";

const validEnv = {
  CONSOLE_HOST: "127.0.0.1",
  CONSOLE_PORT: "18198",
  CONSOLE_PUBLIC_URL: "https://wek.uov.me/mcp-console/",
  OAUTH_ISSUER: "https://wek.uov.me/oauth/realms/weknora",
  OAUTH_JWKS_URL:
    "http://127.0.0.1:18195/oauth/realms/weknora/protocol/openid-connect/certs",
  OAUTH_TOKEN_URL:
    "http://127.0.0.1:18195/oauth/realms/weknora/protocol/openid-connect/token",
  OAUTH_CLIENT_ID: "weknora-mcp-console",
  OAUTH_CLIENT_SECRET_FILE: "/run/secrets/oauth-client",
  OAUTH_REQUIRED_ROLE: "weknora-admin",
  SESSION_SECRET_FILE: "/run/secrets/session",
  KNOWLEDGE_POLICY_FILE: "/var/lib/weknora-mcp-console/knowledge-policy.json",
  KNOWLEDGE_AUDIT_FILE: "/var/lib/weknora-mcp-console/audit.ndjson",
  FALLBACK_KB_ID: "51adf856-2722-4a62-be49-b7d1f2cd20b4",
  FALLBACK_KB_NAME: "镍基合金",
  WEKNORA_API_URL: "http://127.0.0.1:18091/api/v1/",
  WEKNORA_API_KEY_FILE: "/run/secrets/weknora-key",
  READ_GATEWAY_HEALTH_URL: "http://127.0.0.1:18194/readyz",
  ADMIN_GATEWAY_HEALTH_URL: "http://127.0.0.1:18197/readyz",
};

describe("console configuration", () => {
  it("parses the production sidecar configuration", () => {
    const config = parseConsoleConfig(validEnv);

    expect(config.port).toBe(18198);
    expect(config.publicUrl.href).toBe("https://wek.uov.me/mcp-console/");
    expect(config.callbackUrl.href).toBe(
      "https://wek.uov.me/mcp-console/oauth/callback",
    );
    expect(config.requiredRole).toBe("weknora-admin");
    expect(config.tokenUrl.href).toBe(
      "http://127.0.0.1:18195/oauth/realms/weknora/protocol/openid-connect/token",
    );
    expect(config.fallbackKnowledgeBase.name).toBe("镍基合金");
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
        WEKNORA_API_URL: "http://10.0.0.4:18091/api/v1/",
      }),
    ).toThrow(/loopback/i);
    expect(() =>
      parseConsoleConfig({
        ...validEnv,
        OAUTH_TOKEN_URL:
          "http://10.0.0.4:18195/oauth/realms/weknora/protocol/openid-connect/token",
      }),
    ).toThrow(/loopback/i);
  });
});
