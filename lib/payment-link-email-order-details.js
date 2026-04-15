/**
 * HTML fragments for manual payment-link emails and paid-order receipts — built from live quote + address only.
 */

import { getBundleDef, normaliseBundleLines } from "./bundles.js";
import { formatShippingAddressForOrder } from "./checkout-totals.js";
import { getKnownSizes, getProductMap } from "./store.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatSizeBreakdownLine(quantities, boxQuantities, sizes) {
  const parts = [];
  for (const sz of sizes) {
    const c = Math.floor(Number(quantities?.[sz])) || 0;
    const bx = Math.floor(Number(boxQuantities?.[sz])) || 0;
    if (!c && !bx) {
      continue;
    }
    const bits = [];
    if (c) {
      bits.push(`${c} ${c === 1 ? "case" : "cases"}`);
    }
    if (bx) {
      bits.push(`${bx} ${bx === 1 ? "box" : "boxes"}`);
    }
    parts.push(`${sz}: ${bits.join(", ")}`);
  }
  return parts.length ? parts.join(" • ") : "";
}

function formatLineItemQtySummary(item) {
  const c = Math.floor(Number(item?.lineCases) || 0);
  const b = Math.floor(Number(item?.lineBoxCount) || 0);
  const parts = [];
  if (c > 0) {
    parts.push(`${c} case${c === 1 ? "" : "s"}`);
  }
  if (b > 0) {
    parts.push(`${b} box${b === 1 ? "" : "es"}`);
  }
  return parts.length ? parts.join(" · ") : "";
}

function bundleLinesDescriptionHtml(product, bundleLines) {
  const lines = normaliseBundleLines(bundleLines);
  if (!lines.length || !product) {
    return "";
  }
  const blocks = [];
  for (const { id, qty } of lines) {
    const b = getBundleDef(product, id);
    const label = b?.label ? String(b.label) : id;
    const lineText = qty > 1 ? `${qty}× ${label}` : label;
    blocks.push(
      `<p style="margin:0 0 6px;font-size:15px;color:#27272a;font-weight:500;line-height:1.45">${escapeHtml(lineText)}</p>`,
    );
  }
  return blocks.join("");
}

/**
 * Product blocks (name, bundles, size breakdown, or quantity fallback) for email UIs.
 * @param {{ items?: object[] }} quote
 */
export function buildProductLineItemsBlocksHtml(quote) {
  const productMap = getProductMap();
  const sizes = getKnownSizes();
  const items = Array.isArray(quote?.items) ? quote.items : [];

  const productBlocks = [];
  for (const item of items) {
    const product = item?.slug ? productMap.get(item.slug) : null;
    const name = escapeHtml(item.name || item.slug || "Product");
    const bundleHtml = product ? bundleLinesDescriptionHtml(product, item.bundleLines) : "";
    const sizeLine = formatSizeBreakdownLine(item.quantities, item.boxQuantities, sizes);

    const innerParts = [];
    if (bundleHtml) {
      innerParts.push(bundleHtml);
    }
    if (sizeLine) {
      innerParts.push(
        `<p style="margin:${bundleHtml ? "4px" : "0"} 0 0;font-size:14px;color:#52525b;line-height:1.55">${escapeHtml(sizeLine)}</p>`,
      );
    } else if (!bundleHtml && product && item.lineTotalFormatted) {
      innerParts.push(
        `<p style="margin:0;font-size:14px;color:#52525b;line-height:1.55">${escapeHtml(String(item.lineTotalFormatted))}</p>`,
      );
    }

    if (!innerParts.length) {
      const summary = formatLineItemQtySummary(item);
      if (summary) {
        innerParts.push(
          `<p style="margin:0;font-size:14px;color:#52525b;line-height:1.55">${escapeHtml(summary)}</p>`,
        );
      } else if (item.lineTotalFormatted) {
        innerParts.push(
          `<p style="margin:0;font-size:14px;color:#52525b;line-height:1.55">${escapeHtml(String(item.lineTotalFormatted))}</p>`,
        );
      }
    }

    if (!innerParts.length) {
      innerParts.push(
        `<p style="margin:0;font-size:14px;color:#52525b;line-height:1.55">—</p>`,
      );
    }

    productBlocks.push(`
      <div style="margin:0 0 18px;padding:0 0 16px;border-bottom:1px solid #e4e4e7;">
        <p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#18181b;line-height:1.35;">${name}</p>
        ${innerParts.join("\n")}
      </div>`);
  }

  return productBlocks.length ? productBlocks.join("\n") : "";
}

function pricingRow(label, value) {
  return `<tr>
    <td style="padding:6px 8px 6px 0;vertical-align:top;color:#52525b;">${escapeHtml(label)}</td>
    <td style="padding:6px 0 6px 8px;text-align:right;white-space:nowrap;font-weight:500;color:#18181b;">${escapeHtml(value)}</td>
  </tr>`;
}

