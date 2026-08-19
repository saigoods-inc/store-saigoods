import { fetchAdminSummary } from "../lib/admin-summary.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const url = new URL(req.url || "/api/admin-summary", "http://localhost");
    const preset = String(url.searchParams.get("preset") || "last30").trim();
    const start = String(url.searchParams.get("start") || "").trim();
    const end = String(url.searchParams.get("end") || "").trim();
    const channel = String(url.searchParams.get("channel") || "all").trim().toLowerCase();

    const summary = await fetchAdminSummary({ preset, start, end, channel });
    res.status(200).json(summary);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not load admin summary.",
    });
  }
}
