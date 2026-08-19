const RATE_LIMIT_CODES = new Set(["10429", "429"]);

function collectMessages(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectMessages(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  if (value.code != null || value.text != null || value.message != null) {
    output.push(value);
  }
  if (Array.isArray(value.messages)) collectMessages(value.messages, output);
  if (Array.isArray(value.rates)) collectMessages(value.rates, output);
  return output;
}
export function isShippoCarrierRateLimited(response) {
  return collectMessages(response).some((message) => {
    const code = String(message?.code || "").trim();
    const text = String(message?.text || message?.message || "").trim();
    return RATE_LIMIT_CODES.has(code) || /too many requests|rate[ -]?limit/i.test(text);
  });
}
