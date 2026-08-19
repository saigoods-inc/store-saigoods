import "./import-env.mjs";
import { createReadStream, readFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeInventoryIntoProduct } from "./lib/stock.js";
import adminDiscountCodesHandler from "./api/admin-discount-codes.js";
import adminStockHandler from "./api/admin-stock.js";
import adminInventoryHandler from "./api/admin-inventory.js";
import adminMarketplaceOrdersHandler from "./api/admin-marketplace-orders.js";
import adminAddressVerifyHandler from "./api/admin-address-verify.js";
import adminManualOrderCreateHandler from "./api/admin-manual-order-create.js";
import adminManualOrderDeleteDraftHandler from "./api/admin-manual-order-delete-draft.js";
import adminManualOrderDraftsHandler from "./api/admin-manual-order-drafts.js";
import adminManualOrderEstimateHandler from "./api/admin-manual-order-estimate.js";
import adminOrderShippoSyncHandler from "./api/admin-order-shippo-sync.js";
import adminOrderShippoRefreshStatusHandler from "./api/admin-order-shippo-refresh-status.js";
import adminOrderShippoPreviewHandler from "./api/admin-order-shippo-preview.js";
import adminOrderShippoShipmentHandler from "./api/admin-order-shippo-shipment.js";
import adminOrderShippoPurchaseLabelHandler from "./api/admin-order-shippo-purchase-label.js";
import adminOrderShippoBuyAllLabelsHandler from "./api/admin-order-shippo-buy-all-labels.js";
import adminOrderParcelOverrideHandler from "./api/admin-order-parcel-override.js";
import adminOrderPackingPlanHandler from "./api/admin-order-packing-plan.js";
import adminOrderShippoShipmentDateHandler from "./api/admin-order-shippo-shipment-date.js";
import adminOrderUpdateShippingAddressHandler from "./api/admin-order-update-shipping-address.js";
import adminOrderFulfillmentCheckpointHandler from "./api/admin-order-fulfillment-checkpoint.js";
import adminOrderFulfillmentHandoffHandler from "./api/admin-order-fulfillment-handoff.js";
import adminOrderFulfillmentAddressesHandler from "./api/admin-order-fulfillment-addresses.js";
import adminOrderPackingSlipHtmlHandler from "./api/admin-order-packing-slip-html.js";
import adminOrderBuyerShippingNotifyHandler from "./api/admin-order-buyer-shipping-notify.js";
import adminOrderConfirmShippedHandler from "./api/admin-order-confirm-shipped.js";
import adminOrderShipFromDisplayHandler from "./api/admin-order-ship-from-display.js";
import adminOrderExternalFulfillmentSaveHandler from "./api/admin-order-external-fulfillment-save.js";
import adminOrderFulfillmentDocLinksHandler from "./api/admin-order-fulfillment-doc-links.js";
import adminPackagingConfigHandler from "./api/admin-packaging-config.js";
import adminBundleConfigHandler from "./api/admin-bundle-config.js";
import adminWarehouseConfigHandler from "./api/admin-warehouse-config.js";
import adminSummaryHandler from "./api/admin-summary.js";
import adminShippingHealthHandler from "./api/admin-shipping-health.js";
import adminPaymentHealthHandler from "./api/admin-payment-health.js";
import adminPaymentFeeConfigHandler from "./api/admin-payment-fee-config.js";
import adminManualOrderRecordPaymentHandler from "./api/admin-manual-order-record-payment.js";
import adminManualOrderSendLinkHandler from "./api/admin-manual-order-send-link.js";
import adminManualOrderUpdateDraftHandler from "./api/admin-manual-order-update-draft.js";
import adminWalkInOrderCreateHandler from "./api/admin-walk-in-order-create.js";
import adminWalkInOrderDeleteDraftHandler from "./api/admin-walk-in-order-delete-draft.js";
import adminWalkInOrderDraftsHandler from "./api/admin-walk-in-order-drafts.js";
import adminWalkInOrderEstimateHandler from "./api/admin-walk-in-order-estimate.js";
import adminWalkInOrderMarkPaidHandler from "./api/admin-walk-in-order-mark-paid.js";
import adminWalkInOrderQuickPayHandler from "./api/admin-walk-in-order-quick-pay.js";
import adminWalkInOrderUpdateDraftHandler from "./api/admin-walk-in-order-update-draft.js";
import cartQuoteHandler from "./api/cart-quote.js";
import checkoutHandler from "./api/checkout.js";
import checkoutEstimateHandler from "./api/checkout-estimate.js";
import checkoutPayHandler from "./api/checkout-pay.js";
import nexusSummaryHandler from "./api/nexus-summary.js";
import productsHandler from "./api/products.js";
import shippoWebhookHandler from "./api/webhooks/shippo.js";
import squareWebhookHandler from "./api/webhooks/square.js";
import squareSandboxWebhookHandler from "./api/webhooks/square-sandbox.js";
import squareConfigHandler from "./api/square-config.js";
import supabasePublicConfigHandler from "./api/supabase-public-config.js";
import taxSummaryHandler from "./api/tax-summary.js";
import manualOrderPaymentHandler from "./api/manual-order-payment.js";
import { primeRuntimeStore } from "./lib/runtime-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const storeJsonPath = path.join(__dirname, "data", "store.json");

