/**
 * Shared bundle-card size summary (store product page + admin manual order).
 * Each card must reflect only that line's units (qty × bundle.units), not the whole channel.
 */

import { sumQuantitiesMap } from "./bundle-validation.js";

/**
 * When multiple bundles share a channel (all "box" or all "case"), split `channelMap`
 * across lines in catalog order so each line's map sums to its own required units.
 * Returns null if totals do not match (hide summary until allocation matches bundles).
 *
 * @param {object} product
 * @param {Record<string, number>} bundleQty
 * @param {object} bundle Current bundle definition (card being rendered).
 * @param {Record<string, number>} channelMap boxBySize or caseBySize for this product line.
 * @param {string[]} sizes Size display order (e.g. site sizes).
 * @returns {Record<string, number> | null}
 */
export function perBundleSummaryMap(product, bundleQty, bundle, channelMap, sizes) {
  const k = String(bundle?.kind || "").toLowerCase();
  if (k !== "box" && k !== "case") {
    return null;
  }
  const qty = Math.floor(Number(bundleQty?.[bundle.id])) || 0;
  if (qty < 1) {
    return null;
  }

  const sizeOrder = Array.isArray(sizes) && sizes.length ? sizes : Object.keys(channelMap || {});

  const linesOfKind = (product?.bundles || []).filter((x) => {
    const kind = String(x?.kind || "").toLowerCase();
    return kind === k && (Math.floor(Number(bundleQty?.[x.id])) || 0) > 0;
  });
  if (!linesOfKind.length) {
    return null;
  }

  const totalNeed = linesOfKind.reduce((s, x) => {
    const q = Math.floor(Number(bundleQty?.[x.id])) || 0;
    const units = Math.max(0, Math.floor(Number(x.units) || 0));
    return s + q * units;
  }, 0);

  const totalAllocated = sumQuantitiesMap(channelMap, sizeOrder);
  if (totalNeed < 1 || totalAllocated !== totalNeed) {
    return null;
  }

  if (linesOfKind.length === 1) {
    return Object.fromEntries(sizeOrder.map((sz) => [sz, Math.floor(Number(channelMap?.[sz])) || 0]));
  }

  const remaining = Object.fromEntries(
    sizeOrder.map((sz) => [sz, Math.floor(Number(channelMap?.[sz])) || 0]),
  );

  for (const x of linesOfKind) {
    const q = Math.floor(Number(bundleQty?.[x.id])) || 0;
    let need = q * Math.max(0, Math.floor(Number(x.units) || 0));
    const sub = Object.fromEntries(sizeOrder.map((sz) => [sz, 0]));
    for (const sz of sizeOrder) {
      while (need > 0 && remaining[sz] > 0) {
        const take = Math.min(remaining[sz], need);
        sub[sz] += take;
        remaining[sz] -= take;
        need -= take;
      }
    }
    if (String(x.id) === String(bundle.id)) {
      return sub;
    }
  }

  return null;
}

/**
 * @param {Record<string, number>} map
 * @param {string[]} sizes
 * @param {(s: string) => string} escapeHtmlFn
 */
export function formatBundleCardSizeSummaryHtml(map, sizes, escapeHtmlFn) {
  const esc =
    typeof escapeHtmlFn === "function"
      ? escapeHtmlFn
      : (s) =>
          String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");

  const sizeOrder = Array.isArray(sizes) && sizes.length ? sizes : Object.keys(map || {});
  const segments = [];
  for (const size of sizeOrder) {
    const q = Math.floor(Number(map?.[size])) || 0;
    if (q > 0) {
      segments.push(`${q} ${size}`);
    }
  }
  if (segments.length === 0) {
    return "";
  }
  return segments
    .map(
      (seg) =>
        `<span class="bundle-card__size-summary-seg">${esc(seg)}</span>`,
    )
    .join('<span class="bundle-card__size-summary-sep" aria-hidden="true">•</span>');
}
