import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createQuefaClient, MAX_QUEFA_BODY, QuefaError } from "./server/quefa.mjs";
import { openStore, RECONCILE_WINDOW_MS, SESSION_MAX_AGE } from "./server/store.mjs";
import { verifyWebhook, WEBHOOK_BODY_LIMIT } from "./server/webhook.mjs";

const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/config.js": ["config.js", "text/javascript; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};
const MAX_BROWSER_BODY = 2 * 1024 * 1024;
const POLL_MINIMUM_MS = 5000;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32}$/;
const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]{1,120}$/;
const STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);
const STAGES = new Set([
  "queued", "logging_in", "preparing_funds", "awaiting_card", "dispatching", "processing",
  "requires_action", "confirming", "review", "upgrading", "completed", "failed", "cancelled",
]);
const NOT_ACCEPTED = new Set([
  "invalid_request", "invalid_signature", "timestamp_out_of_range", "nonce_replayed",
  "ip_not_allowed", "api_access_required", "custom_redemption_disabled", "product_not_authorized",
  "session_invalid", "account_has_subscription", "precheck_rejected", "recharge_credential_unchanged",
]);
const PUBLIC_ERRORS = {
  session_invalid: "登录资料已失效，请重新登录后获取完整 Session。",
  account_has_subscription: "此账号已有有效订阅，请核对兑换账号。",
  precheck_rejected: "账号校验未通过，请检查账号状态后再确认。",
  recharge_credential_unchanged: "请重新登录并提交最新的完整 Session。",
  invalid_request: "兑换资料格式有误，请检查卡密和 Session。",
};
const QUEFA_CHECK_HINTS = {
  ip_not_allowed: "检查该应用的 IP 白名单，确认运行命令的机器使用了已登记的出口 IP。",
  api_access_required: "在 Quefa 工作台核对代理和该应用的 API 权限。",
  custom_redemption_disabled: "在 Quefa 工作台核对代理的自建兑换权限。",
  invalid_signature: "确认 Partner ID、Key ID 和 Client Secret 属于同一应用及环境。",
  timestamp_out_of_range: "同步运行命令的机器的系统时间，再重新检查。",
};

class ApiError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function token() {
  return randomBytes(24).toString("base64url");
}

function json(response, status, body, retryAfter) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
  });
  response.end(JSON.stringify(body));
}

