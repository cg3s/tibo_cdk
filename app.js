const byId = (id) => document.getElementById(id);
const codeForm = byId("code-form");
const recoveryForm = byId("recovery-form");
const sessionForm = byId("session-form");
const codeInput = byId("code");
const originalCodeInput = byId("original-code");
const sessionInput = byId("session");
const confirmPanel = byId("confirmation-panel");
const progressPanel = byId("progress-panel");
const statusButton = byId("status-button");
const redeemButton = byId("redeem-button");
const toggleSessionButton = byId("toggle-session");
const errorBox = byId("form-error");

const state = {
  step: "code",
  intent: "initial",
  code: "",
  recoveryCode: "",
  record: null,
  busy: false,
  pollGeneration: 0,
  pollTimer: undefined,
  polling: false,
  nextPollAt: 0,
};

const planLabels = {
  team: "ChatGPT Team",
  go: "ChatGPT Go",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  pro_5x: "ChatGPT Pro 5x",
  pro_10x: "ChatGPT Pro 10x",
  pro_20x: "ChatGPT Pro 20x",
  pro_25x: "ChatGPT Pro 25x",
  pro_50x: "ChatGPT Pro 50x",
};
const statusLabels = {
  submitting: "正在提交兑换",
  unknown: "兑换结果待核对",
  queued: "已受理，等待处理",
  running: "正在处理兑换",
  succeeded: "套餐开通成功",
  failed: "本次兑换未完成",
  cancelled: "兑换已取消",
};
const stageLabels = {
  logging_in: "正在验证登录资料。",
  preparing_funds: "正在准备充值资源。",
  awaiting_card: "正在准备充值资源。",
  dispatching: "正在安排充值。",
  confirming: "正在确认充值结果。",
  requires_action: "请查看兑换服务返回的提示。",
  review: "兑换结果正在核对。",
  upgrading: "正在开通目标套餐。",
};
const terminal = new Set(["succeeded", "failed", "cancelled"]);
const siteConfig = window.REDEMPTION_CONFIG ?? {};

