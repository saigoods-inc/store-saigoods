import { assertReportsAuthorized } from "../lib/reports-auth.js";
import {
  getOrderByIdForService,
  updateOrderShippoParcelOverride,
} from "../lib/orders.js";
import {
  buildFulfillmentPackingPlan,
  buildSelectedPackingPlanOverride,
  loadRuntimeFulfillmentPackagingConfig,
} from "../lib/fulfillment-cartonization.js";
import { listOrderShippoLabels } from "../lib/order-shippo-labels.js";
import { primeRuntimeStore } from "../lib/runtime-store.js";

function typedAction(value) {
  const action = String(value || "preview").trim().toLowerCase();
  return ["preview", "save", "clear"].includes(action) ? action : null;
}

function requestValue(req, key) {
  return req?.body?.[key] ?? req?.query?.[key];
}

function savedPlanSummary(order) {
  const raw = order?.shippo_parcels_override_json;
  const plan = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (plan?.source !== "selected_fulfillment_packing_plan") {
    return null;
  }
  return {
    source: plan.source,
    planId: plan.planId || null,
    parcelCount: Array.isArray(plan.parcels) ? plan.parcels.length : 0,
    selectedAt: plan.selectedAt || null,
    selectedBy: plan.selectedBy || null,
  };
}

export default async function handler(req, res) {
  const method = String(req.method || "").toUpperCase();
  if (method !== "POST" && method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    // Packing must use the same live bundle catalog that priced the order. A
    // serverless invocation cannot rely on another request having warmed it.
    await primeRuntimeStore();
    const orderId = String(requestValue(req, "orderId") || "").trim();
    const action = typedAction(requestValue(req, "action"));
    if (!orderId) {
      res.status(400).json({ error: "orderId is required." });
      return;
    }
    if (!action) {
      res.status(400).json({ error: "action must be preview, save, or clear." });
      return;
    }
    if (method === "GET" && action !== "preview") {
      res.status(405).json({ error: "Only preview is allowed with GET." });
      return;
    }

    const order = await getOrderByIdForService(orderId);
    if (!order) {
      res.status(404).json({ error: "Order not found." });
      return;
    }

    if (action === "save" || action === "clear") {
      const labels = await listOrderShippoLabels(order.id);
      const purchased = labels.some((l) => String(l.status || "") === "purchased");
      if (purchased) {
        res.status(409).json({
          error: "Packing plan is locked because one or more Shippo labels have already been purchased.",
        });
        return;
      }
    }

    if (action === "clear") {
      const updated = await updateOrderShippoParcelOverride(orderId, null);
      res.status(200).json({
        ok: true,
        action,
        order: updated || (await getOrderByIdForService(orderId)),
        packingPlan: null,
        selectedPackingPlan: null,
      });
      return;
    }

    const config = await loadRuntimeFulfillmentPackagingConfig();
    const packingPlan = buildFulfillmentPackingPlan(order, { config });
    if (action === "preview") {
      res.status(200).json({
        ok: true,
        action,
        order,
        packingPlan,
        selectedPackingPlan: savedPlanSummary(order),
      });
      return;
    }

    const selected = buildSelectedPackingPlanOverride(order, {
      selectedBy: requestValue(req, "selectedBy") || "admin",
      config,
    });
    const updated = await updateOrderShippoParcelOverride(orderId, selected);
    res.status(200).json({
      ok: true,
      action,
      order: updated || (await getOrderByIdForService(orderId)),
      packingPlan,
      selectedPackingPlan: savedPlanSummary({
        shippo_parcels_override_json: selected,
      }),
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not prepare packing plan.",
    });
  }
}
