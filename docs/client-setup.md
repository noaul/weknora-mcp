# Client Setup

## One connection per application

| Application | Client ID | MCP URL | OAuth scope |
| --- | --- | --- | --- |
| ChatGPT | `chatgpt-weknora-read` | `https://wek.uov.me/mcp` | `weknora:mcp` |
| Claude | `claude-weknora-read` | `https://wek.uov.me/mcp` | `weknora:mcp` |

The `*-read` suffix is retained for compatibility with the existing installed
clients. It does not determine access. Open the management console and choose
按能力 or 全权限 for each client independently.

OAuth issuer:

```text
https://wek.uov.me/oauth/realms/weknora
```

Authorization endpoint:

```text
https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/auth
```

Token endpoint:

```text
https://wek.uov.me/oauth/realms/weknora/protocol/openid-connect/token
```

Anonymous Dynamic Client Registration is disabled. Use the Client ID and
Client Secret shown or rotated in the management console.

## Callback URIs

Use the exact callback URI displayed by the application. Wildcards are not
accepted.

ChatGPT currently uses:

```text
https://chatgpt.com/connector_platform_oauth_redirect
```

For Claude, copy the exact callback URI from its custom connector form. Existing
callbacks and secrets are preserved during the unified-client migration.

## ChatGPT

1. Add or refresh the remote MCP connector.
2. Enter `https://wek.uov.me/mcp`.
3. Enter Client ID `chatgpt-weknora-read` and its Client Secret.
4. Complete the Keycloak login and consent flow.
5. Refresh actions after changing permissions in the management console.

## Claude

1. Open custom connector setup.
2. Enter `https://wek.uov.me/mcp`.
3. Enter Client ID `claude-weknora-read` and its Client Secret.
4. Complete the Keycloak login and consent flow.
5. Reconnect or refresh tools after changing permissions.

## Permission choices

按能力 mode exposes only tools mapped to the selected capability groups. The
knowledge-base scope can be all or selected. Selected scope requires at least
one knowledge base and a default inside that allow-list.

全权限 mode exposes the complete reviewed official tool baseline and all
knowledge bases. Destructive tools remain marked destructive, but clients can
present confirmations differently. Assign this mode only to trusted clients.

## File ingestion

`create_knowledge_from_file` reads a server-local path. Stage approved files
under `/var/lib/weknora-mcp-import`; paths outside that directory are rejected.
For content already available to the client, prefer text or URL ingestion.

The Tenant API Key remains inside the server. Neither ChatGPT nor Claude needs
or receives it.