function showError(message = "") {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

async function request(path, { method = "GET", data } = {}) {
  const response = await fetch(`/api/redemption/${path}`, {
    method,
    headers: data ? { "Content-Type": "application/json" } : undefined,
    body: data ? JSON.stringify(data) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(35000),
  });
  const result = await response.json();
  const retryAfter = Number(response.headers.get("Retry-After"));
  if (Number.isSafeInteger(retryAfter) && retryAfter > 0) {
    state.nextPollAt = Math.max(state.nextPollAt, Date.now() + retryAfter * 1000);
  }
  return { data: result.data, ok: response.ok, error: result.error?.message };
}

async function withButton(button, label, work) {
  if (state.busy) return;
  state.busy = true;
  showError();
  const caption = button.querySelector("span") ?? button;
  const original = caption.textContent;
  button.disabled = true;
  caption.textContent = label;
  try {
    await work();
  } catch {
    showError("连接兑换服务失败，请稍后再试。");
  } finally {
    caption.textContent = original;
    button.disabled = false;
    state.busy = false;
  }
}

function displayPlan(record) {
  return record?.targetPlan ? planLabels[record.targetPlan] ?? record.targetPlan : record?.productName ?? "—";
}

function resetCredentials() {
  sessionInput.value = "";
  originalCodeInput.value = "";
  sessionInput.classList.remove("is-visible");
  toggleSessionButton.setAttribute("aria-pressed", "false");
  toggleSessionButton.setAttribute("aria-label", "显示 Session");
}

function setStep(step) {
  state.step = step;
  codeForm.hidden = step !== "code";
  recoveryForm.hidden = step !== "recover";
  sessionForm.hidden = step !== "session";
  confirmPanel.hidden = step !== "confirm";
  progressPanel.hidden = step !== "progress";
  const headings = {
    code: ["STEP 01 / 03", "验证兑换卡密"],
    recover: ["REDEMPTION STATUS", "恢复兑换进度"],
    session: ["STEP 02 / 03", "填写账号资料"],
    confirm: ["STEP 03 / 03", "确认兑换信息"],
    progress: ["REDEMPTION STATUS", "兑换进度"],
  };
  const [kicker, title] = headings[step];
  byId("step-kicker").textContent = kicker;
  byId("form-title").textContent = title;
  const showRecovery = Boolean(state.recoveryCode && ["session", "confirm", "progress"].includes(step));
  byId("recovery-note").hidden = !showRecovery;
  byId("issued-recovery-code").value = showRecovery ? state.recoveryCode : "";
}

function stopPolling() {
  state.pollGeneration += 1;
  window.clearTimeout(state.pollTimer);
}

function openSession(intent, focus = true) {
  stopPolling();
  state.intent = intent;
  const requireCode = !state.code || Boolean(originalCodeInput.value);
  byId("original-code-field").hidden = !requireCode;
  byId("verified-plan").textContent = displayPlan(state.record);
  byId("change-code-button").textContent = intent === "initial" ? "更换" : "返回进度";
  byId("session-hint").textContent = intent === "reconcile"
    ? "请提供与首次提交完全相同的 Session，用于核对这次请求。"
    : "请复制 ChatGPT 页面显示的完整 Session。";
  setStep("session");
  if (focus) (requireCode ? originalCodeInput : sessionInput).focus();
}

function renderProgress(record) {
  const { phase, paused, stale } = record;
  const reviewing = paused || record.stage === "review";
  const done = terminal.has(phase) && !reviewing;
  progressPanel.classList.toggle("is-success", phase === "succeeded" && done);
  progressPanel.classList.toggle("is-failure", done && phase !== "succeeded");
  byId("progress-kicker").textContent = reviewing ? "UNDER REVIEW" : done ? "RESULT" : "IN PROGRESS";
  byId("progress-title").textContent = reviewing ? "兑换结果核对中" : statusLabels[phase];

  let message = record.message || stageLabels[record.stage];
  if (record.refundInProgress) message = "退款处理中。如需了解进度，请联系本站客服。";
  else if (phase === "succeeded" && done) message = "兑换成功。请刷新 ChatGPT 页面查看套餐状态。";
  else if (phase === "unknown") {
    message = record.canReconcile
      ? "暂未确认本次提交结果。可使用原资料核对本次提交。"
      : "暂未确认本次提交结果，请凭本站兑换编号联系客服核对。";
  } else if (reviewing) message ||= "兑换结果正在核对，请查询原任务进度。";
  else if (done) message ||= "请凭本站兑换编号联系客服。";
  else message ||= "兑换正在处理，请稍后查询进度。";
  byId("progress-message").textContent = stale ? `${message} 进度暂未更新，正在查询原任务。` : message;
  byId("progress-plan").textContent = displayPlan(record);
  byId("progress-account").textContent = record.accountEmailMasked || "—";
  byId("progress-reference").textContent = record.reference || "—";
  const finished = phase === "succeeded" && done && record.finishedAt;
  byId("finished-label").hidden = !finished;
  byId("progress-finished").hidden = !finished;
  byId("progress-finished").textContent = finished ? new Date(finished).toLocaleString("zh-CN") : "";
  byId("retry-button").hidden = !record.canRetry;
  byId("reconcile-button").hidden = !record.canReconcile;
  byId("restart-button").hidden = !(done || (phase === "unknown" && !record.canQuery));
  statusButton.hidden = !record.canQuery;
}

function renderRecord(record, focus = false) {
  state.record = record;
  if (!record) {
    setStep("code");
  } else if (record.phase === "ready") {
    openSession("initial", focus);
  } else {
    state.code = "";
    setStep("progress");
    renderProgress(record);
    scheduleStatus();
  }
}

function scheduleStatus() {
  window.clearTimeout(state.pollTimer);
  const record = state.record;
  if (state.step !== "progress" || !record?.canQuery ||
      (terminal.has(record.phase) && !record.paused && !record.stale && record.stage !== "review")) return;
  const interval = Date.now() - (record.startedAt ?? Date.now()) < 120000 ? 5000 : 20000;
  state.pollTimer = window.setTimeout(pollStatus, Math.max(interval, state.nextPollAt - Date.now()));
}

async function pollStatus() {
  if (state.polling || state.step !== "progress") return;
  if (Date.now() < state.nextPollAt) {
    return scheduleStatus();
  }
  const generation = state.pollGeneration;
  state.polling = true;
  statusButton.disabled = true;
  try {
    const result = await request("status");
    if (generation !== state.pollGeneration) return;
    if (!result.ok) throw new Error(result.error);
    renderRecord(result.data);
  } catch {
    if (generation !== state.pollGeneration || !state.record) return;
    state.record = { ...state.record, stale: true, canRetry: false };
    renderProgress(state.record);
    scheduleStatus();
  } finally {
    state.polling = false;
    statusButton.disabled = false;
  }
}

async function returnHome() {
  const result = await request("status", { method: "DELETE" });
  if (!result.ok) {
    showError(result.error);
    return;
  }
  stopPolling();
  state.record = null;
  state.code = "";
  state.recoveryCode = "";
  state.nextPollAt = 0;
  codeForm.reset();
  recoveryForm.reset();
  resetCredentials();
  setStep("code");
  codeInput.focus();
}

codeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = codeInput.value;
  if (!code.trim()) {
    showError("请输入完整兑换卡密。");
    return codeInput.focus();
  }
  withButton(byId("code-check-button"), "正在验证", async () => {
    const result = await request("preview", { method: "POST", data: { code } });
    if (!result.ok) return showError(result.error);
    state.code = code;
    state.recoveryCode = result.data.recoveryCode ?? "";
    byId("copy-recovery").textContent = "复制";
    codeForm.reset();
    renderRecord(result.data, true);
  });
});

