import { z } from "zod";

import { keycloakArgon2ToPhc, type FileAdminUserStore } from "./admin-users.js";
import { OAUTH_PROVIDERS, type FileOAuthClientStore } from "./oauth-clients.js";

/** JSON produced by deploy/scripts/export-keycloak.sh from the Keycloak database. */
export const keycloakExportSchema = z.object({
  clients: z.array(
    z.object({
      clientId: z.string().min(1),
      name: z.string().nullable().optional(),
      secret: z.string().min(1),
      enabled: z.boolean(),
      redirectUris: z.array(z.string()).nullable().optional(),
    }),
  ),
  users: z.array(
    z.object({
      id: z.string().min(1),
      username: z.string().min(1),
      credentialData: z.unknown(),
      secretData: z.unknown(),
    }),
  ),
});

export type KeycloakExport = z.infer<typeof keycloakExportSchema>;

function isManagedClient(clientId: string): boolean {
  return Object.values(OAUTH_PROVIDERS).some(({ clientIdPrefix }) =>
    clientId.startsWith(`${clientIdPrefix}-`),
  );
}

/**
 * Moves the MCP OAuth clients (with their secrets and callbacks) and the
 * console administrators (with their argon2 password hashes and subject ids)
 * out of Keycloak. Keycloak-internal clients are skipped. Idempotent.
 */
export async function importKeycloakExport(
  data: KeycloakExport,
  stores: {
    clients: Pick<FileOAuthClientStore, "importClient">;
    users: Pick<FileAdminUserStore, "setHash">;
  },
): Promise<{ clients: string[]; users: string[] }> {
  const clients: string[] = [];
  for (const client of data.clients.filter(({ clientId }) => isManagedClient(clientId))) {
    await stores.clients.importClient({
      clientId: client.clientId,
      label: client.name || client.clientId,
      secret: client.secret,
      enabled: client.enabled,
      redirectUris: client.redirectUris ?? [],
    });
    clients.push(client.clientId);
  }
  const users: string[] = [];
  for (const user of data.users) {
    await stores.users.setHash(
      user.username,
      keycloakArgon2ToPhc(user.credentialData, user.secretData),
      user.id,
    );
    users.push(user.username);
  }
  return { clients, users };
}
