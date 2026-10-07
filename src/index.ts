import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { FileMcpAccessPolicyStore } from "./access-policy.js";
import { createRemoteJwtAccessTokenVerifier } from "./auth.js";
import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";
import { ACCESS_POLICY_INHERITANCE, MANAGED_ACCESS_CLIENTS } from "./managed-clients.js";
import { retry } from "./retry.js";
import { FileSessionOwnershipStore } from "./session-ownership.js";
import { createCombinedTokenVerifier, FileStaticTokenStore } from "./static-tokens.js";
import { selectBaselineTools, type ToolBaseline } from "./tool-baseline.js";
import { OfficialWeKnoraMcpClient } from "./upstream-client.js";

async function main(): Promise<void> {
  const config = parseConfig(process.env);
  const upstreamToken = (
    await readFile(config.upstreamMcpTokenFile, "utf8")
  ).trim();
  if (upstreamToken.length < 32) {
    throw new Error("Upstream MCP token must contain at least 32 characters");
  }

  const upstream = new OfficialWeKnoraMcpClient({
    url: config.upstreamMcpUrl,
    token: upstreamToken,
    timeoutMs: config.upstreamTimeoutMs,
  });
  await retry(() => upstream.connect(), { attempts: 12, delayMs: 1_000 });

  const baseline = JSON.parse(
    await readFile(resolve("fixtures/upstream-admin-tools-baseline.json"), "utf8"),
  ) as ToolBaseline;
  const liveTools = await upstream.listTools();
  const { tools, errors: baselineErrors } = selectBaselineTools(baseline, liveTools);
  // Changed or unreviewed upstream tools fail closed individually instead of
  // taking the whole gateway down after an upstream upgrade.
  for (const error of baselineErrors) {
    console.warn(`Upstream tool baseline mismatch, tool hidden: ${error}`);
  }
  if (tools.length === 0) {
    throw new Error("No upstream tool matches the reviewed baseline");
  }

  const verifyToken = createCombinedTokenVerifier({
    staticTokens: new FileStaticTokenStore({ file: config.staticTokenFile }),
    oauth: createRemoteJwtAccessTokenVerifier({
      issuer: config.oauthIssuer.toString().replace(/\/$/, ""),
      audience: config.publicMcpUrl.toString(),
      requiredScope: config.oauthRequiredScope,
      jwksUrl: config.oauthJwksUrl,
    }),
    scope: config.oauthRequiredScope,
  });
  const app = buildApp({
    config,
    verifyToken,
    upstream,
    tools,
    accessPolicy: new FileMcpAccessPolicyStore({
      policyFile: config.accessPolicyFile,
      auditFile: config.auditFile,
      fallbackKnowledgeBase: {
        id: config.fallbackKbId,
        name: config.fallbackKbName,
      },
      defaultClients: MANAGED_ACCESS_CLIENTS,
      inheritFrom: ACCESS_POLICY_INHERITANCE,
    }),
    sessions: new FileSessionOwnershipStore({ file: config.sessionOwnershipFile }),
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await upstream.close();
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
