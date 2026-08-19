import { claimDiscountCodeForOrder, normalizeDiscountCode, releaseDiscountCodeForOrder } from "../lib/discount-codes.js";
import { computeCheckoutEstimate, checkoutFlowErrorJsonFields } from "../lib/checkout-estimate-logic.js";
import { normalizeFulfillmentMethod } from "../lib/manual-order-fulfillment.js";
import { isManualOrderDiscountApplied, readManualOrderDiscountFromOrder } from "../lib/manual-order-discount.js";
import { computeEconomicsSnapshotForOrder } from "../lib/order-economics.js";
import { sendManualOrderPaymentLinkEmail } from "../lib/manual-order-payment-email.js";
import {
  buildOrderQuoteSnapshotColumns,
  getOrderByIdForService,
  resetExpiredManualPaymentLink,
  updateOrderPaymentLinkSent,
} from "../lib/orders.js";
import { assertReportsAuthorized } from "../lib/reports-auth.js";
import { createClient } from "@supabase/supabase-js";
import { createPaymentLink, deletePaymentLink } from "../lib/square.js";
import { manualPaymentAccessUrl } from "../lib/manual-payment-link-access.js";

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

function formatUsdCents(cents) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Math.max(0, Math.round(Number(cents) || 0)) / 100,
  );
}

function quoteFromOrderSnapshot(order) {
  return {
    items: Array.isArray(order?.items) ? order.items : [],
    subtotalCents: Math.max(0, Math.round(Number(order?.subtotal_cents) || 0)),
    shippingCents: Math.max(0, Math.round(Number(order?.shipping_cents) || 0)),
    taxCents: Math.max(0, Math.round(Number(order?.tax_cents) || 0)),
    totalCents: Math.max(0, Math.round(Number(order?.total_cents) || 0)),
    subtotalFormatted: formatUsdCents(order?.subtotal_cents),
    shippingFormatted: formatUsdCents(order?.shipping_cents),
    taxFormatted: formatUsdCents(order?.tax_cents),
    totalFormatted: formatUsdCents(order?.total_cents),
  };
}

function shouldHideLocalDeliveryAddress(fulfillmentMethod, shippingAddress) {
  if (normalizeFulfillmentMethod(fulfillmentMethod) !== "local_delivery") {
    return false;
  }
  const line1 = String(shippingAddress?.line1 || shippingAddress?.address1 || "").trim().toLowerCase();
  return !line1 || line1 === "local delivery";
}

function invalidCarrierQuoteMessage(quote) {
  const shipping = quote?.shipping && typeof quote.shipping === "object" ? quote.shipping : {};
  const quoteStatus = String(shipping.quoteStatus || "").trim();
  const service = String(shipping.serviceLabel || shipping.serviceCode || "").trim();
  const providerQuoteId = String(shipping.providerQuoteId || "").trim();
  const shippingCents = Math.max(0, Math.round(Number(quote?.shippingCents ?? shipping.amountCents) || 0));
  if (!quote?.canCheckout || quote?.userFacingError) {
    return quote?.userFacingError || "Carrier shipping is not ready. Get and confirm a carrier rate before sending this link.";
  }
  if (quoteStatus !== "rated" || !providerQuoteId || !service || shippingCents <= 0) {
    return "Carrier shipping is missing a confirmed paid rate. Get and confirm a carrier rate before sending this link.";
  }
  return "";
}

