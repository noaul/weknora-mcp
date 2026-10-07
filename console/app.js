const CAPABILITY_LABELS = {
  "knowledge.read": ["读取与检索", "知识库读取、混合检索、Wiki 和文档查询"],
  "conversation.use": ["对话与会话", "创建会话、对话，列出和管理自己创建的会话"],
  "knowledge.write": ["导入与更新知识", "从文件、URL 或文本导入，更新手动知识"],
  "knowledge.manage": ["删除与管理知识库", "创建、删除和管理知识库"],
  "agents.read": ["Agent 查询", "读取 Agent 并以 Agent 对话"],
  "models.manage": ["模型配置", "读取与配置模型"],
  "tenants.manage": ["租户管理", "列出与创建 WeKnora 租户"],
};

const UNSUPPORTED_CAPABILITIES = ["WeKnora 租户 API Key 管理", "租户成员管理"];

const CONFIG_FORMATS = [
  ["http", "HTTP 配置"],
  ["mcpServers", "mcpServers"],
  ["fields", "表单字段"],
];

const EXAMPLE_KEY = "wkmcp_xxxxxxxxxxxxxxxx";

const ICONS = {
  copy: "M9 9h10v10H9zM5 15V5h10",
  chevron: "M9 6l6 6-6 6",
  connection:
    "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  key: "M7 15a4 4 0 1 1 3.87-5H21v3h-2v2h-3v-2h-5.13A4 4 0 0 1 7 15zM7 11.5v.01",
  plus: "M12 5v14M5 12h14",
  edit: "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4",
  expand: "M6 9l6 6 6-6",
};

const state = {
  session: null,
  overview: null,
  data: null,
  drafts: new Map(),
  view: "overview",
  tab: "connection",
  pendingAction: null,
  pendingCancel: null,
  // Secrets shown once after creation or rotation; never persisted.
  revealed: new Map(),
  configFormat: "http",
  connectionExpanded: false,
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
  integrationView: document.querySelector("#client-view"),
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
  secretLabel: document.querySelector("#oauth-secret-label"),
  copySecret: document.querySelector("#copy-oauth-secret"),
};

/* Utilities */

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { Accept: "application/json", ...(options.headers || {}) },
  });
  if (response.status === 401) {
    window.location.assign("/mcp-console/login");
    throw new Error("authentication_required");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `request_failed_${response.status}`);
  return payload;
}

