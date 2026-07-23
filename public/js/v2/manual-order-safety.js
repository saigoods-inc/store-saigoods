/**
 * Pure Manual Order v2 safety helpers (browser + Node).
 * No DOM, CDN imports, private config, or side effects.
 */

/**
 * Create-handler contract (api/admin-manual-order-create.js):
 * - 405 / auth 401/403 / parseCreateBody 400 occur BEFORE createManualOrderDraft insert.
 * Only these statuses are definite pre-insert rejections when no orderId exists.
 */
export const MANUAL_ORDER_CREATE_DEFINITE_PRE_INSERT_STATUSES = new Set([400, 401, 403, 405]);

/**
 * Local auth failure before any create request is dispatched (missing/expired token).
 */
export class ManualOrderLocalAuthError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(message = "Sign in again to create the order.") {
    super(message);
    this.name = "ManualOrderLocalAuthError";
    this.code = "local_auth";
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isManualOrderLocalAuthError(error) {
  return Boolean(
    error &&
      (error instanceof ManualOrderLocalAuthError ||
        error.name === "ManualOrderLocalAuthError" ||
        error.code === "local_auth"),
  );
}

/**
 * Duck-typed ReportPostError check (avoids importing admin-shared / CDN).
 * @param {unknown} error
 */
function isReportPostLikeError(error) {
  return Boolean(error && error.name === "ReportPostError" && typeof error.status === "number");
}

/**
 * Classify create failure before a known orderId exists.
 * Local auth is handled separately via ManualOrderLocalAuthError — never pass it here.
 * @param {unknown} error
 * @returns {"pre_create_rejected" | "create_uncertain"}
 */
export function classifyManualOrderCreateFailure(error) {
  if (isManualOrderLocalAuthError(error)) {
    return "pre_create_rejected";
  }
  if (isReportPostLikeError(error)) {
    const status = Number(error.status);
    const body = error.body && typeof error.body === "object" ? error.body : {};
    if (body.orderId != null && String(body.orderId).trim() !== "") {
      return "create_uncertain";
    }
    if (MANUAL_ORDER_CREATE_DEFINITE_PRE_INSERT_STATUSES.has(status)) {
      return "pre_create_rejected";
    }
    return "create_uncertain";
  }
  return "create_uncertain";
}

/**
 * Concurrent estimate guard. Sets in-flight before the first await (token).
 * Optional revision capture: after POST resolves, if the live revision differs from
 * the captured revision, returns inputs_changed without usable quote data.
 *
 * @param {{
 *   inFlight: boolean,
 *   setInFlight?: (v: boolean) => void,
 *   validate: () => { ok: boolean, items?: object[], payload?: object },
 *   getToken: () => Promise<string|undefined>,
 *   post: (token: string, payloadOrItems: object) => Promise<object>,
 *   capturedRevision?: number,
 *   getCurrentRevision?: () => number,
 * }} opts
 */
export async function runGuardedManualOrderEstimate(opts) {
  if (opts.inFlight) return { started: false, reason: "in_flight" };
  const validated = opts.validate();
  if (!validated.ok) return { started: false, reason: "validation", validated };

  const capturedRevision =
    opts.capturedRevision !== undefined
      ? opts.capturedRevision
      : typeof opts.getCurrentRevision === "function"
        ? opts.getCurrentRevision()
        : undefined;

  opts.setInFlight?.(true);
  try {
    const token = await opts.getToken();
    if (!token) return { started: true, ok: false, reason: "auth" };

    const postArg = validated.payload !== undefined ? validated.payload : validated.items;
    const data = await opts.post(token, postArg);

    if (
      typeof opts.getCurrentRevision === "function" &&
      capturedRevision !== undefined &&
      opts.getCurrentRevision() !== capturedRevision
    ) {
      return { started: true, ok: false, reason: "inputs_changed" };
    }
    return { started: true, ok: true, data };
  } catch (error) {
    return { started: true, ok: false, error };
  } finally {
    opts.setInFlight?.(false);
  }
}

/**
 * @param {string} outcome
 * @returns {boolean}
 */
export function allowCreateAnotherManualOrder(outcome) {
  return outcome === "success" || outcome === "email_failed";
}

/**
 * Control state after a verified pre-insert create rejection.
 * Unlock form first; then restore confirm/cancel from the typed phrase.
 * @param {{ phraseInputValue?: string, phrase: string }} opts
 */
export function preCreateRejectionControlState(opts) {
  const phrase = String(opts.phrase || "");
  const typed = String(opts.phraseInputValue || "");
  return {
    formLocked: false,
    cancelDisabled: false,
    confirmText: "Create and send payment link",
    confirmDisabled: typed !== phrase,
  };
}

/**
 * Minimal HTML escape for address / safety summaries.
 * @param {unknown} value
 */
export function escapeManualOrderHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escaped multi-line address HTML (`<br>` separators only).
 * @param {object|null|undefined} addr
 */
export function formatManualOrderAddressSummary(addr) {
  if (!addr) return "—";
  const line1 = escapeManualOrderHtml(String(addr.line1 || "").trim());
  const line2 = escapeManualOrderHtml(String(addr.line2 || "").trim());
  const city = escapeManualOrderHtml(String(addr.city || "").trim());
  const state = escapeManualOrderHtml(String(addr.state || "").trim());
  const postal = escapeManualOrderHtml(String(addr.postalCode || "").trim());
  const country = escapeManualOrderHtml(String(addr.country || "").trim());
  const cityLine = [city, state, postal].filter(Boolean).join(", ");
  const lines = [line1, line2, cityLine, country].filter(Boolean);
  return lines.length ? lines.join("<br>") : "—";
}

/**
 * Classify a resolved send-link JSON body (HTTP 2xx from fetchReportPost).
 * Missing checkoutUrl is always link_uncertain — never success/email_failed.
 * @param {object|null|undefined} sendData
 */
export function classifyManualOrderSendLinkSuccess(sendData) {
  const checkoutUrl = String(sendData?.checkoutUrl || "").trim();
  const warning = String(sendData?.warning || "").trim();
  if (!checkoutUrl) {
    return {
      outcome: "link_uncertain",
      checkoutUrl: "",
      emailed: false,
      warning:
        warning ||
        "Payment link confirmation is incomplete. Do not resubmit. Check Orders v2 and Legacy admin.",
    };
  }
  if (sendData?.emailed === true) {
    return { outcome: "success", checkoutUrl, emailed: true, warning: "" };
  }
  return {
    outcome: "email_failed",
    checkoutUrl,
    emailed: false,
    warning,
  };
}

/**
 * Classify a failed send-link attempt.
 * Structured ReportPostError bodies use returned fields.
 * Generic transport / network / timeout / abort / malformed failures are link_uncertain.
 *
 * @param {object|null|undefined} body
 * @param {string} [fallbackMessage]
 * @param {{ transportUncertain?: boolean }} [opts]
 */
export function classifyManualOrderSendLinkFailure(body, fallbackMessage, opts = {}) {
  if (opts.transportUncertain === true) {
    return {
      outcome: "link_uncertain",
      squareOutcomeUncertain: true,
      checkoutUrl: "",
      emailed: false,
      warning:
        "Payment link outcome is uncertain. Do not resubmit. Check Square and Legacy admin before taking further action.",
    };
  }
  const b = body && typeof body === "object" ? body : {};
  const checkoutUrl = String(b.checkoutUrl || "").trim();
  const warning = String(b.warning || fallbackMessage || "").trim();
  if (b.squareOutcomeUncertain === true) {
    return {
      outcome: "link_uncertain",
      squareOutcomeUncertain: true,
      checkoutUrl: "",
      emailed: false,
      warning:
        warning ||
        "Payment link outcome is uncertain. Do not resubmit. Check Square and Legacy admin before taking further action.",
    };
  }
  if (b.squareLinkCreated === true || checkoutUrl) {
    return {
      outcome: "link_uncertain",
      squareOutcomeUncertain: false,
      checkoutUrl,
      emailed: false,
      warning:
        warning ||
        "Square may have created a payment link, but it was not fully confirmed. Do not retry from this page — check Legacy admin.",
    };
  }
  return {
    outcome: "draft_only",
    squareOutcomeUncertain: false,
    checkoutUrl: "",
    emailed: false,
    warning: warning || "Payment link was not confirmed.",
  };
}
