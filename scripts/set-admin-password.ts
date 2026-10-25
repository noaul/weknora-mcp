import { createInterface } from "node:readline/promises";

import { FileAdminUserStore } from "../src/admin-users.js";

/**
 * Creates a console administrator or replaces its password. The password is
 * read from stdin so that it never appears in the process list or history:
 *   node dist/scripts/set-admin-password.js <username>
 */
async function main(): Promise<void> {
  const username = process.argv[2];
  if (!username) throw new Error("Usage: set-admin-password.js <username>");
  const file = process.env.ADMIN_USERS_FILE ?? "/var/lib/weknora-mcp-console/admin-users.json";
  const input = createInterface({ input: process.stdin, terminal: false });
  if (process.stdin.isTTY) process.stderr.write("New password: ");
  const password = (await input.question("")).replace(/\r?\n$/, "");
  input.close();
  await new FileAdminUserStore({ file }).setPassword(username, password);
  console.log(`Password set for ${username}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