function mutate(path, method, body) {
  return request(path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      "x-csrf-token": state.session.csrfToken,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
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

function button(label, variant = "secondary", onClick, iconPath) {
  const node = el("button", `button button-${variant}`);
  node.type = "button";
  if (iconPath) node.append(icon(iconPath));
  node.append(document.createTextNode(label));
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

async function copyText(value, label) {
  await navigator.clipboard.writeText(value);
  showStatus(`${label} 已复制`);
}

function copyButton(value, label) {
  const copy = el("button", "icon-button copy-button");
  copy.type = "button";
  copy.title = `复制 ${label}`;
  copy.setAttribute("aria-label", `复制 ${label}`);
  copy.append(icon(ICONS.copy));
  copy.addEventListener("click", () => copyText(value, label));
  return copy;
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
  if (copyable && value) node.append(copyButton(value, title));
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

function badge(text, tone = "") {
  return el("span", `badge ${tone}`.trim(), text);
}

/* Model */

function integrations() {
  return state.data?.integrations || [];
}

function currentIntegration() {
  return integrations().find(({ id }) => id === state.view);
}

function credentialStatus(credential) {
  if (!credential.exists) {
    return badge(credential.kind === "token" ? "Key 缺失" : "Keycloak 中缺失", "off");
  }
  return credential.enabled ? badge("已启用", "ok") : badge("已停用", "off");
}

function accessSummary(access) {
  const mode = access.accessType === "full" ? "全权限" : `${access.capabilities.length} 项能力`;
  const scope =
    access.accessType === "full" || access.knowledgeBaseScope === "all"
      ? "全部知识库"
      : `${access.knowledgeBases.length} 个知识库`;
  return `${mode} · ${scope}`;
}

function initialDraft(credential) {
  return {
    accessType: credential.access.accessType,
    capabilities: new Set(credential.access.capabilities),
    knowledgeBaseScope: credential.access.knowledgeBaseScope,
    defaultKbId: credential.access.defaultKbId,
    allowedKbIds: new Set(credential.access.knowledgeBases.map(({ id }) => id)),
  };
}

function draftFor(credential) {
  if (!state.drafts.has(credential.clientId)) {
    state.drafts.set(credential.clientId, initialDraft(credential));
  }
  return state.drafts.get(credential.clientId);
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

function policyIsDirty(credential, draft) {
  return (
    JSON.stringify(policyPayload(draft)) !==
    JSON.stringify(policyPayload(initialDraft(credential)))
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

function mcpConfigText(format, secret) {
  const token = secret || EXAMPLE_KEY;
  const url = state.data.mcpUrl;
  if (format === "fields") {
    return [`名称: weknora`, `服务器 URL: ${url}`, `Auth Token: Bearer ${token}`].join("\n");
  }
  const server = { type: "http", url, headers: { Authorization: `Bearer ${token}` } };
  return JSON.stringify(
    format === "mcpServers" ? { mcpServers: { weknora: server } } : server,
    null,
    2,
  );
}

/* Actions */

function confirmAction(title, summary, actionLabel, action, options = {}) {
  state.pendingAction = action;
  state.pendingCancel = options.onCancel || null;
  elements.confirmTitle.textContent = title;
  elements.confirmSummary.textContent = summary;
  elements.confirmAction.textContent = actionLabel;
  elements.confirmAction.className = `button ${options.danger ? "button-danger-solid" : "button-primary"}`;
  elements.confirmDialog.returnValue = "";
  elements.confirmDialog.showModal();
}

const credentialPath = (credential, suffix = "") =>
  `/mcp-console/api/credentials/${encodeURIComponent(credential.clientId)}${suffix}`;

async function saveAccessPolicy(credential, draft) {
  await mutate(credentialPath(credential, "/access-policy"), "PUT", policyPayload(draft));
  state.drafts.delete(credential.clientId);
  showStatus(`「${credential.label}」的权限已更新`);
  await loadAll();
}

async function updateCredential(credential, update, message) {
  await mutate(credentialPath(credential), "PUT", update);
  showStatus(message);
  await loadAll();
}

async function rotateCredential(credential) {
  const result = await mutate(credentialPath(credential, "/rotate-secret"), "POST");
  state.revealed.set(credential.clientId, { secret: result.secret, kind: credential.kind });
  showStatus(credential.kind === "token" ? "已生成新的 API Key" : "已生成新的 Client Secret");
  await loadAll();
}

async function revokeSessions(credential) {
  const result = await mutate(credentialPath(credential, "/revoke-sessions"), "POST");
  showStatus(`已撤销 ${result.revokedSessions} 个会话`);
  await loadAll();
}

async function deleteCredential(credential) {
  await mutate(credentialPath(credential), "DELETE");
  state.revealed.delete(credential.clientId);
  state.drafts.delete(credential.clientId);
  state.tab = "connection";
  showStatus(`「${credential.label}」已删除`);
  await loadAll();
}

async function createCredential(integration, body) {
  const result = await mutate(
    `/mcp-console/api/integrations/${integration.id}/credentials`,
    "POST",
    body,
  );
  state.revealed.set(result.clientId, { secret: result.secret, kind: result.kind });
  state.tab = result.clientId;
  showStatus(`已创建「${body.label}」`);
  await loadAll();
}

/* Navigation */

function setSidebar(open) {
  elements.shell.classList.toggle("sidebar-visible", open);
  elements.scrim.hidden = !open;
}

function writeHash() {
  const hash = state.view === "overview" ? "#overview" : `#${state.view}/${state.tab}`;
  if (window.location.hash !== hash) history.replaceState(null, "", hash);
}

function readHash() {
  const [view, ...rest] = decodeURIComponent(window.location.hash.slice(1)).split("/");
  return { view: view || "overview", tab: rest.join("/") || "connection" };
}

function selectView(view, tab = "connection") {
  state.view = integrations().some(({ id }) => id === view) ? view : "overview";
  state.tab = tab;
  setSidebar(false);
  render();
  window.scrollTo({ top: 0 });
}

function selectTab(tab) {
  state.tab = tab;
  render();
}

function integrationAvatar(integration, large = false) {
  const initial = { chatgpt: "G", claude: "C", apikey: "K" }[integration.id] || "?";
  return el("span", `client-avatar avatar-${integration.id}${large ? " large" : ""}`, initial);
}

function renderNav() {
  elements.list.replaceChildren();
  elements.empty.hidden = integrations().length > 0;
  if (state.view === "overview") elements.navOverview.setAttribute("aria-current", "page");
  else elements.navOverview.removeAttribute("aria-current");
  for (const integration of integrations()) {
    const item = el("button", "nav-item");
    item.type = "button";
    if (state.view === integration.id) item.setAttribute("aria-current", "page");
    item.append(integrationAvatar(integration), el("span", "nav-name", integration.label));
    const enabled = integration.credentials.filter(({ enabled }) => enabled).length;
    appendText(item, "span", "nav-count", String(integration.credentials.length));
    item.title = `${enabled} / ${integration.credentials.length} 个凭据已启用`;
    item.addEventListener("click", () => selectView(integration.id));
    elements.list.append(item);
  }
}

/* Overview */

function renderOverview() {
  const credentials = integrations().flatMap(({ credentials }) => credentials);
  const enabled = credentials.filter(({ enabled }) => enabled).length;
  const sessions = credentials.reduce((sum, { sessionCount = 0 }) => sum + sessionCount, 0);
  elements.enabledCount.textContent = `${enabled} / ${credentials.length}`;
  elements.sessionCount.textContent = String(sessions);

  elements.services.replaceChildren();
  const status = state.overview?.services?.gateway;
  elements.services.append(
    row(
      "MCP 网关",
      `统一入口 ${state.data.mcpUrl}`,
      status === "healthy" ? badge("正常", "ok") : badge("不可用", "off"),
    ),
  );
  if (state.data.oauth.unavailable) {
    elements.services.append(row("Keycloak", "OAuth 凭据状态暂时无法读取", badge("不可用", "off")));
  }
  elements.updated.textContent = `更新于 ${new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date())}`;

  elements.overviewClients.replaceChildren();
  for (const integration of integrations()) {
    const node = el("div", "row clickable");
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    const main = el("div", "row-main");
    appendText(main, "span", "row-title", integration.label);
    const names = integration.credentials.map(({ label }) => label).join("、");
    appendText(
      main,
      "span",
      "row-description",
      `${integration.kind === "oauth" ? "OAuth 授权" : "API Key"} · ${
        integration.credentials.length
      } 个凭据${names ? `：${names}` : ""}`,
    );
    const chevron = el("span", "chevron");
    chevron.append(icon(ICONS.chevron));
    node.append(integrationAvatar(integration), main, chevron);
    node.addEventListener("click", () => selectView(integration.id));
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectView(integration.id);
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
  for (const record of audit.slice(0, 12)) {
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

/* Integration view */

function renderTabs(parent, integration) {
  const bar = el("div", "tabs");
  bar.setAttribute("role", "tablist");
  const tab = (id, label, iconPath, extra) => {
    const node = el("button", "tab");
    node.type = "button";
    node.setAttribute("role", "tab");
    node.setAttribute("aria-selected", String(state.tab === id));
    node.append(icon(iconPath), el("span", "tab-label", label));
    if (extra) node.append(extra);
    node.addEventListener("click", () => selectTab(id));
    bar.append(node);
    return node;
  };
  tab("connection", "连接信息", ICONS.connection);
  for (const credential of integration.credentials) {
    tab(
      credential.clientId,
      credential.label,
      ICONS.key,
      el("span", `status-dot${credential.enabled && credential.exists ? " on" : ""}`),
    );
  }
  tab("new", integration.kind === "oauth" ? "新增凭据" : "新增 Key", ICONS.plus).classList.add(
    "tab-add",
  );
  parent.append(bar);
}

function renderConfigBlock(secret, note) {
  const wrapper = el("div", "config");
  const toolbar = el("div", "config-toolbar");
  const formats = el("div", "segmented-control");
  for (const [value, label] of CONFIG_FORMATS) {
    formats.append(
      createSegment("config-format", value, label, state.configFormat === value, false, () => {
        state.configFormat = value;
        render();
      }),
    );
  }
  const text = mcpConfigText(state.configFormat, secret);
  const copy = button("复制", "secondary", () => copyText(text, "MCP 配置"), ICONS.copy);
  copy.classList.add("button-small");
  toolbar.append(formats, el("span", "spacer"), copy);
  wrapper.append(toolbar);
  if (note) appendText(wrapper, "p", "config-note", note);
  wrapper.append(el("pre", "config-block", text));
  return wrapper;
}

function renderConnectionTab(parent, integration) {
  const oauth = integration.kind === "oauth";
  const card = el("section", "card");
  const header = el("div", "card-header");
  const title = el("div", "card-title");
  appendText(title, "h2", "", "连接信息");
  appendText(
    title,
    "span",
    "muted",
    oauth
      ? `所有 ${integration.label} 凭据共用以下地址，每个凭据有独立的 Client ID 和权限`
      : "所有 API Key 共用以下地址，每个 Key 有独立的权限",
  );
  const toggle = button(
    state.connectionExpanded ? "收起" : "展开详情",
    "ghost",
    () => {
      state.connectionExpanded = !state.connectionExpanded;
      render();
    },
    ICONS.expand,
  );
  toggle.classList.add("button-small", "expand-toggle");
  toggle.setAttribute("aria-expanded", String(state.connectionExpanded));
  header.append(title, toggle);
  card.append(header);

  const body = el("div", "card-body");
  body.append(
    valueRow("MCP 地址", state.data.mcpUrl, true),
    row(
      "认证方式",
      oauth
        ? `OAuth 2.0 授权码 + PKCE，Scope ${state.data.scope}`
        : "Bearer API Key（请求头 Authorization: Bearer <Key>）",
    ),
  );
  if (state.connectionExpanded) {
    if (oauth) {
      body.append(
        valueRow("Scope", state.data.scope, true),
        valueRow("Issuer", state.data.oauth.issuer, true),
        valueRow("Authorization URL", state.data.oauth.authorizationEndpoint, true),
        valueRow("Token URL", state.data.oauth.tokenEndpoint, true),
        valueRow("默认回调 URL", integration.defaultRedirectUri, true),
      );
    } else {
      const configRow = el("div", "row row-block");
      configRow.append(renderConfigBlock(undefined, "示例配置：将 Key 替换为对应凭据的 Key"));
      body.append(configRow);
    }
  }
  card.append(body);
  parent.append(card);

  const guide = el("section", "card subtle");
  appendText(guide, "h3", "card-subtitle", "接入步骤");
  const steps = el("ol", "steps");
  const items = oauth
    ? [
        `在“新增凭据”中为每个 ${integration.label} 账号或用途创建一个凭据，并复制 Client Secret`,
        `在 ${integration.label} 中添加自定义连接器，填写 MCP 地址、Client ID 与 Client Secret`,
        "若连接器显示的回调地址与默认值不同，在凭据页修改回调 URL",
        "在凭据页配置权限与知识库范围",
      ]
    : [
        "在“新增 Key”中为每个应用（小米手机、LobeHub、Codeg……）创建一个 Key",
        "创建后复制带 Key 的配置，粘贴到对应应用",
        "在 Key 页配置权限与知识库范围，可随时停用、轮换或删除",
      ];
  for (const text of items) appendText(steps, "li", "", text);
  guide.append(steps);
  parent.append(guide);
}

function renderRevealed(parent, credential) {
  const revealed = state.revealed.get(credential.clientId);
  if (!revealed) return;
  const token = revealed.kind === "token";
  const card = el("section", "card reveal");
  const header = el("div", "card-header");
  const title = el("div", "card-title");
  appendText(title, "h2", "", token ? "新 API Key" : "新 Client Secret");
  appendText(title, "span", "muted", "只显示这一次，刷新或离开页面后无法再次查看");
  const dismiss = button("我已保存", "ghost", () => {
    state.revealed.delete(credential.clientId);
    render();
  });
  dismiss.classList.add("button-small");
  header.append(title, dismiss);
  const secretRow = el("div", "secret-row");
  secretRow.append(
    el("code", "secret-value", revealed.secret),
    copyButton(revealed.secret, token ? "API Key" : "Client Secret"),
  );
  card.append(header, secretRow);
  if (token) {
    card.append(renderConfigBlock(revealed.secret, "已填入该 Key，可直接粘贴"));
  } else {
    const fields = el("div", "card-body");
    fields.append(
      valueRow("Client ID", credential.clientId, true),
      valueRow("MCP 地址", state.data.mcpUrl, true),
    );
    card.append(fields);
  }
  parent.append(card);
}

function renderCredentialHeader(parent, integration, credential) {
  const header = el("div", "credential-header");
  const text = el("div", "credential-title");
  const titleRow = el("div", "credential-title-row");
  appendText(titleRow, "h2", "", credential.label);
  const rename = el("button", "icon-button icon-button-small");
  rename.type = "button";
  rename.title = "重命名";
  rename.setAttribute("aria-label", "重命名");
  rename.append(icon(ICONS.edit));
  rename.addEventListener("click", () => {
    const label = window.prompt("凭据名称（用途）", credential.label)?.trim();
    if (label && label !== credential.label) {
      updateCredential(credential, { label }, "名称已更新").catch(() =>
        showStatus("重命名失败", true),
      );
    }
  });
  titleRow.append(rename, credentialStatus(credential));
  const meta = el("div", "credential-meta");
  appendText(meta, "code", "", credential.clientId);
  meta.append(copyButton(credential.clientId, credential.kind === "oauth" ? "Client ID" : "凭据 ID"));
  appendText(meta, "span", "muted", accessSummary(credential.access));
  text.append(titleRow, meta);

  const toggle = switchControl(
    credential.enabled,
    `启用 ${credential.label}`,
    !credential.exists,
    (checked, input) =>
      confirmAction(
        `${checked ? "启用" : "停用"}「${credential.label}」`,
        checked
          ? "该凭据将重新可用。"
          : credential.kind === "token"
            ? "停用后使用该 Key 的请求会被拒绝，可随时重新启用。"
            : "停用后该 OAuth 客户端无法发起新的登录。",
        checked ? "确认启用" : "确认停用",
        () =>
          updateCredential(
            credential,
            { enabled: checked },
            `「${credential.label}」已${checked ? "启用" : "停用"}`,
          ),
        {
          danger: !checked,
          onCancel: () => {
            input.checked = credential.enabled;
          },
        },
      ),
  );
  header.append(integrationAvatar(integration, true), text, toggle);
  parent.append(header);
}

function renderCredentialSettings(parent, credential) {
  const oauth = credential.kind === "oauth";
  const { section, body } = group(oauth ? "OAuth 凭据" : "API Key");
  if (oauth) {
    body.append(
      valueRow("Client ID", credential.clientId, true),
      row(
        "Client Secret",
        "现有 Secret 不可查看，轮换后旧 Secret 立即失效",
        button("轮换 Secret", "secondary", () =>
          confirmAction(
            `轮换「${credential.label}」的 Client Secret`,
            "现有 Client Secret 将立即失效，需要在客户端中更新。",
            "确认轮换",
            () => rotateCredential(credential),
          ),
        ),
        "wrap-mobile",
      ),
    );
    const redirectRow = el("div", "row row-stack");
    const main = el("div", "row-main");
    appendText(main, "span", "row-title", "回调 URL");
    appendText(main, "span", "row-description", "必须与客户端显示的回调地址完全一致");
    const input = el("input", "text-input");
    input.type = "url";
    input.value = credential.redirectUri;
    input.spellcheck = false;
    input.setAttribute("aria-label", `${credential.label} 回调 URL`);
    const save = button("保存", "primary", () => {
      if (!input.reportValidity()) return;
      updateCredential(credential, { redirectUri: input.value }, "回调 URL 已更新").catch(() =>
        showStatus("保存回调 URL 失败", true),
      );
    });
    save.disabled = true;
    input.addEventListener("input", () => {
      save.disabled = input.value === credential.redirectUri;
    });
    redirectRow.append(main, input, save);
    body.append(
      redirectRow,
      row(
        "活跃会话",
        `${credential.sessionCount} 个登录会话`,
        button("撤销会话", "secondary", () =>
          confirmAction(
            `撤销「${credential.label}」的会话`,
            `将撤销 ${credential.sessionCount} 个活跃会话，客户端需重新授权。`,
            "确认撤销",
            () => revokeSessions(credential),
            { danger: true },
          ),
        ),
        "wrap-mobile",
      ),
    );
  } else {
    body.append(
      row("创建时间", formatDate(credential.createdAt)),
      row(
        "Key",
        "旧 Key 不可查看；丢失时轮换生成新 Key，权限保持不变",
        button("轮换 Key", "secondary", () =>
          confirmAction(
            `轮换「${credential.label}」`,
            "旧 Key 将立即失效，新 Key 只显示一次。",
            "确认轮换",
            () => rotateCredential(credential),
          ),
        ),
        "wrap-mobile",
      ),
    );
  }
  parent.append(section);
}

function renderCapabilityControls(parent, credential, draft) {
  const full = draft.accessType === "full";
  const { section, body } = group(
    "MCP 权限",
    full ? "可调用全部已审核官方工具" : "仅暴露已开启能力对应的工具",
  );
  const modes = el("div", "segmented-control");
  modes.append(
    createSegment(`${credential.clientId}-access`, "capabilities", "按能力授权", !full, false, () => {
      draft.accessType = "capabilities";
      if (draft.capabilities.size === 0) draft.capabilities.add("knowledge.read");
      render();
    }),
    createSegment(`${credential.clientId}-access`, "full", "全权限", full, false, () => {
      draft.accessType = "full";
      draft.knowledgeBaseScope = "all";
      render();
    }),
  );
  body.append(
    row("授权方式", full ? "包含写入、删除与管理操作" : "按能力逐项开启", modes, "wrap-mobile"),
  );
  for (const capability of state.data.capabilities) {
    const [label, description] = CAPABILITY_LABELS[capability] || [capability, ""];
    const node = row(
      label,
      description,
      switchControl(
        full || draft.capabilities.has(capability),
        `${credential.label} ${label}`,
        full,
        (checked) => {
          if (checked) draft.capabilities.add(capability);
          else draft.capabilities.delete(capability);
          render();
        },
      ),
      full ? "disabled" : "",
    );
    appendText(node.querySelector(".row-title"), "code", "capability-id", capability);
    body.append(node);
  }
  for (const label of UNSUPPORTED_CAPABILITIES) {
    body.append(row(label, "官方 MCP 暂无对应工具", badge("不支持"), "disabled"));
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

function renderKnowledgeControls(parent, credential, draft) {
  const full = draft.accessType === "full";
  const allScope = full || draft.knowledgeBaseScope === "all";
  const { section, body } = group(
    "知识库范围",
    allScope ? "全部知识库" : `已选择 ${draft.allowedKbIds.size} 个`,
  );
  const scope = el("div", "segmented-control");
  scope.append(
    createSegment(`${credential.clientId}-kb`, "selected", "指定知识库", !allScope, full, () => {
      draft.knowledgeBaseScope = "selected";
      if (draft.allowedKbIds.size === 0 && draft.defaultKbId) draft.allowedKbIds.add(draft.defaultKbId);
      render();
    }),
    createSegment(`${credential.clientId}-kb`, "all", "全部知识库", allScope, full, () => {
      draft.knowledgeBaseScope = "all";
      render();
    }),
  );
  body.append(row("访问范围", "限制检索和写入可触达的知识库", scope, "wrap-mobile"));

  const defaultSelect = el("select", "select");
  defaultSelect.setAttribute("aria-label", `${credential.label} 默认知识库`);
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
    const node = el("label", `row knowledge-row${allScope ? " disabled" : ""}`);
    const allowed = document.createElement("input");
    allowed.type = "checkbox";
    allowed.checked = allScope || draft.allowedKbIds.has(kb.id);
    allowed.disabled = allScope;
    allowed.setAttribute("aria-label", `${credential.label} 允许 ${kb.name}`);
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
    node.append(allowed, names);
    if (kb.id === draft.defaultKbId) node.append(badge("默认"));
    body.append(node);
  }
  parent.append(section);
}

function renderDangerZone(parent, credential) {
  const oauth = credential.kind === "oauth";
  const { section, body } = group("危险操作");
  section.classList.add("danger-zone");
  body.append(
    row(
      oauth ? "删除凭据" : "删除 Key",
      oauth
        ? "从 Keycloak 删除该 OAuth 客户端，已连接的客户端将无法再授权"
        : "删除后使用该 Key 的客户端立即无法访问，且无法恢复",
      button("删除", "danger", () =>
        confirmAction(
          `删除「${credential.label}」`,
          "该操作无法撤销，凭据的权限设置也会一并删除。",
          "确认删除",
          () => deleteCredential(credential),
          { danger: true },
        ),
      ),
      "wrap-mobile",
    ),
  );
  parent.append(section);
}

function renderSaveBar(parent, credential, draft) {
  if (!policyIsDirty(credential, draft)) return;
  const valid = policyIsValid(draft);
  const bar = el("div", "save-bar");
  const summary =
    draft.accessType === "full"
      ? "全权限"
      : `${draft.capabilities.size} 项能力 · ${
          draft.knowledgeBaseScope === "all" ? "全部知识库" : `${draft.allowedKbIds.size} 个知识库`
        }`;
  appendText(bar, "span", "", valid ? `${summary} · 有未保存的更改` : `${summary} · 配置不完整`);
  const actions = el("div", "bar-actions");
  const reset = button("撤销更改", "ghost", () => {
    state.drafts.delete(credential.clientId);
    render();
  });
  const save = button("应用权限", "primary", () =>
    confirmAction(
      `更新「${credential.label}」的权限`,
      draft.accessType === "full"
        ? "该凭据将可调用全部已审核官方工具并访问全部知识库。"
        : `该凭据将启用 ${draft.capabilities.size} 项能力。`,
      "确认应用",
      () => saveAccessPolicy(credential, draft),
      { danger: draft.accessType === "full" },
    ),
  );
  save.disabled = !valid;
  actions.append(reset, save);
  bar.append(actions);
  parent.append(bar);
}

function renderNewTab(parent, integration) {
  const oauth = integration.kind === "oauth";
  const card = el("section", "card");
  const header = el("div", "card-header");
  const title = el("div", "card-title");
  appendText(title, "h2", "", oauth ? `新增 ${integration.label} 凭据` : "新增 API Key");
  appendText(
    title,
    "span",
    "muted",
    oauth
      ? "创建独立的 OAuth 客户端；默认只读，只能访问默认知识库"
      : "为一个应用或用途创建独立的 Key；默认只读，只能访问默认知识库",
  );
  header.append(title);
  const form = el("form", "card-body form");
  const nameField = el("label", "field");
  appendText(nameField, "span", "field-label", "名称（用途）");
  const name = el("input", "text-input");
  name.required = true;
  name.maxLength = 60;
  name.placeholder = oauth ? "例如：工作账号" : "例如：Codeg";
  nameField.append(name);
  form.append(nameField);
  let redirect;
  if (oauth) {
    const redirectField = el("label", "field");
    appendText(redirectField, "span", "field-label", "回调 URL");
    redirect = el("input", "text-input");
    redirect.type = "url";
    redirect.required = true;
    redirect.spellcheck = false;
    redirect.value = integration.defaultRedirectUri;
    redirectField.append(redirect);
    appendText(
      redirectField,
      "span",
      "field-hint",
      `${integration.label} 的默认回调地址，创建后也可修改`,
    );
    form.append(redirectField);
  }
  const actions = el("div", "form-actions");
  const submit = el("button", "button button-primary", oauth ? "创建凭据" : "创建 Key");
  submit.type = "submit";
  actions.append(submit);
  form.append(actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await createCredential(integration, {
        label: name.value.trim(),
        ...(redirect ? { redirectUri: redirect.value } : {}),
      });
    } catch {
      showStatus("创建失败，请检查服务状态", true);
      submit.disabled = false;
    }
  });
  card.append(header, form);
  parent.append(card);
  window.setTimeout(() => name.focus(), 0);
}

function renderIntegration(integration) {
  const view = elements.integrationView;
  view.replaceChildren();
  const known = ["connection", "new", ...integration.credentials.map(({ clientId }) => clientId)];
  if (!known.includes(state.tab)) state.tab = "connection";

  const header = el("div", "page-header");
  const text = el("div", "page-header-text");
  appendText(text, "h2", "", integration.label);
  appendText(
    text,
    "span",
    "muted",
    `${integration.kind === "oauth" ? "OAuth 授权" : "API Key"} · ${
      integration.credentials.length
    } 个凭据 · 权限按凭据单独管理`,
  );
  header.append(integrationAvatar(integration, true), text);
  view.append(header);
  renderTabs(view, integration);

  const panel = el("div", "tab-panel");
  panel.setAttribute("role", "tabpanel");
  view.append(panel);
  if (state.tab === "connection") return renderConnectionTab(panel, integration);
  if (state.tab === "new") return renderNewTab(panel, integration);
  const credential = integration.credentials.find(({ clientId }) => clientId === state.tab);
  const draft = draftFor(credential);
  renderCredentialHeader(panel, integration, credential);
  renderRevealed(panel, credential);
  if (credential.exists) renderCredentialSettings(panel, credential);
  renderCapabilityControls(panel, credential, draft);
  renderKnowledgeControls(panel, credential, draft);
  renderDangerZone(panel, credential);
  renderSaveBar(panel, credential, draft);
}

function render() {
  renderNav();
  const integration = currentIntegration();
  elements.overviewView.hidden = Boolean(integration);
  elements.integrationView.hidden = !integration;
  elements.title.textContent = integration ? "MCP 接入" : "概览";
  document.title = integration ? `${integration.label} · WeKnora MCP 管理` : "WeKnora MCP 管理";
  if (integration) renderIntegration(integration);
  else renderOverview();
  writeHash();
}

async function loadAll(showMessage = false) {
  elements.list.setAttribute("aria-busy", "true");
  elements.refresh.disabled = true;
  try {
    const [session, overview, data] = await Promise.all([
      request("/mcp-console/api/session"),
      request("/mcp-console/api/overview"),
      request("/mcp-console/api/integrations"),
    ]);
    state.session = session;
    state.overview = overview;
    state.data = data;
    elements.user.textContent = session.username;
    elements.avatar.textContent = (session.username || "A").slice(0, 1);
    if (!integrations().some(({ id }) => id === state.view)) state.view = "overview";
    render();
    if (showMessage) showStatus("状态已刷新");
  } catch (error) {
    if (error.message !== "authentication_required") showStatus("管理数据加载失败", true);
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
  const { view, tab } = readHash();
  if (view !== state.view || tab !== state.tab) selectView(view, tab);
});
elements.refresh.addEventListener("click", () => {
  state.drafts.clear();
  loadAll(true);
});
elements.logout.addEventListener("click", async () => {
  try {
    await mutate("/mcp-console/logout", "POST");
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
elements.copySecret.addEventListener("click", () =>
  copyText(elements.secretValue.value, elements.secretLabel.textContent),
);
elements.secretDialog.addEventListener("close", () => {
  elements.secretValue.value = "";
});

({ view: state.view, tab: state.tab } = readHash());
loadAll();
