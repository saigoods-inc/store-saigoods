import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { parseExternalFulfillmentBody, saveAdminExternalFulfillmentRecord } from "../lib/admin-external-fulfillment.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  try {
    await assertReportsAuthorized(req);
    const orderId = String(req.body?.orderId || "").trim();
    if (!orderId) {
      res.status(400).json({ error: "orderId is required." });
      return;
    }
    const { fields, files } = parseExternalFulfillmentBody(req.body || {});
    const updated = await saveAdminExternalFulfillmentRecord(orderId, fields, files);
    res.status(200).json({ ok: true, order: updated });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not save fulfillment record.",
    });
  }
}
