const CAPABILITY_LABELS = {
  "knowledge.read": ["读取与检索", "知识库读取、混合检索、Wiki 和文档查询"],
  "conversation.use": ["对话与会话", "创建会话、对话和管理自己创建的会话"],
  "knowledge.write": ["导入与新建知识", "从文件、URL 或文本导入和更新知识"],
  "knowledge.manage": ["删除与管理知识", "创建、删除和管理知识库"],
  "agents.read": ["Agent 查询", "读取 Agent 并以 Agent 对话"],
  "models.manage": ["模型配置", "读取与配置模型"],
};

const UNSUPPORTED_CAPABILITIES = ["WeKnora 租户 API Key 管理", "租户成员管理"];

const CONFIG_FORMATS = [
  ["http", "Codeg / Claude Code"],
  ["mcpServers", "mcpServers"],
  ["fields", "小米手机 / 表单"],
];

const state = {
  session: null,
  overview: null,
  clients: [],
  capabilities: [],
  drafts: new Map(),
  view: "overview",
  pendingAction: null,
  pendingCancel: null,
  // Plaintext of the API key created in this page view; never persisted.
  createdKey: null,
  configFormat: "http",
};

const elements = {
  shell: document.querySelector(".shell"),
  user: document.querySelector("#current-user"),
  avatar: document.querySelector("#account-avatar"),
  list: document.querySelector("#oauth-client-list"),
  empty: document.querySelector("#oauth-empty-state"),
  navOverview: document.querySelector("#nav-overview"),
  refresh: document.querySelector("#refresh-oauth-clients"),
  title: document.querySelector("#view-title"),
  overviewView: document.querySelector("#overview-view"),
  clientView: document.querySelector("#client-view"),
  overviewClients: document.querySelector("#overview-clients"),
  enabledCount: document.querySelector("#oauth-enabled-count"),
  sessionCount: document.querySelector("#oauth-session-count"),
  services: document.querySelector("#service-status"),
  updated: document.querySelector("#last-updated"),
  audit: document.querySelector("#audit-list"),
  toast: document.querySelector("#app-status"),
  logout: document.querySelector("#logout"),
  openSidebar: document.querySelector("#open-sidebar"),
  closeSidebar: document.querySelector("#close-sidebar"),
  scrim: document.querySelector("#sidebar-scrim"),
  confirmDialog: document.querySelector("#oauth-confirm-dialog"),
  confirmTitle: document.querySelector("#oauth-confirm-title"),
  confirmSummary: document.querySelector("#oauth-confirm-summary"),
  confirmAction: document.querySelector("#oauth-confirm-action"),
  secretDialog: document.querySelector("#oauth-secret-dialog"),
  secretValue: document.querySelector("#oauth-secret-value"),
  secretTitle: document.querySelector("#oauth-secret-title"),
  secretLabel: document.querySelector("#oauth-secret-label"),
  copySecret: document.querySelector("#copy-oauth-secret"),
};

const ICONS = {
  copy: "M9 9h10v10H9zM5 15V5h10",
  chevron: "M9 6l6 6-6 6",
};

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (response.status === 401) {
    window.location.assign("/mcp-console/login");
    throw new Error("authentication_required");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `request_failed_${response.status}`);
  return payload;
}

function showStatus(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.hidden = false;
  window.clearTimeout(showStatus.timer);
  showStatus.timer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3600);
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "-"
    : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function appendText(parent, tag, className, value) {
  const node = el(tag, className, value);
  parent.append(node);
  return node;
}

