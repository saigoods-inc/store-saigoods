import { getShippoApiBaseUrl } from "./shippo.js";

const SHIPPO_API_VERSION = "2018-02-08";

function extractError(json, status) {
  if (!json || typeof json !== "object") {
    return `Shippo transaction failed (HTTP ${status}).`;
  }
  if (typeof json.detail === "string" && json.detail.trim()) {
    return json.detail.trim();
  }
  if (typeof json.message === "string" && json.message.trim()) {
    return json.message.trim();
  }
  try {
    const s = JSON.stringify(json);
    if (s && s !== "{}") {
      return `Shippo transaction (HTTP ${status}): ${s.slice(0, 2000)}`;
    }
  } catch {
    /* ignore */
  }
  return `Shippo transaction failed (HTTP ${status}).`;
}

/**
 * Purchase a label using a Rate object_id from a Shipment.
 * @param {string} rateObjectId
 * @param {{ labelFileType?: string }} [opts]
 */
export async function purchaseShippoLabelWithRate(rateObjectId, opts = {}) {
  const token = process.env.SHIPPO_API_TOKEN?.trim();
  if (!token) {
    throw new Error("SHIPPO_API_TOKEN is not configured.");
  }
  const id = String(rateObjectId || "").trim();
  if (!id) {
    throw new Error("rateObjectId is required.");
  }

  const labelFileType = String(opts.labelFileType || process.env.SHIPPO_LABEL_FILE_TYPE || "PDF_4x6").trim() || "PDF_4x6";

  const body = {
    rate: id,
    async: false,
    label_file_type: labelFileType,
  };

  const url = `${getShippoApiBaseUrl()}/transactions/`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `ShippoToken ${token}`,
      "Content-Type": "application/json",
      "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }

  if (!res.ok) {
    const err = new Error(extractError(json, res.status));
    err.shippoResponseJson = json;
    throw err;
  }

  let tx = json;
  let status = String(tx.status || "").toUpperCase();

  if (status === "QUEUED" || status === "WAITING") {
    const txId = String(tx.object_id || "").trim();
    if (txId) {
      tx = await pollTransactionUntilTerminal(txId, token);
      status = String(tx.status || "").toUpperCase();
    }
  }

  if (status === "ERROR") {
    const msgs = Array.isArray(tx.messages) ? tx.messages : [];
    const msg = msgs.map((m) => (m && m.text ? m.text : "")).filter(Boolean).join(" ") || "Transaction returned ERROR.";
    const err = new Error(msg);
    err.shippoResponseJson = tx;
    throw err;
  }

  if (status !== "SUCCESS") {
    const err = new Error(`Unexpected transaction status: ${tx.status || "unknown"}`);
    err.shippoResponseJson = tx;
    throw err;
  }

  return {
    transactionObjectId: String(tx.object_id || "").trim(),
    labelUrl: String(tx.label_url || "").trim() || null,
    trackingNumber: String(tx.tracking_number || "").trim() || null,
    trackingStatus: String(tx.tracking_status || "").trim() || null,
    trackingUrlProvider: String(tx.tracking_url_provider || "").trim() || null,
    transactionStatus: String(tx.status || "").trim(),
    eta: String(tx.eta || "").trim() || null,
    rate: tx.rate,
    raw: tx,
  };
}

async function pollTransactionUntilTerminal(txId, token, maxAttempts = 15) {
  const base = `${getShippoApiBaseUrl()}/transactions/${encodeURIComponent(txId)}`;
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(base, {
      headers: {
        Authorization: `ShippoToken ${token}`,
        "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
      },
    });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      return json;
    }
    const st = String(json.status || "").toUpperCase();
    if (st === "SUCCESS" || st === "ERROR" || st === "REFUNDED") {
      return json;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  const res = await fetch(base, {
    headers: {
      Authorization: `ShippoToken ${token}`,
      "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
    },
  });
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}
