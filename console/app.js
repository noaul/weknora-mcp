const state = {
  session: null,
  overview: null,
  oauthClients: [],
  allowed: new Set(),
  defaultKbId: "",
  filter: "",
  dirty: false,
  currentView: "knowledge",
  pendingOauthAction: null,
};

const elements = {
  user: document.querySelector("#current-user"),
  list: document.querySelector("#knowledge-list"),
  empty: document.querySelector("#empty-state"),
  frame: document.querySelector(".table-frame"),
  filter: document.querySelector("#knowledge-filter"),
  refresh: document.querySelector("#refresh-overview"),
  save: document.querySelector("#save-policy"),
  selection: document.querySelector("#selection-summary"),
  services: document.querySelector("#service-status"),
  updated: document.querySelector("#last-updated"),
  activeDefault: document.querySelector("#active-default"),
  activeCount: document.querySelector("#active-count"),
  activeUpdated: document.querySelector("#active-updated"),
  audit: document.querySelector("#audit-list"),
  toast: document.querySelector("#app-status"),
  dialog: document.querySelector("#confirm-dialog"),
  confirmSummary: document.querySelector("#confirm-summary"),
  confirmSave: document.querySelector("#confirm-save"),
  logout: document.querySelector("#logout"),
  viewTabs: document.querySelectorAll(".view-tab"),
  knowledgeView: document.querySelector("#knowledge-view"),
  oauthView: document.querySelector("#oauth-view"),
  oauthList: document.querySelector("#oauth-client-list"),
  oauthEmpty: document.querySelector("#oauth-empty-state"),
  oauthRefresh: document.querySelector("#refresh-oauth-clients"),
  oauthEnabledCount: document.querySelector("#oauth-enabled-count"),
  oauthSessionCount: document.querySelector("#oauth-session-count"),
  oauthConfirmDialog: document.querySelector("#oauth-confirm-dialog"),
  oauthConfirmTitle: document.querySelector("#oauth-confirm-title"),
  oauthConfirmSummary: document.querySelector("#oauth-confirm-summary"),
  oauthConfirmAction: document.querySelector("#oauth-confirm-action"),
  oauthSecretDialog: document.querySelector("#oauth-secret-dialog"),
  oauthSecretValue: document.querySelector("#oauth-secret-value"),
  copyOauthSecret: document.querySelector("#copy-oauth-secret"),
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

function appendText(parent, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  parent.append(node);
  return node;
}

function renderKnowledgeBases() {
  elements.list.replaceChildren();
  const query = state.filter.trim().toLocaleLowerCase();
  const knowledgeBases = (state.overview?.knowledgeBases || []).filter(
    (kb) =>
      !query ||
      kb.name.toLocaleLowerCase().includes(query) ||
      kb.id.includes(query),
  );
  elements.empty.hidden = knowledgeBases.length > 0;

  for (const kb of knowledgeBases) {
    const row = document.createElement("div");
    row.className = "knowledge-row";
    row.dataset.kbId = kb.id;

    const allowCell = document.createElement("label");
    allowCell.className = "control-cell allow-control";
    const allow = document.createElement("input");
    allow.type = "checkbox";
    allow.checked = state.allowed.has(kb.id);
    allow.setAttribute("aria-label", `允许读取 ${kb.name}`);
    allow.addEventListener("change", () => toggleAllowed(kb.id, allow.checked));
    allowCell.append(allow);

    const main = document.createElement("div");
    main.className = "knowledge-main";
    appendText(main, "span", "knowledge-name", kb.name);
    appendText(main, "span", "knowledge-id", kb.id);

    const count = document.createElement("span");
    count.className = "knowledge-count";
    count.textContent = kb.knowledgeCount.toLocaleString("zh-CN");

    const capabilities = document.createElement("div");
    capabilities.className = "capabilities";
    for (const [key, label] of [
      ["vector", "向量"],
      ["keyword", "关键词"],
      ["wiki", "Wiki"],
    ]) {
      if (kb.capabilities[key]) appendText(capabilities, "span", "capability", label);
    }

    const defaultCell = document.createElement("label");
    defaultCell.className = "control-cell default-control";
    const defaultControl = document.createElement("input");
    defaultControl.type = "radio";
    defaultControl.name = "default-knowledge-base";
    defaultControl.checked = state.defaultKbId === kb.id;
    defaultControl.disabled = !state.allowed.has(kb.id);
    defaultControl.setAttribute("aria-label", `设为默认知识库 ${kb.name}`);
    defaultControl.addEventListener("change", () => {
      state.defaultKbId = kb.id;
      setDirty();
      renderKnowledgeBases();
    });
    defaultCell.append(defaultControl);

    row.append(allowCell, main, count, capabilities, defaultCell);
    elements.list.append(row);
  }
  elements.selection.textContent = `已允许 ${state.allowed.size} 个知识库`;
  elements.save.disabled =
    !state.dirty ||
    state.allowed.size === 0 ||
    !state.allowed.has(state.defaultKbId);
}

function toggleAllowed(id, enabled) {
  if (enabled) {
    state.allowed.add(id);
    if (!state.defaultKbId) state.defaultKbId = id;
  } else {
    state.allowed.delete(id);
    if (state.defaultKbId === id) {
      state.defaultKbId = state.allowed.values().next().value || "";
    }
  }
  setDirty();
  renderKnowledgeBases();
}

function setDirty() {
  state.dirty = true;
}

function renderOverview() {
  const { policy, services, audit, knowledgeBases } = state.overview;
  const activeDefault = knowledgeBases.find((kb) => kb.id === policy.defaultKbId);
  elements.activeDefault.textContent = activeDefault?.name || policy.defaultKbId;
  elements.activeCount.textContent = String(policy.knowledgeBases.length);
  elements.activeUpdated.textContent = formatDate(policy.updatedAt);
  elements.updated.textContent = `更新 ${new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date())}`;

  elements.services.replaceChildren();
  for (const [key, label] of [
    ["readGateway", "只读网关"],
    ["adminGateway", "管理网关"],
  ]) {
    const item = document.createElement("div");
    item.className = "service-item";
    appendText(item, "span", "service-name", label);
    appendText(
      item,
      "span",
      `status-label ${services[key] === "healthy" ? "healthy" : ""}`,
      services[key] === "healthy" ? "正常" : "不可用",
    );
    elements.services.append(item);
  }

  elements.audit.replaceChildren();
  if (!audit.length) appendText(elements.audit, "li", "muted", "暂无变更记录");
  for (const record of audit) {
    const item = document.createElement("li");
    item.className = "audit-item";
    appendText(
      item,
      "strong",
      "",
      record.actor?.username || record.actor || record.policy?.updatedBy || "管理员",
    );
    appendText(
      item,
      "span",
      "",
      `${record.action || "策略更新"} · ${formatDate(record.timestamp)}`,
    );
    elements.audit.append(item);
  }
  renderKnowledgeBases();
}

async function loadOverview(showMessage = false) {
  elements.frame.setAttribute("aria-busy", "true");
  elements.refresh.disabled = true;
  try {
    const [session, overview] = await Promise.all([
      request("/mcp-console/api/session"),
      request("/mcp-console/api/overview"),
    ]);
    state.session = session;
    state.overview = overview;
    state.allowed = new Set(overview.policy.knowledgeBases.map((kb) => kb.id));
    state.defaultKbId = overview.policy.defaultKbId;
    state.dirty = false;
    elements.user.textContent = session.username;
    renderOverview();
    if (showMessage) showStatus("状态已刷新");
  } catch (error) {
    if (error.message !== "authentication_required") {
      showStatus("加载失败，请稍后重试", true);
    }
  } finally {
    elements.frame.setAttribute("aria-busy", "false");
    elements.refresh.disabled = false;
  }
}

async function savePolicy() {
  elements.confirmSave.disabled = true;
  try {
    await request("/mcp-console/api/policy", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": state.session.csrfToken,
      },
      body: JSON.stringify({
        defaultKbId: state.defaultKbId,
        allowedKbIds: Array.from(state.allowed),
      }),
    });
    showStatus("访问策略已应用");
    await loadOverview();
  } catch {
    showStatus("策略保存失败，请检查服务状态", true);
  } finally {
    elements.confirmSave.disabled = false;
  }
}