function icon(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

function button(label, variant = "secondary", onClick) {
  const node = el("button", `button button-${variant}`, label);
  node.type = "button";
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

function clientInitial(client) {
  return (
    { ChatGPT: "G", Claude: "C", Token: "K" }[client.provider] ||
    client.label.slice(0, 1)
  );
}

function clientAvatar(client, large = false) {
  return el("span", `client-avatar${large ? " large" : ""}`, clientInitial(client));
}

function isToken(client) {
  return client.kind === "token";
}

function secretName() {
  return "Client Secret";
}

/* Settings rows */

function group(title, note) {
  const section = el("section", "group");
  const heading = el("div", "group-heading");
  appendText(heading, "h2", "", title);
  if (note) appendText(heading, "span", "muted", note);
  const body = el("div", "group-body");
  section.append(heading, body);
  return { section, body };
}

function row(title, description, trailing, className = "") {
  const node = el("div", `row ${className}`.trim());
  const main = el("div", "row-main");
  appendText(main, "span", "row-title", title);
  if (description) appendText(main, "span", "row-description", description);
  node.append(main);
  if (trailing) node.append(trailing);
  return node;
}

function valueRow(title, value, copyable = false) {
  const node = el("div", "row wrap-mobile");
  const main = el("div", "row-main");
  appendText(main, "span", "row-title", title);
  appendText(main, "span", "row-value", value || "-");
  node.append(main);
  if (copyable && value) {
    const copy = el("button", "icon-button copy-button");
    copy.type = "button";
    copy.setAttribute("aria-label", `复制 ${title}`);
    copy.append(icon(ICONS.copy));
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(value);
      showStatus(`${title} 已复制`);
    });
    node.append(copy);
  }
  return node;
}

function switchControl(checked, label, disabled, onChange) {
  const control = el("label", "switch");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.disabled = disabled;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => onChange(input.checked, input));
  control.append(input, el("span", "switch-track"));
  return control;
}

function createSegment(name, value, label, checked, disabled, onChange) {
  const control = el("label", "segment");
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener("change", () => {
    if (input.checked) onChange(value);
  });
  control.append(input);
  appendText(control, "span", "", label);
  return control;
}

/* Drafts */

function initialDraft(client) {
  return {
    redirectUri: client.redirectUri,
    accessType: client.access.accessType,
    capabilities: new Set(client.access.capabilities),
    knowledgeBaseScope: client.access.knowledgeBaseScope,
    defaultKbId: client.access.defaultKbId,
    allowedKbIds: new Set(client.access.knowledgeBases.map(({ id }) => id)),
  };
}

function draftFor(client) {
  if (!state.drafts.has(client.key)) {
    state.drafts.set(client.key, initialDraft(client));
  }
  return state.drafts.get(client.key);
}

function policyPayload(draft) {
  const full = draft.accessType === "full";
  return {
    accessType: draft.accessType,
    capabilities: full ? [] : [...draft.capabilities].sort(),
    knowledgeBaseScope: full ? "all" : draft.knowledgeBaseScope,
    defaultKbId: draft.defaultKbId,
    allowedKbIds:
      full || draft.knowledgeBaseScope === "all" ? [] : [...draft.allowedKbIds].sort(),
  };
}

function policyIsDirty(client, draft) {
  return (
    JSON.stringify(policyPayload(draft)) !==
    JSON.stringify(policyPayload(initialDraft(client)))
  );
}

function policyIsValid(draft) {
  if (!draft.defaultKbId) return false;
  if (draft.accessType === "full") return true;
  if (draft.capabilities.size === 0) return false;
  return (
    draft.knowledgeBaseScope === "all" ||
    (draft.allowedKbIds.size > 0 && draft.allowedKbIds.has(draft.defaultKbId))
  );
}

/* Actions */

function confirmAction(title, summary, actionLabel, action, options = {}) {
  state.pendingAction = action;
  state.pendingCancel = options.onCancel || null;
  elements.confirmTitle.textContent = title;
  elements.confirmSummary.textContent = summary;
  elements.confirmAction.textContent = actionLabel;
  elements.confirmAction.className = `button ${options.danger ? "button-danger" : "button-primary"}`;
  elements.confirmDialog.returnValue = "";
  elements.confirmDialog.showModal();
}

async function saveAccessPolicy(client, draft) {
  await request(`/mcp-console/api/oauth-clients/${client.key}/access-policy`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": state.session.csrfToken,
    },
    body: JSON.stringify(policyPayload(draft)),
  });
  showStatus(`${client.label} MCP 权限已更新`);
  await loadAll();
}

