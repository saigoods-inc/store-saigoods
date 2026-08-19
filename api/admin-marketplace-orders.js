import { assertReportsAuthorized, getReportsActor } from "../lib/reports-auth.js";
import { createMarketplaceOrder, listMarketplaceOrders, transitionMarketplaceOrder } from "../lib/marketplace-orders.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  try {
    await assertReportsAuthorized(req);
    if (req.method === "GET") return res.status(200).json({ orders: await listMarketplaceOrders() });
    const actor = await getReportsActor(req);
    const action = String(req.body?.action || "").trim();
    if (action === "record") return res.status(200).json({ ok: true, order: await createMarketplaceOrder(req.body?.order, actor) });
    if (action === "transition") return res.status(200).json({ ok: true, order: await transitionMarketplaceOrder(req.body?.id, req.body?.status, actor) });
    return res.status(400).json({ error: "Unknown action. Use: record | transition." });
  } catch (error) {
    console.error(error);
    return res.status(error.statusCode || 500).json({ error: error.message || "Marketplace order request failed." });
  }
}
