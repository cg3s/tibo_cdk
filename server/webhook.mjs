import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_BODY_LIMIT = 256 * 1024;
const SYNC_EVENTS = new Set([
  "fulfillment.updated",
  "fulfillment.succeeded",
  "fulfillment.failed",
  "fulfillment.cancelled",
  "refund.succeeded",
]);

export function verifyWebhook({ headers, body, secret, now = Date.now() }) {
  const timestamp = headers["x-quefa-timestamp"];
  const signature = /^t=([0-9]{1,13}),v1=([a-f0-9]{64})$/.exec(headers["x-quefa-signature"] ?? "");
  if (!signature || timestamp !== signature[1] || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300) {
    return { status: 401 };
  }
  const expected = createHmac("sha256", secret).update(timestamp).update(".").update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature[2], "hex"))) return { status: 401 };

  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: 400 };
  }
  const { event_id: id, event, data } = payload ?? {};
  if (typeof id !== "string" || !/^[a-zA-Z0-9._:-]{1,160}$/.test(id) ||
      typeof event !== "string" || !/^[a-z][a-z0-9_.]{1,80}$/.test(event) ||
      id !== headers["x-quefa-event-id"] || event !== headers["x-quefa-event"] ||
      typeof headers["x-quefa-delivery"] !== "string" || !headers["x-quefa-delivery"].trim()) {
    return { status: 400 };
  }
  if (!SYNC_EVENTS.has(event)) return { id, orderId: null };
  const orderId = data?.order_id;
  if (typeof orderId !== "string" || !/^(?:ord_[a-zA-Z0-9_-]+|QF[0-9]+)$/.test(orderId) || orderId.length > 120 ||
      (data.event != null && data.event !== event)) {
    return { status: 400 };
  }
  return { id, orderId };
}
