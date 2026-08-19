import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { loadFreeDeliveryConfig, saveFreeDeliveryConfig } from "../lib/free-delivery-settings.js";

export default async function handler(req, res) {
  const method = String(req.method || "").toUpperCase();
  if (method !== "GET" && method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  try {
    await assertReportsAuthorized(req);
    if (method === "GET") return res.status(200).json(await loadFreeDeliveryConfig());
    return res.status(200).json({ ok: true, ...(await saveFreeDeliveryConfig(req.body?.config)) });
  } catch (error) {
    console.error(error);
    return res.status(error.statusCode || 500).json({ error: error.message || "Could not save free-delivery settings." });
  }
}
