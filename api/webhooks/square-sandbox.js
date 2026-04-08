import { config, handleSquareWebhook } from "../../lib/square-webhook-handler.js";

export { config };

export default async function handler(req, res) {
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY_SANDBOX?.trim() || "";
  return handleSquareWebhook(req, res, {
    notificationPath: "/api/webhooks/square-sandbox",
    signatureKey,
  });
}