async function readBody(request, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new ApiError(415, "请使用 JSON 提交兑换资料。");
  }
  if (Number(request.headers["content-length"]) > limit) {
    throw new ApiError(413, "兑换资料过长，请检查复制内容。");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, "兑换资料过长，请检查复制内容。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readJson(request) {
  const raw = await readBody(request, MAX_BROWSER_BODY);
  try {
    const body = JSON.parse(raw.toString("utf8"));
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {}
  throw new ApiError(400, "兑换资料格式有误。");
}

const validCode = (code) => typeof code === "string" && code.length <= 64 && code.trim().length > 0;
const isToken = (value) => typeof value === "string" && TOKEN_PATTERN.test(value);
const safeTaskId = (id) => typeof id === "string" && TASK_ID_PATTERN.test(id);
const asInteger = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

function publicText(value) {
  if (typeof value !== "string" || value.length > 300 ||
      /https?:\/\/|\b(?:access[_-]?token|session[_-]?token|client[_-]?secret|bearer|password)\b|[\u0000-\u001f]/i.test(value)) {
    return null;
  }
  return value
    .replace(/\b(?:tibo|quefa)(?:\.ink)?\b|雀发/gi, "兑换服务")
    .replace(/\b(?:ord_|ful_|req_)[\w-]+|\bQF[0-9]+\b/gi, "〔已隐藏〕")
    .replace(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "〔邮箱已隐藏〕")
    .replace(/[A-Za-z0-9_-]{20,}/g, "〔已隐藏〕")
    .trim() || null;
}

function taskFrom(data, accepted = false) {
  if (!safeTaskId(data.redemption_id) || !safeTaskId(data.order_id) ||
      (!accepted && (!STATUSES.has(data.status) || typeof data.paused !== "boolean"))) {
    throw new QuefaError();
  }
  const finished = typeof data.finished_at === "string" ? Date.parse(data.finished_at) : NaN;
  return {
    id: data.redemption_id,
    orderId: data.order_id,
    attempt: asInteger(data.attempt_no),
    version: accepted ? null : asInteger(data.progress_version),
    status: accepted ? "queued" : data.status,
    paused: !accepted && data.paused === true,
    stage: !accepted && STAGES.has(data.progress_stage) ? data.progress_stage : null,
    message: accepted ? null : publicText(data.message),
    account: typeof data.account_email_masked === "string" && data.account_email_masked.length <= 320 &&
      /^[^@\s]*\*[^@\s]*@[a-z0-9.-]+$/i.test(data.account_email_masked) ? data.account_email_masked : null,
    finishedAt: !accepted && Number.isFinite(finished) ? new Date(finished).toISOString() : null,
    retryAllowed: !accepted && data.retry_allowed === true && data.next_action === "resubmit" &&
      data.fallback_recharge_available === true && data.recovery_action !== "refund",
    refundInProgress: !accepted && data.recovery_action === "refund",
  };
}

function describeQuefaCheckError(error, endpoint) {
  if (!error.receivedResponse) {
    return `无法连接 Quefa 权限接口 ${endpoint}，请检查 API 地址和本机网络。`;
  }
  const hasCode = error.code !== "upstream_unavailable";
  const details = [`HTTP ${error.status}`, hasCode ? error.code : "未返回 Quefa 错误码"];
  if (error.requestId) details.push(`Request ID ${error.requestId}`);
  const hint = Object.hasOwn(QUEFA_CHECK_HINTS, error.code) ? QUEFA_CHECK_HINTS[error.code]
    : error.status === 403 ? "请核对 Quefa API 地址、应用权限和运行机器的出口 IP 白名单。" : "";
  return `Quefa 权限查询失败（${details.join("，")}）。\n请求地址 ${endpoint}。${hint}`;
}

function mayRetry(record) {
  const task = record.task;
  return Boolean(task && (!record.submission || ["accepted", "rejected"].includes(record.submission.state)) &&
    ["failed", "cancelled"].includes(task.status) && !task.paused && !task.orderRefunded &&
    task.stage !== "review" && task.retryAllowed);
}

export function createRedemptionService({
  appOrigin, dbPath, recordSecret, provider, webhookSecret, retryEnabled = false, trustLoopbackProxy = false,
  pollMinimumMs = POLL_MINIMUM_MS, logger = console,
}) {
  const store = openStore(dbPath);
  const secure = new URL(appOrigin).protocol === "https:";
  const cookieName = secure ? "__Host-redemption" : "redemption";
  const inflight = new Map();
  const lastPoll = new Map();
  const rateLimits = new Map();
  const hash = (purpose, value) => createHmac("sha256", recordSecret).update(purpose).update("\0").update(value).digest("hex");

  function view(record, { stale = false } = {}) {
    if (!record) return null;
    const { task, submission } = record;
    const phase = submission?.state === "pending" ? "submitting"
      : submission?.state === "unknown" ? "unknown" : task?.status ?? "ready";
    const opened = phase === "unknown" || phase === "submitting";
    return {
      reference: record.reference,
      productName: record.product_name,
      targetPlan: record.target_plan,
      revision: submission?.revision ?? 0,
      startedAt: submission?.first_sent_at ?? null,
      phase,
      paused: !opened && task?.paused === true,
      stage: !opened ? task?.stage ?? null : null,
      message: !opened ? task?.message ?? null : null,
      accountEmailMasked: !opened ? task?.account ?? null : null,
      finishedAt: !opened ? task?.finishedAt ?? null : null,
      refundInProgress: !opened && task?.refundInProgress === true,
      canRetry: retryEnabled && !stale && mayRetry(record),
      canReconcile: phase === "unknown" && Date.now() - submission.first_sent_at < RECONCILE_WINDOW_MS,
      canQuery: Boolean(task) || phase === "submitting",
      stale,
    };
  }

  function lookup(request) {
    const cookie = request.headers.cookie?.split(";").map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`));
    const value = cookie?.slice(cookieName.length + 1);
    return isToken(value) ? hash("cookie", value) : null;
  }

  function setCookie(response, value, maxAge) {
    response.setHeader("Set-Cookie",
      `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
  }

  function issueSession(response, reference, oldCookie) {
    const secret = token();
    store.attach(reference, hash("cookie", secret));
    if (oldCookie) store.detach(oldCookie);
    setCookie(response, secret, SESSION_MAX_AGE);
  }

  function limit(request, action) {
    const address = request.socket.remoteAddress;
    const proxied = request.headers["x-real-ip"];
    const trusted = trustLoopbackProxy && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address) &&
      typeof proxied === "string" && isIP(proxied);
    const key = `${action}:${trusted ? proxied : address}`;
    const now = Date.now();
    for (const [entry, { until }] of rateLimits) if (until <= now) rateLimits.delete(entry);
    const bucket = rateLimits.get(key) ?? { count: 0, until: now + 60000 };
    if (++bucket.count > 30) {
      throw new ApiError(429, "操作过于频繁，请稍后再试。", Math.ceil((bucket.until - now) / 1000));
    }
    rateLimits.set(key, bucket);
  }

  function warn(action, reference, error) {
    logger.warn("quefa", { action, reference, status: error.status, requestId: error.requestId });
  }

  async function verifyOrder(orderId) {
    const { data: order } = await provider.order(orderId);
    if (order.order_id !== orderId || order.fulfillment_mode !== "cdk" || order.delivery_mode === "auto_recharge" ||
        !["pending", "paid", "expired", "closed", "partially_refunded", "refunded"].includes(order.payment_status)) {
      throw new QuefaError();
    }
    if (order.payment_status === "refunded") store.markOrderRefunded(orderId);
    const { data: list } = await provider.fulfillments(orderId);
    if (!Array.isArray(list)) throw new QuefaError();
    let latest;
    for (const item of list) {
      if (!item || item.order_id !== orderId || item.fulfillment_mode !== "cdk" ||
          !Number.isSafeInteger(item.attempt_no) || item.attempt_no < 1 || !safeTaskId(item.fulfillment_id) ||
          (latest?.attempt_no === item.attempt_no && latest.fulfillment_id !== item.fulfillment_id)) {
        throw new QuefaError();
      }
      if (!latest || item.attempt_no > latest.attempt_no) latest = item;
    }
    if (!latest) throw new QuefaError();
    return {
      taskId: latest.fulfillment_id,
      attempt: latest.attempt_no,
      canRedeem: ["paid", "partially_refunded"].includes(order.payment_status),
    };
  }

  async function refresh(record, force = false, checkOrder = false) {
    if (!record.task || record.submission?.state === "pending") return { stale: false };
    const { reference, task } = record;
    const active = inflight.get(reference);
    if (active) {
      if (!checkOrder || active.checkOrder) return active.job;
      await active.job;
      return refresh(store.read(reference), true, true);
    }
    const now = Date.now();
    for (const [key, previous] of lastPoll) if (now - previous.at > 60000) lastPoll.delete(key);
    const previous = lastPoll.get(reference);
    if (!force && previous && previous.taskId === task.id && now - previous.at < pollMinimumMs) {
      return previous.result;
    }
    const job = (async () => {
      try {
        const verified = checkOrder ? await verifyOrder(task.orderId) : null;
        if (verified && task.attempt !== null && (verified.attempt < task.attempt ||
            (verified.attempt === task.attempt && verified.taskId !== task.id))) {
          throw new QuefaError();
        }
        let id = verified?.taskId ?? task.id;
        let response = await provider.status(id);
        const latestId = response.data.latest_redemption_id;
        if (response.data.redemption_id !== id || response.data.order_id !== task.orderId) throw new QuefaError();
        if (latestId != null && latestId !== id) {
          if (!safeTaskId(latestId)) throw new QuefaError();
          id = latestId;
          response = await provider.status(id);
        }
        const updated = taskFrom(response.data);
        if (updated.id !== id || updated.orderId !== task.orderId ||
            (response.data.latest_redemption_id != null && response.data.latest_redemption_id !== id)) {
          throw new QuefaError();
        }
        if (verified && id === verified.taskId) {
          if (updated.attempt !== null && updated.attempt !== verified.attempt) throw new QuefaError();
          updated.attempt = verified.attempt;
        }
        if (verified && !verified.canRedeem) updated.retryAllowed = false;
        const applied = store.applyStatus(reference, task.id, updated);
        return { stale: !applied };
      } catch (error) {
        if (!(error instanceof QuefaError)) throw error;
        warn("status", reference, error);
        return { stale: true, retryAfter: error.retryAfter };
      }
    })().then((result) => {
      lastPoll.set(reference, { at: Date.now(), taskId: store.read(reference).task?.id, result });
      return result;
    }).finally(() => {
      inflight.delete(reference);
    });
    inflight.set(reference, { job, checkOrder });
    return job;
  }

  let webhookTimer;
  let webhookJob;
  let closing = false;
  function drainWebhookChecks() {
    if (closing || webhookJob) return;
    webhookJob = (async () => {
      for (const check of store.dueWebhookChecks(Date.now())) {
        if (closing) break;
        const age = Date.now() - check.received_at;
        const records = store.recordsForOrder(check.order_id);
        if (!records.length) {
          store.finishWebhookCheck(check, age < 5 * 60000 ? 5000 : undefined);
          continue;
        }
        const retryDelay = Math.min(5000 * 2 ** check.retries, 300000);
        let retryInMs;
        for (const record of records) {
          if (record.submission?.state === "pending") {
            retryInMs = Math.max(retryInMs ?? 0, 5000);
            continue;
          }
          const result = await refresh(record, true, true);
          if (result.stale) {
            retryInMs = Math.max(retryInMs ?? 0, retryDelay, (result.retryAfter ?? 0) * 1000);
          }
        }
        store.finishWebhookCheck(check, age < RECONCILE_WINDOW_MS ? retryInMs : undefined);
      }
    })().catch((error) => {
      logger.error("quefa webhook sync failed", { type: error?.name });
    }).finally(() => {
      webhookJob = undefined;
    });
  }

  async function webhook(request, response) {
    if (!webhookSecret) throw new ApiError(503, "Quefa Webhook 未配置。");
    const body = await readBody(request, WEBHOOK_BODY_LIMIT);
    const receipt = verifyWebhook({ headers: request.headers, body, secret: webhookSecret });
    if (receipt.status) {
      throw new ApiError(receipt.status, receipt.status === 401 ? "Webhook 验签失败。" : "Webhook 事件无效。");
    }
    if (store.receiveWebhook(receipt)) response.once("finish", drainWebhookChecks);
    response.writeHead(204).end();
  }

  async function preview(request, response, current, cookie) {
    limit(request, "preview");
    const { code } = await readJson(request);
    if (!validCode(code)) throw new ApiError(400, "请输入完整的兑换卡密。");
    const codeHash = hash("code", code);
    if (current?.code_hash === codeHash) {
      return json(response, 200, { data: view(current) });
    }
    if (store.claimed(codeHash)) {
      throw new ApiError(409, "此卡密已有兑换记录，请使用本站查询码恢复进度。");
    }
    let previewed;
    try {
      ({ data: previewed } = await provider.preview(Buffer.from(JSON.stringify({ code })), `preview:${randomUUID()}`));
    } catch (error) {
      if (!(error instanceof QuefaError)) throw error;
      warn("preview", undefined, error);
      if (error.status === 429) throw new ApiError(429, "验证请求较多，请稍后再试。", error.retryAfter);
      if ([400, 404, 409, 422].includes(error.status) && error.code !== "idempotency_conflict") {
        throw new ApiError(error.status, "卡密当前不可兑换，请核对完整卡密或联系本站客服。");
      }
      throw new ApiError(503, "暂时无法验证卡密，请稍后再试。", error.retryAfter);
    }
    const productName = publicText(previewed.product_name);
    if (!productName || typeof previewed.product_code !== "string" ||
        (previewed.target_plan !== null && typeof previewed.target_plan !== "string")) {
      throw new ApiError(502, "兑换服务返回的套餐信息不完整，请稍后再试。");
    }
    const reference = randomUUID();
    const recoveryCode = token();
    store.create({ reference, codeHash, recoveryHash: hash("recovery", recoveryCode),
      productName, targetPlan: publicText(previewed.target_plan) });
    issueSession(response, reference, cookie);
    return json(response, 200, { data: { ...view(store.read(reference)), recoveryCode } });
  }

  async function recover(request, response, cookie) {
    limit(request, "recover");
    const { code, recoveryCode } = await readJson(request);
    if (!validCode(code) || !isToken(recoveryCode)) throw new ApiError(400, "请输入完整的原卡密和本站查询码。");
    const codeHash = hash("code", code);
    const reference = store.recover(codeHash, hash("recovery", recoveryCode));
    const owner = store.claimed(codeHash);
    if (!reference || (owner && owner !== reference)) {
      throw new ApiError(404, "卡密或查询码有误，请检查后再试。");
    }
    issueSession(response, reference, cookie);
    return json(response, 200, { data: view(store.read(reference)) });
  }

  async function submit(request, response, record) {
    if (!record) throw new ApiError(401, "请先验证卡密或恢复兑换进度。");
    limit(request, "submit");
    const { reference, code, session, confirmed, intent, revision } = await readJson(request);
    if (reference !== record.reference || !validCode(code) || hash("code", code) !== record.code_hash) {
      throw new ApiError(400, "请核对本次兑换使用的原卡密。");
    }
    if (confirmed !== true || typeof session !== "string" || !session.trim() ||
        !["initial", "retry", "reconcile"].includes(intent) || asInteger(revision) === null) {
      throw new ApiError(400, "请填写完整 Session 并确认本次兑换。");
    }
    const body = Buffer.from(JSON.stringify({
      mode: "cdk", code, credential: { mode: "session", session }, customer_confirmed_email: true,
    }));
    if (body.byteLength > MAX_QUEFA_BODY) {
      throw new ApiError(413, "完整兑换资料超过 256 KiB，请检查是否复制了多余内容。");
    }
    record = store.read(reference);
    if ((record.submission?.revision ?? 0) !== revision || record.submission?.state === "pending" ||
        (intent === "initial" && (record.task || record.submission?.state === "unknown"))) {
      return json(response, 202, { data: view(record) });
    }
    if (intent === "retry") {
      if (!retryEnabled || !mayRetry(record)) throw new ApiError(409, "当前状态暂不能重新提交，请查询进度。");
      const previousTaskId = record.task.id;
      const result = await refresh(record, true);
      record = store.read(reference);
      if (result.stale || record.task?.id !== previousTaskId || !mayRetry(record)) {
        return json(response, 409, { data: view(record, result),
          error: { message: "暂不能重新提交，请核对最新兑换进度。" } }, result.retryAfter);
      }
    }
    if (intent === "reconcile" && record.task) {
      await refresh(record);
      record = store.read(reference);
      if (record.submission?.state !== "unknown") {
        return json(response, 202, { data: view(record) });
      }
    }
    const submission = store.startSubmission({
      reference, expectedRevision: revision, businessKey: `redeem:${randomUUID()}`,
      bodyHash: hash("body", body), reconcile: intent === "reconcile",
    });
    if (submission.reason === "cannot_reconcile") {
      throw new ApiError(409, "无法核对，请确认填写的是原样提交的资料且仍在核对时限内。");
    }
    if (submission.reason === "already_claimed") {
      throw new ApiError(409, "此卡密已有兑换记录，请使用本站查询码恢复进度。");
    }
    if (submission.reason) return json(response, 202, { data: view(store.read(reference)) });

    let requestId;
    try {
      const submitted = await provider.submit(body, submission.businessKey);
      requestId = submitted.requestId;
      const task = taskFrom(submitted.data, true);
      if (record.task && (record.task.orderId !== task.orderId ||
          (task.attempt !== null && record.task.attempt !== null && task.attempt <= record.task.attempt) ||
          task.id === record.task.id)) throw new QuefaError();
      store.finishSubmission(reference, submission.revision, "accepted", requestId, task);
    } catch (error) {
      if (!(error instanceof QuefaError)) throw error;
      warn("submit", reference, error);
      const rejected = intent !== "reconcile" && (!error.sent ||
        (error.status >= 400 && error.status < 500 && NOT_ACCEPTED.has(error.code)));
      store.finishSubmission(reference, submission.revision, rejected ? "rejected" : "unknown", error.requestId ?? requestId);
      const data = view(store.read(reference), { stale: rejected && Boolean(record.task) });
      if (!rejected) return json(response, 202, { data }, error.retryAfter);
      const message = Object.hasOwn(PUBLIC_ERRORS, error.code) ? PUBLIC_ERRORS[error.code]
        : error.status === 429 ? "提交请求较多，请稍后再试。" : "本次提交未受理，请稍后再试或联系本站客服。";
      return json(response, error.status === 429 ? 429 : 400, { data, error: { message } }, error.retryAfter);
    }
    return json(response, 202, { data: view(store.read(reference)) });
  }

  const server = createServer({ requestTimeout: 30000 }, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy",
      "default-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    try {
      const pathname = request.url?.split("?")[0];
      const method = request.method;
      if (Object.hasOwn(STATIC_FILES, pathname) && ["GET", "HEAD"].includes(method)) {
        const [name, type] = STATIC_FILES[pathname];
        const body = await readFile(new URL(name, import.meta.url));
        response.writeHead(200, { "Content-Type": type, "Content-Length": body.byteLength });
        return response.end(method === "HEAD" ? undefined : body);
      }
      if (pathname === "/webhooks/quefa") {
        if (method === "POST") return await webhook(request, response);
        response.setHeader("Allow", "POST");
        throw new ApiError(405, "Webhook 仅接受 POST。");
      }
      if (!pathname?.startsWith("/api/redemption/")) throw new ApiError(404, "页面不存在。");
      if (method !== "GET" && request.headers.origin !== appOrigin) throw new ApiError(403, "请从本站提交请求。");
      const cookie = lookup(request);
      const record = cookie ? store.browserRecord(cookie) : null;
      if (method === "GET" && pathname === "/api/redemption/status") {
        if (!record) return json(response, 200, { data: null });
        const result = await refresh(record);
        return json(response, 200, { data: view(store.read(record.reference), result) }, result.retryAfter);
      }
      if (method === "DELETE" && pathname === "/api/redemption/status") {
        if (cookie) store.detach(cookie);
        setCookie(response, "", 0);
        return json(response, 200, { data: null });
      }
      if (method === "POST" && pathname === "/api/redemption/preview") return await preview(request, response, record, cookie);
      if (method === "POST" && pathname === "/api/redemption/recover") return await recover(request, response, cookie);
      if (method === "POST" && pathname === "/api/redemption/submit") return await submit(request, response, record);
      throw new ApiError(404, "接口不存在。");
    } catch (error) {
      request.resume();
      if (!(error instanceof ApiError)) logger.error("redemption request failed", { type: error?.name });
      if (!response.headersSent) {
        const known = error instanceof ApiError;
        json(response, known ? error.status : 500,
          { error: { message: known ? error.message : "服务暂时不可用，请查询最新进度或联系本站客服。" } },
          known ? error.retryAfter : undefined);
      }
    }
  });
  if (webhookSecret) {
    server.once("listening", () => {
      webhookTimer = setInterval(drainWebhookChecks, 1000);
      webhookTimer.unref();
      drainWebhookChecks();
    });
  }
  server.once("close", () => {
    closing = true;
    clearInterval(webhookTimer);
    if (webhookJob) void webhookJob.then(() => store.close());
    else store.close();
  });
  return server;
}