async function saveOauthClient(client, update) {
  await request(`/mcp-console/api/oauth-clients/${client.key}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": state.session.csrfToken,
    },
    body: JSON.stringify(update),
  });
  showStatus(`${client.label} 连接配置已更新`);
  await loadAll();
}

async function rotateSecret(client) {
  const result = await request(
    `/mcp-console/api/oauth-clients/${client.key}/rotate-secret`,
    {
      method: "POST",
      headers: { "x-csrf-token": state.session.csrfToken },
    },
  );
  elements.secretTitle.textContent = `新 ${secretName(client)}`;
  elements.secretLabel.textContent = secretName(client);
  elements.secretValue.value = result.secret;
  elements.secretDialog.showModal();
  showStatus(`${client.label} ${secretName(client)} 已生成`);
}

async function revokeSessions(client) {
  const result = await request(
    `/mcp-console/api/oauth-clients/${client.key}/revoke-sessions`,
    {
      method: "POST",
      headers: { "x-csrf-token": state.session.csrfToken },
    },
  );
  showStatus(`已撤销 ${result.revokedSessions} 个 ${client.label} 会话`);
  await loadAll();
}

/* Navigation */

function setSidebar(open) {
  elements.shell.classList.toggle("sidebar-visible", open);
  elements.scrim.hidden = !open;
}

function selectView(view) {
  state.view = state.clients.some(({ key }) => key === view) ? view : "overview";
  if (window.location.hash.slice(1) !== state.view) {
    history.replaceState(null, "", `#${state.view}`);
  }
  setSidebar(false);
  render();
  window.scrollTo({ top: 0 });
}

function renderNav() {
  elements.list.replaceChildren();
  elements.empty.hidden = state.clients.length > 0;
  if (state.view === "overview") elements.navOverview.setAttribute("aria-current", "page");
  else elements.navOverview.removeAttribute("aria-current");
  for (const client of state.clients) {
    const item = el("button", "nav-item");
    item.type = "button";
    if (state.view === client.key) item.setAttribute("aria-current", "page");
    item.append(clientAvatar(client), el("span", "nav-name", client.label));
    const dot = el("span", `status-dot${client.enabled ? " on" : ""}`);
    dot.title = client.enabled ? "已启用" : "已停用";
    item.append(dot);
    item.addEventListener("click", () => selectView(client.key));
    elements.list.append(item);
  }
}

/* Overview */

function clientStatusBadge(client) {
  if (isToken(client)) {
    const active = client.keys.filter((key) => key.enabled).length;
    return client.keys.length === 0
      ? el("span", "badge warn", "未创建 Key")
      : el("span", active > 0 ? "badge ok" : "badge off", `${active} / ${client.keys.length} 个 Key 启用`);
  }
  return client.enabled
    ? el("span", "badge ok", "已启用")
    : el("span", "badge off", "已停用");
}

function accessSummary(client) {
  const access = client.access;
  const mode =
    access.accessType === "full" ? "全权限" : `按能力授权 · ${access.capabilities.length} 项能力`;
  const scope =
    access.accessType === "full" || access.knowledgeBaseScope === "all"
      ? "全部知识库"
      : `${access.knowledgeBases.length} 个知识库`;
  return `${mode} · ${scope}`;
}

function renderOverview() {
  const enabled = state.clients.filter((client) => client.enabled).length;
  const sessions = state.clients.reduce((sum, client) => sum + client.sessionCount, 0);
  elements.enabledCount.textContent = `${enabled} / ${state.clients.length}`;
  elements.sessionCount.textContent = String(sessions);

  elements.services.replaceChildren();
  const status = state.overview?.services?.gateway;
  elements.services.append(
    row(
      "MCP 网关",
      "统一 /mcp 入口与权限检查",
      status === "healthy"
        ? el("span", "badge ok", "正常")
        : el("span", "badge off", "不可用"),
    ),
  );
  elements.updated.textContent = `更新于 ${new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date())}`;

  elements.overviewClients.replaceChildren();
  for (const client of state.clients) {
    const node = el("div", "row clickable");
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    const main = el("div", "row-main");
    appendText(main, "span", "row-title", client.label);
    appendText(main, "span", "row-description", accessSummary(client));
    const chevron = el("span", "chevron");
    chevron.append(icon(ICONS.chevron));
    node.append(clientAvatar(client), main, clientStatusBadge(client), chevron);
    node.addEventListener("click", () => selectView(client.key));
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectView(client.key);
      }
    });
    elements.overviewClients.append(node);
  }

  elements.audit.replaceChildren();
  const audit = state.overview?.audit || [];
  if (!audit.length) {
    const empty = el("li", "row");
    appendText(empty, "span", "muted", "暂无变更记录");
    elements.audit.append(empty);
  }
  for (const record of audit) {
    const item = el("li", "row");
    const main = el("div", "row-main");
    appendText(main, "span", "row-title", record.action || "策略更新");
    appendText(
      main,
      "span",
      "row-description",
      record.actor?.username || record.actor || record.updatedBy || "管理员",
    );
    item.append(main, el("span", "muted", formatDate(record.timestamp)));
    elements.audit.append(item);
  }
}

