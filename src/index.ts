import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { FileMcpAccessPolicyStore } from "./access-policy.js";
import { createRemoteJwtAccessTokenVerifier } from "./auth.js";
import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";
import { retry } from "./retry.js";
import { compareToolBaseline, type ToolBaseline } from "./tool-baseline.js";
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
  const baselineErrors = compareToolBaseline(baseline, liveTools, {
    rejectUnexpected: true,
  });
  if (baselineErrors.length > 0) {
    throw new Error(baselineErrors.join("\n"));
  }

  const liveByName = new Map(liveTools.map((tool) => [tool.name, tool]));
  const tools = baseline.tools.map((tool) => {
    const live = liveByName.get(tool.name);
    if (!live) throw new Error(`Missing upstream tool: ${tool.name}`);
    return live;
  });

  const verifyToken = createRemoteJwtAccessTokenVerifier({
    issuer: config.oauthIssuer.toString().replace(/\/$/, ""),
    audience: config.publicMcpUrl.toString(),
    requiredScope: config.oauthRequiredScope,
    jwksUrl: config.oauthJwksUrl,
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
      defaultClients: [
        {
          clientId: "chatgpt-weknora-read",
          label: "ChatGPT WeKnora",
          provider: "ChatGPT",
        },
        {
          clientId: "claude-weknora-read",
          label: "Claude WeKnora",
          provider: "Claude",
        },
      ],
    }),
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
