import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compareToolBaseline, type ToolBaseline } from "../src/tool-baseline.js";
import { OfficialWeKnoraMcpClient } from "../src/upstream-client.js";

async function main(): Promise<void> {
  const url = process.env.UPSTREAM_MCP_URL;
  const tokenFile = process.env.UPSTREAM_MCP_TOKEN_FILE;
  if (!url || !tokenFile) {
    throw new Error("UPSTREAM_MCP_URL and UPSTREAM_MCP_TOKEN_FILE are required");
  }

  const token = (await readFile(tokenFile, "utf8")).trim();
  const adminMode = process.env.GATEWAY_MODE === "admin";
  const baselineFile = adminMode
    ? "fixtures/upstream-admin-tools-baseline.json"
    : "fixtures/upstream-tools-baseline.json";
  const baseline = JSON.parse(
    await readFile(resolve(baselineFile), "utf8"),
  ) as ToolBaseline;
  const client = new OfficialWeKnoraMcpClient({
    url: new URL(url),
    token,
    timeoutMs: 30_000,
  });

  try {
    const liveTools = await client.listTools();
    const errors = compareToolBaseline(baseline, liveTools, {
      rejectUnexpected: adminMode,
    });
    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }
    console.log(`Upstream tool baseline matches ${baseline.tools.length} allowed tools.`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
