import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRedemptionService } from "../server.mjs";
import { canonicalQuery, createQuefaClient, MAX_QUEFA_BODY, signRequest } from "../server/quefa.mjs";

const APP_ORIGIN = "http://127.0.0.1:5173";
const partnerId = "pt_demo";
const keyId = "key_demo_01";
const clientSecret = "tibo_demo_secret_never_use_in_production";
const code = "SHOP_AX8D-B7X9-Z3K2";
const session = '  { "user":{"email":"test@example.com"},"accessToken":"synthetic-session-for-tests"}\n}\n';
const queued = {
  redemption_id: "ful_attempt_1", order_id: "QF0000003001", attempt_no: 1,
  fulfillment_mode: "cdk", status: "queued", paused: false, fallback_recharge_available: false,
  account_email_masked: null, message: null, finished_at: null,
};
const failed = {
  ...queued, status: "failed", retry_allowed: true, next_action: "resubmit",
  fallback_recharge_available: true, message: "登录资料已失效，请重新提交。",
};

test("matches all three Quefa signing vectors and keeps plus signs literal", () => {
  const body = JSON.stringify({
    merchant_order_no: "DEMO-中文-001", product_code: "chatgpt_plus_cdk_1m", quantity: 1,
    sale_amount: "135.00", collection_mode: "platform_collect", delivery_mode: "auto_recharge",
  });
  const order = {
    method: "POST", url: "https://tibo.ink/v1/orders", body: Buffer.from(body),
    idempotencyKey: "demo-order-0001", keyId, clientSecret,
  };
  assert.equal(signRequest({ ...order, timestamp: 1790323200, nonce: "demo-nonce-0001" }),
    "82844463eb516b0891b81956465ee7e4c240e5fec403da12f0c4ea5e5d7cd1e0");
  assert.equal(signRequest({
    ...order, method: "GET", body: "", idempotencyKey: "",
    url: "https://tibo.ink/v1/orders?search=%E6%B5%8B%E8%AF%95&limit=20&payment_status=paid",
    timestamp: 1790323260, nonce: "demo-nonce-0002",
  }), "9913c8b36f8354f1a15d6c8a875fa9f45b846a1ea33b054212d30c9e30dd3496");
  assert.equal(signRequest({ ...order, timestamp: 1790323320, nonce: "demo-nonce-0003" }),
    "4688e31de9214846fc167d1756a863d83837238ebdc4f394b39e84a6bdb6f207");
  assert.equal(canonicalQuery("z=x&a=+&a=%21&a=%20"), "a=%20&a=%21&a=%2B&z=x");
});

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", "X-Request-Id": "req_test", ...headers });
  response.end(JSON.stringify(body));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const close = (server) => new Promise((resolve, reject) =>
  server.close((error) => error ? reject(error) : resolve()));

async function fixture(t, { dbPath = ":memory:", retryEnabled = true } = {}) {
  const calls = [];
  const state = {
    preview(response) {
      send(response, 200, { data: {
        product_code: "chatgpt_plus_cdk_1m", product_name: "ChatGPT Plus 一个月", target_plan: "plus",
      } });
    },
    submit(response) { send(response, 202, { data: queued }); },
    status(response) { send(response, 200, { data: queued }); },
  };
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const call = { path: request.url, method: request.method, headers: request.headers, body };
    calls.push(call);
    const h = request.headers;
    const expected = signRequest({
      method: call.method, url: `http://127.0.0.1${call.path}`, body, clientSecret, keyId,
      timestamp: h["x-timestamp"], nonce: h["x-nonce"], idempotencyKey: h["idempotency-key"],
    });
    if (h["x-signature"] !== expected || h["x-partner-id"] !== partnerId || h["x-key-id"] !== keyId ||
        (call.method === "POST" && !h["idempotency-key"])) {
      send(response, 401, { error: { code: "invalid_signature" } });
      return;
    }
    if (call.path === "/v1/cdk/preview") return state.preview(response, call);
    if (call.path === "/v1/redemptions") return state.submit(response, call);
    if (call.path.startsWith("/v1/redemptions/")) return state.status(response, call);
    send(response, 404, { error: { code: "not_found" } });
  });
  const origin = await listen(upstream);
  let app;
  let url;
  const provider = createQuefaClient({ origin, partnerId, keyId, clientSecret, timeoutMs: 500 });
  async function start() {
    app = createRedemptionService({
      appOrigin: APP_ORIGIN, dbPath, retryEnabled, provider,
      recordSecret: "record-secret-kept-across-test-restarts",
      pollMinimumMs: 0, logger: { warn() {}, error() {} },
    });
    url = await listen(app);
  }
  t.after(async () => {
    if (app.listening) await close(app);
    await close(upstream);
  });
  await start();
  function browser() {
    let cookie;
    return {
      async api(path, data, method = data ? "POST" : "GET", originHeader = APP_ORIGIN) {
        const response = await fetch(`${url}/api/redemption/${path}`, {
          method,
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(method !== "GET" ? { Origin: originHeader } : {}),
            ...(data ? { "Content-Type": "application/json" } : {}),
          },
          body: data ? JSON.stringify(data) : undefined,
        });
        const setCookie = response.headers.get("Set-Cookie");
        if (setCookie) [cookie] = setCookie.split(";");
        return { status: response.status, setCookie, retryAfter: response.headers.get("Retry-After"),
          ...await response.json() };
      },
    };
  }
  return {
    state, calls, browser, close: () => close(app), restart: async () => { await close(app); await start(); },
    staticFile: (path) => fetch(url + path),
  };
}

