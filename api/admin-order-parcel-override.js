import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { getOrderByIdForService, updateOrderShippoParcelOverride } from "../lib/orders.js";

/**
 * Body: { orderId, override: { parcels: [...] } | null }
 * Clears override when override is null.
 */
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

    const raw = req.body?.override;
    const override = raw === null || raw === undefined ? null : raw;

    if (override !== null && (typeof override !== "object" || !Array.isArray(override.parcels))) {
      res.status(400).json({ error: "override must be null or an object { parcels: [...] }." });
      return;
    }

    if (override?.parcels?.length) {
      for (const p of override.parcels) {
        if (!p || typeof p !== "object") {
          res.status(400).json({ error: "Each parcel must be an object." });
          return;
        }
        const need = ["length", "width", "height", "weight"];
        for (const k of need) {
          if (p[k] == null || String(p[k]).trim() === "") {
            res.status(400).json({ error: `Parcel missing ${k}.` });
            return;
          }
        }
      }
    }

    const updated = await updateOrderShippoParcelOverride(orderId, override);
    const order = updated || (await getOrderByIdForService(orderId));
    res.status(200).json({ ok: true, order });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not save parcel override.",
    });
  }
}