function readStoreData() {
  return JSON.parse(readFileSync(storeJsonPath, "utf8"));
}

const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");
const imageDir = path.join(__dirname, "public", "img");

function adaptExpressStyleResponse(res) {
  let statusCode = 200;
  /** @type {Record<string, string>} */
  const extraHeaders = {};
  return {
    status(c) {
      statusCode = c;
      return this;
    },
    setHeader(name, value) {
      extraHeaders[String(name)] = String(value);
      return this;
    },
    json(body) {
      sendJson(res, statusCode, body, extraHeaders);
    },
    end(body = "") {
      res.writeHead(statusCode, extraHeaders);
      res.end(body);
    },
  };
}

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".otf": "font/otf",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || `localhost:${port}`}`);
    const { pathname } = requestUrl;

    if (pathname === "/api/products") {
      await productsHandler({ method: req.method }, adaptExpressStyleResponse(res));
      return;
    }

    if (pathname.startsWith("/api/products/") && req.method === "GET") {
      const slug = pathname.replace("/api/products/", "");
      const { store: fresh } = await primeRuntimeStore();
      const found = fresh.products.find((p) => p.slug === slug);
      const product = found ? { ...found, bundles: (found.bundles || []).filter((bundle) => bundle.active !== false) } : null;

      if (!product) {
        return sendJson(res, 404, { error: "Product not found." });
      }

      return sendJson(res, 200, await mergeInventoryIntoProduct(product));
    }

    if (pathname === "/api/cart/quote" && req.method === "POST") {
      const body = await readJsonBody(req);
      await cartQuoteHandler({ method: "POST", body }, adaptExpressStyleResponse(res));
      return;
    }

    if (pathname === "/api/square-config") {
      await squareConfigHandler(
        { method: req.method },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/nexus-summary") {
      await nexusSummaryHandler(
        { method: req.method, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/tax-summary") {
      await taxSummaryHandler(
        { method: req.method, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/checkout-estimate" && req.method === "POST") {
      const body = await readJsonBody(req);
      await checkoutEstimateHandler(
        { method: "POST", body, headers: req.headers, socket: req.socket },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/checkout-pay" && req.method === "POST") {
      const body = await readJsonBody(req);
      await checkoutPayHandler(
        { method: "POST", body, headers: req.headers, socket: req.socket },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/webhooks/shippo" && req.method === "POST") {
      const body = await readJsonBody(req);
      const query = Object.fromEntries(requestUrl.searchParams.entries());
      await shippoWebhookHandler(
        { method: "POST", body, headers: req.headers, query, url: req.url },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/webhooks/square" && req.method === "POST") {
      await squareWebhookHandler(req, adaptExpressStyleResponse(res));
      return;
    }

    if (pathname === "/api/webhooks/square-sandbox" && req.method === "POST") {
      await squareSandboxWebhookHandler(req, adaptExpressStyleResponse(res));
      return;
    }

    if (pathname === "/api/admin-discount-codes" && req.method === "GET") {
      await adminDiscountCodesHandler(
        { method: "GET", headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (
      (pathname === "/api/admin/stock" || pathname === "/api/admin-stock") &&
      (req.method === "GET" || req.method === "POST")
    ) {
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await adminStockHandler(
        { method: req.method, headers: req.headers, body },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (
      (pathname === "/api/admin/inventory" || pathname === "/api/admin-inventory") &&
      (req.method === "GET" || req.method === "POST")
    ) {
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await adminInventoryHandler(
        { method: req.method, headers: req.headers, body },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-packaging-config" && (req.method === "GET" || req.method === "POST")) {
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await adminPackagingConfigHandler(
        { method: req.method, headers: req.headers, body },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-payment-fee-config" && (req.method === "GET" || req.method === "POST")) {
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await adminPaymentFeeConfigHandler({ method: req.method, headers: req.headers, body }, adaptExpressStyleResponse(res));
      return;
    }

    if (pathname === "/api/admin-bundle-config" && (req.method === "GET" || req.method === "POST")) {
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await adminBundleConfigHandler(
        { method: req.method, headers: req.headers, body },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-warehouse-config" && (req.method === "GET" || req.method === "POST")) {
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await adminWarehouseConfigHandler(
        { method: req.method, headers: req.headers, body },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-marketplace-orders" && (req.method === "GET" || req.method === "POST")) {
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await adminMarketplaceOrdersHandler(
        { method: req.method, headers: req.headers, body, url: req.url },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-address-verify" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminAddressVerifyHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-manual-order-estimate" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminManualOrderEstimateHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-manual-order-create" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminManualOrderCreateHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-manual-order-send-link" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminManualOrderSendLinkHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/manual-order-payment" && req.method === "GET") {
      await manualOrderPaymentHandler(
        {
          method: "GET",
          headers: req.headers,
          query: Object.fromEntries(requestUrl.searchParams.entries()),
        },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-manual-order-record-payment" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminManualOrderRecordPaymentHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-shippo-sync" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderShippoSyncHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-shippo-refresh-status" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderShippoRefreshStatusHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-shippo-preview" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderShippoPreviewHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-packing-plan" && (req.method === "POST" || req.method === "GET")) {
      const body = req.method === "POST" ? await readJsonBody(req) : {};
      const query = Object.fromEntries(requestUrl.searchParams.entries());
      await adminOrderPackingPlanHandler(
        { method: req.method, body, query, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-shippo-shipment" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderShippoShipmentHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-shippo-purchase-label" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderShippoPurchaseLabelHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-shippo-buy-all-labels" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderShippoBuyAllLabelsHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-parcel-override" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderParcelOverrideHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-shippo-shipment-date" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderShippoShipmentDateHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-update-shipping-address" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderUpdateShippingAddressHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-fulfillment-checkpoint" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderFulfillmentCheckpointHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-fulfillment-handoff" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderFulfillmentHandoffHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-fulfillment-addresses" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderFulfillmentAddressesHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-packing-slip-html" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderPackingSlipHtmlHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-buyer-shipping-notify" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderBuyerShippingNotifyHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-confirm-shipped" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderConfirmShippedHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-ship-from-display" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderShipFromDisplayHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-external-fulfillment-save" && req.method === "POST") {
      const body = await readJsonBodyWithLimit(req, 18_000_000);
      await adminOrderExternalFulfillmentSaveHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-order-fulfillment-doc-links" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminOrderFulfillmentDocLinksHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-manual-order-drafts" && req.method === "GET") {
      await adminManualOrderDraftsHandler(
        { method: "GET", headers: req.headers, url: req.url },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-manual-order-update-draft" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminManualOrderUpdateDraftHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-manual-order-delete-draft" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminManualOrderDeleteDraftHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-walk-in-order-estimate" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminWalkInOrderEstimateHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-walk-in-order-create" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminWalkInOrderCreateHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-walk-in-order-drafts" && req.method === "GET") {
      await adminWalkInOrderDraftsHandler(
        { method: "GET", headers: req.headers, url: req.url },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-walk-in-order-update-draft" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminWalkInOrderUpdateDraftHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-walk-in-order-delete-draft" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminWalkInOrderDeleteDraftHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-walk-in-order-mark-paid" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminWalkInOrderMarkPaidHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-walk-in-order-quick-pay" && req.method === "POST") {
      const body = await readJsonBody(req);
      await adminWalkInOrderQuickPayHandler(
        { method: "POST", body, headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/checkout" && req.method === "POST") {
      const body = await readJsonBody(req);
      await checkoutHandler(
        { method: "POST", body },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-summary" && req.method === "GET") {
      await adminSummaryHandler(
        { method: "GET", headers: req.headers, url: req.url },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-shipping-health" && req.method === "GET") {
      await adminShippingHealthHandler(
        { method: "GET", headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/admin-payment-health" && req.method === "GET") {
      await adminPaymentHealthHandler(
        { method: "GET", headers: req.headers },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/supabase-public-config") {
      await supabasePublicConfigHandler(
        { method: req.method },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "Method not allowed." });
    }

    if (pathname === "/admin/orders" || pathname === "/admin/orders/" || pathname === "/admin/orders.html") {
      return serveFile(res, path.join(publicDir, "admin", "orders.html"), req.method);
    }

    if (pathname === "/admin/summary" || pathname === "/admin/summary/" || pathname === "/admin/summary.html") {
      return serveFile(res, path.join(publicDir, "admin", "summary.html"), req.method);
    }

    if (pathname === "/admin/tax" || pathname === "/admin/tax/" || pathname === "/admin/tax.html") {
      return serveFile(res, path.join(publicDir, "admin", "tax.html"), req.method);
    }

    if (pathname === "/admin/nexus" || pathname === "/admin/nexus/" || pathname === "/admin/nexus.html") {
      return serveFile(res, path.join(publicDir, "admin", "nexus.html"), req.method);
    }

    if (
      pathname === "/admin/discount-codes" ||
      pathname === "/admin/discount-codes/" ||
      pathname === "/admin/discount-codes.html"
    ) {
      return serveFile(res, path.join(publicDir, "admin", "discount-codes.html"), req.method);
    }

    if (
      pathname === "/admin/manual-order" ||
      pathname === "/admin/manual-order/" ||
      pathname === "/admin/manual-order.html"
    ) {
      return serveFile(res, path.join(publicDir, "admin", "manual-order.html"), req.method);
    }

    if (
      pathname === "/admin/walk-in-order" ||
      pathname === "/admin/walk-in-order/" ||
      pathname === "/admin/walk-in-order.html"
    ) {
      return serveFile(res, path.join(publicDir, "admin", "walk-in-order.html"), req.method);
    }

    if (
      pathname === "/admin/inventory" ||
      pathname === "/admin/inventory/" ||
      pathname === "/admin/inventory.html"
    ) {
      return serveFile(res, path.join(publicDir, "admin", "inventory.html"), req.method);
    }

    if (pathname === "/admin-v2" || pathname === "/admin-v2/") {
      return serveFile(res, path.join(publicDir, "admin-v2", "summary.html"), req.method);
    }

    if (
      pathname === "/admin-v2/summary" ||
      pathname === "/admin-v2/summary/" ||
      pathname === "/admin-v2/summary.html"
    ) {
      return serveFile(res, path.join(publicDir, "admin-v2", "summary.html"), req.method);
    }

    if (pathname === "/admin-v2/tax" || pathname === "/admin-v2/tax/" || pathname === "/admin-v2/tax.html") {
      return serveFile(res, path.join(publicDir, "admin-v2", "tax.html"), req.method);
    }

    if (pathname === "/admin-v2/nexus" || pathname === "/admin-v2/nexus/" || pathname === "/admin-v2/nexus.html") {
      return serveFile(res, path.join(publicDir, "admin-v2", "nexus.html"), req.method);
    }

    if (
      pathname === "/admin-v2/discount-codes" ||
      pathname === "/admin-v2/discount-codes/" ||
      pathname === "/admin-v2/discount-codes.html"
    ) {
      return serveFile(res, path.join(publicDir, "admin-v2", "discount-codes.html"), req.method);
    }

    if (
      pathname === "/admin-v2/inventory" ||
      pathname === "/admin-v2/inventory/" ||
      pathname === "/admin-v2/inventory.html"
    ) {
      return serveFile(res, path.join(publicDir, "admin-v2", "inventory.html"), req.method);
    }

    if (
      pathname === "/admin-v2/orders" ||
      pathname === "/admin-v2/orders/" ||
      pathname === "/admin-v2/orders.html"
    ) {
      return serveFile(res, path.join(publicDir, "admin-v2", "orders.html"), req.method);
    }

    if (
      pathname === "/admin-v2/manual-order" ||
      pathname === "/admin-v2/manual-order/" ||
      pathname === "/admin-v2/manual-order.html"
    ) {
      return serveFile(res, path.join(publicDir, "admin-v2", "manual-order.html"), req.method);
    }

    if (
      pathname === "/admin-v2/walk-in-order" ||
      pathname === "/admin-v2/walk-in-order/" ||
      pathname === "/admin-v2/walk-in-order.html"
    ) {
      return serveFile(res, path.join(publicDir, "admin-v2", "walk-in-order.html"), req.method);
    }

    if (pathname === "/admin-v2.5" || pathname === "/admin-v2.5/") {
      return serveFile(res, path.join(publicDir, "admin-v2.5", "index.html"), req.method);
    }

    if (pathname.startsWith("/admin-v2.5/")) {
      const requestedAsset = safeJoin(publicDir, pathname.replace(/^\//, ""));
      if (requestedAsset && path.extname(pathname)) {
        return serveFile(res, requestedAsset, req.method);
      }
      return serveFile(res, path.join(publicDir, "admin-v2.5", "index.html"), req.method);
    }

    if (pathname === "/" || pathname === "/index.html") {
      return serveFile(res, path.join(publicDir, "index.html"), req.method);
    }

    if (pathname === "/product.html") {
      return serveFile(res, path.join(publicDir, "product.html"), req.method);
    }

    if (pathname === "/cart.html") {
      return serveFile(res, path.join(publicDir, "cart.html"), req.method);
    }

    if (pathname === "/checkout.html") {
      return serveFile(res, path.join(publicDir, "checkout.html"), req.method);
    }

    if (pathname.startsWith("/css/")) {
      const filePath = safeJoin(publicDir, pathname.replace("/css/", "css/"));
      return filePath
        ? serveFile(res, filePath, req.method)
        : sendJson(res, 403, { error: "Forbidden." });
    }

    if (pathname.startsWith("/js/")) {
      const filePath = safeJoin(publicDir, pathname.replace("/js/", "js/"));
      return filePath
        ? serveFile(res, filePath, req.method)
        : sendJson(res, 403, { error: "Forbidden." });
    }

    if (pathname.startsWith("/img/")) {
      const filePath = safeJoin(imageDir, pathname.replace("/img/", ""));
      return filePath
        ? serveFile(res, filePath, req.method)
        : sendJson(res, 403, { error: "Forbidden." });
    }

    if (pathname.startsWith("/font/")) {
      const filePath = safeJoin(publicDir, pathname.replace("/font/", "font/"));
      return filePath
        ? serveFile(res, filePath, req.method)
        : sendJson(res, 403, { error: "Forbidden." });
    }

    return sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    console.error(error);

    if (error.statusCode) {
      return sendJson(res, error.statusCode, { error: error.message });
    }

    return sendJson(res, 500, { error: "Internal server error." });
  }
});

server.listen(port, () => {
  console.log(`SAI Goods Store running at http://localhost:${port}`);
});

function safeJoin(root, requestPath) {
  const normalized = path.normalize(decodeURIComponent(requestPath)).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(root, normalized);

  if (!filePath.startsWith(root)) {
    return null;
  }

  return filePath;
}

async function serveFile(res, filePath, method) {
  try {
    await access(filePath);
    const fileStats = await stat(filePath);

    if (!fileStats.isFile()) {
      return sendJson(res, 404, { error: "Not found." });
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });

    if (method === "HEAD") {
      return res.end();
    }

    createReadStream(filePath).pipe(res);
  } catch {
    return sendJson(res, 404, { error: "Not found." });
  }
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  return readJsonBodyWithLimit(req, 128_000);
}

async function readJsonBodyWithLimit(req, maxBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("Request body too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");

  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    const error = new Error("Invalid JSON body.");
    error.statusCode = 400;
    throw error;
  }
}
