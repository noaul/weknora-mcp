#!/usr/bin/env bash
# One-time migration from the former Keycloak deployment. Writes the MCP OAuth
# clients (secrets, callbacks, enabled state) and the realm's weknora-admin
# users (argon2 password credentials, subject ids) as JSON to stdout. Pipe it straight into
# the importer so that secrets never touch the disk:
#
#   deploy/scripts/export-keycloak.sh | sudo -u weknora-console \
#     node /opt/weknora-mcp-console/dist/scripts/import-keycloak.js
set -euo pipefail

container="${KEYCLOAK_DB_CONTAINER:-weknora-mcp-auth-postgres-1}"
realm="${KEYCLOAK_REALM:-weknora}"

docker exec -i "$container" psql -U keycloak -d keycloak -At -v realm="$realm" <<'SQL'
select json_build_object(
  'clients', coalesce((
    select json_agg(json_build_object(
      'clientId', c.client_id,
      'name', c.name,
      'secret', c.secret,
      'enabled', c.enabled,
      'redirectUris', (select json_agg(r.value) from redirect_uris r where r.client_id = c.id)
    ))
    from client c join realm rl on rl.id = c.realm_id
    where rl.name = :'realm' and not c.public_client and c.secret is not null
  ), '[]'::json),
  'users', coalesce((
    select json_agg(json_build_object(
      'id', u.id,
      'username', u.username,
      'credentialData', cr.credential_data::json,
      'secretData', cr.secret_data::json
    ))
    from user_entity u
    join realm rl on rl.id = u.realm_id
    join credential cr on cr.user_id = u.id and cr.type = 'password'
    where rl.name = :'realm' and u.enabled and u.service_account_client_link is null
      and exists (
        select 1 from user_role_mapping m join keycloak_role kr on kr.id = m.role_id
        where m.user_id = u.id and kr.name = 'weknora-admin'
      )
  ), '[]'::json)
);
SQL
