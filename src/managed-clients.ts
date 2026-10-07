import type {
  ClientAccessPolicy,
  FileMcpAccessPolicyStore,
  ManagedAccessClient,
} from "./access-policy.js";
import { MANAGED_OAUTH_CLIENTS } from "./keycloak-admin.js";
import {
  API_KEY_CLIENT_PREFIX,
  apiKeyClientId,
  LEGACY_TOKEN_CLIENT_IDS,
  type FileStaticTokenStore,
} from "./static-tokens.js";

/** Clients seeded into a new or version-1 policy: the two original OAuth clients. */
export const MANAGED_ACCESS_CLIENTS: ManagedAccessClient[] = MANAGED_OAUTH_CLIENTS.map(
  ({ clientId, label, provider }) => ({ clientId, label, provider }),
);

const MIGRATION_ACTOR = { subject: "system", username: "migration" };

/**
 * Gives every API key its own access-policy client. Keys of the former shared
 * token clients (`token-weknora`, `xiaomi-weknora-token`, ...) become
 * `apikey-<id>` clients that keep the shared client's access; the legacy
 * policy entries are removed afterwards. Idempotent.
 */
export async function migrateApiKeyClients(
  policyStore: FileMcpAccessPolicyStore,
  tokenStore: FileStaticTokenStore,
): Promise<{ migratedKeys: number; removedClients: string[] }> {
  const policy = await policyStore.read();
  const byId = new Map(policy.clients.map((client) => [client.clientId, client]));
  const keys = await tokenStore.listKeys();
  const pending = keys.filter((key) => !key.clientId.startsWith(API_KEY_CLIENT_PREFIX));

  const inherited = (legacyClientId: string): ClientAccessPolicy | undefined =>
    byId.get(legacyClientId) ??
    LEGACY_TOKEN_CLIENT_IDS.map((id) => byId.get(id)).find(Boolean);

  const additions = pending
    .filter((key) => !byId.has(apiKeyClientId(key.id)))
    .map((key) => {
      const target = { clientId: apiKeyClientId(key.id), label: key.name, provider: "Token" as const };
      const source = inherited(key.clientId);
      return source ? { ...source, ...target } : policyStore.defaultAccess(target);
    });
  if (additions.length > 0) await policyStore.addClients(additions, MIGRATION_ACTOR);
  // The policy entry exists before the key moves to it, so the key keeps working.
  for (const key of pending) await tokenStore.reassignKey(key.id, apiKeyClientId(key.id));

  const removedClients = policy.clients
    .map(({ clientId }) => clientId)
    .filter((clientId) => LEGACY_TOKEN_CLIENT_IDS.includes(clientId));
  if (removedClients.length > 0) {
    await policyStore.removeClients(removedClients, MIGRATION_ACTOR);
  }
  return { migratedKeys: pending.length, removedClients };
}
