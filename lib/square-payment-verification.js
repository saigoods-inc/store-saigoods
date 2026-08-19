export function assertCompletedSquarePaymentMatchesOrder(payment, { orderId, amountCents, currency = "USD" }) {
  const status = String(payment?.status || "").trim().toUpperCase();
  const paidAmount = Number(payment?.amount_money?.amount);
  const paidCurrency = String(payment?.amount_money?.currency || "").trim().toUpperCase();
  const note = String(payment?.note || "");
  if (status !== "COMPLETED") {
    const error = new Error("Square has not confirmed this payment as completed.");
    error.statusCode = 503;
    error.code = "SQUARE_PAYMENT_NOT_COMPLETED";
    error.retrySafe = true;
    throw error;
  }
  if (!Number.isFinite(paidAmount) || Math.round(paidAmount) !== Math.round(Number(amountCents))) {
    const error = new Error("Square payment amount does not match this order.");
    error.statusCode = 409;
    error.code = "SQUARE_PAYMENT_AMOUNT_MISMATCH";
    throw error;
  }
  if (paidCurrency !== String(currency || "USD").trim().toUpperCase()) {
    const error = new Error("Square payment currency does not match this order.");
    error.statusCode = 409;
    error.code = "SQUARE_PAYMENT_CURRENCY_MISMATCH";
    throw error;
  }
  const escapedOrderId = String(orderId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`Order\\s+${escapedOrderId}\\s+from`, "i").test(note)) {
    const error = new Error("Square payment does not reference this order.");
    error.statusCode = 409;
    error.code = "SQUARE_PAYMENT_ORDER_MISMATCH";
    throw error;
  }
}