/* Client detail */

function renderHero(parent, client) {
  const hero = el("div", "client-hero");
  const text = el("div", "client-hero-text");
  appendText(text, "h2", "", client.label);
  appendText(text, "code", "", client.clientId);
  hero.append(clientAvatar(client, true), text, clientStatusBadge(client));
  if (!isToken(client)) {
    const toggle = switchControl(client.enabled, `启用 ${client.label}`, false, (checked, input) => {
      confirmAction(
        `${checked ? "启用" : "停用"} ${client.label}`,
        checked ? "客户端将可以重新发起 OAuth 登录。" : "将停用客户端并阻止新的 OAuth 登录。",
        checked ? "确认启用" : "确认停用",
        () => saveOauthClient(client, { enabled: checked, redirectUri: client.redirectUri }),
        {
          danger: !checked,
          onCancel: () => {
            input.checked = client.enabled;
          },
        },
      );
    });
    hero.append(toggle);
  }
  parent.append(hero);
}

function renderOauthConnection(parent, client, draft) {
  const { section, body } = group("连接信息", `活跃会话 ${client.sessionCount} 个`);
  body.append(
    valueRow("MCP URL", client.mcpUrl, true),
    valueRow("Client ID", client.clientId, true),
    valueRow("Scope", client.scope, true),
    valueRow("Issuer", client.issuer),
    valueRow("Authorization URL", client.authorizationEndpoint),
    valueRow("Token URL", client.tokenEndpoint),
  );
  const redirectRow = el("div", "row row-stack");
  const main = el("div", "row-main");
  appendText(main, "span", "row-title", "回调 URL");
  appendText(main, "span", "row-description", "必须与 ChatGPT 或 Claude 页面显示的地址完全一致");
  const redirect = document.createElement("input");
  redirect.className = "text-input";
  redirect.type = "url";
  redirect.required = true;
  redirect.spellcheck = false;
  redirect.value = draft.redirectUri;
  redirect.setAttribute("aria-label", `${client.label} 回调 URL`);
  const save = button("保存", "primary", () => {
    if (!redirect.reportValidity()) return;
    confirmAction(
      `更新 ${client.label} 回调 URL`,
      "将保存新的精确回调 URL。",
      "确认保存",
      () => saveOauthClient(client, { enabled: client.enabled, redirectUri: draft.redirectUri }),
    );
  });
  save.disabled = draft.redirectUri === client.redirectUri;
  redirect.addEventListener("input", () => {
    draft.redirectUri = redirect.value;
    save.disabled = redirect.value === client.redirectUri;
  });
  redirectRow.append(main, redirect, save);
  body.append(redirectRow);
  parent.append(section);
}

