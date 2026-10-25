import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { FileMcpAccessPolicyStore } from "./access-policy.js";
import { FileAdminUserStore, LoginThrottle } from "./admin-users.js";
import { buildConsoleApp } from "./console-app.js";
import { ConsoleSessionStore } from "./console-auth.js";
import { parseConsoleConfig } from "./console-config.js";
import { MANAGED_ACCESS_CLIENTS, migrateApiKeyClients } from "./managed-clients.js";
import { FileOAuthClientStore } from "./oauth-clients.js";
import { loadOrCreateSigningKey } from "./oauth-server.js";
import { FileStaticTokenStore } from "./static-tokens.js";
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
  const [sessionSecret, weknoraApiKey, indexHtml, appCss, appJs, loginCss, signingKey] =
    await Promise.all([
      readSecret(config.sessionSecretFile, "Session secret"),
      readSecret(config.weknoraApiKeyFile, "WeKnora API key"),
      readFile(resolve("console/index.html"), "utf8"),
      readFile(resolve("console/app.css"), "utf8"),
      readFile(resolve("console/app.js"), "utf8"),
      readFile(resolve("console/login.css"), "utf8"),
      loadOrCreateSigningKey(config.signingKeyFile),
    ]);
  const issuer = config.issuer.toString().replace(/\/$/, "");
  const derive = (label: string) =>
    createHmac("sha256", sessionSecret).update(label).digest();
  const users = new FileAdminUserStore({ file: config.adminUsersFile });
  if (!(await users.hasUsers())) {
    console.warn(
      "No console administrator exists; run `node dist/scripts/set-admin-password.js <username>`",
    );
  }
  const throttle = new LoginThrottle();
  const sessions = new ConsoleSessionStore({
    ttlMs: 8 * 60 * 60_000,
    secret: Buffer.from(sessionSecret, "utf8"),
  });
  const accessPolicyStore = new FileMcpAccessPolicyStore({
    policyFile: config.policyFile,
    auditFile: config.auditFile,
    fallbackKnowledgeBase: config.fallbackKnowledgeBase,
    defaultClients: MANAGED_ACCESS_CLIENTS,
  });
  const staticTokens = new FileStaticTokenStore({ file: config.staticTokenFile });
  const migration = await migrateApiKeyClients(accessPolicyStore, staticTokens);
  if (migration.migratedKeys > 0 || migration.removedClients.length > 0) {
    console.log(
      `Migrated ${migration.migratedKeys} API key(s) to per-key clients; removed ${migration.removedClients.join(", ") || "none"}`,
    );
  }
  const weknora = new WeKnoraApiClient({
    baseUrl: config.weknoraApiUrl,
    apiKey: weknoraApiKey,
  });
  const oauthClientManager = new FileOAuthClientStore({
    file: config.oauthClientFile,
    issuer,
  });
  const app = buildConsoleApp({
    publicUrl: config.publicUrl,
    mcpUrl: config.mcpUrl,
    login: { users, throttle, formSecret: derive("console-login-form") },
    oauthServer: {
      issuer,
      resource: config.mcpUrl.toString(),
      clients: oauthClientManager,
      users,
      throttle,
      signingKey,
      formSecret: derive("oauth-authorize-form"),
    },
    sessions,
    accessPolicyStore,
    oauthClientManager,
    staticTokens,
    weknora,
    checkServices: async () => ({
      gateway: await healthStatus(config.gatewayHealthUrl),
    }),
    indexHtml,
    appCss,
    appJs,
    loginCss,
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
