# Client Setup

## Choose a connection

| Permission | MCP URL | OAuth scope | Required role |
| --- | --- | --- | --- |
| Read-only `镍基合金` | `https://wek.uov.me/mcp` | `weknora:read` | none |
| Full administration | `https://wek.uov.me/mcp-admin` | `weknora:admin` | `weknora-admin` |

The two connections are separate MCP resources. Add one or both in each client. Do not put admin credentials into the read-only connection.

OAuth issuer for both profiles:

```text
https://wek.uov.me/oauth/realms/weknora
```

The gateway uses static confidential OAuth clients. Anonymous Dynamic Client Registration is disabled.

## Keycloak preparation

1. Copy the exact callback URI displayed by ChatGPT or Claude.
2. Put the matching secret and callback URI in `deploy/keycloak.env`.
3. Run `deploy/scripts/configure-keycloak.sh` on nc48.
4. For admin access, assign the Keycloak realm role `weknora-admin` only to approved users.

The script supports these client pairs:

| Client ID | Secret variable | Redirect variable |
| --- | --- | --- |
| `chatgpt-weknora-read` | `CHATGPT_READ_CLIENT_SECRET` | `CHATGPT_READ_REDIRECT_URI` |
| `chatgpt-weknora-admin` | `CHATGPT_ADMIN_CLIENT_SECRET` | `CHATGPT_ADMIN_REDIRECT_URI` |
| `claude-weknora-read` | `CLAUDE_READ_CLIENT_SECRET` | `CLAUDE_READ_REDIRECT_URI` |
| `claude-weknora-admin` | `CLAUDE_ADMIN_CLIENT_SECRET` | `CLAUDE_ADMIN_REDIRECT_URI` |

Never use wildcard callback URIs.

## ChatGPT

1. Enable developer mode and add a remote MCP app.
2. Use the read-only or admin MCP URL from the table above.
3. Enter the matching client ID and generated client secret.
4. Complete the Keycloak login and consent flow.
5. Confirm read-only shows exactly four tools; admin shows the reviewed 30-tool baseline.

## Claude

1. Open custom connector setup.
2. Use the read-only or admin MCP URL from the table above.
3. Enter the matching client ID and generated client secret.
4. Complete the Keycloak login and consent flow.
5. Confirm the displayed tool count matches the chosen profile.

## Smoke prompts

Read-only:

```text
Use WeKnora to search the 镍基合金 knowledge base for 晶界腐蚀 and summarize the strongest matching passages with source titles.
```

Admin, non-destructive:

```text
Use WeKnora admin to list all knowledge bases, then show the details of 镍基合金. Do not create, change, or delete anything.
```

## File ingestion

`create_knowledge_from_file` reads a path on nc48, not a file from the browser. Place approved files in `/var/lib/weknora-mcp-import` through an authenticated server-side transfer, then pass that server path. For content already available to the client, prefer `create_knowledge_from_text` or `create_knowledge_from_url`.

Delete tools are marked destructive, but clients may differ in how they request confirmation. Treat the admin connection as full tenant authority.
