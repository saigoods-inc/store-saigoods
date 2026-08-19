import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { persistWarehouseConfig, readWarehouseConfig } from "../lib/warehouse-settings.js";

export default async function handler(req, res) {
  const method = String(req.method || "").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  try {
    await assertReportsAuthorized(req);
    if (method === "GET") {
      res.status(200).json(await readWarehouseConfig());
      return;
    }
    const saved = await persistWarehouseConfig(req.body?.locations);
    res.status(200).json({ ok: true, migrationRequired: false, ...saved });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not save warehouse locations.",
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      ...(error.addressSuggestion ? { addressSuggestion: error.addressSuggestion } : {}),
    });
  }
}
