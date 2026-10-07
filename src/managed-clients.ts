import type { ManagedAccessClient } from "./access-policy.js";
import { MANAGED_OAUTH_CLIENTS } from "./keycloak-admin.js";
import { MANAGED_TOKEN_CLIENTS } from "./static-tokens.js";

/** Every client with an access-policy entry: OAuth clients and static-token clients. */
export const MANAGED_ACCESS_CLIENTS: ManagedAccessClient[] = [
  ...MANAGED_OAUTH_CLIENTS,
  ...MANAGED_TOKEN_CLIENTS,
].map(({ clientId, label, provider }) => ({ clientId, label, provider }));