byId("open-recovery").addEventListener("click", () => {
  if (state.busy) return;
  showError();
  setStep("recover");
  byId("recovery-card").focus();
});
byId("close-recovery").addEventListener("click", () => {
  if (state.busy) return;
  recoveryForm.reset();
  showError();
  setStep("code");
  codeInput.focus();
});

recoveryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = byId("recovery-card").value;
  const recoveryCode = byId("recovery-code").value.trim();
  if (!code.trim() || !recoveryCode) return showError("请输入原兑换卡密和本站查询码。");
  withButton(byId("recover-button"), "正在恢复", async () => {
    const result = await request("recover", { method: "POST", data: { code, recoveryCode } });
    if (!result.ok) return showError(result.error);
    state.code = code;
    state.recoveryCode = recoveryCode;
    byId("copy-recovery").textContent = "复制";
    recoveryForm.reset();
    renderRecord(result.data, true);
  });
});

function getAccountEmail(session) {
  try {
    const email = JSON.parse(session)?.user?.email;
    return typeof email === "string" && email.length <= 320 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
      ? email : null;
  } catch {
    return null;
  }
}

sessionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.busy || !state.record) return;
  showError();
  const code = byId("original-code-field").hidden ? state.code : originalCodeInput.value;
  if (!code.trim()) {
    showError("请输入原兑换卡密。");
    return originalCodeInput.focus();
  }
  const session = sessionInput.value;
  if (!session.trim()) {
    showError("请输入 ChatGPT Session。");
    return sessionInput.focus();
  }
  state.code = code;
  byId("account-email").textContent = getAccountEmail(session) || "请核对登录账号";
  byId("plan-name").textContent = displayPlan(state.record);
  byId("confirm-product").textContent = state.record.productName;
  byId("confirm-message").textContent = state.intent === "reconcile"
    ? "请确认填写的是本次提交使用的原卡密和原始 Session，再核对原请求。"
    : "请核对 ChatGPT 账号。确认后将提交 Session 并开始兑换。";
  redeemButton.querySelector("span").textContent = state.intent === "reconcile" ? "确认核对" : "确认兑换";
  setStep("confirm");
  redeemButton.focus();
});

