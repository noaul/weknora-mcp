import { readFile } from "node:fs/promises";

import { createRemoteJwtAccessTokenVerifier } from "./auth.js";
import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";
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
  await upstream.connect();

  const verifyToken = createRemoteJwtAccessTokenVerifier({
    issuer: config.oauthIssuer.toString().replace(/\/$/, ""),
    audience: config.publicMcpUrl.toString(),
    requiredScope: config.oauthRequiredScope,
    jwksUrl: config.oauthJwksUrl,
  });
  const app = buildApp({ config, verifyToken, upstream });

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
