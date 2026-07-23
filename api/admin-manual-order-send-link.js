import { claimDiscountCodeForOrder, normalizeDiscountCode, releaseDiscountCodeForOrder } from "../lib/discount-codes.js";
import { computeCheckoutEstimate, checkoutFlowErrorJsonFields } from "../lib/checkout-estimate-logic.js";
import { normalizeFulfillmentMethod } from "../lib/manual-order-fulfillment.js";
import { computeEconomicsSnapshotForOrder } from "../lib/order-economics.js";
import { sendManualOrderPaymentLinkEmail } from "../lib/manual-order-payment-email.js";
import {
  buildOrderQuoteSnapshotColumns,
  getOrderByIdForService,
  updateOrderPaymentLinkSent,
} from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { createClient } from "@supabase/supabase-js";
import { createPaymentLink } from "../lib/square.js";

function parseOptionalYmd(input) {
  if (input === null || input === undefined || input === "") {
    return { ok: true, value: null };
  }
  const s = String(input).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { ok: false, error: "Expected ship date must be YYYY-MM-DD." };
  }
  const [y, mo, d] = s.split("-").map((x) => Number(x));
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, error: "Expected ship date is invalid." };
  }
  return { ok: true, value: s };
}

function getServiceClient() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    const e = new Error("Supabase is not configured.");
    e.statusCode = 503;
    throw e;
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function syncOrderTotalsFromQuote(client, orderId, quote, shippingAddress, shipmentDateYmd = null) {
  const amountCents =
    Math.max(0, Number(quote.subtotalCents) || 0) + Math.max(0, Number(quote.shippingCents) || 0);
  const taxCollected = Math.max(0, Number(quote.taxCents) || 0);

  const { error } = await client
    .from("orders")
    .update({
      items: quote.items,
      subtotal_cents: quote.subtotalCents,
      shipping_cents: quote.shippingCents,
      tax_cents: quote.taxCents,
      total_cents: quote.totalCents,
      amount: amountCents,
      tax_collected: taxCollected,
      ...buildOrderQuoteSnapshotColumns({ quote, shippingAddress }),
      shippo_shipment_date:
        shipmentDateYmd === null || shipmentDateYmd === undefined || String(shipmentDateYmd).trim() === ""
          ? null
          : String(shipmentDateYmd).trim(),
      admin_local_discount_override: Boolean(quote.adminLocalDiscountForced),
      updated_at: new Date().toISOString(),
      ...computeEconomicsSnapshotForOrder(quote.items, quote),
    })
    .eq("id", orderId)
    .eq("order_status", "draft");

  if (error) {
    throw error;
  }
}

/**
 * Gate checks that must run before any Square / email work.
 * @param {object} order
 * @returns {{ ok: true } | { ok: false, status: number, body: object }}
 */
export function assertManualOrderEligibleForPaymentLink(order) {
  if (!order) {
    return { ok: false, status: 404, body: { error: "Order not found." } };
  }
  if (String(order.order_source || "web") !== "manual") {
    return {
      ok: false,
      status: 400,
      body: { error: "Only manual orders can receive a payment link from this action." },
    };
  }
  const st = String(order.order_status || "");
  if (st === "payment_link_sent") {
    return {
      ok: false,
      status: 400,
      body: { error: "A payment link email was already sent for this order." },
    };
  }
  if (st !== "draft") {
    return { ok: false, status: 400, body: { error: "Order must be a draft to send a payment link." } };
  }
  if (String(order.payment_flow || "square_payment_link") === "pay_later") {
    return {
      ok: false,
      status: 400,
      body: {
        error:
          "This order is Pay later. Use mark-as-paid when the customer pays (or change payment method to Square link before saving if you need to email a link).",
      },
    };
  }
  if (String(order.status || "") === "paid") {
    return { ok: false, status: 400, body: { error: "This order is already paid." } };
  }
  const shipAddr = order.shipping_address;
  if (!shipAddr || typeof shipAddr !== "object") {
    return {
      ok: false,
      status: 400,
      body: { error: "Order is missing shipping_address; recreate the draft." },
    };
  }
  return { ok: true };
}

