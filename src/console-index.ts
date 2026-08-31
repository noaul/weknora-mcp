import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildConsoleApp } from "./console-app.js";
import { ConsoleOidcClient, ConsoleSessionStore } from "./console-auth.js";
import { parseConsoleConfig } from "./console-config.js";
import { FileKnowledgePolicyStore } from "./knowledge-policy.js";
import { WeKnoraApiClient } from "./weknora-api.js";

async function readSecret(path: string, name: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
}

async function healthStatus(url: URL): Promise<"healthy" | "unavailable"> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return response.ok ? "healthy" : "unavailable";
  } catch {
    return "unavailable";
  }
}

async function main(): Promise<void> {
  const config = parseConsoleConfig(process.env);
  const [clientSecret, sessionSecret, weknoraApiKey, indexHtml, appCss, appJs] =
    await Promise.all([
      readSecret(config.clientSecretFile, "OAuth client secret"),
      readSecret(config.sessionSecretFile, "Session secret"),
      readSecret(config.weknoraApiKeyFile, "WeKnora API key"),
      readFile(resolve("console/index.html"), "utf8"),
      readFile(resolve("console/app.css"), "utf8"),
      readFile(resolve("console/app.js"), "utf8"),
    ]);
  const issuer = config.issuer.toString().replace(/\/$/, "");
  const oidc = new ConsoleOidcClient({
    issuer,
    authorizationEndpoint: `${issuer}/protocol/openid-connect/auth`,
    tokenEndpoint: config.tokenUrl.toString(),
    jwksUrl: config.jwksUrl.toString(),
    clientId: config.clientId,
    clientSecret,
    callbackUrl: config.callbackUrl.toString(),
    requiredRole: config.requiredRole,
  });
  const sessions = new ConsoleSessionStore({
    ttlMs: 8 * 60 * 60_000,
    secret: Buffer.from(sessionSecret, "utf8"),
  });
  const policyStore = new FileKnowledgePolicyStore({
    policyFile: config.policyFile,
    auditFile: config.auditFile,
    fallback: config.fallbackKnowledgeBase,
  });
  const weknora = new WeKnoraApiClient({
    baseUrl: config.weknoraApiUrl,
    apiKey: weknoraApiKey,
  });
  const app = buildConsoleApp({
    publicUrl: config.publicUrl,
    oidc,
    sessions,
    policyStore,
    weknora,
    checkServices: async () => ({
      readGateway: await healthStatus(config.readGatewayHealthUrl),
      adminGateway: await healthStatus(config.adminGatewayHealthUrl),
    }),
    indexHtml,
    appCss,
    appJs,
    logLevel: config.logLevel,
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  await app.listen({ host: config.host, port: config.port });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
