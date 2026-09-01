const CAPABILITY_LABELS = {
  "knowledge.read": "读取与检索",
  "conversation.use": "对话与会话",
  "knowledge.write": "导入与新建知识",
  "knowledge.manage": "删除与管理知识",
  "agents.read": "Agent 查询",
  "models.manage": "模型配置",
};

const state = {
  session: null,
  overview: null,
  clients: [],
  capabilities: [],
  drafts: new Map(),
  pendingAction: null,
};

const elements = {
  user: document.querySelector("#current-user"),
  list: document.querySelector("#oauth-client-list"),
  empty: document.querySelector("#oauth-empty-state"),
  refresh: document.querySelector("#refresh-oauth-clients"),
  enabledCount: document.querySelector("#oauth-enabled-count"),
  sessionCount: document.querySelector("#oauth-session-count"),
  services: document.querySelector("#service-status"),
  updated: document.querySelector("#last-updated"),
  audit: document.querySelector("#audit-list"),
  toast: document.querySelector("#app-status"),
  logout: document.querySelector("#logout"),
  confirmDialog: document.querySelector("#oauth-confirm-dialog"),
  confirmTitle: document.querySelector("#oauth-confirm-title"),
  confirmSummary: document.querySelector("#oauth-confirm-summary"),
  confirmAction: document.querySelector("#oauth-confirm-action"),
  secretDialog: document.querySelector("#oauth-secret-dialog"),
  secretValue: document.querySelector("#oauth-secret-value"),
  copySecret: document.querySelector("#copy-oauth-secret"),
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

function appendText(parent, tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  parent.append(node);
  return node;
}

function appendField(parent, label, value) {
  const field = document.createElement("div");
  field.className = "oauth-field";
  appendText(field, "span", "", label);
  appendText(field, "code", "", value || "-");
  parent.append(field);
}

function createSegment(name, value, label, checked, disabled, onChange) {
  const control = document.createElement("label");
  control.className = "segment";
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

function initialDraft(client) {
  return {
    enabled: client.enabled,
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

function renderServiceStatus() {
  elements.services.replaceChildren();
  const status = state.overview?.services?.gateway;
  const item = document.createElement("div");
  item.className = "service-item";
  appendText(item, "span", "service-name", "MCP 网关");
  appendText(
    item,
    "span",
    `status-label ${status === "healthy" ? "healthy" : ""}`,
    status === "healthy" ? "正常" : "不可用",
  );
  elements.services.append(item);
  elements.updated.textContent = `更新 ${new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date())}`;
}

function renderAudit() {
  elements.audit.replaceChildren();
  const audit = state.overview?.audit || [];
  if (!audit.length) appendText(elements.audit, "li", "muted", "暂无变更记录");
  for (const record of audit) {
    const item = document.createElement("li");
    item.className = "audit-item";
    appendText(
      item,
      "strong",
      "",
      record.actor?.username || record.actor || record.updatedBy || "管理员",
    );
    appendText(
      item,
      "span",
      "",
      `${record.action || "策略更新"} · ${formatDate(record.timestamp)}`,
    );
    elements.audit.append(item);
  }
}

function renderSummary() {
  const enabled = state.clients.filter((client) => client.enabled).length;
  const sessions = state.clients.reduce((sum, client) => sum + client.sessionCount, 0);
  elements.enabledCount.textContent = `${enabled} / ${state.clients.length}`;
  elements.sessionCount.textContent = String(sessions);
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

function renderCapabilityControls(parent, client, draft) {
  const section = document.createElement("section");
  section.className = "client-section";
  const heading = document.createElement("div");
  heading.className = "section-title-row";
  appendText(heading, "h3", "", "MCP 权限");
  appendText(
    heading,
    "span",
    draft.accessType === "full" ? "section-note full-warning" : "section-note",
    draft.accessType === "full" ? "可调用全部已审核官方工具" : "仅暴露已勾选能力对应的工具",
  );
  section.append(heading);

  const modes = document.createElement("div");
  modes.className = "segmented-control";
  modes.append(
    createSegment(
      `${client.key}-access-type`,
      "capabilities",
      "按能力授权",
      draft.accessType === "capabilities",
      false,
      () => {
        draft.accessType = "capabilities";
        if (draft.capabilities.size === 0) draft.capabilities.add("knowledge.read");
        renderClients();
      },
    ),
    createSegment(
      `${client.key}-access-type`,
      "full",
      "全权限",
      draft.accessType === "full",
      false,
      () => {
        draft.accessType = "full";
        draft.knowledgeBaseScope = "all";
        renderClients();
      },
    ),
  );
  section.append(modes);

  const capabilityGrid = document.createElement("div");
  capabilityGrid.className = "capability-grid";
  for (const capability of state.capabilities) {
    const option = document.createElement("label");
    option.className = "capability-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = draft.capabilities.has(capability);
    input.disabled = draft.accessType === "full";
    input.setAttribute("aria-label", `${client.label} ${CAPABILITY_LABELS[capability] || capability}`);
    input.addEventListener("change", () => {
      if (input.checked) draft.capabilities.add(capability);
      else draft.capabilities.delete(capability);
      renderClients();
    });
    const text = document.createElement("span");
    appendText(text, "strong", "", CAPABILITY_LABELS[capability] || capability);
    appendText(text, "code", "", capability);
    option.append(input, text);
    capabilityGrid.append(option);
  }
  section.append(capabilityGrid);

  const unsupported = document.createElement("div");
  unsupported.className = "unsupported-options";
  for (const label of ["API Key 管理", "租户成员管理"]) {
    const option = document.createElement("label");
    option.className = "unsupported-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.disabled = true;
    const text = document.createElement("span");
    appendText(text, "strong", "", label);
    appendText(text, "span", "", "当前官方 MCP 无对应工具");
    option.append(input, text);
    unsupported.append(option);
  }
  section.append(unsupported);
  parent.append(section);
}

function renderKnowledgeControls(parent, client, draft) {
  const section = document.createElement("section");
  section.className = "client-section";
  const heading = document.createElement("div");
  heading.className = "section-title-row";
  appendText(heading, "h3", "", "知识库范围");
  appendText(
    heading,
    "span",
    "section-note",
    draft.accessType === "full" || draft.knowledgeBaseScope === "all"
      ? "全部知识库"
      : `已选择 ${draft.allowedKbIds.size} 个`,
  );
  section.append(heading);

  const toolbar = document.createElement("div");
  toolbar.className = "knowledge-toolbar";
  const scope = document.createElement("div");
  scope.className = "segmented-control";
  const full = draft.accessType === "full";
  scope.append(
    createSegment(
      `${client.key}-kb-scope`,
      "selected",
      "指定知识库",
      draft.knowledgeBaseScope === "selected",
      full,
      () => {
        draft.knowledgeBaseScope = "selected";
        if (draft.allowedKbIds.size === 0 && draft.defaultKbId) {
          draft.allowedKbIds.add(draft.defaultKbId);
        }
        renderClients();
      },
    ),
    createSegment(
      `${client.key}-kb-scope`,
      "all",
      "全部知识库",
      draft.knowledgeBaseScope === "all",
      full,
      () => {
        draft.knowledgeBaseScope = "all";
        renderClients();
      },
    ),
  );
  toolbar.append(scope);
  const defaultLabel = document.createElement("label");
  appendText(defaultLabel, "span", "field-label", "默认知识库");
  const defaultSelect = document.createElement("select");
  defaultSelect.className = "default-select";
  defaultSelect.setAttribute("aria-label", `${client.label} 默认知识库`);
  for (const kb of state.overview.knowledgeBases) {
    const option = document.createElement("option");
    option.value = kb.id;
    option.textContent = kb.name;
    option.selected = kb.id === draft.defaultKbId;
    defaultSelect.append(option);
  }
  defaultSelect.addEventListener("change", () => {
    draft.defaultKbId = defaultSelect.value;
    if (draft.knowledgeBaseScope === "selected") {
      draft.allowedKbIds.add(defaultSelect.value);
    }
    renderClients();
  });
  defaultLabel.append(defaultSelect);
  toolbar.append(defaultLabel);
  section.append(toolbar);

  const list = document.createElement("div");
  list.className = "knowledge-list";
  for (const kb of state.overview.knowledgeBases) {
    const row = document.createElement("div");
    row.className = "knowledge-row";
    const allowed = document.createElement("input");
    allowed.className = "knowledge-check";
    allowed.type = "checkbox";
    allowed.checked = full || draft.knowledgeBaseScope === "all" || draft.allowedKbIds.has(kb.id);
    allowed.disabled = full || draft.knowledgeBaseScope === "all";
    allowed.setAttribute("aria-label", `${client.label} 允许 ${kb.name}`);
    allowed.addEventListener("change", () => {
      if (allowed.checked) draft.allowedKbIds.add(kb.id);
      else draft.allowedKbIds.delete(kb.id);
      if (!draft.allowedKbIds.has(draft.defaultKbId)) {
        draft.defaultKbId = draft.allowedKbIds.values().next().value || "";
      }
      renderClients();
    });
    const main = document.createElement("div");
    main.className = "knowledge-main";
    appendText(main, "span", "knowledge-name", kb.name);
    appendText(main, "span", "knowledge-id", kb.id);
    const defaultControl = document.createElement("label");
    defaultControl.className = "default-control";
    const radio = document.createElement("input");
    radio.className = "default-radio";
    radio.type = "radio";
    radio.name = `${client.key}-default-kb`;
    radio.checked = draft.defaultKbId === kb.id;
    radio.addEventListener("change", () => {
      draft.defaultKbId = kb.id;
      if (draft.knowledgeBaseScope === "selected") draft.allowedKbIds.add(kb.id);
      renderClients();
    });
    defaultControl.append(radio, document.createTextNode("默认"));
    row.append(allowed, main, defaultControl);
    list.append(row);
  }
  section.append(list);
  parent.append(section);
}

function confirmAction(title, summary, actionLabel, action) {
  state.pendingAction = action;
  elements.confirmTitle.textContent = title;
  elements.confirmSummary.textContent = summary;
  elements.confirmAction.textContent = actionLabel;
  elements.confirmDialog.returnValue = "";
  elements.confirmDialog.showModal();
}

async function saveAccessPolicy(client, draft) {
  const full = draft.accessType === "full";
  await request(`/mcp-console/api/oauth-clients/${client.key}/access-policy`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": state.session.csrfToken,
    },
    body: JSON.stringify({
      accessType: draft.accessType,
      capabilities: full ? [] : Array.from(draft.capabilities),
      knowledgeBaseScope: full ? "all" : draft.knowledgeBaseScope,
      defaultKbId: draft.defaultKbId,
      allowedKbIds:
        full || draft.knowledgeBaseScope === "all"
          ? []
          : Array.from(draft.allowedKbIds),
    }),
  });
  showStatus(`${client.label} MCP 权限已更新`);
  await loadAll();
}

async function saveOauthClient(client, draft) {
  await request(`/mcp-console/api/oauth-clients/${client.key}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": state.session.csrfToken,
    },
    body: JSON.stringify({ enabled: draft.enabled, redirectUri: draft.redirectUri }),
  });
  showStatus(`${client.label} OAuth 配置已更新`);
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
  elements.secretValue.value = result.secret;
  elements.secretDialog.showModal();
  showStatus(`${client.label} Client Secret 已轮换`);
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

function renderClient(client) {
  const draft = draftFor(client);
  const card = document.createElement("article");
  card.className = "oauth-client";

  const header = document.createElement("header");
  header.className = "client-header";
  const title = document.createElement("div");
  title.className = "client-title";
  appendText(title, "h2", "", client.label);
  appendText(title, "code", "", client.clientId);
  const toggle = document.createElement("label");
  toggle.className = "oauth-toggle";
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = draft.enabled;
  enabled.setAttribute("aria-label", `启用 ${client.label}`);
  const enabledText = document.createTextNode(draft.enabled ? "已启用" : "已停用");
  enabled.addEventListener("change", () => {
    draft.enabled = enabled.checked;
    enabledText.textContent = draft.enabled ? "已启用" : "已停用";
  });
  toggle.append(enabled, enabledText);
  header.append(title, toggle);
  card.append(header);

  const connection = document.createElement("section");
  connection.className = "client-section";
  const connectionHeading = document.createElement("div");
  connectionHeading.className = "section-title-row";
  appendText(connectionHeading, "h3", "", "连接信息");
  appendText(connectionHeading, "span", "section-note", `活跃会话 ${client.sessionCount} 个`);
  connection.append(connectionHeading);
  const grid = document.createElement("div");
  grid.className = "connection-grid";
  appendField(grid, "MCP URL", client.mcpUrl);
  appendField(grid, "Scope", client.scope);
  appendField(grid, "Issuer", client.issuer);
  appendField(grid, "Authorization URL", client.authorizationEndpoint);
  appendField(grid, "Token URL", client.tokenEndpoint);
  appendField(grid, "Provider", client.provider);
  connection.append(grid);
  const redirectRow = document.createElement("div");
  redirectRow.className = "redirect-row";
  const redirectLabel = document.createElement("label");
  redirectLabel.className = "redirect-field";
  appendText(redirectLabel, "span", "field-label", "回调 URL");
  const redirect = document.createElement("input");
  redirect.type = "url";
  redirect.required = true;
  redirect.spellcheck = false;
  redirect.value = draft.redirectUri;
  redirect.setAttribute("aria-label", `${client.label} 回调 URL`);
  redirect.addEventListener("input", () => {
    draft.redirectUri = redirect.value;
  });
  redirectLabel.append(redirect);
  const saveOauth = appendText(redirectRow, "button", "button button-primary", "保存连接");
  saveOauth.type = "button";
  saveOauth.addEventListener("click", () => {
    if (!redirect.reportValidity()) return;
    confirmAction(
      `更新 ${client.label} 连接`,
      draft.enabled
        ? "将保存启用状态和精确回调 URL。"
        : "将停用客户端并阻止新的 OAuth 登录。",
      "确认保存",
      () => saveOauthClient(client, draft),
    );
  });
  redirectRow.prepend(redirectLabel);
  connection.append(redirectRow);
  card.append(connection);

  renderCapabilityControls(card, client, draft);
  renderKnowledgeControls(card, client, draft);

  const footer = document.createElement("footer");
  footer.className = "client-footer";
  appendText(
    footer,
    "span",
    "session-count",
    draft.accessType === "full" ? "全权限模式" : `${draft.capabilities.size} 项能力`,
  );
  const actions = document.createElement("div");
  actions.className = "client-actions";
  const savePolicy = appendText(actions, "button", "button button-primary", "应用 MCP 权限");
  savePolicy.type = "button";
  savePolicy.disabled = !policyIsValid(draft);
  savePolicy.addEventListener("click", () =>
    confirmAction(
      `更新 ${client.label} MCP 权限`,
      draft.accessType === "full"
        ? "该客户端将可调用全部已审核官方工具并访问全部知识库。"
        : `该客户端将启用 ${draft.capabilities.size} 项能力。`,
      "确认应用",
      () => saveAccessPolicy(client, draft),
    ),
  );
  const rotate = appendText(actions, "button", "button button-quiet", "轮换 Secret");
  rotate.type = "button";
  rotate.addEventListener("click", () =>
    confirmAction(
      `轮换 ${client.label} Client Secret`,
      "现有 Client Secret 将失效，新密钥只显示一次。",
      "确认轮换",
      () => rotateSecret(client),
    ),
  );
  const revoke = appendText(actions, "button", "button button-quiet", "撤销会话");
  revoke.type = "button";
  revoke.addEventListener("click", () =>
    confirmAction(
      `撤销 ${client.label} 会话`,
      `将撤销当前 ${client.sessionCount} 个活跃会话。`,
      "确认撤销",
      () => revokeSessions(client),
    ),
  );
  footer.append(actions);
  card.append(footer);
  return card;
}

function renderClients() {
  elements.list.replaceChildren();
  elements.empty.hidden = state.clients.length > 0;
  for (const client of state.clients) elements.list.append(renderClient(client));
  renderSummary();
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
    renderServiceStatus();
    renderAudit();
    renderClients();
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
  state.pendingAction = null;
  if (elements.confirmDialog.returnValue !== "confirm" || !action) return;
  elements.confirmAction.disabled = true;
  try {
    await action();
  } catch {
    showStatus("操作失败，请检查服务状态", true);
  } finally {
    elements.confirmAction.disabled = false;
  }
});
elements.copySecret.addEventListener("click", async () => {
  await navigator.clipboard.writeText(elements.secretValue.value);
  showStatus("Client Secret 已复制");
});
elements.secretDialog.addEventListener("close", () => {
  elements.secretValue.value = "";
});

loadAll();
