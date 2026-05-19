import { assertReportsAuthorized } from "../lib/reports-auth.js";
import {
  applyAdminStockPatches,
  buildInventoryDashboardOverview,
  buildInventoryEditorGrid,
  readInventorySnapshot,
} from "../lib/stock.js";
import { buildIncomingInventoryPayloadForAdminStock } from "../lib/incoming-inventory-batches.js";
import { buildSalesChannelCommitmentsPayloadForAdminStock } from "../lib/sales-channel-commitments.js";
import { buildStockOverrideHistoryForAdminStock } from "../lib/inventory-service.js";
import { loadStore } from "../lib/store.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);

    if (req.method === "GET") {
      const stock = await readInventorySnapshot();
      const site = loadStore()?.site;
      res.status(200).json({
        ...stock,
        storefrontGlobalOutOfStock: Boolean(site?.storefrontGlobalOutOfStock),
        overview: await buildInventoryDashboardOverview(),
        editor: await buildInventoryEditorGrid(),
        salesChannelCommitments: await buildSalesChannelCommitmentsPayloadForAdminStock(),
        incomingInventory: await buildIncomingInventoryPayloadForAdminStock(),
        stockOverrideHistory: await buildStockOverrideHistoryForAdminStock(25),
      });
      return;
    }

    const body = req.body || {};
    const patches = Array.isArray(body.patches) ? body.patches : null;
    if (!patches) {
      res.status(400).json({ error: "POST body must include a `patches` array." });
      return;
    }

    const next = await applyAdminStockPatches(patches);
    res.status(200).json({
      ok: true,
      stock: next,
      overview: await buildInventoryDashboardOverview(),
      editor: await buildInventoryEditorGrid(),
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Stock request failed." });
  }
}
