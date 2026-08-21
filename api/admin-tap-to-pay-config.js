import { assertReportsAuthorized, getReportsActor } from "../lib/reports-auth.js";
import { assertTapToPayActor, tapToPayConfig } from "../lib/tap-to-pay.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  try {
    await assertReportsAuthorized(req);
    const config = tapToPayConfig();
    let allowed = false;
    if (config.enabled) {
      const actor = await getReportsActor(req);
      try {
        assertTapToPayActor(actor, config);
        allowed = true;
      } catch {
        allowed = false;
      }
    }
    res.status(200).json({
      enabled: config.enabled && allowed,
      environment: "staging",
      simulationEnabled: config.enabled && allowed && config.simulationEnabled,
      reason: config.enabled && !allowed ? "admin_not_allowed" : config.reason,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Tap to Pay configuration is unavailable." });
  }
}
