import { createSignedTaxExemptionCertificateUrl, taxExemptionFromOrder } from "../lib/admin-tax-exemption.js";
import { getOrderByIdForService } from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";

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
    const order = await getOrderByIdForService(orderId);
    if (!order) {
      res.status(404).json({ error: "Order not found." });
      return;
    }
    const exemption = taxExemptionFromOrder(order);
    if (!exemption) {
      res.status(404).json({ error: "This order does not have an approved tax exemption." });
      return;
    }
    const url = await createSignedTaxExemptionCertificateUrl(exemption);
    res.setHeader?.("Cache-Control", "private, no-store, max-age=0");
    res.status(200).json({ url, expiresInSeconds: 300 });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Could not open the exemption certificate." });
  }
}
