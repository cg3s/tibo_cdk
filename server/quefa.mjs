import { createHash, createHmac, randomUUID } from "node:crypto";

export const MAX_QUEFA_BODY = 256 * 1024;

function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function canonicalQuery(query) {
  return query.split("&").filter(Boolean).map((parameter) => {
    const separator = parameter.indexOf("=");
    const key = separator === -1 ? parameter : parameter.slice(0, separator);
    const value = separator === -1 ? "" : parameter.slice(separator + 1);
    return [encode(decodeURIComponent(key)), encode(decodeURIComponent(value))];
  }).sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    if (leftValue === rightValue) return 0;
    return leftValue < rightValue ? -1 : 1;
  }).map(([key, value]) => `${key}=${value}`).join("&");
}

export function signRequest({
  method, url, body = "", timestamp, nonce, keyId, idempotencyKey = "", clientSecret,
}) {
  const parsed = new URL(url);
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = [
    method.toUpperCase(), parsed.pathname, canonicalQuery(parsed.search.slice(1)),
    String(timestamp), nonce, keyId, idempotencyKey, bodyHash,
  ].join("\n");
  return createHmac("sha256", clientSecret).update(canonical).digest("hex");
}

export class QuefaError extends Error {
  constructor({ status = 502, code = "upstream_unavailable", requestId, retryAfter, sent = true } = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
    this.sent = sent;
  }
}

function retryDelay(value) {
  if (!value) return 20;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isSafeInteger(seconds) ? Math.max(1, seconds) : 20;
}

const safeIdentifier = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value) ? value : undefined;

export function createQuefaClient({ origin, partnerId, keyId, clientSecret, timeoutMs = 10000 }) {
  const blockedUntil = { GET: 0, POST: 0 };

  async function request(method, path, body, idempotencyKey = "") {
    const remaining = Math.ceil((blockedUntil[method] - Date.now()) / 1000);
    if (remaining > 0) {
      throw new QuefaError({ status: 429, code: "rate_limited", retryAfter: remaining, sent: false });
    }
    const url = new URL(path, origin);
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = randomUUID();
    const headers = {
      Accept: "application/json",
      "X-Partner-Id": partnerId,
      "X-Key-Id": keyId,
      "X-Timestamp": String(timestamp),
      "X-Nonce": nonce,
      "X-Signature": signRequest({ method, url, body, timestamp, nonce, keyId, idempotencyKey, clientSecret }),
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = idempotencyKey;
    }
    let response;
    let payload;
    try {
      response = await fetch(url, {
        method, headers, body, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      });
      payload = await response.json();
    } catch {
      if (!response) throw new QuefaError();
    }
    const requestId = safeIdentifier(response.headers.get("X-Request-Id"));
    const retryAfter = response.headers.has("Retry-After") || response.status === 429
      ? retryDelay(response.headers.get("Retry-After")) : undefined;
    if (response.status === 429 || (response.status === 503 && retryAfter)) {
      blockedUntil[method] = Date.now() + retryAfter * 1000;
    }
    const expectedStatus = path === "/v1/redemptions" ? 202 : 200;
    if (response.status !== expectedStatus || !payload?.data || typeof payload.data !== "object") {
      throw new QuefaError({
        status: response.ok ? 502 : response.status,
        code: safeIdentifier(payload?.error?.code) ?? "upstream_unavailable",
        requestId, retryAfter,
      });
    }
    return { data: payload.data, requestId };
  }

  return {
    preview: (body, key) => request("POST", "/v1/cdk/preview", body, key),
    submit: (body, key) => request("POST", "/v1/redemptions", body, key),
    status: (id) => request("GET", `/v1/redemptions/${encodeURIComponent(id)}`),
    order: (id) => request("GET", `/v1/orders/${encodeURIComponent(id)}`),
    fulfillments: (id) => request("GET", `/v1/orders/${encodeURIComponent(id)}/fulfillments`),
    profile: () => request("GET", "/v1/agent-profile"),
  };
}
