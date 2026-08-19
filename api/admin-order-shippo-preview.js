import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { getOrderByIdForService } from "../lib/orders.js";
import {
  buildFulfillmentPackingPlan,
  loadRuntimeFulfillmentPackagingConfig,
} from "../lib/fulfillment-cartonization.js";
import { primeRuntimeStore } from "../lib/runtime-store.js";
import { describeShippoOrderSync } from "../lib/shippo-order-sync.js";
import { describeShipmentCreatePreview } from "../lib/shippo-shipment-sync.js";
import { withRuntimeWarehouseAddress } from "../lib/warehouse-settings.js";

/**
 * Returns the same merge + payloads the server uses for Shippo POST /orders/ and POST /shipments/
 * (no API call to Shippo).
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await primeRuntimeStore();
    await assertReportsAuthorized(req);
    const orderId = String(req.body?.orderId || "").trim();
    if (!orderId) {
      res.status(400).json({ error: "orderId is required." });
      return;
    }

    let order = await getOrderByIdForService(orderId);
    if (!order) {
      res.status(404).json({ error: "Order not found." });
      return;
    }
    order = await withRuntimeWarehouseAddress(order);

    let packingPlan = null;
    let packingPlanError = null;
    try {
      const config = await loadRuntimeFulfillmentPackagingConfig();
      packingPlan = buildFulfillmentPackingPlan(order, { config });
    } catch (e) {
      packingPlanError = String(e?.message || e);
    }

    const preview = {
      ...describeShippoOrderSync(order),
      ...describeShipmentCreatePreview(order),
      recommendedPackingPlan: packingPlan,
      recommendedPackingPlanError: packingPlanError,
    };
    res.status(200).json({ ok: true, order, preview });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not build Shippo preview.",
    });
  }
}
