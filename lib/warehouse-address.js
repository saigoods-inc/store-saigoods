/**
 * Warehouse / ship-from display for admin (reads SHIPPO_FROM_* env + order sender override).
 * Intentionally not named "shippo" in exports — same env keys kept for backward compatibility.
 */

function coerceJsonObject(raw) {
  if (raw == null) {
    return null;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) {
      return null;
    }
    try {
      const p = JSON.parse(t);
      return p && typeof p === "object" && !Array.isArray(p) ? p : null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeZip(z) {
  return String(z || "")
    .trim()
    .replace(/\s+/g, "");
}

/**
 * Human-readable ship-from lines for packing slips and admin order summary.
 * @param {object} orderRow — row with optional shippo_from_address_override_json
 * @returns {string[]}
 */
export function getWarehouseShipFromLines(orderRow) {
  const ov = coerceJsonObject(orderRow?.shippo_from_address_override_json);
  if (ov) {
    const line1 = String(ov.line1 || "").trim();
    const city = String(ov.city || "").trim();
    const state = String(ov.state || "").trim().toUpperCase().slice(0, 2);
    const postalCode = normalizeZip(ov.postalCode || ov.zip);
    const country = String(ov.country || "US").trim().toUpperCase() || "US";
    if (line1 && city && state && postalCode) {
      const lines = [];
      const name = String(ov.name || "").trim();
      if (name) {
        lines.push(name);
      }
      lines.push(line1);
      const line2 = String(ov.line2 || "").trim();
      if (line2) {
        lines.push(line2);
      }
      lines.push(`${city}, ${state} ${postalCode}`);
      if (country && country !== "US") {
        lines.push(country);
      }
      const email = String(ov.email || "").trim();
      const phone = String(ov.phone || "").trim();
      if (email) {
        lines.push(`Email: ${email}`);
      }
      if (phone) {
        lines.push(`Phone: ${phone}`);
      }
      return lines;
    }
  }

  const street1 = String(process.env.SHIPPO_FROM_STREET1 || "").trim();
  const city = String(process.env.SHIPPO_FROM_CITY || "").trim();
  const state = String(process.env.SHIPPO_FROM_STATE || "")
    .trim()
    .toUpperCase()
    .slice(0, 2);
  const zip = normalizeZip(process.env.SHIPPO_FROM_ZIP);
  const country = String(process.env.SHIPPO_FROM_COUNTRY || "US")
    .trim()
    .toUpperCase() || "US";

  if (!street1 || !city || !state || !zip) {
    return [
      "Warehouse ship-from address is not fully configured on the server.",
      "Configure SHIPPO_FROM_NAME, SHIPPO_FROM_STREET1, SHIPPO_FROM_CITY, SHIPPO_FROM_STATE, SHIPPO_FROM_ZIP — or save a complete sender override on this order.",
    ];
  }

  const lines = [];
  const name = String(process.env.SHIPPO_FROM_NAME || "SAI Goods").trim() || "SAI Goods";
  lines.push(name);
  const company = String(process.env.SHIPPO_FROM_COMPANY || "").trim();
  if (company) {
    lines.push(company);
  }
  lines.push(street1);
  const line2 = String(process.env.SHIPPO_FROM_STREET2 || "").trim();
  if (line2) {
    lines.push(line2);
  }
  lines.push(`${city}, ${state} ${zip}`);
  if (country && country !== "US") {
    lines.push(country);
  }
  const email = String(process.env.SHIPPO_FROM_EMAIL || "").trim();
  const phone = String(process.env.SHIPPO_FROM_PHONE || "").trim();
  if (email) {
    lines.push(`Email: ${email}`);
  }
  if (phone) {
    lines.push(`Phone: ${phone}`);
  }
  return lines;
}