function invalidCarrierOrderSnapshotMessage(order) {
  const service = String(order?.quoted_shipping_service_label || order?.quoted_shipping_service_code || "").trim();
  const providerQuoteId = String(order?.quoted_shipping_provider_quote_id || "").trim();
  const shippingCents = Math.max(0, Math.round(Number(order?.shipping_cents) || 0));
  if (!providerQuoteId || !service || shippingCents <= 0) {
    return "This payment link was created before a valid carrier rate was saved. Do not resend it; refresh rates and recreate the order.";
  }
  return "";
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
export function assertManualOrderEligibleForPaymentLink(order, opts = {}) {
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
  const payLater = String(order.payment_flow || "square_payment_link") === "pay_later";
  const allowPayLaterLink = opts.allowPayLaterLink === true;
  if (payLater && !allowPayLaterLink) {
    return {
      ok: false,
      status: 400,
      body: {
        error:
          "This order is Pay later. Use mark-as-paid when the customer pays (or change payment method to Square link before saving if you need to email a link).",
      },
    };
  }
  if (payLater && allowPayLaterLink && String(order.manual_payment_method || "") !== "arrival_payment_link") {
    return {
      ok: false,
      status: 400,
      body: { error: "This pay-later order was not set up for an arrival payment link." },
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
 *   buildCustomerCheckoutUrlFn?: Function,
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
  const buildCustomerCheckoutUrlFn =
    opts.buildCustomerCheckoutUrlFn || manualPaymentAccessUrl;
  const sendEmailFn = opts.sendEmailFn || sendManualOrderPaymentLinkEmail;
  const releaseDiscountFn = opts.releaseDiscountFn || releaseDiscountCodeForOrder;
  const logErrorFn = opts.logErrorFn || ((err) => console.error(err));
  const claimed = opts.claimed === true;
  const orderId = String(opts.orderId || "").trim();

  let squareLinkCreated = false;
  let persisted = false;
  let checkoutUrl = "";
  let customerCheckoutUrl = "";

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
      const savedOrder = await persistPaymentLinkFn(orderId, checkoutUrl, {
        paymentLinkId: created?.paymentLinkId || null,
      });
      persisted = true;
      customerCheckoutUrl = buildCustomerCheckoutUrlFn({
        orderId,
        expiresAt: savedOrder?.payment_link_expires_at,
      });
      if (!customerCheckoutUrl) {
        return {
          status: 503,
          body: {
            ok: false,
            squareLinkCreated: true,
            emailed: false,
            error: "Payment-link expiry protection is not configured. The Square link was saved but was not emailed.",
          },
        };
      }
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
          checkoutUrl: "",
          emailed: false,
          warning:
            "Square may have created a payment link that was not persisted. Check Legacy admin before taking further action.",
        },
      };
    }

    let emailed = false;
    try {
      emailed = (await sendEmailFn({ ...opts.sendEmailArgs, checkoutUrl: customerCheckoutUrl })) === true;
    } catch (emailErr) {
      logErrorFn(emailErr);
      // Persisted payment_link_sent — keep claim; never mint another link.
      return {
        status: 200,
        body: {
          ok: true,
          checkoutUrl: customerCheckoutUrl,
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
          checkoutUrl: customerCheckoutUrl,
          emailed: false,
          warning:
            "Payment link was created and saved, but the email could not be sent. Configure RESEND_API_KEY and RESEND_FROM, or share the link manually. Do not create another link for this order.",
        },
      };
    }

    return { status: 200, body: { ok: true, checkoutUrl: customerCheckoutUrl, emailed: true, expiresInHours: 48 } };
  } catch (err) {
    // Unexpected errors after Square success: never release; never expose provider details.
    if (squareLinkCreated && persisted) {
      return {
        status: 200,
        body: {
          ok: true,
          checkoutUrl: customerCheckoutUrl,
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
          checkoutUrl: "",
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

    let order = await getOrderByIdForService(orderId);
    const existingPaymentLinkUrl = String(order?.payment_link_url || "").trim();
    let renewingExpiredLink = false;
    if (String(order?.order_status || "") === "payment_link_sent" && existingPaymentLinkUrl) {
      if (String(order.order_source || "web") !== "manual") {
        res.status(400).json({ error: "Only manual orders can receive a payment link from this action." });
        return;
      }
      if (String(order.status || "") === "paid") {
        res.status(400).json({ error: "This order is already paid." });
        return;
      }
      const expiresAtMs = new Date(order.payment_link_expires_at || 0).getTime();
      const expired = !Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs;
      if (expired) {
        renewingExpiredLink = true;
        const paymentLinkId = String(order.payment_link_id || "").trim();
        if (paymentLinkId) await deletePaymentLink(paymentLinkId);
        order = await resetExpiredManualPaymentLink(order.id);
        if (!order) {
          res.status(409).json({ error: "The expired payment link could not be reset. Refresh the order and try again." });
          return;
        }
      } else {
      const quote = quoteFromOrderSnapshot(order);
      const fm = normalizeFulfillmentMethod(order.fulfillment_method);
      const shipAddr = order.shipping_address && typeof order.shipping_address === "object" ? order.shipping_address : null;
      if (fm === "carrier") {
        const carrierSnapshotError = invalidCarrierOrderSnapshotMessage(order);
        if (carrierSnapshotError) {
          res.status(400).json({ error: carrierSnapshotError });
          return;
        }
      }
      const customerUrl = manualPaymentAccessUrl({ orderId: order.id, expiresAt: order.payment_link_expires_at });
      if (!customerUrl) {
        res.status(503).json({ error: "Payment link access signing is not configured." });
        return;
      }
      const emailed = await sendManualOrderPaymentLinkEmail({
        customerEmail: order.customer_email,
        customerName: order.customer_name,
        orderRef: order.order_ref,
        totalFormatted: quote.totalFormatted,
        checkoutUrl: customerUrl,
        quote,
        shippingAddress: shouldHideLocalDeliveryAddress(fm, shipAddr) ? null : shipAddr,
      });
      res.status(200).json({
        ok: true,
        checkoutUrl: customerUrl,
        emailed,
        warning: emailed
          ? "A payment link had already been sent. The existing link was resent."
          : "A payment link had already been sent, but the email could not be resent. Share the saved link manually.",
      });
      return;
      }
    }
    const gate = assertManualOrderEligibleForPaymentLink(order, {
      allowPayLaterLink: req.body?.allowPayLaterLink === true,
    });
    if (!gate.ok) {
      res.status(gate.status).json(gate.body);
      return;
    }

    const shipAddr = order.shipping_address;
    const fm = normalizeFulfillmentMethod(order.fulfillment_method);
    const isCarrier = fm === "carrier";
    const quote = quoteFromOrderSnapshot(order);
    if (isCarrier) {
      const carrierQuoteError = invalidCarrierOrderSnapshotMessage(order);
      if (carrierQuoteError) {
        res.status(400).json({ error: carrierQuoteError });
        return;
      }
    }

    const normalizedCode = order.discount_code_used
      ? normalizeDiscountCode(String(order.discount_code_used))
      : null;
    let claimed = false;

    if (!renewingExpiredLink && String(order.order_status || "") === "draft" && order.is_hardin_discount && normalizedCode) {
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
        shippingAddress: shouldHideLocalDeliveryAddress(fm, shipAddr) ? null : shipAddr,
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
