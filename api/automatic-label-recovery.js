import crypto from "node:crypto";
import { processAutomaticLabelsForOrder } from "../lib/automatic-label-worker.js";
import { listRecoverableAutomaticLabelOrders } from "../lib/order-shippo-labels.js";

function authorized(req) {
  const expected = String(process.env.CRON_SECRET || "").trim();
  const received = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  try {
    const orderIds = await listRecoverableAutomaticLabelOrders({ limit: 25 });
    const results = [];
    for (const orderId of orderIds) {
      try {
        results.push({ orderId, ...(await processAutomaticLabelsForOrder(orderId)) });
      } catch (error) {
        results.push({
          orderId,
          ok: false,
          errorCode: String(error?.code || "AUTOMATIC_LABEL_RECOVERY_FAILED").slice(0, 64),
        });
      }
    }
    res.status(200).json({ ok: true, processed: results.length, results });
  } catch (error) {
    console.error("[shipping] automatic label recovery failed", {
      code: String(error?.code || "AUTOMATIC_LABEL_RECOVERY_FAILED").slice(0, 64),
    });
    res.status(500).json({ error: "Automatic label recovery failed." });
  }
}
