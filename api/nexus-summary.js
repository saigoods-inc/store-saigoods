import { fetchNexusSummaryRows } from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const summary = await fetchNexusSummaryRows();
    res.status(200).json({
      generated_at: new Date().toISOString(),
      currency: "USD",
      amounts_in: "cents",
      summary,
    });
  } catch (error) {
    console.error(error);
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || "Could not load nexus summary." });
  }
}
