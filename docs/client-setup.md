# Client Setup

## Shared values

```text
MCP URL: https://wek.uov.me/mcp
OAuth issuer: https://wek.uov.me/oauth/realms/weknora
Scope: weknora:read
```

The gateway uses static confidential OAuth clients. Do not enable anonymous Dynamic Client Registration.

## Claude

1. Open the custom connector setup in Claude.
2. Enter `https://wek.uov.me/mcp` as the remote MCP URL.
3. Copy the callback URI shown by Claude into `CLAUDE_REDIRECT_URI` before running `configure-keycloak.sh`.
4. Enter client ID `claude-weknora` and the generated Claude client secret.
5. Complete the Keycloak login and consent flow.
6. Confirm the connector lists exactly four tools.

## ChatGPT

1. Enable developer mode and add a remote MCP app.
2. Enter `https://wek.uov.me/mcp`.
3. Copy the callback URI shown by ChatGPT into `CHATGPT_REDIRECT_URI` before running `configure-keycloak.sh`.
4. Enter client ID `chatgpt-weknora` and the generated ChatGPT client secret.
5. Complete the Keycloak login and consent flow.
6. Confirm the app lists exactly four tools.

## Smoke prompt

```text
Use WeKnora to search the 镍基合金 knowledge base for 晶界腐蚀 and summarize the strongest matching passages with source titles.
```

Expected tools are `hybrid_search`, `wiki_search`, `wiki_read_page`, and `wiki_index_view`. A client must not see `delete_knowledge_base`, `create_knowledge_from_url`, or any other upstream tool.
