import {
  builtInShippingAllowanceTotalCents,
  expectedProfitCentsFromBundle,
  getBundleDef,
  normaliseBundleLines,
} from "./bundles.js";
import { bundleUnitPriceCents } from "./pricing-tier.js";
import { formatCurrency } from "./quote.js";
import { getProductMap } from "./store.js";

const MAX_NEGOTIATED_UNIT_PRICE_CENTS = 10_000_000;

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function hasNegotiatedFields(item) {
  return item?.b2bNegotiatedUnitPriceCents != null || String(item?.b2bNegotiationReason || "").trim() !== "";
}

/** Apply server-authoritative, B2B-only negotiated bundle prices to a merchandise quote. */
export function applyB2BNegotiatedPricingToQuote(quote, sourceItems, options = {}) {
  const items = Array.isArray(sourceItems) ? sourceItems : [];
  const requested = items.some(hasNegotiatedFields);
  if (!requested) return { quote, applied: false };
  if (options.enabled !== true) {
    throw badRequest("Negotiated product pricing is only available for admin B2B orders.");
  }

  const productMap = getProductMap();
  const quoteItems = Array.isArray(quote?.items) ? quote.items : [];
  let subtotalCents = 0;
  const nextItems = quoteItems.map((quoteItem, index) => {
    const source = items.find((item) =>
      String(item?.clientLineId || "").trim() &&
      String(item.clientLineId).trim() === String(quoteItem?.clientLineId || "").trim(),
    ) || items[index];
    if (!hasNegotiatedFields(source)) {
      subtotalCents += Math.max(0, Math.round(Number(quoteItem?.lineTotalCents) || 0));
      return quoteItem;
    }

    const reason = String(source?.b2bNegotiationReason || "").trim();
    if (reason.length < 3) throw badRequest("Enter a negotiation reason for every custom B2B price.");
    const unitPriceCents = Math.round(Number(source?.b2bNegotiatedUnitPriceCents));
    if (!Number.isFinite(unitPriceCents) || unitPriceCents < 1 || unitPriceCents > MAX_NEGOTIATED_UNIT_PRICE_CENTS) {
      throw badRequest("Negotiated unit price must be between $0.01 and $100,000.00.");
    }

    const product = productMap.get(String(quoteItem?.slug || ""));
    const lines = normaliseBundleLines(quoteItem?.bundleLines);
    if (!product || lines.length !== 1) {
      throw badRequest("Each negotiated B2B product line must use one bundle type.");
    }
    const bundle = getBundleDef(product, lines[0].id);
    const quantity = Math.max(1, Math.floor(Number(lines[0].qty) || 0));
    if (!bundle) throw badRequest("The selected B2B bundle is no longer available.");

    const regularUnitPriceCents = bundleUnitPriceCents(bundle, "standard");
    const minimumUnitPriceCents = Math.max(
      1,
      regularUnitPriceCents - expectedProfitCentsFromBundle(bundle) - builtInShippingAllowanceTotalCents(bundle),
    );
    if (unitPriceCents < minimumUnitPriceCents) {
      throw badRequest(`Negotiated unit price cannot be below cost (${formatCurrency(minimumUnitPriceCents)}).`);
    }

    const catalogLineTotalCents = Math.max(0, Math.round(Number(quoteItem?.lineTotalCents) || 0));
    const catalogUnitPriceCents = Math.round(catalogLineTotalCents / quantity);
    const lineTotalCents = unitPriceCents * quantity;
    subtotalCents += lineTotalCents;
    return {
      ...quoteItem,
      lineTotalCents,
      lineTotalFormatted: formatCurrency(lineTotalCents),
      b2bPricing: {
        mode: "negotiated",
        unitPriceCents,
        unitPriceFormatted: formatCurrency(unitPriceCents),
        catalogUnitPriceCents,
        catalogUnitPriceFormatted: formatCurrency(catalogUnitPriceCents),
        quantity,
        adjustmentCents: lineTotalCents - catalogLineTotalCents,
        reason,
      },
    };
  });

  return {
    applied: true,
    quote: {
      ...quote,
      items: nextItems,
      subtotalCents,
      subtotalFormatted: formatCurrency(subtotalCents),
      totalCents: subtotalCents + Math.max(0, Math.round(Number(quote?.shippingCents) || 0)) + Math.max(0, Math.round(Number(quote?.taxCents) || 0)),
      totalFormatted: formatCurrency(subtotalCents + Math.max(0, Math.round(Number(quote?.shippingCents) || 0)) + Math.max(0, Math.round(Number(quote?.taxCents) || 0))),
    },
  };
}
