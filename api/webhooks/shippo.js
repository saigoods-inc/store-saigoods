import { handleShippoWebhook } from "../../lib/shippo-webhook-handler.js";

export default async function handler(req, res) {
  return handleShippoWebhook(req, res);
}