/**
 * Definite no-link Square failures (safe to release a discount claim):
 * - `err.definitiveNoLinkCreated === true`, or
 * - HTTP 400 / 401 / 403 / 404 / 422 (client/validation rejections that cannot
 *   represent timeout, rate limiting, idempotency conflict, or unknown completion).
 *
 * Ambiguous (retain claim; no persist; no email):
 * - network / missing status
 * - 408, 409, 429
 * - any 5xx
 * - any other status not listed as definite
 *
 * @param {unknown} err
 * @returns {{ kind: "definite_no_link" | "uncertain", status: number }}
 */
export function classifySquareCreatePaymentLinkError(err) {
  if (err && err.definitiveNoLinkCreated === true) {
    const marked = Number(err.statusCode ?? err.status);
    return {
      kind: "definite_no_link",
      status: Number.isFinite(marked) && marked >= 400 ? marked : 400,
    };
  }
  const status = Number(err?.statusCode ?? err?.status);
  if (!Number.isFinite(status) || status <= 0) {
    return { kind: "uncertain", status: 502 };
  }
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
    return { kind: "definite_no_link", status };
  }
  return { kind: "uncertain", status: status >= 400 ? status : 502 };
}

/**
 * Production Square → persist → email sequence for Manual Order payment links.
 * Discount claims are released only on definite evidence that Square created no link.
 *
 * @param {{
 *   claimed: boolean,
 *   orderId: string,
 *   createPaymentLinkFn?: Function,
 *   persistPaymentLinkFn?: Function,
 *   sendEmailFn?: Function,
 *   releaseDiscountFn?: Function,
 *   logErrorFn?: Function,
 *   createPaymentLinkArgs: object,
 *   sendEmailArgs: object,
 * }} opts
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function deliverManualOrderPaymentLink(opts) {
  const createPaymentLinkFn = opts.createPaymentLinkFn || createPaymentLink;
  const persistPaymentLinkFn = opts.persistPaymentLinkFn || updateOrderPaymentLinkSent;
  const sendEmailFn = opts.sendEmailFn || sendManualOrderPaymentLinkEmail;
  const releaseDiscountFn = opts.releaseDiscountFn || releaseDiscountCodeForOrder;
  const logErrorFn = opts.logErrorFn || ((err) => console.error(err));
  const claimed = opts.claimed === true;
  const orderId = String(opts.orderId || "").trim();

  let squareLinkCreated = false;
  let persisted = false;
  let checkoutUrl = "";

  try {
    let created;
    try {
      created = await createPaymentLinkFn(opts.createPaymentLinkArgs);
    } catch (squareErr) {
      logErrorFn(squareErr);
      const classification = classifySquareCreatePaymentLinkError(squareErr);
      if (classification.kind === "definite_no_link") {
        if (claimed) {
          try {
            await releaseDiscountFn(orderId);
          } catch (releaseErr) {
            logErrorFn(releaseErr);
          }
        }
        return {
          status: classification.status,
          body: {
            ok: false,
            emailed: false,
            error:
              "Payment link could not be created. The draft remains available to check or correct in Legacy admin.",
          },
        };
      }
      // Ambiguous: retain claim; do not persist; do not email; do not expose provider details.
      return {
        status: classification.status >= 500 ? classification.status : 502,
        body: {
          ok: false,
          squareOutcomeUncertain: true,
          squareLinkCreated: false,
          emailed: false,
          error:
            "Payment link outcome is uncertain. Do not retry from Admin v2 without checking Square and Legacy admin.",
          warning:
            "Square may have created a payment link. Do not retry before checking Square and Legacy admin.",
        },
      };
    }

    // Any non-throwing Square create is treated as a created link — never release the claim afterward.
    squareLinkCreated = true;
    checkoutUrl = String(created?.checkoutUrl || "").trim();
    if (!checkoutUrl) {
      return {
        status: 500,
        body: {
          ok: false,
          error:
            "Square payment link was created but no checkout URL was returned. Do not retry from Admin v2 without checking Legacy admin.",
          squareLinkCreated: true,
          checkoutUrl: "",
          emailed: false,
          warning:
            "Square may have created a payment link that was not returned. Check Legacy admin before taking further action.",
        },
      };
    }

    try {
      await persistPaymentLinkFn(orderId, checkoutUrl);
      persisted = true;
    } catch (persistErr) {
      logErrorFn(persistErr);
      // Keep discount claim — Square already created a potentially payable link.
      return {
        status: 500,
        body: {
          ok: false,
          error:
            "Square payment link was created but could not be saved on the order. Do not retry from Admin v2 without checking Legacy admin.",
          squareLinkCreated: true,
          checkoutUrl,
          emailed: false,
          warning:
            "Square may have created a payment link that was not persisted. Check Legacy admin before taking further action.",
        },
      };
    }

    let emailed = false;
    try {
      emailed = (await sendEmailFn({ ...opts.sendEmailArgs, checkoutUrl })) === true;
    } catch (emailErr) {
      logErrorFn(emailErr);
      // Persisted payment_link_sent — keep claim; never mint another link.
      return {
        status: 200,
        body: {
          ok: true,
          checkoutUrl,
          emailed: false,
          warning:
            "Payment link was created and saved, but the email could not be sent. Configure RESEND_API_KEY and RESEND_FROM, or share the link manually. Do not create another link for this order.",
        },
      };
    }

    if (!emailed) {
      return {
        status: 200,
        body: {
          ok: true,
          checkoutUrl,
          emailed: false,
          warning:
            "Payment link was created and saved, but the email could not be sent. Configure RESEND_API_KEY and RESEND_FROM, or share the link manually. Do not create another link for this order.",
        },
      };
    }

    return { status: 200, body: { ok: true, checkoutUrl, emailed: true } };
  } catch (err) {
    // Unexpected errors after Square success: never release; never expose provider details.
    if (squareLinkCreated && persisted) {
      return {
        status: 200,
        body: {
          ok: true,
          checkoutUrl,
          emailed: false,
          warning:
            "Payment link was created and saved, but the email could not be sent. Configure RESEND_API_KEY and RESEND_FROM, or share the link manually. Do not create another link for this order.",
        },
      };
    }
    if (squareLinkCreated && !persisted) {
      return {
        status: 500,
        body: {
          ok: false,
          error:
            "Square payment link was created but could not be saved on the order. Do not retry from Admin v2 without checking Legacy admin.",
          squareLinkCreated: true,
          checkoutUrl,
          emailed: false,
          warning:
            "Square may have created a payment link that was not persisted. Check Legacy admin before taking further action.",
        },
      };
    }
    logErrorFn(err);
    return {
      status: 500,
      body: {
        ok: false,
        squareOutcomeUncertain: true,
        squareLinkCreated: false,
        emailed: false,
        error:
          "Payment link outcome is uncertain. Do not retry from Admin v2 without checking Square and Legacy admin.",
        warning:
          "Square may have created a payment link. Do not retry before checking Square and Legacy admin.",
      },
    };
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    await assertReportsAuthorized(req);
    const orderId = String(req.body?.orderId || "").trim();
    const parsedShipmentDate = parseOptionalYmd(req.body?.shipmentDate);
    if (!parsedShipmentDate.ok) {
      res.status(400).json({ error: parsedShipmentDate.error });
      return;
    }
    if (!orderId) {
      res.status(400).json({ error: "orderId is required." });
      return;
    }

    const order = await getOrderByIdForService(orderId);
    const gate = assertManualOrderEligibleForPaymentLink(order);
    if (!gate.ok) {
      res.status(gate.status).json(gate.body);
      return;
    }

    const shipAddr = order.shipping_address;
    const adminAddressHardin =
      order.is_hardin_discount === true && !String(order.discount_code_used || "").trim();
    const fm = normalizeFulfillmentMethod(order.fulfillment_method);
    const isCarrier = fm === "carrier";

    const b = req.body || {};
    const selectedFromBody = String(b?.selectedShippingRateObjectId || "").trim();
    const selectedFromOrder = String(order.quoted_shipping_provider_quote_id || "").trim();
    const selectedRateId = selectedFromBody || selectedFromOrder;
    const estimateBody = {
      items: order.items,
      address: shipAddr,
      discountCode: order.discount_code_used || "",
      applyEligibleLocalDiscount: adminAddressHardin,
      forceApplyEligibleLocalDiscount:
        adminAddressHardin && order.admin_local_discount_override === true,
      fulfillmentMethod: fm,
      ...(b.forceStockOverride === true ? { forceStockOverride: true } : {}),
      ...(selectedRateId ? { selectedShippingRateObjectId: selectedRateId } : {}),
      ...(String(b?.selectedShippingServiceCode || "").trim()
        ? { selectedShippingServiceCode: String(b.selectedShippingServiceCode).trim() }
        : {}),
      ...(String(b?.selectedShippingServiceLabel || "").trim()
        ? { selectedShippingServiceLabel: String(b.selectedShippingServiceLabel).trim() }
        : {}),
      ...(String(b?.selectedShippingProvider || "").trim()
        ? { selectedShippingProvider: String(b.selectedShippingProvider).trim() }
        : {}),
      ...(b?.selectedShippingAmountCents != null && Number.isFinite(Number(b.selectedShippingAmountCents))
        ? { selectedShippingAmountCents: Math.max(0, Math.round(Number(b.selectedShippingAmountCents))) }
        : {}),
      ...(b?.selectedShippingParcelCount != null && Number.isFinite(Number(b.selectedShippingParcelCount))
        ? { selectedShippingParcelCount: Math.max(0, Math.floor(Number(b.selectedShippingParcelCount))) }
        : {}),
      ...(b?.selectedShippingResidentialSurchargeCents != null &&
      Number.isFinite(Number(b.selectedShippingResidentialSurchargeCents))
        ? {
            selectedShippingResidentialSurchargeCents: Math.max(
              0,
              Math.round(Number(b.selectedShippingResidentialSurchargeCents)),
            ),
          }
        : {}),
    };

    const quote = await computeCheckoutEstimate(estimateBody, {
      requireCompleteAddress: isCarrier,
      adminLocalDiscount: adminAddressHardin,
      strictShippo: isCarrier,
      allowForceStockOverride: true,
    });

    const client = getServiceClient();
    await syncOrderTotalsFromQuote(
      client,
      order.id,
      quote,
      shipAddr,
      parsedShipmentDate.value != null ? parsedShipmentDate.value : order.shippo_shipment_date || null,
    );

    const normalizedCode = order.discount_code_used
      ? normalizeDiscountCode(String(order.discount_code_used))
      : null;
    let claimed = false;

    if (String(order.order_status || "") === "draft" && order.is_hardin_discount && normalizedCode) {
      claimed = await claimDiscountCodeForOrder(normalizedCode, order.id);
      if (!claimed) {
        res.status(409).json({
          error:
            "Could not reserve the discount code (it may have been used elsewhere). Update the order or remove the code.",
        });
        return;
      }
    }

    const customer = {
      email: order.customer_email,
      phone: order.customer_phone,
      name: order.customer_name,
    };

    const result = await deliverManualOrderPaymentLink({
      claimed,
      orderId: String(order.id),
      createPaymentLinkArgs: {
        quote,
        customer,
        orderId: String(order.id),
        checkoutOptions: {
          quoteShipping: true,
          askForShippingAddress: false,
          shippingAsLineItems: true,
        },
      },
      sendEmailArgs: {
        customerEmail: order.customer_email,
        customerName: order.customer_name,
        orderRef: order.order_ref,
        totalFormatted: quote.totalFormatted,
        quote,
        shippingAddress: shipAddr,
      },
    });

    res.status(result.status).json(result.body);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not send payment link.",
      ...checkoutFlowErrorJsonFields(error),
    });
  }
}