function submission(record, options = {}) {
  return { reference: record.reference, revision: record.revision, code, session,
    confirmed: true, intent: "initial", ...options };
}

test("previews and submits the original fields, then recovers a persistent status across devices", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tibo-redemption-"));
  const dbPath = join(directory, "test.sqlite");
  const app = await fixture(t, { dbPath });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const buyer = app.browser();
  const other = app.browser();
  assert.equal((await buyer.api("preview", { code }, "POST", "https://another.invalid")).status, 403);
  const preview = await buyer.api("preview", { code });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.targetPlan, "plus");
  assert.match(preview.setCookie, /HttpOnly; SameSite=Strict/);
  assert.equal(JSON.parse(app.calls[0].body).code, code);
  assert.equal((await other.api("status")).data, null);
  assert.equal((await other.api("submit", submission(preview.data))).status, 401);
  assert.equal((await buyer.api("submit", submission(preview.data, { session: "中文".repeat(MAX_QUEFA_BODY) }))).status, 413);
  assert.equal(app.calls.length, 1);

  const longSession = session.replace("synthetic-session-for-tests", "长".repeat(64000));
  const payload = submission(preview.data, { session: longSession });
  const accepted = await buyer.api("submit", payload);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.data.phase, "queued");
  assert.deepEqual(JSON.parse(app.calls[1].body), {
    mode: "cdk", code, credential: { mode: "session", session: longSession }, customer_confirmed_email: true,
  });
  assert.equal(accepted.data.redemption_id, undefined);
  assert.equal((await app.staticFile("/server.mjs")).status, 404);
  assert.equal((await app.staticFile("/.env")).status, 404);
  assert.equal((await app.staticFile("/quefa-partner-integration-kit.zip")).status, 404);

  app.state.status = (response) => send(response, 200, { data: {
    ...queued, status: "succeeded", account_email_masked: "t***@example.com",
    finished_at: "2026-11-24T08:02:30Z", message: "成功，内部编号 QF0000003001",
  } });
  await app.restart();
  const restored = await buyer.api("status");
  assert.equal(restored.data.phase, "succeeded");
  assert.equal(restored.data.finishedAt, "2026-11-24T08:02:30.000Z");
  assert.equal(restored.data.accountEmailMasked, "t***@example.com");
  assert.doesNotMatch(JSON.stringify(restored.data), /QF0000003001|ful_attempt|synthetic-session|SHOP_AX8D/);
  assert.equal((await other.api("recover", { code: "WRONG_CODE", recoveryCode: preview.data.recoveryCode })).status, 404);
  assert.equal((await other.api("recover", { code, recoveryCode: preview.data.recoveryCode })).data.reference, preview.data.reference);
  assert.equal((await other.api("status")).data.phase, "succeeded");
  assert.equal((await other.api("status", undefined, "DELETE")).status, 200);
  assert.equal((await other.api("status")).data, null);
  await app.close();
  assert.doesNotMatch((await readFile(dbPath)).toString(), /synthetic-session|SHOP_AX8D|test@example\.com/);
  assert.ok(!(await readFile(dbPath)).includes(preview.data.recoveryCode));
});

test("atomically prevents concurrent submissions for the same card and stale form", async (t) => {
  const app = await fixture(t);
  const first = app.browser();
  const second = app.browser();
  const primary = await first.api("preview", { code });
  const competing = await second.api("preview", { code });
  const results = await Promise.all([
    first.api("submit", submission(primary.data)),
    first.api("submit", submission(primary.data)),
    second.api("submit", submission(competing.data)),
  ]);
  assert.equal(app.calls.filter((call) => call.path === "/v1/redemptions").length, 1);
  assert.ok(results.some((result) => result.status === 202 && result.data.phase === "queued"));
  assert.ok(results.some((result) => result.status === 409));
});

