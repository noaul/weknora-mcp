import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.js";

const importRoot = resolve("weknora-import");
const validEnv = {
  HOST: "127.0.0.1",
  PORT: "18194",
  PUBLIC_MCP_URL: "https://wek.uov.me/mcp",
  OAUTH_ISSUER: "https://wek.uov.me/oauth/realms/weknora",
  OAUTH_JWKS_URL:
    "https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/certs",
  OAUTH_REQUIRED_SCOPE: "weknora:mcp",
  UPSTREAM_MCP_URL: "http://127.0.0.1:18193/mcp",
  UPSTREAM_MCP_TOKEN_FILE: "/run/secrets/upstream-token",
  FALLBACK_KB_ID: "51adf856-2722-4a62-be49-b7d1f2cd20b4",
  FALLBACK_KB_NAME: "镍基合金",
  MCP_ACCESS_POLICY_FILE: "/var/lib/weknora-mcp-console/access-policy.json",
  MCP_AUDIT_FILE: "/var/lib/weknora-mcp-console/audit.ndjson",
  ADMIN_IMPORT_ROOT: importRoot,
  ALLOWED_ORIGINS: "https://chatgpt.com,https://claude.ai",
  RATE_LIMIT_IP_PER_MINUTE: "120",
  RATE_LIMIT_SUBJECT_PER_MINUTE: "60",
  UPSTREAM_TIMEOUT_MS: "30000",
  LOG_LEVEL: "info",
};

describe("parseConfig", () => {
  it("parses the production configuration", () => {
    const config = parseConfig(validEnv);

    expect("gatewayMode" in config).toBe(false);
    expect(config.publicMcpUrl.href).toBe("https://wek.uov.me/mcp");
    expect(config.oauthRequiredScope).toBe("weknora:mcp");
    expect(config.allowedOrigins).toEqual([
      "https://chatgpt.com",
      "https://claude.ai",
    ]);
    expect(config.port).toBe(18194);
    expect(config.accessPolicyFile).toContain("access-policy.json");
    expect(config.importRoot).toBe(importRoot);
    expect(config.httpBodyLimitBytes).toBe(16_777_216);
  });

  it("always requires an absolute import root", () => {
    expect(() =>
      parseConfig({
        ...validEnv,
        ADMIN_IMPORT_ROOT: "relative/imports",
      }),
    ).toThrow(/ADMIN_IMPORT_ROOT.*absolute/i);
  });

  it("requires an import root", () => {
    const { ADMIN_IMPORT_ROOT: _removed, ...withoutImportRoot } = validEnv;
    expect(() =>
      parseConfig(withoutImportRoot),
    ).toThrow(/ADMIN_IMPORT_ROOT/i);
  });

  it("rejects a non-HTTPS public MCP URL", () => {
    expect(() =>
      parseConfig({ ...validEnv, PUBLIC_MCP_URL: "http://wek.uov.me/mcp" }),
    ).toThrow(/PUBLIC_MCP_URL.*HTTPS/i);
  });

  it("rejects a non-loopback upstream endpoint", () => {
    expect(() =>
      parseConfig({ ...validEnv, UPSTREAM_MCP_URL: "http://10.0.0.4:18193/mcp" }),
    ).toThrow(/UPSTREAM_MCP_URL.*loopback/i);
  });

  it("allows a loopback HTTP JWKS endpoint", () => {
    expect(
      parseConfig({
        ...validEnv,
        OAUTH_JWKS_URL:
          "http://127.0.0.1:18195/oauth/realms/weknora/protocol/openid-connect/certs",
      }).oauthJwksUrl.href,
    ).toContain("127.0.0.1:18195");
  });

  it("rejects a public HTTP JWKS endpoint", () => {
    expect(() =>
      parseConfig({
        ...validEnv,
        OAUTH_JWKS_URL: "http://keycloak.example/realms/weknora/certs",
      }),
    ).toThrow(/OAUTH_JWKS_URL.*HTTPS.*loopback/i);
  });

  it("rejects a malformed fallback knowledge-base id", () => {
    expect(() => parseConfig({ ...validEnv, FALLBACK_KB_ID: "nickel" })).toThrow(
      /FALLBACK_KB_ID/i,
    );
  });
});
