import { z } from "zod";

const schema = z.object({
  CONSOLE_HOST: z.string().default("127.0.0.1"),
  CONSOLE_PORT: z.coerce.number().int().min(1).max(65_535).default(18_198),
  CONSOLE_PUBLIC_URL: z.string().url(),
  OAUTH_ISSUER: z.string().url(),
  PUBLIC_MCP_URL: z.string().url().optional(),
  MCP_OAUTH_CLIENT_FILE: z
    .string()
    .min(1)
    .default("/var/lib/weknora-mcp-console/oauth-clients.json"),
  OAUTH_SIGNING_KEY_FILE: z
    .string()
    .min(1)
    .default("/var/lib/weknora-mcp-console/oauth-signing-key.json"),
  ADMIN_USERS_FILE: z
    .string()
    .min(1)
    .default("/var/lib/weknora-mcp-console/admin-users.json"),
  SESSION_SECRET_FILE: z.string().min(1),
  MCP_ACCESS_POLICY_FILE: z.string().min(1),
  MCP_AUDIT_FILE: z.string().min(1),
  MCP_STATIC_TOKEN_FILE: z
    .string()
    .min(1)
    .default("/var/lib/weknora-mcp-console/static-tokens.json"),
  FALLBACK_KB_ID: z.string().uuid(),
  FALLBACK_KB_NAME: z.string().min(1),
  WEKNORA_API_URL: z.string().url(),
  WEKNORA_API_KEY_FILE: z.string().min(1),
  GATEWAY_HEALTH_URL: z.string().url(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export interface ConsoleConfig {
  host: string;
  port: number;
  publicUrl: URL;
  issuer: URL;
  /** The protected MCP resource and audience of OAuth access tokens. */
  mcpUrl: URL;
  oauthClientFile: string;
  signingKeyFile: string;
  adminUsersFile: string;
  sessionSecretFile: string;
  policyFile: string;
  auditFile: string;
  staticTokenFile: string;
  fallbackKnowledgeBase: { id: string; name: string };
  weknoraApiUrl: URL;
  weknoraApiKeyFile: string;
  gatewayHealthUrl: URL;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

function requireHttps(name: string, url: URL): void {
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
}

function requireLoopback(name: string, url: URL): void {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) {
    throw new Error(`${name} must use a loopback host`);
  }
}

export function parseConsoleConfig(
  env: NodeJS.ProcessEnv | Record<string, string>,
): ConsoleConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid console configuration: ${z.prettifyError(parsed.error)}`);
  }
  const publicUrl = new URL(parsed.data.CONSOLE_PUBLIC_URL);
  const issuer = new URL(parsed.data.OAUTH_ISSUER);
  const mcpUrl = new URL(parsed.data.PUBLIC_MCP_URL ?? new URL("/mcp", publicUrl).toString());
  const weknoraApiUrl = new URL(parsed.data.WEKNORA_API_URL);
  const gatewayHealthUrl = new URL(parsed.data.GATEWAY_HEALTH_URL);

  requireHttps("CONSOLE_PUBLIC_URL", publicUrl);
  requireHttps("OAUTH_ISSUER", issuer);
  requireHttps("PUBLIC_MCP_URL", mcpUrl);
  requireLoopback("WEKNORA_API_URL", weknoraApiUrl);
  requireLoopback("GATEWAY_HEALTH_URL", gatewayHealthUrl);

  if (!publicUrl.pathname.endsWith("/")) {
    throw new Error("CONSOLE_PUBLIC_URL must end with /");
  }

  return {
    host: parsed.data.CONSOLE_HOST,
    port: parsed.data.CONSOLE_PORT,
    publicUrl,
    issuer,
    mcpUrl,
    oauthClientFile: parsed.data.MCP_OAUTH_CLIENT_FILE,
    signingKeyFile: parsed.data.OAUTH_SIGNING_KEY_FILE,
    adminUsersFile: parsed.data.ADMIN_USERS_FILE,
    sessionSecretFile: parsed.data.SESSION_SECRET_FILE,
    policyFile: parsed.data.MCP_ACCESS_POLICY_FILE,
    auditFile: parsed.data.MCP_AUDIT_FILE,
    staticTokenFile: parsed.data.MCP_STATIC_TOKEN_FILE,
    fallbackKnowledgeBase: {
      id: parsed.data.FALLBACK_KB_ID,
      name: parsed.data.FALLBACK_KB_NAME,
    },
    weknoraApiUrl,
    weknoraApiKeyFile: parsed.data.WEKNORA_API_KEY_FILE,
    gatewayHealthUrl,
    logLevel: parsed.data.LOG_LEVEL,
  };
}
