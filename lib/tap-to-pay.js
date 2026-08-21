import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SQUARE_API_VERSION = "2026-07-15";
const STATE_TTL_MS = 15 * 60 * 1000;

function enabled(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function csv(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64url(value) {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function stagingRuntime(env) {
  const vercelEnv = String(env.VERCEL_ENV || "development").trim().toLowerCase();
  return vercelEnv === "preview" || vercelEnv === "development" || vercelEnv === "test";
}

export function tapToPayConfig(env = process.env) {
  const applicationId = String(env.TAP_TO_PAY_SQUARE_APPLICATION_ID || "").trim();
  const locationId = String(env.TAP_TO_PAY_SQUARE_LOCATION_ID || "").trim();
  const accessToken = String(env.TAP_TO_PAY_SQUARE_ACCESS_TOKEN || "").trim();
  const callbackUrl = String(env.TAP_TO_PAY_CALLBACK_URL || "").trim();
  const stateSecret = String(env.TAP_TO_PAY_STATE_SECRET || "").trim();
  const allowedEmails = csv(env.TAP_TO_PAY_ADMIN_EMAILS);
  const stagingOnly = stagingRuntime(env);
  const isolated = String(env.TAP_TO_PAY_ISOLATED_DATA_ACK || "").trim().toLowerCase() === "staging";
  const requested = enabled(env.TAP_TO_PAY_STAGING_ENABLED);
  const configured = Boolean(
    applicationId &&
      locationId &&
      accessToken &&
      callbackUrl &&
      stateSecret.length >= 32 &&
      allowedEmails.size &&
      isolated,
  );

  return {
    enabled: requested && stagingOnly && configured,
    requested,
    stagingOnly,
    isolated,
    configured,
    applicationId,
    locationId,
    accessToken,
    callbackUrl,
    stateSecret,
    allowedEmails,
    simulationEnabled: enabled(env.TAP_TO_PAY_SIMULATION_ENABLED) && stagingOnly && isolated,
    reason: !requested
      ? "disabled"
      : !stagingOnly
        ? "production_blocked"
        : !isolated
          ? "isolated_data_not_acknowledged"
          : !configured
            ? "configuration_incomplete"
            : "ready",
  };
}

export function assertTapToPayEnabled(env = process.env) {
  const config = tapToPayConfig(env);
  if (!config.enabled) {
    const error = new Error("Tap to Pay staging is not available in this environment.");
    error.statusCode = 503;
    error.code = config.reason;
    throw error;
  }
  return config;
}

export function assertTapToPayActor(actor, config) {
  const email = String(actor?.email || "").trim().toLowerCase();
  if (actor?.kind !== "user" || !email || !config.allowedEmails.has(email)) {
    const error = new Error("This admin is not approved for Tap to Pay staging.");
    error.statusCode = 403;
    error.code = "tap_to_pay_admin_not_allowed";
    throw error;
  }
  return email;
}

export function createTapToPayState({ orderId, amountCents, actorEmail, now = Date.now(), nonce } = {}, secret) {
  const payload = {
    v: 1,
    oid: String(orderId || ""),
    amt: Math.round(Number(amountCents)),
    actor: String(actorEmail || "").trim().toLowerCase(),
    exp: now + STATE_TTL_MS,
    nonce: nonce || randomBytes(12).toString("hex"),
  };
  if (!payload.oid || !Number.isSafeInteger(payload.amt) || payload.amt <= 0 || !payload.actor) {
    throw new Error("Invalid Tap to Pay state payload.");
  }
  const encoded = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyTapToPayState(token, secret, { now = Date.now(), actorEmail } = {}) {
  const [encoded, suppliedSignature, extra] = String(token || "").split(".");
  if (!encoded || !suppliedSignature || extra) {
    throw invalidState();
  }
  const expectedSignature = createHmac("sha256", secret).update(encoded).digest("base64url");
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw invalidState();
  }
  let payload;
  try {
    payload = JSON.parse(decodeBase64url(encoded));
  } catch {
    throw invalidState();
  }
  if (
    payload?.v !== 1 ||
    !payload.oid ||
    !Number.isSafeInteger(payload.amt) ||
    payload.amt <= 0 ||
    !Number.isFinite(payload.exp) ||
    payload.exp < now ||
    String(payload.actor || "").toLowerCase() !== String(actorEmail || "").trim().toLowerCase()
  ) {
    throw invalidState();
  }
  return payload;
}

function invalidState() {
  const error = new Error("Tap to Pay session is invalid or expired. Start payment again.");
  error.statusCode = 400;
  error.code = "tap_to_pay_state_invalid";
  return error;
}

export function buildTapToPayUrls({ config, orderId, orderRef, amountCents, state }) {
  const note = `Order ${orderId} from SAI Goods Tap to Pay${orderRef ? ` (${orderRef})` : ""}`;
  const fallbackUrl = new URL(config.callbackUrl);
  fallbackUrl.searchParams.set("tap_to_pay_error", "square_app_not_installed");
  fallbackUrl.searchParams.set("tap_to_pay_state", state);

  const androidParts = [
    "intent:#Intent",
    "action=com.squareup.pos.action.CHARGE",
    "package=com.squareup",
    `S.browser_fallback_url=${encodeURIComponent(fallbackUrl.toString())}`,
    `S.com.squareup.pos.WEB_CALLBACK_URI=${encodeURIComponent(config.callbackUrl)}`,
    `S.com.squareup.pos.CLIENT_ID=${encodeURIComponent(config.applicationId)}`,
    "S.com.squareup.pos.API_VERSION=v2.0",
    `S.com.squareup.pos.LOCATION_ID=${encodeURIComponent(config.locationId)}`,
    `i.com.squareup.pos.TOTAL_AMOUNT=${Math.round(Number(amountCents))}`,
    "S.com.squareup.pos.CURRENCY_CODE=USD",
    "S.com.squareup.pos.TENDER_TYPES=com.squareup.pos.TENDER_CARD",
    "l.com.squareup.pos.AUTO_RETURN_TIMEOUT_MS=3200",
    `S.com.squareup.pos.NOTE=${encodeURIComponent(note)}`,
    `S.com.squareup.pos.REQUEST_METADATA=${encodeURIComponent(state)}`,
    "end",
  ];

  const iosData = {
    amount_money: { amount: String(Math.round(Number(amountCents))), currency_code: "USD" },
    callback_url: config.callbackUrl,
    client_id: config.applicationId,
    version: "1.3",
    location_id: config.locationId,
    state,
    notes: note,
    options: { supported_tender_types: ["CREDIT_CARD"] },
  };

  return {
    androidUrl: `${androidParts.join(";")}`,
    iosUrl: `square-commerce-v1://payment/create?data=${encodeURIComponent(JSON.stringify(iosData))}`,
  };
}

export function parseTapToPayCallback(search) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(String(search || ""));
  const iosDataRaw = params.get("data");
  if (iosDataRaw) {
    try {
      const data = JSON.parse(decodeURIComponent(iosDataRaw));
      return {
        transactionId: String(data.transaction_id || "").trim(),
        state: String(data.state || "").trim(),
        errorCode: String(data.error_code || "").trim(),
      };
    } catch {
      return { transactionId: "", state: "", errorCode: "invalid_callback" };
    }
  }
  return {
    transactionId: String(params.get("com.squareup.pos.SERVER_TRANSACTION_ID") || "").trim(),
    state: String(
      params.get("com.squareup.pos.REQUEST_METADATA") || params.get("tap_to_pay_state") || "",
    ).trim(),
    errorCode: String(
      params.get("com.squareup.pos.ERROR_CODE") || params.get("tap_to_pay_error") || "",
    ).trim(),
  };
}

export async function retrieveTapToPayPayment(transactionId, config, fetchImpl = fetch) {
  const headers = {
    Authorization: `Bearer ${config.accessToken}`,
    "Square-Version": SQUARE_API_VERSION,
    "Content-Type": "application/json",
  };
  const orderResponse = await fetchImpl(`https://connect.squareup.com/v2/orders/${encodeURIComponent(transactionId)}`, {
    method: "GET",
    headers,
  });
  const orderPayload = await readSquareJson(orderResponse);
  if (!orderResponse.ok) {
    throw squareLookupError("Square could not verify this Tap to Pay transaction.", orderResponse.status);
  }
  const squareOrder = orderPayload.order || orderPayload.orders?.[0];
  if (String(squareOrder?.location_id || "") !== config.locationId) {
    const error = new Error("Square payment location does not match Tap to Pay staging.");
    error.statusCode = 409;
    error.code = "tap_to_pay_location_mismatch";
    throw error;
  }
  const tender = Array.isArray(squareOrder?.tenders) ? squareOrder.tenders[0] : null;
  const paymentId = String(tender?.payment_id || tender?.id || "").trim();
  if (!paymentId) {
    throw squareLookupError("Square has not attached a card payment to this transaction yet.", 503);
  }
  const paymentResponse = await fetchImpl(`https://connect.squareup.com/v2/payments/${encodeURIComponent(paymentId)}`, {
    method: "GET",
    headers,
  });
  const paymentPayload = await readSquareJson(paymentResponse);
  if (!paymentResponse.ok || !paymentPayload.payment) {
    throw squareLookupError("Square could not retrieve this Tap to Pay payment.", paymentResponse.status);
  }
  return { squareOrder, payment: paymentPayload.payment };
}

async function readSquareJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function squareLookupError(message, status) {
  const error = new Error(message);
  error.statusCode = status >= 400 && status < 500 ? 409 : 503;
  error.code = "tap_to_pay_square_lookup_failed";
  error.retrySafe = true;
  return error;
}