/**
 * Merchandise, shipping, optional discount, tax, and total — all from `quote` fields.
 * @param {{ items?: object[], subtotalFormatted?: string, shippingCents?: number, shippingFormatted?: string, taxFormatted?: string, totalFormatted?: string, merchandiseDiscountCents?: number, merchandiseDiscountFormatted?: string, originalMerchandiseSubtotalFormatted?: string }} quote
 * @param {{ taxLabel?: string, totalLabel?: string }} [opts]
 */
export function buildPricingBreakdownTableHtml(quote, { taxLabel = "Tax", totalLabel = "Total paid" } = {}) {
  const discCents = Math.max(0, Number(quote?.merchandiseDiscountCents) || 0);
  const hasDisc = discCents > 0 && quote?.merchandiseDiscountFormatted && quote?.originalMerchandiseSubtotalFormatted;

  const shipCents = Math.max(0, Number(quote?.shippingCents) || 0);
  const baseShipCents =
    quote?.baseShippingFormatted != null ? Math.max(0, Math.round(Number(quote?.baseShippingCents) || 0)) : null;
  const shipLabel =
    baseShipCents != null
      ? baseShipCents === 0
        ? "Free"
        : String(quote.baseShippingFormatted)
      : shipCents === 0
        ? "Free"
        : String(quote.shippingFormatted || "—");
  const resSurCents = Math.max(0, Math.round(Number(quote?.residentialSurchargeCents) || 0));

  const merchDisplay = hasDisc
    ? String(quote.originalMerchandiseSubtotalFormatted)
    : String(quote?.subtotalFormatted || "—");

  const pricingRows = [];
  pricingRows.push(pricingRow("Merchandise", merchDisplay));
  pricingRows.push(pricingRow("Shipping", shipLabel));
  if (resSurCents > 0 && quote?.residentialSurchargeFormatted) {
    pricingRows.push(pricingRow("Residential charge", String(quote.residentialSurchargeFormatted)));
  }
  if (hasDisc) {
    pricingRows.push(pricingRow("Discount", `−${String(quote.merchandiseDiscountFormatted)}`));
  }
  pricingRows.push(pricingRow(taxLabel, String(quote?.taxFormatted || "—")));
  pricingRows.push(
    `<tr><td colspan="2" style="padding:12px 0 8px;border-top:1px solid #d4d4d8;font-size:1px;line-height:1;">&nbsp;</td></tr>`,
  );
  pricingRows.push(
    `<tr><td style="padding:0 0 4px;font-size:16px;font-weight:700;color:#18181b;">${escapeHtml(totalLabel)}</td><td style="padding:0 0 4px;font-size:16px;font-weight:700;color:#18181b;text-align:right;white-space:nowrap;">${escapeHtml(String(quote?.totalFormatted || "—"))}</td></tr>`,
  );

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:15px;color:#27272a;">
        ${pricingRows.join("\n")}
      </table>`;
}

/**
 * @param {{ items?: object[], subtotalFormatted?: string, shippingCents?: number, shippingFormatted?: string, taxFormatted?: string, totalFormatted?: string, merchandiseDiscountCents?: number, merchandiseDiscountFormatted?: string, originalMerchandiseSubtotalFormatted?: string }} quote
 * @param {object | null | undefined} shippingAddress
 */
export function buildPaymentLinkOrderDetailsSectionHtml(quote, shippingAddress) {
  const lineItemsHtml = buildProductLineItemsBlocksHtml(quote);
  const productSection = lineItemsHtml ? `<div style="margin:0 0 16px;">${lineItemsHtml}</div>` : "";

  const pricingTable = buildPricingBreakdownTableHtml(quote, {
    taxLabel: "Estimated tax",
    totalLabel: "Total due",
  });

  const addrText = formatShippingAddressForOrder(shippingAddress);
  const shipToBlock =
    addrText && String(addrText).trim()
      ? `
      <div style="margin:20px 0 0;padding:14px 16px;background:#fafafa;border-radius:10px;border:1px solid #e4e4e7;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:0.02em;color:#71717a;text-transform:uppercase;">Ship to</p>
        <p style="margin:0;font-size:14px;color:#27272a;line-height:1.55;white-space:pre-wrap;">${escapeHtml(String(addrText).trim())}</p>
      </div>`
      : "";

  return `
    <div style="margin:0 0 28px;padding:20px 18px;background:#fafafa;border-radius:12px;border:1px solid #e4e4e7;">
      <p style="margin:0 0 14px;font-size:13px;font-weight:700;letter-spacing:0.04em;color:#52525b;text-transform:uppercase;">Order details</p>
      ${productSection}
      <p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#3f3f46;">Pricing</p>
      ${pricingTable}
      ${shipToBlock}
    </div>`;
}
