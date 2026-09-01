# WeKnora MCP Access Gateway

为腾讯官方 WeKnora MCP 提供 OAuth 认证、按客户端权限控制和知识库范围管理的独立网关。

ChatGPT 与 Claude 通过同一个远程 `/mcp` 入口连接，服务器根据 OAuth Client 分别决定可见工具、可访问知识库以及是否授予全权限。

> 本项目是独立 sidecar，不修改 WeKnora 官方前端、后端或镜像，也不是腾讯官方项目。底层 MCP 工具来自 [Tencent/WeKnora](https://github.com/Tencent/WeKnora) 发布的 `tencent-weknora-mcp`。

## 项目定位

官方 `tencent-weknora-mcp` 负责把 WeKnora REST API 转换为 MCP 工具。本项目部署在它前面，补充适合网页端 AI 客户端长期使用的认证和授权能力：

```text
ChatGPT / Claude
        |
        | OAuth access token
        v
WeKnora MCP Access Gateway
        |
        | server-only upstream token
        v
tencent-weknora-mcp
        |
        | Tenant API Key
        v
WeKnora REST API
```

外部客户端只接触 OAuth access token，不会获得 Tenant API Key 或内部 MCP token。

## 核心功能

- 一个统一的远程 MCP 入口，例如 `https://mcp.example.com/mcp`
- 使用 Keycloak 提供 OAuth 2.0 / OIDC 登录
- 为 ChatGPT、Claude 等 OAuth Client 独立配置权限
- 支持“按能力”和“全权限”两种授权模式
- 支持全部知识库或指定知识库 allow-list
- 为指定范围配置默认知识库
- 调用工具时再次检查能力和知识库范围
- 未经审核的新增上游工具默认拒绝暴露
- 限制服务器本地文件导入目录
- 提供独立 MCP 管理控制台
- 记录不包含密钥和 token 的追加式审计日志

## 权限模型

### 按能力

客户端只看到被授权能力对应的工具。

| 能力 ID | 用途 |
| --- | --- |
| `knowledge.read` | 知识库读取、混合检索、Wiki 和文档查询 |
| `conversation.use` | 会话创建、对话和会话管理 |
| `knowledge.write` | 从文件、URL 或文本导入知识 |
| `knowledge.manage` | 创建、删除和管理知识库 |
| `agents.read` | Agent 列表、读取和调用所需能力 |
| `models.manage` | 模型读取与配置管理 |

知识库范围可以设置为：

- `all`：允许访问当前 Tenant 下的全部知识库
- `selected`：只允许访问明确选择的知识库，并指定其中一个作为默认知识库

### 全权限

客户端可以使用已经审核过的完整官方 MCP 工具集，并访问全部知识库。该模式可能包含写入、删除或管理操作，只应授予可信客户端。

## 管理控制台

控制台默认发布在：

```text
https://mcp.example.com/mcp-console/
```

每个受管理的 OAuth Client 可以单独操作：

- 启用或禁用客户端
- 查看 Client ID、OAuth endpoint 和回调地址
- 修改精确 callback URI
- 轮换 Client Secret
- 撤销现有登录会话
- 选择按能力或全权限
- 选择能力组和知识库范围
- 设置默认知识库
- 查看权限变更审计记录

现有 Client Secret 不可读取。轮换后生成的新 Secret 只显示一次。

## 客户端接入

默认使用一个 `/mcp` endpoint 和一个 OAuth scope：

| 客户端 | Client ID | MCP URL | OAuth scope |
| --- | --- | --- | --- |
| ChatGPT | `chatgpt-weknora-read` | `https://mcp.example.com/mcp` | `weknora:mcp` |
| Claude | `claude-weknora-read` | `https://mcp.example.com/mcp` | `weknora:mcp` |

`*-read` 后缀仅用于兼容已经安装的连接器，不代表客户端永久只读。实际权限完全由服务端策略决定。

回调地址必须使用 ChatGPT 或 Claude 页面显示的精确地址，不接受通配符。完整配置步骤见 [客户端接入文档](docs/client-setup.md)。

## 安全边界

- Tenant API Key 只保存在服务器受限文件中
- OAuth token 校验签名、issuer、audience、有效期、scope 和 client identity
- 每次 `tools/call` 都重新读取并执行服务端权限策略
- 未授权知识库 ID 会在请求到达 WeKnora 前被拒绝
- 上游工具必须同时存在于审核基线和能力目录中
- 新增或变化的官方工具默认 fail closed
- 本地文件导入只能访问 `ADMIN_IMPORT_ROOT` 下的规范化路径
- OAuth Client Secret、Tenant API Key 和上游 token 不写入审计日志
- 管理控制台使用独立管理员角色和最小化 Keycloak service-account 权限

## 运行组件

典型生产部署包含：

| 组件 | 作用 |
| --- | --- |
| WeKnora REST API | 保存和处理知识库数据 |
| `tencent-weknora-mcp` | 提供腾讯官方 MCP 工具 |
| Access Gateway | OAuth 验证、工具过滤和调用时授权 |
| Keycloak | OAuth 2.0 / OIDC authorization server |
| Management Console | OAuth Client 与 MCP 权限管理 |
| OpenResty / Nginx | HTTPS、公开路由和反向代理 |

网关、控制台和策略文件均部署在 WeKnora 官方目录之外，便于后续升级官方镜像。

## 开发与验证

要求 Node.js 20.20 或更高版本。

```bash
npm ci
npm test
npm run typecheck
npm run build
```

开发模式：

```bash
npm run dev
```

构建后的主要启动命令：

```bash
npm start
npm run start:console
```

生产环境还需要官方 MCP、Keycloak、HTTPS reverse proxy、systemd 配置和受保护的 secret 文件。不要直接把示例环境文件中的占位值用于公网部署。

## 部署与运维

- [客户端接入](docs/client-setup.md)
- [生产部署与运维](docs/operations.md)
- [统一权限实现计划](docs/superpowers/plans/2026-09-01-unified-mcp-permissions.md)

升级 WeKnora 或官方 MCP 后，应重新执行：

```bash
npm test
npm run typecheck
npm run build
npm run check:baseline
```

如果上游工具名称或 schema 发生变化，网关会拒绝启动或拒绝暴露未分类工具，直到审核基线与能力映射同步更新。

## 项目结构

```text
console/    MCP 管理控制台前端
deploy/     Keycloak、systemd、OpenResty 和安装资产
docs/       客户端接入、运维和实现文档
fixtures/   官方 MCP 工具 schema 审核基线
scripts/    基线检查脚本
src/        网关、认证、策略、控制台和上游客户端
tests/      单元测试、集成测试和部署断言
```

## 已知限制

- 当前部署资产以 Keycloak、systemd 和 OpenResty 为主要参考实现
- API Key 和 Tenant 成员管理不属于当前官方 MCP 工具集，因此控制台不提供对应操作
- `create_knowledge_from_file` 使用服务器本地路径，网页客户端不能直接上传任意本机文件路径
- OAuth Client 被禁用或会话被撤销后，已签发 JWT 仍可能在原有效期内继续有效
- 全权限模式不会替代客户端自身对危险操作的确认机制

## License

[MIT](LICENSE)

## 社区

讨论与交流：**[LINUX DO 社区](https://linux.do/)**