async function main() {
  const port = Number(process.env.PORT ?? 5173);
  const appOrigin = new URL(process.env.APP_ORIGIN ?? `http://127.0.0.1:${port}`);
  const production = process.env.NODE_ENV === "production";
  const origin = new URL(process.env.QUEFA_API_ORIGIN ?? "https://tibo.ink");
  const partnerId = process.env.QUEFA_PARTNER_ID;
  const appId = process.env.QUEFA_APP_ID;
  const keyId = process.env.QUEFA_KEY_ID;
  const clientSecret = process.env.QUEFA_CLIENT_SECRET;
  const webhookSecret = process.env.QUEFA_WEBHOOK_SECRET;
  if (!partnerId || !keyId || !clientSecret || origin.protocol !== "https:" || origin.username || origin.password) {
    throw new Error("请配置 QUEFA_PARTNER_ID、QUEFA_KEY_ID、QUEFA_CLIENT_SECRET 和 HTTPS Quefa 地址。");
  }
  if (appId && !/^[a-zA-Z0-9_.:-]{1,120}$/.test(appId)) throw new Error("QUEFA_APP_ID 格式无效。");
  const provider = createQuefaClient({ origin: origin.origin, partnerId, keyId, clientSecret });
  if (process.argv.includes("--check-quefa")) {
    try {
      const { data } = await provider.profile();
      if (typeof data.merchant?.status !== "string" || typeof data.profile?.customRedemptionEnabled !== "boolean") {
        throw new Error("Quefa 权限响应缺少代理状态或自建兑换开关。");
      }
      if (data.merchant.status !== "active") throw new Error("Quefa API 已连通，代理账号当前未启用。");
      if (!data.profile.customRedemptionEnabled) throw new Error("Quefa API 已连通，代理尚未开启自建兑换权限。");
      console.log("Quefa 代理状态正常，自建兑换权限已开启。");
      if (appId) console.log(`Quefa 应用 App ID ${appId}`);
      if (webhookSecret) console.log(`本站 Quefa Webhook ${new URL("/webhooks/quefa", appOrigin)}`);
    } catch (error) {
      if (!(error instanceof QuefaError)) throw error;
      throw new Error(describeQuefaCheckError(error, new URL("/v1/agent-profile", origin)));
    }
    return;
  }
  const recordSecret = process.env.REDEMPTION_RECORD_SECRET;
  if (!recordSecret || Buffer.byteLength(recordSecret) < 32 ||
      !["https:", "http:"].includes(appOrigin.protocol) || (production && appOrigin.protocol !== "https:")) {
    throw new Error("请配置至少 32 字节的 REDEMPTION_RECORD_SECRET 和本站 APP_ORIGIN，生产环境使用 HTTPS。");
  }
  const server = createRedemptionService({
    appOrigin: appOrigin.origin,
    dbPath: resolve(process.env.REDEMPTION_DB_PATH ?? "data/redemptions.sqlite"),
    recordSecret, provider, webhookSecret,
    retryEnabled: process.env.ENABLE_CDK_RETRY === "1",
    trustLoopbackProxy: process.env.TRUST_LOOPBACK_PROXY === "1",
  });
  server.listen(port, process.env.HOST ?? "127.0.0.1", () => console.log(`兑换服务已启动，监听端口 ${port}。`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
