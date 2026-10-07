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

## Credentials and permissions

The console groups access by integration: ChatGPT, Claude, and API Key. Each
integration page has a `连接信息` tab (shared MCP URL and authentication
details), one tab per credential, and a `新增` tab. Every credential has its own
capabilities and knowledge-base scope.

- ChatGPT / Claude: each credential is a separate Keycloak OAuth client
  (`chatgpt-weknora-xxxxxx`, `claude-weknora-xxxxxx`) with its own Client ID,
  Client Secret, callback URL, and sessions. The Client Secret is shown once
  after creation or rotation.
- API Key: each key (`apikey-<id>`) is for one app such as the Xiaomi phone,
  LobeHub, or Codeg. The key and a ready-to-paste configuration are shown once
  after creation or rotation; old keys cannot be viewed, rotate to get a new
  one with the same permissions. Configuration formats: HTTP
  (`{"type": "http", "url": …, "headers": {"Authorization": "Bearer …"}}`),
  `mcpServers`, and form fields (`wkmcp_…` and `Bearer wkmcp_…` both work).

New credentials start read-only on the default knowledge base. Disable, rotate,
or delete a credential from its tab; other credentials are unaffected.

## Permission choices

按能力 mode exposes only tools mapped to the selected capability groups. The
knowledge-base scope can be all or selected. Selected scope requires at least
one knowledge base and a default inside that allow-list.

全权限 mode exposes the complete reviewed official tool baseline and all
knowledge bases. Destructive tools remain marked destructive, but clients can
present confirmations differently. Assign this mode only to trusted clients.

Since WeKnora v0.8 a chat session is not bound to a knowledge base. In 按能力
mode the gateway therefore records which client created each session; a client
can read, chat in, or delete only its own sessions. When a selected-scope client
calls `chat` or `agent_chat` without `knowledge_base_ids`, the gateway fills in
the client's allow-list. A custom agent may still have its own knowledge-base
configuration in WeKnora, so grant `agents.read` only where that is acceptable.

## File ingestion

`create_knowledge_from_file` reads a server-local path. Stage approved files
under `/var/lib/weknora-mcp-import`; paths outside that directory are rejected.
For content already available to the client, prefer text or URL ingestion.

The Tenant API Key remains inside the server. Neither ChatGPT nor Claude needs
or receives it.
