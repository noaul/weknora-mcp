const state = {
  session: null,
  overview: null,
  allowed: new Set(),
  defaultKbId: "",
  filter: "",
  dirty: false,
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
  showStatus.timer = window.setTimeout(() => { elements.toast.hidden = true; }, 3600);
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "-" : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
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
  const knowledgeBases = (state.overview?.knowledgeBases || []).filter((kb) =>
    !query || kb.name.toLocaleLowerCase().includes(query) || kb.id.includes(query),
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

    const count = appendText(document.createElement("span"), "span", "", kb.knowledgeCount.toLocaleString("zh-CN"));
    count.parentElement.className = "knowledge-count";

    const capabilities = document.createElement("div");
    capabilities.className = "capabilities";
    for (const [key, label] of [["vector", "向量"], ["keyword", "关键词"], ["wiki", "Wiki"]]) {
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

    row.append(allowCell, main, count.parentElement, capabilities, defaultCell);
    elements.list.append(row);
  }
  elements.selection.textContent = `已允许 ${state.allowed.size} 个知识库`;
  elements.save.disabled = !state.dirty || state.allowed.size === 0 || !state.allowed.has(state.defaultKbId);
}

function toggleAllowed(id, enabled) {
  if (enabled) {
    state.allowed.add(id);
    if (!state.defaultKbId) state.defaultKbId = id;
  } else {
    state.allowed.delete(id);
    if (state.defaultKbId === id) state.defaultKbId = state.allowed.values().next().value || "";
  }
  setDirty();
  renderKnowledgeBases();
}

function setDirty() { state.dirty = true; }

function renderOverview() {
  const { policy, services, audit, knowledgeBases } = state.overview;
  const activeDefault = knowledgeBases.find((kb) => kb.id === policy.defaultKbId);
  elements.activeDefault.textContent = activeDefault?.name || policy.defaultKbId;
  elements.activeCount.textContent = String(policy.knowledgeBases.length);
  elements.activeUpdated.textContent = formatDate(policy.updatedAt);
  elements.updated.textContent = `更新 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`;

  elements.services.replaceChildren();
  for (const [key, label] of [["readGateway", "只读网关"], ["adminGateway", "管理网关"]]) {
    const item = document.createElement("div");
    item.className = "service-item";
    appendText(item, "span", "service-name", label);
    appendText(item, "span", `status-label ${services[key] === "healthy" ? "healthy" : ""}`, services[key] === "healthy" ? "正常" : "不可用");
    elements.services.append(item);
  }

  elements.audit.replaceChildren();
  if (!audit.length) appendText(elements.audit, "li", "muted", "暂无变更记录");
  for (const record of audit) {
    const item = document.createElement("li");
    item.className = "audit-item";
    appendText(item, "strong", "", record.actor?.username || record.actor || record.policy?.updatedBy || "管理员");
    appendText(item, "span", "", `${record.action || "策略更新"} · ${formatDate(record.timestamp)}`);
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
    if (error.message !== "authentication_required") showStatus("加载失败，请稍后重试", true);
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
  } catch (error) {
    showStatus("策略保存失败，请检查服务状态", true);
  } finally {
    elements.confirmSave.disabled = false;
  }
}

elements.filter.addEventListener("input", () => {
  state.filter = elements.filter.value;
  renderKnowledgeBases();
});
elements.refresh.addEventListener("click", () => loadOverview(true));
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
  const defaultKb = state.overview.knowledgeBases.find((kb) => kb.id === state.defaultKbId);
  elements.confirmSummary.textContent = `允许 ${state.allowed.size} 个知识库，默认使用“${defaultKb?.name || state.defaultKbId}”。`;
  elements.dialog.showModal();
});
elements.dialog.addEventListener("close", () => {
  if (elements.dialog.returnValue === "confirm") savePolicy();
});

loadOverview();
