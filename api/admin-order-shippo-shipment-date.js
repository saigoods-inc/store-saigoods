import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { normalizeFulfillmentMethod } from "../lib/manual-order-fulfillment.js";
import { getOrderByIdForService, updateOrderShippoShipmentDate } from "../lib/orders.js";

function parseOptionalYmd(input) {
  if (input === null || input === undefined || input === "") {
    return { ok: true, value: null };
  }
  const s = String(input).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { ok: false, error: "shipmentDate must be YYYY-MM-DD or empty to clear." };
  }
  const [y, mo, d] = s.split("-").map((x) => Number(x));
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, error: "Invalid calendar date." };
  }
  return { ok: true, value: s };
}

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

    const existing = await getOrderByIdForService(orderId);
    if (!existing) {
      res.status(404).json({ error: "Order not found." });
      return;
    }

    const src = String(existing.order_source || "");
    const typ = String(existing.order_type || "");
    if (typ === "walk_in" || src === "walk_in") {
      res.status(400).json({ error: "Planned ship date does not apply to walk-in orders." });
      return;
    }
    if (src === "manual") {
      const fm = normalizeFulfillmentMethod(existing.fulfillment_method);
      if (fm === "pickup" || fm === "local_delivery") {
        res
          .status(400)
          .json({ error: "Planned ship date applies to carrier (ship) orders, not pickup or local delivery." });
        return;
      }
    }

    const parsed = parseOptionalYmd(req.body?.shipmentDate);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const updated = await updateOrderShippoShipmentDate(orderId, parsed.value);
    res.status(200).json({ ok: true, order: updated || existing });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not save shipment date.",
    });
  }
}