async function apiKeyRequest(client, path, options) {
  return request(`/mcp-console/api/oauth-clients/${client.key}/keys${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      "x-csrf-token": state.session.csrfToken,
    },
  });
}

async function createApiKey(client, name) {
  const result = await apiKeyRequest(client, "", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  state.createdKey = { clientKey: client.key, name: result.key.name, secret: result.secret };
  showStatus(`已创建 API Key「${result.key.name}」`);
  await loadAll();
}

async function setApiKeyEnabled(client, key, enabled) {
  await apiKeyRequest(client, `/${key.id}`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
  showStatus(`API Key「${key.name}」已${enabled ? "启用" : "停用"}`);
  await loadAll();
}

async function deleteApiKey(client, key) {
  await apiKeyRequest(client, `/${key.id}`, { method: "DELETE" });
  showStatus(`API Key「${key.name}」已删除`);
  await loadAll();
}

function mcpConfigText(client, format, secret) {
  const token = secret || "<API Key>";
  if (format === "fields") {
    return [`名称: weknora`, `服务器 URL: ${client.mcpUrl}`, `Auth Token: Bearer ${token}`].join("\n");
  }
  const server = {
    type: "http",
    url: client.mcpUrl,
    headers: { Authorization: `Bearer ${token}` },
  };
  return JSON.stringify(format === "mcpServers" ? { mcpServers: { weknora: server } } : server, null, 2);
}

function renderTokenConnection(parent, client) {
  const created =
    state.createdKey?.clientKey === client.key ? state.createdKey : null;
  const connection = group("连接信息");
  connection.body.append(
    valueRow("服务器 URL", client.mcpUrl, true),
    row("认证方式", "静态 Bearer API Key，不需要 OAuth 登录；所有 Key 共用下方的权限设置"),
  );
  parent.append(connection.section);

  const keys = group("API Key", `${client.keys.length} 个`);
  const createRow = el("div", "row row-stack");
  const createMain = el("div", "row-main");
  appendText(createMain, "span", "row-title", "新建 API Key");
  appendText(
    createMain,
    "span",
    "row-description",
    "每个应用单独建一个，例如“小米手机”“LobeHub”“Codeg”。Key 只在创建后显示一次，旧 Key 不能查看，丢失时新建即可。",
  );
  const nameInput = el("input", "text-input");
  nameInput.placeholder = "名称，例如 Codeg";
  nameInput.maxLength = 60;
  nameInput.setAttribute("aria-label", "API Key 名称");
  const createButton = button("新建 Key", "primary", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    createButton.disabled = true;
    try {
      await createApiKey(client, name);
    } catch {
      showStatus("创建 API Key 失败", true);
      createButton.disabled = false;
    }
  });
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") createButton.click();
  });
  createRow.append(createMain, nameInput, createButton);
  keys.body.append(createRow);

  if (created) {
    const createdRow = el("div", "row row-stack created-key");
    const main = el("div", "row-main");
    appendText(main, "span", "row-title", `新 Key「${created.name}」`);
    appendText(main, "span", "row-description", "请立即复制保存，刷新页面后不再显示。");
    const value = el("code", "secret-value", created.secret);
    const copy = button("复制 Key", "secondary", async () => {
      await navigator.clipboard.writeText(created.secret);
      showStatus("API Key 已复制");
    });
    createdRow.append(main, value, copy);
    keys.body.append(createdRow);
  }

  if (client.keys.length === 0) {
    keys.body.append(row("还没有 API Key", "新建一个后即可在客户端中接入"));
  }
  for (const key of client.keys) {
    const actions = el("div", "row-actions");
    actions.append(
      switchControl(key.enabled, `启用 ${key.name}`, false, (checked, input) =>
        confirmAction(
          `${checked ? "启用" : "停用"} API Key「${key.name}」`,
          checked ? "该 Key 将重新可用。" : "停用后使用该 Key 的请求会被拒绝，可随时重新启用。",
          checked ? "确认启用" : "确认停用",
          () => setApiKeyEnabled(client, key, checked),
          {
            danger: !checked,
            onCancel: () => {
              input.checked = key.enabled;
            },
          },
        ),
      ),
      button("删除", "danger", () =>
        confirmAction(
          `删除 API Key「${key.name}」`,
          "删除后使用该 Key 的客户端立即无法访问，且无法恢复。",
          "确认删除",
          () => deleteApiKey(client, key),
          { danger: true },
        ),
      ),
    );
    actions.lastChild.classList.add("button-small");
    keys.body.append(
      row(
        key.name,
        `创建于 ${formatDate(key.createdAt)} · ${key.enabled ? "已启用" : "已停用"}`,
        actions,
        `wrap-mobile${key.enabled ? "" : " disabled"}`,
      ),
    );
  }
  parent.append(keys.section);

  const config = group("MCP 配置 (JSON)", created ? `已填入「${created.name}」` : "将 <API Key> 替换为你的 Key");
  const formats = el("div", "segmented-control");
  for (const [value, label] of CONFIG_FORMATS) {
    formats.append(
      createSegment(`${client.key}-config-format`, value, label, state.configFormat === value, false, () => {
        state.configFormat = value;
        render();
      }),
    );
  }
  const text = mcpConfigText(client, state.configFormat, created?.secret);
  const copyConfig = button("复制配置", "secondary", async () => {
    await navigator.clipboard.writeText(text);
    showStatus("MCP 配置已复制");
  });
  const toolbar = el("div", "row wrap-mobile");
  toolbar.append(formats, el("span", "row-main"), copyConfig);
  const pre = el("pre", "config-block", text);
  config.body.append(toolbar, pre);
  parent.append(config.section);
  appendText(
    parent,
    "div",
    "callout",
    "Codeg：设置 → MCP → 新建 MCP，粘贴 “Codeg / Claude Code” 格式；Cursor、Claude Desktop、Cherry Studio 等用 “mcpServers” 格式；小米手机按表单逐项填写。",
  );
}

function renderCapabilityControls(parent, client, draft) {
  const full = draft.accessType === "full";
  const { section, body } = group(
    "MCP 权限",
    full ? "可调用全部已审核官方工具" : "仅暴露已开启能力对应的工具",
  );
  const modes = el("div", "segmented-control");
  modes.append(
    createSegment(`${client.key}-access-type`, "capabilities", "按能力授权", !full, false, () => {
      draft.accessType = "capabilities";
      if (draft.capabilities.size === 0) draft.capabilities.add("knowledge.read");
      render();
    }),
    createSegment(`${client.key}-access-type`, "full", "全权限", full, false, () => {
      draft.accessType = "full";
      draft.knowledgeBaseScope = "all";
      render();
    }),
  );
  body.append(
    row("授权方式", full ? "包含写入、删除与管理操作" : "按能力组逐项开启", modes, "wrap-mobile"),
  );
  for (const capability of state.capabilities) {
    const [label, description] = CAPABILITY_LABELS[capability] || [capability, ""];
    body.append(
      row(
        label,
        `${description} · ${capability}`,
        switchControl(
          full || draft.capabilities.has(capability),
          `${client.label} ${label}`,
          full,
          (checked) => {
            if (checked) draft.capabilities.add(capability);
            else draft.capabilities.delete(capability);
            render();
          },
        ),
        full ? "disabled" : "",
      ),
    );
  }
  for (const label of UNSUPPORTED_CAPABILITIES) {
    body.append(
      row(label, "当前官方 MCP 无对应工具", switchControl(false, label, true, () => {}), "disabled"),
    );
  }
  parent.append(section);
  if (full) {
    appendText(
      parent,
      "div",
      "callout warning",
      "全权限会开放写入、删除和管理类工具，并允许访问全部知识库，只应授予可信客户端。",
    );
  }
}

function renderKnowledgeControls(parent, client, draft) {
  const full = draft.accessType === "full";
  const allScope = full || draft.knowledgeBaseScope === "all";
  const { section, body } = group(
    "知识库范围",
    allScope ? "全部知识库" : `已选择 ${draft.allowedKbIds.size} 个`,
  );
  const scope = el("div", "segmented-control");
  scope.append(
    createSegment(`${client.key}-kb-scope`, "selected", "指定知识库", !allScope, full, () => {
      draft.knowledgeBaseScope = "selected";
      if (draft.allowedKbIds.size === 0 && draft.defaultKbId) {
        draft.allowedKbIds.add(draft.defaultKbId);
      }
      render();
    }),
    createSegment(`${client.key}-kb-scope`, "all", "全部知识库", allScope, full, () => {
      draft.knowledgeBaseScope = "all";
      render();
    }),
  );
  body.append(row("访问范围", "限制检索和写入可触达的知识库", scope, "wrap-mobile"));

  const defaultSelect = el("select", "select");
  defaultSelect.style.maxWidth = "240px";
  defaultSelect.setAttribute("aria-label", `${client.label} 默认知识库`);
  for (const kb of state.overview.knowledgeBases) {
    const option = el("option", "", kb.name);
    option.value = kb.id;
    option.selected = kb.id === draft.defaultKbId;
    defaultSelect.append(option);
  }
  defaultSelect.addEventListener("change", () => {
    draft.defaultKbId = defaultSelect.value;
    if (draft.knowledgeBaseScope === "selected") draft.allowedKbIds.add(defaultSelect.value);
    render();
  });
  body.append(row("默认知识库", "检索工具未指定知识库时使用", defaultSelect, "wrap-mobile"));

  for (const kb of state.overview.knowledgeBases) {
    const node = el("div", `row knowledge-row${allScope ? " disabled" : ""}`);
    const allowed = document.createElement("input");
    allowed.type = "checkbox";
    allowed.checked = allScope || draft.allowedKbIds.has(kb.id);
    allowed.disabled = allScope;
    allowed.setAttribute("aria-label", `${client.label} 允许 ${kb.name}`);
    allowed.addEventListener("change", () => {
      if (allowed.checked) draft.allowedKbIds.add(kb.id);
      else draft.allowedKbIds.delete(kb.id);
      if (!draft.allowedKbIds.has(draft.defaultKbId)) {
        draft.defaultKbId = draft.allowedKbIds.values().next().value || "";
      }
      render();
    });
    const names = el("div", "row-main");
    appendText(names, "span", "row-title", kb.name);
    appendText(names, "span", "row-value", kb.id);
    const defaultControl = el("label", "default-control");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `${client.key}-default-kb`;
    radio.checked = draft.defaultKbId === kb.id;
    radio.addEventListener("change", () => {
      draft.defaultKbId = kb.id;
      if (draft.knowledgeBaseScope === "selected") draft.allowedKbIds.add(kb.id);
      render();
    });
    defaultControl.append(radio, document.createTextNode("默认"));
    node.append(allowed, names, defaultControl);
    body.append(node);
  }
  parent.append(section);
}

function renderSecurity(parent, client) {
  if (isToken(client)) return;
  const { section, body } = group("安全");
  section.classList.add("danger-zone");
  body.append(
    row(
      "轮换 Secret",
      "生成新的 Client Secret，现有 Secret 立即失效，新值只显示一次",
      button("轮换 Secret", "secondary", () =>
        confirmAction(
          `轮换 Secret：${client.label}`,
          "现有 Client Secret 将失效，新密钥只显示一次。",
          "确认生成",
          () => rotateSecret(client),
        ),
      ),
      "wrap-mobile",
    ),
    row(
      "撤销会话",
      `撤销 ${client.sessionCount} 个活跃登录会话`,
      button("撤销会话", "danger", () =>
        confirmAction(
          `撤销 ${client.label} 会话`,
          `将撤销当前 ${client.sessionCount} 个活跃会话。`,
          "确认撤销",
          () => revokeSessions(client),
          { danger: true },
        ),
      ),
      "wrap-mobile",
    ),
  );
  parent.append(section);
}

function renderSaveBar(parent, client, draft) {
  const dirty = policyIsDirty(client, draft);
  const valid = policyIsValid(draft);
  const bar = el("div", `save-bar${dirty ? "" : " idle"}`);
  const summary =
    draft.accessType === "full"
      ? "全权限模式"
      : `${draft.capabilities.size} 项能力 · ${
          draft.knowledgeBaseScope === "all" ? "全部知识库" : `${draft.allowedKbIds.size} 个知识库`
        }`;
  appendText(
    bar,
    "span",
    "",
    !valid ? `${summary} · 配置不完整` : dirty ? `${summary} · 有未保存的更改` : `${summary} · 已保存`,
  );
  const actions = el("div", "dialog-actions");
  actions.style.margin = "0";
  const reset = button("撤销更改", "ghost", () => {
    state.drafts.delete(client.key);
    render();
  });
  reset.disabled = !dirty;
  const savePolicy = button("应用 MCP 权限", "primary", () =>
    confirmAction(
      `更新 ${client.label} MCP 权限`,
      draft.accessType === "full"
        ? "该客户端将可调用全部已审核官方工具并访问全部知识库。"
        : `该客户端将启用 ${draft.capabilities.size} 项能力。`,
      "确认应用",
      () => saveAccessPolicy(client, draft),
      { danger: draft.accessType === "full" },
    ),
  );
  savePolicy.disabled = !dirty || !valid;
  actions.append(reset, savePolicy);
  bar.append(actions);
  parent.append(bar);
}

function renderClientView(client) {
  const draft = draftFor(client);
  const view = elements.clientView;
  view.replaceChildren();
  renderHero(view, client);
  if (isToken(client)) renderTokenConnection(view, client);
  else renderOauthConnection(view, client, draft);
  renderCapabilityControls(view, client, draft);
  renderKnowledgeControls(view, client, draft);
  renderSecurity(view, client);
  renderSaveBar(view, client, draft);
}

function render() {
  renderNav();
  const client = state.clients.find(({ key }) => key === state.view);
  elements.overviewView.hidden = Boolean(client);
  elements.clientView.hidden = !client;
  elements.title.textContent = client ? client.label : "概览";
  document.title = client ? `${client.label} · WeKnora MCP 管理` : "WeKnora MCP 管理";
  if (client) renderClientView(client);
  else renderOverview();
}

async function loadAll(showMessage = false) {
  elements.list.setAttribute("aria-busy", "true");
  elements.refresh.disabled = true;
  try {
    const [session, overview, oauth] = await Promise.all([
      request("/mcp-console/api/session"),
      request("/mcp-console/api/overview"),
      request("/mcp-console/api/oauth-clients"),
    ]);
    state.session = session;
    state.overview = overview;
    state.clients = oauth.clients;
    state.capabilities = oauth.capabilities;
    state.drafts.clear();
    elements.user.textContent = session.username;
    elements.avatar.textContent = (session.username || "A").slice(0, 1);
    const requested = window.location.hash.slice(1) || state.view;
    state.view = state.clients.some(({ key }) => key === requested) ? requested : "overview";
    render();
    if (showMessage) showStatus("状态已刷新");
  } catch (error) {
    if (error.message !== "authentication_required") {
      showStatus("管理数据加载失败", true);
    }
  } finally {
    elements.list.setAttribute("aria-busy", "false");
    elements.refresh.disabled = false;
  }
}

elements.navOverview.addEventListener("click", () => selectView("overview"));
elements.openSidebar.addEventListener("click", () => setSidebar(true));
elements.closeSidebar.addEventListener("click", () => setSidebar(false));
elements.scrim.addEventListener("click", () => setSidebar(false));
window.addEventListener("hashchange", () => {
  const view = window.location.hash.slice(1);
  if (view && view !== state.view) selectView(view);
});
elements.refresh.addEventListener("click", () => loadAll(true));
elements.logout.addEventListener("click", async () => {
  try {
    await request("/mcp-console/logout", {
      method: "POST",
      headers: { "x-csrf-token": state.session.csrfToken },
    });
    window.location.assign("/mcp-console/login");
  } catch (error) {
    if (error.message !== "authentication_required") showStatus("退出失败", true);
  }
});
elements.confirmDialog.addEventListener("close", async () => {
  const action = state.pendingAction;
  const cancel = state.pendingCancel;
  state.pendingAction = null;
  state.pendingCancel = null;
  if (elements.confirmDialog.returnValue !== "confirm" || !action) {
    cancel?.();
    return;
  }
  elements.confirmAction.disabled = true;
  try {
    await action();
  } catch {
    cancel?.();
    showStatus("操作失败，请检查服务状态", true);
  } finally {
    elements.confirmAction.disabled = false;
  }
});
elements.copySecret.addEventListener("click", async () => {
  await navigator.clipboard.writeText(elements.secretValue.value);
  showStatus(`${elements.secretLabel.textContent} 已复制`);
});
elements.secretDialog.addEventListener("close", () => {
  elements.secretValue.value = "";
});

loadAll();
