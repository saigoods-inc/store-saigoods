import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { createSignedFulfillmentDocUrls } from "../lib/admin-external-fulfillment.js";

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
    const out = {
      ok: true,
      labelUrls: [],
      packingSlipUrls: [],
      labelUrl: null,
      packingSlipUrl: null,
    };
    try {
      const r = await createSignedFulfillmentDocUrls(orderId, "label");
      out.labelUrls = r.urls;
      out.labelUrl = r.urls[0] || null;
    } catch {
      /* no label on file */
    }
    try {
      const r = await createSignedFulfillmentDocUrls(orderId, "packing_slip");
      out.packingSlipUrls = r.urls;
      out.packingSlipUrl = r.urls[0] || null;
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
