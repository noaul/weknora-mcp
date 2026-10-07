import type { ManagedAccessClient } from "./access-policy.js";
import { MANAGED_OAUTH_CLIENTS } from "./keycloak-admin.js";
import { LEGACY_TOKEN_CLIENTS, MANAGED_TOKEN_CLIENTS } from "./static-tokens.js";

/** Every client with an access-policy entry: OAuth clients and static-token clients. */
export const MANAGED_ACCESS_CLIENTS: ManagedAccessClient[] = [
  ...MANAGED_OAUTH_CLIENTS,
  ...MANAGED_TOKEN_CLIENTS,
].map(({ clientId, label, provider }) => ({ clientId, label, provider }));

/** Merged token clients start with the access of the per-app client they replace. */
export const ACCESS_POLICY_INHERITANCE: Record<string, string[]> = Object.entries(
  LEGACY_TOKEN_CLIENTS,
).reduce<Record<string, string[]>>((inherit, [legacyId, { clientId }]) => {
  (inherit[clientId] ??= []).push(legacyId);
  return inherit;
}, {});
