import { assertReportsAuthorized, getReportsActor } from "../lib/reports-auth.js";
import {
  applyAdminStockPatches,
  createIncomingShipmentRecord,
  readInventoryDashboardPayload,
  receiveIncomingShipmentStock,
} from "../lib/stock.js";

function normaliseChannel(raw) {
  const c = String(raw || "").toLowerCase();
  if (c === "case" || c === "cases") return "case";
  if (c === "box" || c === "boxes") return "box";
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const actor = await getReportsActor(req);
    const adminUser = actor?.email || (actor?.kind === "service" ? "internal" : null);

    if (req.method === "GET") {
      res.status(200).json(readInventoryDashboardPayload());
      return;
    }

    const body = req.body || {};
    const action = String(body.action || "").trim();

    if (action === "stock_patch") {
      const patches = Array.isArray(body.patches) ? body.patches : null;
      if (!patches) {
        res.status(400).json({ error: "Provide `patches` array." });
        return;
      }
      const next = await applyAdminStockPatches(patches, {
        adminUser,
        reason: body.reason || "Admin inventory form",
      });
      res.status(200).json({ ok: true, stock: next, dashboard: readInventoryDashboardPayload() });
      return;
    }

    if (action === "manual_adjust") {
      const slug = String(body.productSlug || "").trim();
      const size = String(body.size || "").trim();
      const channel = normaliseChannel(body.channel || body.unit);
      const delta = Math.floor(Number(body.deltaOnHand) || 0);
      if (!slug || !size || !channel || !delta) {
        res.status(400).json({ error: "productSlug, size, channel, and non-zero deltaOnHand are required." });
        return;
      }
      const next = await applyAdminStockPatches(
        [{ productSlug: slug, size, channel, addOnHand: delta, reason: body.reason }],
        { adminUser, reason: body.reason || "Manual adjustment" },
      );
      res.status(200).json({ ok: true, stock: next, dashboard: readInventoryDashboardPayload() });
      return;
    }

    if (action === "mark_damaged") {
      const slug = String(body.productSlug || "").trim();
      const size = String(body.size || "").trim();
      const channel = normaliseChannel(body.channel || body.unit);
      const d = Math.max(0, Math.floor(Number(body.quantity) || Number(body.damagedQty) || 0));
      if (!slug || !size || !channel || d < 1) {
        res.status(400).json({ error: "productSlug, size, channel, and positive quantity are required." });
        return;
      }
      const next = await applyAdminStockPatches(
        [{ productSlug: slug, size, channel, addDamaged: d, addOnHand: -d }],
        { adminUser, reason: body.reason || "Mark damaged" },
      );
      res.status(200).json({ ok: true, stock: next, dashboard: readInventoryDashboardPayload() });
      return;
    }

    if (action === "toggle_track") {
      const slug = String(body.productSlug || "").trim();
      const size = String(body.size || "").trim();
      const channel = normaliseChannel(body.channel || body.unit);
      const track = Boolean(body.track);
      if (!slug || !size || !channel) {
        res.status(400).json({ error: "productSlug, size, and channel are required." });
        return;
      }
      const next = await applyAdminStockPatches([{ productSlug: slug, size, channel, track }], {
        adminUser,
        reason: body.reason || (track ? "Enable tracking" : "Disable tracking"),
      });
      res.status(200).json({ ok: true, stock: next, dashboard: readInventoryDashboardPayload() });
      return;
    }

    if (action === "set_threshold") {
      const slug = String(body.productSlug || "").trim();
      const size = String(body.size || "").trim();
      const channel = normaliseChannel(body.channel || body.unit);
      if (!slug || !size || !channel) {
        res.status(400).json({ error: "productSlug, size, and channel are required." });
        return;
      }
      const th =
        body.reorderThreshold === null || body.reorderThreshold === "" || body.reorderThreshold === undefined
          ? null
          : body.reorderThreshold;
      const next = await applyAdminStockPatches(
        [{ productSlug: slug, size, channel, reorderThreshold: th }],
        { adminUser, reason: body.reason || "Reorder threshold" },
      );
      res.status(200).json({ ok: true, stock: next, dashboard: readInventoryDashboardPayload() });
      return;
    }

    if (action === "create_shipment") {
      const result = await createIncomingShipmentRecord(
        { eta: body.eta, notes: body.notes, lines: body.lines },
        { adminUser, reason: body.reason },
      );
      res.status(200).json({ ok: true, ...result, dashboard: readInventoryDashboardPayload() });
      return;
    }

    if (action === "receive_shipment") {
      const result = await receiveIncomingShipmentStock({
        shipmentId: body.shipmentId,
        lineId: body.lineId,
        qty: body.qty,
        adminUser,
        reason: body.reason,
      });
      res.status(200).json({ ok: true, ...result, dashboard: readInventoryDashboardPayload() });
      return;
    }

    res.status(400).json({
      error:
        "Unknown action. Use: stock_patch | manual_adjust | mark_damaged | toggle_track | set_threshold | create_shipment | receive_shipment",
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Inventory request failed." });
  }
}