redeemButton.addEventListener("click", () => {
  if (!state.record || !state.code || !sessionInput.value.trim()) return;
  withButton(redeemButton, "正在提交", async () => {
    const record = state.record;
    const intent = state.intent;
    let result;
    try {
      const submission = request("submit", { method: "POST", data: {
        reference: record.reference, revision: record.revision, code: state.code, session: sessionInput.value,
        intent, confirmed: true,
      } });
      state.code = "";
      resetCredentials();
      byId("account-email").textContent = "—";
      result = await submission;
    } catch {
      renderRecord({ ...record, phase: "submitting", canRetry: false, canReconcile: false, canQuery: true, stale: true });
      return;
    }
    if (result.data) {
      renderRecord(result.data);
    } else if (!result.ok) {
      openSession(intent);
    } else {
      renderRecord({ ...record, phase: "submitting", canRetry: false, canReconcile: false, canQuery: true, stale: true });
    }
    if (!result.ok) showError(result.error || "请核对本次兑换资料。");
  });
});

byId("back-button").addEventListener("click", () => {
  if (state.busy) return;
  showError();
  byId("account-email").textContent = "—";
  openSession(state.intent);
});

byId("change-code-button").addEventListener("click", () => {
  if (state.busy) return;
  if (state.intent === "initial") {
    return withButton(byId("change-code-button"), "正在返回", returnHome);
  }
  showError();
  resetCredentials();
  renderRecord(state.record);
});
byId("restart-button").addEventListener("click", () =>
  withButton(byId("restart-button"), "正在返回", returnHome));
byId("retry-button").addEventListener("click", () => {
  if (!state.busy && state.record?.canRetry) {
    showError();
    openSession("retry");
  }
});
byId("reconcile-button").addEventListener("click", () => {
  if (!state.busy && state.record?.canReconcile) {
    showError();
    openSession("reconcile");
  }
});
statusButton.addEventListener("click", pollStatus);

toggleSessionButton.addEventListener("click", () => {
  const visible = toggleSessionButton.getAttribute("aria-pressed") === "true";
  toggleSessionButton.setAttribute("aria-pressed", String(!visible));
  toggleSessionButton.setAttribute("aria-label", visible ? "显示 Session" : "隐藏 Session");
  sessionInput.classList.toggle("is-visible", !visible);
});

const sessionHelpDialog = byId("session-help-dialog");
byId("session-help-button").addEventListener("click", () => sessionHelpDialog.showModal());
byId("close-session-help").addEventListener("click", () => sessionHelpDialog.close());
sessionHelpDialog.addEventListener("click", (event) => {
  if (event.target === sessionHelpDialog) sessionHelpDialog.close();
});
byId("copy-recovery").addEventListener("click", async () => {
  const input = byId("issued-recovery-code");
  if (!input.value) return;
  input.focus();
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
    byId("copy-recovery").textContent = "已复制";
  } catch {
    byId("copy-recovery").textContent = "请手动复制";
  }
});

const siteTitle = (typeof siteConfig.siteTitle === "string" && siteConfig.siteTitle.trim()) || "AI代充";
const footerBrandName = (typeof siteConfig.footerBrandName === "string" && siteConfig.footerBrandName.trim()) || siteTitle;
document.title = siteTitle;
byId("year").textContent = new Date().getFullYear();
byId("header-brand-name").textContent = footerBrandName;
byId("footer-brand-name").textContent = footerBrandName;
if (typeof siteConfig.supportUrl === "string" && /^(https:\/\/|mailto:)/i.test(siteConfig.supportUrl)) {
  byId("support-link").href = siteConfig.supportUrl;
  byId("support-link").hidden = false;
}

state.busy = true;
byId("code-check-button").disabled = true;
request("status").then((result) => {
  if (result.ok) renderRecord(result.data);
  else showError(result.error || "暂时无法读取兑换进度。");
}).catch(() => showError("暂时无法读取兑换进度。")).finally(() => {
  state.busy = false;
  byId("code-check-button").disabled = false;
});
