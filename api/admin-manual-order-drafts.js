import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { getOrderByIdForService, listManualDraftOrders } from "../lib/orders.js";
import {
  issueTaxExemptionCertificateReference,
  taxExemptionFromOrder,
} from "../lib/admin-tax-exemption.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const rawUrl = req.url || "/api/admin-manual-order-drafts";
    const url = new URL(rawUrl, "http://localhost");
    const id = url.searchParams.get("id");

    if (id) {
      const order = await getOrderByIdForService(id);
      if (!order) {
        res.status(404).json({ error: "Order not found." });
        return;
      }
      if (String(order.order_source || "") !== "manual" || String(order.order_status || "") !== "draft") {
        res.status(400).json({ error: "Not a manual draft order." });
        return;
      }
      const exemption = taxExemptionFromOrder(order);
      res.status(200).json({
        order,
        taxExemptionCertificateReference: issueTaxExemptionCertificateReference(exemption),
      });
      return;
    }

    const drafts = await listManualDraftOrders();
    res.status(200).json({ drafts });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Could not load drafts." });
  }
}
