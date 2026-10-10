export function manualPaymentEmailSubject(orderRef) {
  return `Your SAI Goods order is ready — ${orderRef || "SAI Goods order"}`;
}
