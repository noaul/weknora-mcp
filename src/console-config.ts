import { z } from "zod";

const schema = z.object({
  CONSOLE_HOST: z.string().default("127.0.0.1"),
  CONSOLE_PORT: z.coerce.number().int().min(1).max(65_535).default(18_198),
  CONSOLE_PUBLIC_URL: z.string().url(),
  OAUTH_ISSUER: z.string().url(),
  OAUTH_JWKS_URL: z.string().url(),
  OAUTH_TOKEN_URL: z.string().url(),
  OAUTH_CLIENT_ID: z.string().min(1),
  OAUTH_CLIENT_SECRET_FILE: z.string().min(1),
  OAUTH_REQUIRED_ROLE: z.string().min(1).default("weknora-admin"),
  KEYCLOAK_ADMIN_URL: z.string().url(),
  KEYCLOAK_SERVICE_CLIENT_ID: z.string().min(1),
  KEYCLOAK_SERVICE_CLIENT_SECRET_FILE: z.string().min(1),
  SESSION_SECRET_FILE: z.string().min(1),
  MCP_ACCESS_POLICY_FILE: z.string().min(1),
  MCP_AUDIT_FILE: z.string().min(1),
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
  callbackUrl: URL;
  issuer: URL;
  jwksUrl: URL;
  tokenUrl: URL;
  clientId: string;
  clientSecretFile: string;
  requiredRole: string;
  keycloakAdminUrl: URL;
  keycloakServiceClientId: string;
  keycloakServiceClientSecretFile: string;
  sessionSecretFile: string;
  policyFile: string;
  auditFile: string;
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

function requireHttpsOrLoopback(name: string, url: URL): void {
  if (url.protocol === "https:") return;
  requireLoopback(name, url);
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
  const jwksUrl = new URL(parsed.data.OAUTH_JWKS_URL);
  const tokenUrl = new URL(parsed.data.OAUTH_TOKEN_URL);
  const keycloakAdminUrl = new URL(parsed.data.KEYCLOAK_ADMIN_URL);
  const weknoraApiUrl = new URL(parsed.data.WEKNORA_API_URL);
  const gatewayHealthUrl = new URL(parsed.data.GATEWAY_HEALTH_URL);

  requireHttps("CONSOLE_PUBLIC_URL", publicUrl);
  requireHttps("OAUTH_ISSUER", issuer);
  requireHttpsOrLoopback("OAUTH_JWKS_URL", jwksUrl);
  requireLoopback("OAUTH_TOKEN_URL", tokenUrl);
  requireLoopback("KEYCLOAK_ADMIN_URL", keycloakAdminUrl);
  requireLoopback("WEKNORA_API_URL", weknoraApiUrl);
  requireLoopback("GATEWAY_HEALTH_URL", gatewayHealthUrl);

  if (!publicUrl.pathname.endsWith("/")) {
    throw new Error("CONSOLE_PUBLIC_URL must end with /");
  }

  return {
    host: parsed.data.CONSOLE_HOST,
    port: parsed.data.CONSOLE_PORT,
    publicUrl,
    callbackUrl: new URL("oauth/callback", publicUrl),
    issuer,
    jwksUrl,
    tokenUrl,
    clientId: parsed.data.OAUTH_CLIENT_ID,
    clientSecretFile: parsed.data.OAUTH_CLIENT_SECRET_FILE,
    requiredRole: parsed.data.OAUTH_REQUIRED_ROLE,
    keycloakAdminUrl,
    keycloakServiceClientId: parsed.data.KEYCLOAK_SERVICE_CLIENT_ID,
    keycloakServiceClientSecretFile:
      parsed.data.KEYCLOAK_SERVICE_CLIENT_SECRET_FILE,
    sessionSecretFile: parsed.data.SESSION_SECRET_FILE,
    policyFile: parsed.data.MCP_ACCESS_POLICY_FILE,
    auditFile: parsed.data.MCP_AUDIT_FILE,
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
