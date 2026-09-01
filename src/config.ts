import { isAbsolute } from "node:path";

import { z } from "zod";

const uuid = z.string().uuid();

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(18_194),
  PUBLIC_MCP_URL: z.string().url(),
  OAUTH_ISSUER: z.string().url(),
  OAUTH_JWKS_URL: z.string().url(),
  OAUTH_REQUIRED_SCOPE: z.string().min(1).default("weknora:mcp"),
  UPSTREAM_MCP_URL: z.string().url(),
  UPSTREAM_MCP_TOKEN_FILE: z.string().min(1),
  FALLBACK_KB_ID: uuid,
  FALLBACK_KB_NAME: z.string().min(1),
  MCP_ACCESS_POLICY_FILE: z
    .string()
    .min(1)
    .default("/var/lib/weknora-mcp-console/access-policy.json"),
  MCP_AUDIT_FILE: z
    .string()
    .min(1)
    .default("/var/lib/weknora-mcp-console/audit.ndjson"),
  ADMIN_IMPORT_ROOT: z.string().min(1),
  ALLOWED_ORIGINS: z.string().default(""),
  RATE_LIMIT_IP_PER_MINUTE: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_SUBJECT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  HTTP_BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(16_777_216)
    .default(16_777_216),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export interface GatewayConfig {
  host: string;
  port: number;
  publicMcpUrl: URL;
  oauthIssuer: URL;
  oauthJwksUrl: URL;
  oauthRequiredScope: string;
  upstreamMcpUrl: URL;
  upstreamMcpTokenFile: string;
  fallbackKbId: string;
  fallbackKbName: string;
  accessPolicyFile: string;
  auditFile: string;
  importRoot: string;
  allowedOrigins: string[];
  rateLimitIpPerMinute: number;
  rateLimitSubjectPerMinute: number;
  upstreamTimeoutMs: number;
  httpBodyLimitBytes: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

function requireHttps(name: string, url: URL): void {
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }
}

function isLoopback(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return new Set(["127.0.0.1", "localhost", "::1"]).has(host);
}

function requireLoopback(name: string, url: URL): void {
  if (!isLoopback(url)) {
    throw new Error(`${name} must use a loopback host`);
  }
}

function requireHttpsOrLoopback(name: string, url: URL): void {
  if (url.protocol !== "https:" && !isLoopback(url)) {
    throw new Error(`${name} must use HTTPS or a loopback host`);
  }
}

export function parseConfig(env: NodeJS.ProcessEnv | Record<string, string>): GatewayConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid gateway configuration: ${z.prettifyError(parsed.error)}`);
  }

  const publicMcpUrl = new URL(parsed.data.PUBLIC_MCP_URL);
  const oauthIssuer = new URL(parsed.data.OAUTH_ISSUER);
  const oauthJwksUrl = new URL(parsed.data.OAUTH_JWKS_URL);
  const upstreamMcpUrl = new URL(parsed.data.UPSTREAM_MCP_URL);

  requireHttps("PUBLIC_MCP_URL", publicMcpUrl);
  requireHttps("OAUTH_ISSUER", oauthIssuer);
  requireHttpsOrLoopback("OAUTH_JWKS_URL", oauthJwksUrl);
  requireLoopback("UPSTREAM_MCP_URL", upstreamMcpUrl);

  if (!isAbsolute(parsed.data.ADMIN_IMPORT_ROOT)) {
    throw new Error("ADMIN_IMPORT_ROOT must be an absolute path");
  }

  const config: GatewayConfig = {
    host: parsed.data.HOST,
    port: parsed.data.PORT,
    publicMcpUrl,
    oauthIssuer,
    oauthJwksUrl,
    oauthRequiredScope: parsed.data.OAUTH_REQUIRED_SCOPE,
    upstreamMcpUrl,
    upstreamMcpTokenFile: parsed.data.UPSTREAM_MCP_TOKEN_FILE,
    fallbackKbId: parsed.data.FALLBACK_KB_ID,
    fallbackKbName: parsed.data.FALLBACK_KB_NAME,
    accessPolicyFile: parsed.data.MCP_ACCESS_POLICY_FILE,
    auditFile: parsed.data.MCP_AUDIT_FILE,
    importRoot: parsed.data.ADMIN_IMPORT_ROOT,
    allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    rateLimitIpPerMinute: parsed.data.RATE_LIMIT_IP_PER_MINUTE,
    rateLimitSubjectPerMinute: parsed.data.RATE_LIMIT_SUBJECT_PER_MINUTE,
    upstreamTimeoutMs: parsed.data.UPSTREAM_TIMEOUT_MS,
    httpBodyLimitBytes: parsed.data.HTTP_BODY_LIMIT_BYTES,
    logLevel: parsed.data.LOG_LEVEL,
  };
  return config;
}
