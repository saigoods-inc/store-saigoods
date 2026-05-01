import { markManualPayLaterOrderRecorded } from "../lib/orders.js";
import { assertReportsAuthorized, getReportsActor } from "../lib/reports-auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const orderId = String(req.body?.orderId ?? "").trim();
    const manualPaymentMethod = String(req.body?.manualPaymentMethod ?? "").trim().toLowerCase();
    const noteRaw = req.body?.paymentNote;
    const paymentNote =
      noteRaw == null || String(noteRaw).trim() === "" ? null : String(noteRaw).trim().slice(0, 2000);

    if (!orderId) {
      res.status(400).json({ error: "orderId is required." });
      return;
    }
    if (manualPaymentMethod !== "cash" && manualPaymentMethod !== "check" && manualPaymentMethod !== "other") {
      res.status(400).json({ error: "manualPaymentMethod must be cash, check, or other." });
      return;
    }

    const actor = await getReportsActor(req);
    const recordedByEmail = actor?.kind === "user" ? actor.email || null : null;

    const order = await markManualPayLaterOrderRecorded({
      orderId,
      manualPaymentMethod,
      paymentNote,
      recordedByEmail,
    });

    res.status(200).json({
      ok: true,
      orderId: order.id,
      orderRef: order.order_ref,
      order_status: order.order_status,
      manual_payment_method: order.manual_payment_method,
      manual_payment_recorded_at: order.manual_payment_recorded_at,
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Could not record payment." });
  }
}
