import { formatCurrency } from "./quote.js";

function manualOrderNoDiscount() {
  return {
    type: "none",
    value: 0,
    percent: null,
    amountCents: null,
    label: "None",
  };
}

function parseDiscountSource(rawTypeOrDiscount, rawValue) {
  if (rawTypeOrDiscount && typeof rawTypeOrDiscount === "object") {
    const source = rawTypeOrDiscount;
    const rawType =
      source.type ??
      source.kind ??
      source.manualDiscountType ??
      source.discountType ??
      source.mode ??
      "";
    const value =
      source.value ??
      source.manualDiscountValue ??
      source.discountValue ??
      source.percent ??
      source.amountCents ??
      rawValue;
    return { rawType, rawValue: value };
  }
  return { rawType: rawTypeOrDiscount, rawValue };
}

function normalizeDiscountType(rawType) {
  const type = String(rawType || "")
    .trim()
    .toLowerCase();
  if (!type || type === "none") {
    return "none";
  }
  if (type === "percent" || type === "percentage") {
    return "percent";
  }
  if (type === "amount" || type === "fixed" || type === "custom") {
    return "amount";
  }
  return null;
}

function buildDiscountError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

export function isManualOrderDiscountApplied(discount) {
  return Boolean(discount && typeof discount === "object" && String(discount.type || "") !== "none");
}

export function normalizeManualOrderDiscountInput(rawTypeOrDiscount, rawValue) {
  const { rawType, rawValue: valueInput } = parseDiscountSource(rawTypeOrDiscount, rawValue);
  const type = normalizeDiscountType(rawType);
  if (type == null) {
    throw buildDiscountError("Discount selection is invalid.");
  }
  if (type === "none") {
    return manualOrderNoDiscount();
  }
  if (type === "percent") {
    const percent = Math.round(Number(valueInput));
    if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
      throw buildDiscountError("Discount percentage must be between 1% and 100%.");
    }
    return {
      type: "percent",
      value: percent,
      percent,
      amountCents: null,
      label: `${percent}% off`,
    };
  }

  const amountCents = Math.round(Number(valueInput));
  if (!Number.isFinite(amountCents) || amountCents < 1) {
    throw buildDiscountError("Custom discount amount must be greater than $0.00.");
  }
  return {
    type: "amount",
    value: amountCents,
    percent: null,
    amountCents,
    label: `${formatCurrency(amountCents)} off`,
  };
}

export function serializeManualOrderDiscount(discount) {
  const normalized = normalizeManualOrderDiscountInput(discount);
  return {
    type: normalized.type,
    value: normalized.value,
    label: normalized.label,
    ...(normalized.percent != null ? { percent: normalized.percent } : {}),
    ...(normalized.amountCents != null
      ? {
          amountCents: normalized.amountCents,
          amountFormatted: formatCurrency(normalized.amountCents),
        }
      : {}),
  };
}

function distributeIntegerByWeights(totalCents, weights) {
  const total = Math.max(0, Math.round(Number(totalCents) || 0));
  const normalizedWeights = weights.map((value) => Math.max(0, Math.round(Number(value) || 0)));
  const sumWeights = normalizedWeights.reduce((sum, value) => sum + value, 0);
  if (sumWeights <= 0) {
    return normalizedWeights.map(() => 0);
  }

  const rawAllocations = normalizedWeights.map((weight) => (total * weight) / sumWeights);
  const floorAllocations = rawAllocations.map((value) => Math.floor(value));
  let remainder = total - floorAllocations.reduce((sum, value) => sum + value, 0);
  const remainderOrder = rawAllocations
    .map((value, index) => ({ index, remainder: value - floorAllocations[index] }))
    .sort((a, b) => b.remainder - a.remainder);

  for (let i = 0; i < remainder; i += 1) {
    floorAllocations[remainderOrder[i % remainderOrder.length].index] += 1;
  }
  return floorAllocations;
}

export function applyManualOrderDiscountToQuote(quote, discount) {
  const normalized = normalizeManualOrderDiscountInput(discount);
  const baseSubtotalCents = Math.max(0, Math.round(Number(quote?.subtotalCents) || 0));
  let discountCents = 0;
  if (normalized.type === "percent") {
    discountCents = Math.min(baseSubtotalCents, Math.round((baseSubtotalCents * normalized.percent) / 100));
  } else if (normalized.type === "amount") {
    discountCents = Math.min(baseSubtotalCents, normalized.amountCents);
  }

  const manualDiscount = {
    ...serializeManualOrderDiscount(normalized),
    discountCents,
    discountFormatted: formatCurrency(discountCents),
  };

  if (discountCents < 1) {
    return {
      quote: {
        ...quote,
        manualDiscount,
      },
      discountBreakdown: {},
    };
  }

  const nextSubtotalCents = Math.max(0, baseSubtotalCents - discountCents);
  const items = Array.isArray(quote?.items) ? quote.items : [];
  const adjustedLineTotals = distributeIntegerByWeights(
    nextSubtotalCents,
    items.map((row) => Math.max(0, Math.round(Number(row?.lineTotalCents) || 0))),
  );
  const adjustedItems = items.map((row, index) => {
    const originalLineTotalCents = Math.max(0, Math.round(Number(row?.lineTotalCents) || 0));
    const lineTotalCents = Math.max(0, adjustedLineTotals[index] || 0);
    return {
      ...row,
      originalLineTotalCents,
      originalLineTotalFormatted: formatCurrency(originalLineTotalCents),
      lineTotalCents,
      lineTotalFormatted: formatCurrency(lineTotalCents),
    };
  });

  return {
    quote: {
      ...quote,
      items: adjustedItems,
      subtotalCents: nextSubtotalCents,
      subtotalFormatted: formatCurrency(nextSubtotalCents),
      manualDiscount,
    },
    discountBreakdown: {
      originalMerchandiseSubtotalCents: baseSubtotalCents,
      originalMerchandiseSubtotalFormatted: formatCurrency(baseSubtotalCents),
      merchandiseDiscountCents: discountCents,
      merchandiseDiscountFormatted: formatCurrency(discountCents),
      manualDiscount,
    },
  };
}

function normalizeJsonObjectOrNull(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function readManualOrderDiscountFromOrder(order) {
  const snapshot = normalizeJsonObjectOrNull(order?.quoted_address_snapshot_json);
  const raw = snapshot?.manualDiscount;
  if (!raw || typeof raw !== "object") {
    return manualOrderNoDiscount();
  }
  try {
    return normalizeManualOrderDiscountInput(raw);
  } catch {
    return manualOrderNoDiscount();
  }
}
