import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { fetchShippingHealthSnapshot } from "../lib/shipping-health.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  try {
    await assertReportsAuthorized(req);
    res.status(200).json(await fetchShippingHealthSnapshot());
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Could not load shipping health." });
  }
}