function appendOauthField(parent, label, value) {
  const field = document.createElement("div");
  field.className = "oauth-field";
  appendText(field, "span", "", label);
  appendText(field, "code", "", value || "-");
  parent.append(field);
}

function confirmOauthAction(title, summary, actionLabel, action) {
  state.pendingOauthAction = action;
  elements.oauthConfirmTitle.textContent = title;
  elements.oauthConfirmSummary.textContent = summary;
  elements.oauthConfirmAction.textContent = actionLabel;
  elements.oauthConfirmDialog.showModal();
}

async function updateOauthClient(client, enabled, redirectUri) {
  await request(`/mcp-console/api/oauth-clients/${client.key}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": state.session.csrfToken,
    },
    body: JSON.stringify({ enabled, redirectUri }),
  });
  showStatus(`${client.label} 配置已更新`);
  await loadOauthClients();
}

async function rotateOauthSecret(client) {
  const result = await request(
    `/mcp-console/api/oauth-clients/${client.key}/rotate-secret`,
    {
      method: "POST",
      headers: { "x-csrf-token": state.session.csrfToken },
    },
  );
  elements.oauthSecretValue.value = result.secret;
  elements.oauthSecretDialog.showModal();
  showStatus(`${client.label} 密钥已轮换`);
}

async function revokeOauthSessions(client) {
  const result = await request(
    `/mcp-console/api/oauth-clients/${client.key}/revoke-sessions`,
    {
      method: "POST",
      headers: { "x-csrf-token": state.session.csrfToken },
    },
  );
  showStatus(`已撤销 ${result.revokedSessions} 个 ${client.label} 会话`);
  await loadOauthClients();
}

function renderOauthClients() {
  elements.oauthList.replaceChildren();
  elements.oauthEmpty.hidden = state.oauthClients.length > 0;
  const enabledCount = state.oauthClients.filter((client) => client.enabled).length;
  const sessionCount = state.oauthClients.reduce(
    (sum, client) => sum + client.sessionCount,
    0,
  );
  elements.oauthEnabledCount.textContent = `${enabledCount} / ${state.oauthClients.length}`;
  elements.oauthSessionCount.textContent = String(sessionCount);

  for (const client of state.oauthClients) {
    const card = document.createElement("article");
    card.className = "oauth-client";

    const header = document.createElement("div");
    header.className = "oauth-client-header";
    const title = document.createElement("div");
    title.className = "oauth-client-title";
    appendText(title, "h2", "", client.label);
    appendText(
      title,
      "span",
      `profile-badge ${client.profile === "admin" ? "admin" : ""}`,
      client.profile === "admin" ? "管理" : "只读",
    );
    const toggleLabel = document.createElement("label");
    toggleLabel.className = "oauth-toggle";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = client.enabled;
    enabled.setAttribute("aria-label", `启用 ${client.label}`);
    toggleLabel.append(enabled, document.createTextNode(client.enabled ? "已启用" : "已停用"));
    enabled.addEventListener("change", () => {
      toggleLabel.lastChild.textContent = enabled.checked ? "已启用" : "已停用";
    });
    header.append(title, toggleLabel);

    const grid = document.createElement("div");
    grid.className = "oauth-client-grid";
    appendOauthField(grid, "MCP URL", client.mcpUrl);
    appendOauthField(grid, "Client ID", client.clientId);
    appendOauthField(grid, "Issuer", client.issuer);
    appendOauthField(grid, "Scope", client.scope);
    appendOauthField(grid, "Authorization URL", client.authorizationEndpoint);
    appendOauthField(grid, "Token URL", client.tokenEndpoint);

    const redirectLabel = document.createElement("label");
    redirectLabel.className = "redirect-field";
    appendText(redirectLabel, "span", "", "回调 URL");
    const redirect = document.createElement("input");
    redirect.type = "url";
    redirect.value = client.redirectUri;
    redirect.required = true;
    redirect.spellcheck = false;
    redirect.setAttribute("aria-label", `${client.label} 回调 URL`);
    redirectLabel.append(redirect);

    const footer = document.createElement("div");
    footer.className = "oauth-client-footer";
    appendText(
      footer,
      "span",
      "oauth-session-count",
      `活跃会话 ${client.sessionCount} 个`,
    );
    const actions = document.createElement("div");
    actions.className = "oauth-client-actions";
    const save = appendText(actions, "button", "button button-primary", "保存配置");
    save.type = "button";
    save.addEventListener("click", () => {
      if (!redirect.reportValidity()) return;
      confirmOauthAction(
        `更新 ${client.label}`,
        enabled.checked
          ? "将保存启用状态和精确回调 URL。"
          : "将停用该客户端并阻止新的 OAuth 登录；已签发 token 最长仍可使用 10 分钟。",
        "确认保存",
        () => updateOauthClient(client, enabled.checked, redirect.value),
      );
    });
    const rotate = appendText(actions, "button", "button button-quiet", "轮换密钥");
    rotate.type = "button";
    rotate.addEventListener("click", () =>
      confirmOauthAction(
        `轮换 ${client.label} 密钥`,
        "现有 Client Secret 将失效，新密钥只显示一次。",
        "确认轮换",
        () => rotateOauthSecret(client),
      ),
    );
    const revoke = appendText(actions, "button", "button button-quiet", "撤销会话");
    revoke.type = "button";
    revoke.addEventListener("click", () =>
      confirmOauthAction(
        `撤销 ${client.label} 会话`,
        `将删除当前 ${client.sessionCount} 个活跃会话；已签发 token 最长仍可使用 10 分钟。`,
        "确认撤销",
        () => revokeOauthSessions(client),
      ),
    );
    footer.append(actions);
    card.append(header, grid, redirectLabel, footer);
    elements.oauthList.append(card);
  }
}

async function loadOauthClients(showMessage = false) {
  elements.oauthList.setAttribute("aria-busy", "true");
  elements.oauthRefresh.disabled = true;
  try {
    const result = await request("/mcp-console/api/oauth-clients");
    state.oauthClients = result.clients;
    renderOauthClients();
    if (showMessage) showStatus("OAuth 客户端已刷新");
  } catch (error) {
    if (error.message !== "authentication_required") {
      showStatus("OAuth 客户端加载失败", true);
    }
  } finally {
    elements.oauthList.setAttribute("aria-busy", "false");
    elements.oauthRefresh.disabled = false;
  }
}

function switchView(view) {
  state.currentView = view;
  elements.knowledgeView.hidden = view !== "knowledge";
  elements.oauthView.hidden = view !== "oauth";
  for (const tab of elements.viewTabs) {
    const selected = tab.dataset.view === view;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
  }
  if (view === "oauth" && state.oauthClients.length === 0) {
    loadOauthClients();
  }
}

elements.filter.addEventListener("input", () => {
  state.filter = elements.filter.value;
  renderKnowledgeBases();
});
elements.refresh.addEventListener("click", () => loadOverview(true));
elements.oauthRefresh.addEventListener("click", () => loadOauthClients(true));
for (const tab of elements.viewTabs) {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
}
elements.logout.addEventListener("click", async () => {
  try {
    await request("/mcp-console/logout", {
      method: "POST",
      headers: { "x-csrf-token": state.session.csrfToken },
    });
    window.location.assign("/mcp-console/login");
  } catch (error) {
    if (error.message !== "authentication_required") {
      showStatus("退出失败，请稍后重试", true);
    }
  }
});
elements.save.addEventListener("click", () => {
  const defaultKb = state.overview.knowledgeBases.find(
    (kb) => kb.id === state.defaultKbId,
  );
  elements.confirmSummary.textContent = `允许 ${state.allowed.size} 个知识库，默认使用“${defaultKb?.name || state.defaultKbId}”。`;
  elements.dialog.showModal();
});
elements.dialog.addEventListener("close", () => {
  if (elements.dialog.returnValue === "confirm") savePolicy();
});
elements.oauthConfirmDialog.addEventListener("close", async () => {
  const action = state.pendingOauthAction;
  state.pendingOauthAction = null;
  if (elements.oauthConfirmDialog.returnValue !== "confirm" || !action) return;
  elements.oauthConfirmAction.disabled = true;
  try {
    await action();
  } catch {
    showStatus("OAuth 客户端操作失败", true);
  } finally {
    elements.oauthConfirmAction.disabled = false;
  }
});
elements.copyOauthSecret.addEventListener("click", async () => {
  await navigator.clipboard.writeText(elements.oauthSecretValue.value);
  showStatus("Client Secret 已复制");
});
elements.oauthSecretDialog.addEventListener("close", () => {
  elements.oauthSecretValue.value = "";
});

loadOverview();
