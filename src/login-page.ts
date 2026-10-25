/** Server-rendered login pages shared by the console and the OAuth server. */

export const LOGIN_STYLESHEET_PATH = "/mcp-console/assets/login.css";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${LOGIN_STYLESHEET_PATH}">
</head>
<body>
<main class="card">
${body}
</main>
</body>
</html>`;
}

function errorBlock(error?: string): string {
  return error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";
}

function credentialFields(username?: string): string {
  return `<label>用户名
<input name="username" autocomplete="username" required maxlength="100" value="${escapeHtml(username ?? "")}"${username ? "" : " autofocus"}>
</label>
<label>密码
<input name="password" type="password" autocomplete="current-password" required maxlength="256"${username ? " autofocus" : ""}>
</label>`;
}

export function consoleLoginPage(options: {
  action: string;
  formToken: string;
  username?: string;
  error?: string;
}): string {
  return page(
    "登录 · WeKnora MCP 控制台",
    `<h1>欢迎回来</h1>
<p class="lead">登录 WeKnora MCP 管理控制台</p>
${errorBlock(options.error)}
<form method="post" action="${escapeHtml(options.action)}">
<input type="hidden" name="form_token" value="${escapeHtml(options.formToken)}">
${credentialFields(options.username)}
<button type="submit">登录</button>
</form>`,
  );
}

export function authorizePage(options: {
  action: string;
  request: string;
  clientLabel: string;
  redirectHost: string;
  username?: string;
  error?: string;
}): string {
  return page(
    "授权访问 · WeKnora",
    `<h1>授权访问</h1>
<p class="lead"><strong>${escapeHtml(options.clientLabel)}</strong> 请求访问你的 WeKnora 知识库 MCP。</p>
<p class="hint">授权后将跳转到 ${escapeHtml(options.redirectHost)}。可访问的工具与知识库由控制台中该凭据的权限决定。</p>
${errorBlock(options.error)}
<form method="post" action="${escapeHtml(options.action)}">
<input type="hidden" name="request" value="${escapeHtml(options.request)}">
${credentialFields(options.username)}
<!-- "allow" comes first so that pressing Enter authorizes. -->
<div class="actions">
<button type="submit" name="decision" value="allow">登录并授权</button>
<button type="submit" name="decision" value="deny" class="secondary" formnovalidate>拒绝</button>
</div>
</form>`,
  );
}

export function errorPage(message: string): string {
  return page(
    "无法继续 · WeKnora",
    `<h1>无法继续</h1>
${errorBlock(message)}
<p class="hint">请返回发起授权的应用重试；如果问题持续，请在控制台检查该 OAuth 凭据的回调地址与启用状态。</p>`,
  );
}
