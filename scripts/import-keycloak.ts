import { FileAdminUserStore } from "../src/admin-users.js";
import { importKeycloakExport, keycloakExportSchema } from "../src/keycloak-import.js";
import { FileOAuthClientStore } from "../src/oauth-clients.js";

/**
 * Reads a Keycloak export (deploy/scripts/export-keycloak.sh) from stdin and
 * writes the console's OAuth client and administrator files. Run it as the
 * console service user so that the files get the right owner.
 */
async function main(): Promise<void> {
  const env = process.env;
  const issuer = env.OAUTH_ISSUER ?? "https://wek.uov.me/oauth/realms/weknora";
  const clientFile = env.MCP_OAUTH_CLIENT_FILE ?? "/var/lib/weknora-mcp-console/oauth-clients.json";
  const usersFile = env.ADMIN_USERS_FILE ?? "/var/lib/weknora-mcp-console/admin-users.json";

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const data = keycloakExportSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const result = await importKeycloakExport(data, {
    clients: new FileOAuthClientStore({ file: clientFile, issuer }),
    users: new FileAdminUserStore({ file: usersFile }),
  });
  console.log(
    `Imported OAuth clients: ${result.clients.join(", ") || "none"}; administrators: ${result.users.join(", ") || "none"}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
