import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { createSignedFulfillmentDocUrl } from "../lib/admin-external-fulfillment.js";

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
    const out = { ok: true, labelUrl: null, packingSlipUrl: null };
    try {
      const r = await createSignedFulfillmentDocUrl(orderId, "label");
      out.labelUrl = r.url;
    } catch {
      /* no label on file */
    }
    try {
      const r = await createSignedFulfillmentDocUrl(orderId, "packing_slip");
      out.packingSlipUrl = r.url;
    } catch {
      /* no slip on file */
    }
    res.status(200).json(out);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not create document links.",
    });
  }
}