test("retains an unknown attempt across restart and only replays its original bytes and key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tibo-replay-"));
  const app = await fixture(t, { dbPath: join(directory, "test.sqlite") });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const buyer = app.browser();
  const preview = await buyer.api("preview", { code });
  app.state.submit = (response) => response.destroy();
  const unknown = await buyer.api("submit", submission(preview.data));
  assert.equal(unknown.data.phase, "unknown");
  assert.equal(unknown.data.canReconcile, true);
  assert.equal(unknown.data.canRetry, false);
  await app.restart();
  const current = await buyer.api("status");
  assert.equal(current.data.phase, "unknown");
  const wrong = await buyer.api("submit", submission(current.data, { intent: "reconcile", session: session.trim() }));
  assert.equal(wrong.status, 409);
  assert.equal((await buyer.api("submit", submission(current.data))).data.phase, "unknown");
  assert.equal(app.calls.length, 2);
  app.state.submit = (response) => send(response, 202, { data: queued });
  const replayed = await buyer.api("submit", submission(current.data, { intent: "reconcile" }));
  assert.equal(replayed.data.phase, "queued");
  assert.deepEqual(app.calls[1].body, app.calls[2].body);
  assert.equal(app.calls[1].headers["idempotency-key"], app.calls[2].headers["idempotency-key"]);
  assert.notEqual(app.calls[1].headers["x-nonce"], app.calls[2].headers["x-nonce"]);
});

test("follows latest tasks, backs off on 429, and ignores a stale or unrelated result", async (t) => {
  const app = await fixture(t);
  const buyer = app.browser();
  const preview = await buyer.api("preview", { code });
  await buyer.api("submit", submission(preview.data));
  app.state.status = (response, call) => {
    const old = call.path.endsWith(queued.redemption_id);
    send(response, 200, { data: old
      ? { ...failed, latest_redemption_id: "ful_attempt_2" }
      : { ...queued, redemption_id: "ful_attempt_2", attempt_no: 2, status: "running", progress_version: 3 } });
  };
  assert.equal((await buyer.api("status")).data.phase, "running");
  app.state.status = (response) => send(response, 200, { data: {
    ...failed, redemption_id: "ful_attempt_2", attempt_no: 2, progress_version: 1,
  } });
  const stale = await buyer.api("status");
  assert.equal(stale.data.phase, "running");
  assert.equal(stale.data.canRetry, false);
  app.state.status = (response) => send(response, 200, { data: {
    ...failed, redemption_id: "ful_attempt_2", attempt_no: 2, progress_version: 4,
    order_id: "QF0000009999",
  } });
  assert.equal((await buyer.api("status")).data.stale, true);
  app.state.status = (response) => send(response, 429, { error: { code: "rate_limited" } }, { "Retry-After": "9" });
  const limited = await buyer.api("status");
  assert.equal(limited.retryAfter, "9");
  assert.equal(limited.data.phase, "running");
  const callCount = app.calls.length;
  assert.equal((await buyer.api("status")).data.stale, true);
  assert.equal(app.calls.length, callCount);
});

test("manual retry rechecks eligibility, closes on refund, and uses a new key only when authorized", async (t) => {
  const app = await fixture(t);
  const buyer = app.browser();
  const preview = await buyer.api("preview", { code });
  await buyer.api("submit", submission(preview.data));
  app.state.status = (response) => send(response, 200, { data: failed });
  const retryable = await buyer.api("status");
  assert.equal(retryable.data.canRetry, true);

  app.state.status = (response) => send(response, 200, { data: {
    ...failed, recovery_action: "refund", retry_allowed: false, next_action: "none",
  } });
  const blocked = await buyer.api("submit", submission(retryable.data, { intent: "retry" }));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.canRetry, false);
  assert.equal(blocked.data.refundInProgress, true);
  assert.equal(app.calls.filter((call) => call.path === "/v1/redemptions").length, 1);

  app.state.status = (response) => send(response, 200, { data: failed });
  app.state.submit = (response) => send(response, 202, { data: {
    ...queued, redemption_id: "ful_attempt_2", attempt_no: 2,
  } });
  const refreshed = await buyer.api("status");
  const retry = await buyer.api("submit", submission(refreshed.data, { intent: "retry", session: session + " " }));
  assert.equal(retry.data.phase, "queued");
  const writes = app.calls.filter((call) => call.path === "/v1/redemptions");
  assert.equal(writes.length, 2);
  assert.notEqual(writes[0].headers["idempotency-key"], writes[1].headers["idempotency-key"]);
  assert.equal(JSON.parse(writes[1].body).mode, "cdk");
});

test("manual retry stays disabled before sandbox validation even with eligible status", async (t) => {
  const app = await fixture(t, { retryEnabled: false });
  const buyer = app.browser();
  const preview = await buyer.api("preview", { code });
  await buyer.api("submit", submission(preview.data));
  app.state.status = (response) => send(response, 200, { data: failed });
  const status = await buyer.api("status");
  assert.equal(status.data.canRetry, false);
  assert.equal((await buyer.api("submit", submission(status.data, { intent: "retry" }))).status, 409);
  assert.equal(app.calls.filter((call) => call.path === "/v1/redemptions").length, 1);
});
