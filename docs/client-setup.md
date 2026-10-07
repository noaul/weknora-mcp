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

## API keys (Xiaomi phone, LobeHub, Codeg, coding agents)

Clients that cannot run OAuth use named static API keys of the single
`Key 访问` client (`token-weknora`). All keys share that client's capabilities
and knowledge-base scope.

1. In the management console, open `Key 访问`, choose its capabilities and
   knowledge bases, and apply the MCP permissions.
2. Enter a name such as `小米手机`, `LobeHub`, or `Codeg` and click `新建 Key`.
   The `wkmcp_…` key is shown once; old keys cannot be viewed again, so create
   a new one when a key is lost.
3. Copy the ready-made configuration under `MCP 配置 (JSON)`:
   - Codeg / Claude Code: `{"type": "http", "url": …, "headers": {"Authorization": "Bearer wkmcp_…"}}`
   - Cursor, Claude Desktop, Cherry Studio: the `mcpServers` form
   - Xiaomi phone: server URL `https://wek.uov.me/mcp` and the key as Auth Token
     (`wkmcp_…` and `Bearer wkmcp_…` are both accepted)
4. Disable or delete a single key from its row; other keys keep working.
   Changes apply to the next request.

API keys do not expire. Keep `Key 访问` on the smallest capability set and
knowledge-base allow-list its clients need.

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
