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
  const timeoutMs = Math.max(1_000, Math.min(60_000, Number(opts.timeoutMs) || 20_000));
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `ShippoToken ${token}`,
        "Content-Type": "application/json",
        "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const err = new Error("Shippo label result is unknown. Reconcile this package before retrying.");
    err.code = "SHIPPO_LABEL_OUTCOME_UNKNOWN";
    err.labelPurchaseOutcomeUnknown = true;
    err.cause = cause;
    throw err;
  }

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

export async function getShippoTransaction(transactionObjectId) {
  const token = process.env.SHIPPO_API_TOKEN?.trim();
  const id = String(transactionObjectId || "").trim();
  if (!token || !id) return null;
  const res = await fetch(`${getShippoApiBaseUrl()}/transactions/${encodeURIComponent(id)}`, {
    headers: {
      Authorization: `ShippoToken ${token}`,
      "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const tx = await res.json();
  return tx && typeof tx === "object" ? tx : null;
}

function shippoTrackingStatus(transaction) {
  const raw = transaction?.tracking_status;
  return String(typeof raw === "object" ? raw?.status : raw || "").trim().toUpperCase();
}

export function assertShippoTransactionUnused(transaction) {
  const status = shippoTrackingStatus(transaction);
  if (["TRANSIT", "IN_TRANSIT", "DELIVERED", "RETURNED", "FAILURE"].includes(status)) {
    const error = new Error(`The shipping label is already ${status.toLowerCase().replaceAll("_", " ")} and cannot be automatically refunded.`);
    error.statusCode = 409;
    error.code = "LABEL_ALREADY_USED";
    throw error;
  }
}

/** Request a refund for an unused Shippo transaction. Shippo may settle it asynchronously. */
export async function requestShippoTransactionRefund(transactionObjectId) {
  const token = process.env.SHIPPO_API_TOKEN?.trim();
  const id = String(transactionObjectId || "").trim();
  if (!token || !id) throw Object.assign(new Error("Shippo transaction is missing."), { statusCode: 400 });
  const transaction = await getShippoTransaction(id);
  if (!transaction) throw Object.assign(new Error("Shippo transaction could not be verified."), { statusCode: 502 });
  assertShippoTransactionUnused(transaction);
  const transactionStatus = String(transaction.status || "").toUpperCase();
  if (transactionStatus === "REFUNDED") return { status: "REFUNDED", alreadyComplete: true, transaction };
  if (transactionStatus === "REFUNDPENDING") return { status: "REFUNDPENDING", alreadyComplete: true, transaction };

  const response = await fetch(`${getShippoApiBaseUrl()}/refunds/`, {
    method: "POST",
    headers: {
      Authorization: `ShippoToken ${token}`,
      "Content-Type": "application/json",
      "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
    },
    body: JSON.stringify({ transaction: id }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(extractError(json, response.status));
    error.statusCode = response.status;
    error.code = "LABEL_REFUND_REJECTED";
    throw error;
  }
  return { status: String(json.status || "PENDING").toUpperCase(), refundId: json.object_id || null, refund: json, transaction };
}

export async function findRecentShippoTransactionForRate(rateObjectId) {
  const token = process.env.SHIPPO_API_TOKEN?.trim();
  const rateId = String(rateObjectId || "").trim();
  if (!token || !rateId) return null;
  const url = new URL(`${getShippoApiBaseUrl()}/transactions/`);
  url.searchParams.set("results", "25");
  const res = await fetch(url, {
    headers: {
      Authorization: `ShippoToken ${token}`,
      "SHIPPO-API-VERSION": SHIPPO_API_VERSION,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const json = await res.json();
  const rows = Array.isArray(json?.results) ? json.results : [];
  return rows.find((tx) => {
    const rate = tx?.rate;
    const id = typeof rate === "string" ? rate : rate?.object_id || rate?.id;
    return String(id || "").trim() === rateId && String(tx?.status || "").toUpperCase() === "SUCCESS";
  }) || null;
}
