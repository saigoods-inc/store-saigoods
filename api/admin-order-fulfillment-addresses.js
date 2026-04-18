import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { getOrderByIdForService, updateOrderShippoAddressOverrides } from "../lib/orders.js";

function validateOverrideBlock(raw, label) {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `${label} must be an object or null.` };
  }
  const line1 = String(raw.line1 || "").trim();
  const city = String(raw.city || "").trim();
  const state = String(raw.state || "").trim().toUpperCase().slice(0, 2);
  const postalCode = String(raw.postalCode || raw.zip || "").trim();
  const country = String(raw.country || "").trim().toUpperCase();
  const name = String(raw.name || "").trim();
  if (!line1 || !city || !state || !postalCode || !country || !name) {
    return { ok: false, error: `${label}: name, line1, city, state, postalCode, and country are required.` };
  }
  if (!/^[A-Z]{2}$/.test(state)) {
    return { ok: false, error: `${label}: state must be a 2-letter code.` };
  }
  if (!/^\d{5}$/.test(postalCode) && !/^\d{5}-\d{4}$/.test(postalCode)) {
    return { ok: false, error: `${label}: postalCode must be 5 digits or ZIP+4.` };
  }
  const line2 = String(raw.line2 || "").trim();
  const email = String(raw.email || "").trim();
  const phone = String(raw.phone || "").trim();
  return {
    ok: true,
    value: {
      name,
      line1,
      ...(line2 ? { line2 } : {}),
      city,
      state,
      postalCode,
      country,
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
    },
  };
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

    if (!("shipFromOverride" in req.body) && !("returnOverride" in req.body)) {
      res.status(400).json({ error: "Provide shipFromOverride and/or returnOverride (null to clear)." });
      return;
    }

    const patch = {};
    if ("shipFromOverride" in req.body) {
      const sf = validateOverrideBlock(req.body.shipFromOverride, "shipFromOverride");
      if (!sf.ok) {
        res.status(400).json({ error: sf.error });
        return;
      }
      patch.shipFromOverride = sf.value;
    }
    if ("returnOverride" in req.body) {
      const rt = validateOverrideBlock(req.body.returnOverride, "returnOverride");
      if (!rt.ok) {
        res.status(400).json({ error: rt.error });
        return;
      }
      patch.returnOverride = rt.value;
    }

    const existing = await getOrderByIdForService(orderId);
    if (!existing) {
      res.status(404).json({ error: "Order not found." });
      return;
    }

    const updated = await updateOrderShippoAddressOverrides(orderId, patch);
    res.status(200).json({ ok: true, order: updated || existing });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not save fulfillment addresses.",
    });
  }
}
