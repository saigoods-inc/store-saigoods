import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { getOrderByIdForService } from "../lib/orders.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatAddr(obj) {
  if (!obj || typeof obj !== "object") {
    return "—";
  }
  const lines = [];
  if (obj.name) lines.push(String(obj.name));
  const s = [obj.line1, obj.line2].filter(Boolean).join(", ");
  if (s) lines.push(s);
  const c = [obj.city, obj.state, obj.postalCode].filter(Boolean).join(", ");
  if (c) lines.push(c);
  if (obj.country) lines.push(String(obj.country));
  return lines.length ? lines.map((l) => escapeHtml(l)).join("<br/>") : "—";
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
    const order = await getOrderByIdForService(orderId);
    if (!order) {
      res.status(404).json({ error: "Order not found." });
      return;
    }
    const ship = order.shipping_address && typeof order.shipping_address === "object" ? order.shipping_address : {};
    const items = Array.isArray(order.items) ? order.items : [];
    const rows = items
      .map((it) => {
        const name = escapeHtml(it.name || it.slug || "Item");
        const qty = escapeHtml(String(Math.max(1, Math.floor(Number(it.lineCases) || 0) + Math.floor(Number(it.lineBoxCount) || 0) || 1)));
        return `<tr><td>${name}</td><td>${qty}</td></tr>`;
      })
      .join("");

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>Packing slip ${escapeHtml(
      order.order_ref || "",
    )}</title>
<style>
body{font-family:system-ui,sans-serif;margin:1.25rem;color:#111}
h1{font-size:1.25rem;margin:0 0 0.5rem}
table{border-collapse:collapse;width:100%;max-width:40rem;margin-top:1rem}
th,td{border:1px solid #ccc;padding:0.35rem 0.5rem;text-align:left;font-size:14px}
th{background:#f4f4f5}
.muted{color:#555;font-size:13px;margin-top:0.25rem}
</style></head><body>
<h1>Packing slip — ${escapeHtml(order.order_ref || "Order")}</h1>
<p class="muted">Print this page for the shipment.</p>
<h2 style="font-size:1rem;margin:1rem 0 0.35rem">Ship to</h2>
<div>${formatAddr(ship)}</div>
<h2 style="font-size:1rem;margin:1rem 0 0.35rem">Items</h2>
<table><thead><tr><th>Product</th><th>Qty (cases+boxes)</th></tr></thead><tbody>${rows || "<tr><td colspan=2>—</td></tr>"}</tbody></table>
</body></html>`;

    res.status(200).json({ ok: true, html });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not build packing slip.",
    });
  }
}
