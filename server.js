import { createReadStream, readFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enrichCartQuoteApiResponse } from "./lib/cart-api-response.js";
import { fetchNexusSummaryRows, fetchTaxSummaryTnRows } from "./lib/orders.js";
import { buildQuote } from "./lib/quote.js";
import { mergeInventoryIntoProduct, mergeInventoryIntoStore } from "./lib/stock.js";
import { assertReportsAuthorized } from "./lib/reports-auth.js";
import adminDiscountCodesHandler from "./api/admin-discount-codes.js";
import adminStockHandler from "./api/admin-stock.js";
import adminInventoryHandler from "./api/admin-inventory.js";
import adminManualOrderCreateHandler from "./api/admin-manual-order-create.js";
import adminManualOrderDeleteDraftHandler from "./api/admin-manual-order-delete-draft.js";
import adminManualOrderDraftsHandler from "./api/admin-manual-order-drafts.js";
import adminManualOrderEstimateHandler from "./api/admin-manual-order-estimate.js";
import adminOrderShippoSyncHandler from "./api/admin-order-shippo-sync.js";
import adminOrderShippoRefreshStatusHandler from "./api/admin-order-shippo-refresh-status.js";
import adminOrderShippoPreviewHandler from "./api/admin-order-shippo-preview.js";
import adminOrderShippoShipmentHandler from "./api/admin-order-shippo-shipment.js";
import adminOrderShippoPurchaseLabelHandler from "./api/admin-order-shippo-purchase-label.js";
import adminOrderParcelOverrideHandler from "./api/admin-order-parcel-override.js";
import adminOrderShippoShipmentDateHandler from "./api/admin-order-shippo-shipment-date.js";
import adminOrderUpdateShippingAddressHandler from "./api/admin-order-update-shipping-address.js";
import adminOrderFulfillmentCheckpointHandler from "./api/admin-order-fulfillment-checkpoint.js";
import adminOrderFulfillmentHandoffHandler from "./api/admin-order-fulfillment-handoff.js";
import adminOrderFulfillmentAddressesHandler from "./api/admin-order-fulfillment-addresses.js";
import adminOrderPackingSlipHtmlHandler from "./api/admin-order-packing-slip-html.js";
import adminOrderBuyerShippingNotifyHandler from "./api/admin-order-buyer-shipping-notify.js";
import adminOrderShipFromDisplayHandler from "./api/admin-order-ship-from-display.js";
import adminOrderExternalFulfillmentSaveHandler from "./api/admin-order-external-fulfillment-save.js";
import adminOrderFulfillmentDocLinksHandler from "./api/admin-order-fulfillment-doc-links.js";
import adminSummaryHandler from "./api/admin-summary.js";
import adminManualOrderSendLinkHandler from "./api/admin-manual-order-send-link.js";
import adminManualOrderUpdateDraftHandler from "./api/admin-manual-order-update-draft.js";
import adminWalkInOrderCreateHandler from "./api/admin-walk-in-order-create.js";
import adminWalkInOrderDeleteDraftHandler from "./api/admin-walk-in-order-delete-draft.js";
import adminWalkInOrderDraftsHandler from "./api/admin-walk-in-order-drafts.js";
import adminWalkInOrderEstimateHandler from "./api/admin-walk-in-order-estimate.js";
import adminWalkInOrderMarkPaidHandler from "./api/admin-walk-in-order-mark-paid.js";
import adminWalkInOrderUpdateDraftHandler from "./api/admin-walk-in-order-update-draft.js";
import checkoutEstimateHandler from "./api/checkout-estimate.js";
import checkoutPayHandler from "./api/checkout-pay.js";
import shippoWebhookHandler from "./api/webhooks/shippo.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadDotEnv();

const storeJsonPath = path.join(__dirname, "data", "store.json");

function readStoreData() {
  return JSON.parse(readFileSync(storeJsonPath, "utf8"));
}

const storeData = readStoreData();

const productMap = new Map(storeData.products.map((product) => [product.slug, product]));
const knownSizes = storeData.site.sizes;
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");
const imageDir = path.join(__dirname, "public", "img");

function adaptExpressStyleResponse(res) {
  let statusCode = 200;
  return {
    status(c) {
      statusCode = c;
      return this;
    },
    json(body) {
      sendJson(res, statusCode, body);
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

    if (pathname === "/api/products" && req.method === "GET") {
      // Always read from disk so site metadata (phone, address, etc.) updates without restarting Node.
      return sendJson(res, 200, await mergeInventoryIntoStore(readStoreData()));
    }

    if (pathname.startsWith("/api/products/") && req.method === "GET") {
      const slug = pathname.replace("/api/products/", "");
      const fresh = readStoreData();
      const product = fresh.products.find((p) => p.slug === slug);

      if (!product) {
        return sendJson(res, 404, { error: "Product not found." });
      }

      return sendJson(res, 200, await mergeInventoryIntoProduct(product));
    }

    if (pathname === "/api/cart/quote" && req.method === "POST") {
      const body = await readJsonBody(req);
      const quote = buildQuote(body.items, { omitShippingEstimate: true });
      return sendJson(res, 200, enrichCartQuoteApiResponse(quote));
    }

    if (pathname === "/api/square-config" && req.method === "GET") {
      const squareApplicationId = process.env.SQUARE_APPLICATION_ID?.trim() || null;
      const squareLocationId = process.env.SQUARE_LOCATION_ID?.trim() || null;

      if (!squareApplicationId || !squareLocationId) {
        return sendJson(res, 503, {
          error: "Embedded checkout is not configured.",
          squareApplicationId: null,
          squareLocationId: null,
        });
      }

      return sendJson(res, 200, {
        squareApplicationId,
        squareLocationId,
      });
    }

    if (pathname === "/api/nexus-summary" && req.method === "GET") {
      try {
        await assertReportsAuthorized(req);
        const summary = await fetchNexusSummaryRows();
        return sendJson(res, 200, {
          generated_at: new Date().toISOString(),
          currency: "USD",
          amounts_in: "cents",
          summary,
        });
      } catch (error) {
        console.error(error);
        return sendJson(res, error.statusCode || 500, {
          error: error.message || "Could not load nexus summary.",
        });
      }
    }

    if (pathname === "/api/tax-summary" && req.method === "GET") {
      try {
        await assertReportsAuthorized(req);
        const summary = await fetchTaxSummaryTnRows();
        return sendJson(res, 200, {
          generated_at: new Date().toISOString(),
          currency: "USD",
          amounts_in: "cents",
          note: "Tennessee (TN) paid orders only; months are UTC.",
          summary,
        });
      } catch (error) {
        console.error(error);
        return sendJson(res, error.statusCode || 500, {
          error: error.message || "Could not load tax summary.",
        });
      }
    }

    if (pathname === "/api/checkout-estimate" && req.method === "POST") {
      const body = await readJsonBody(req);
      await checkoutEstimateHandler(
        { method: "POST", body },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (pathname === "/api/checkout-pay" && req.method === "POST") {
      const body = await readJsonBody(req);
      await checkoutPayHandler({ method: "POST", body }, adaptExpressStyleResponse(res));
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

    if (pathname === "/api/checkout" && req.method === "POST") {
      const body = await readJsonBody(req);
      const quote = buildQuote(body.items, { omitShippingEstimate: true });

      if (!quote.items.length) {
        return sendJson(res, 400, { error: "Your cart is empty." });
      }

      if (!process.env.STRIPE_SECRET_KEY) {
        return sendJson(res, 503, {
          error:
            "Stripe is not configured yet. Add STRIPE_SECRET_KEY and PUBLIC_BASE_URL to your .env file to enable live checkout.",
          stripeReady: false,
          quote,
        });
      }

      const session = await createCheckoutSession(quote, req);
      return sendJson(res, 200, {
        checkoutUrl: session.url,
        sessionId: session.id,
        quote,
        stripeReady: true,
      });
    }

    if (pathname === "/api/admin-summary" && req.method === "GET") {
      await adminSummaryHandler(
        { method: "GET", headers: req.headers, url: req.url },
        adaptExpressStyleResponse(res),
      );
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "Method not allowed." });
    }

    if (pathname === "/api/supabase-public-config") {
      const supabaseUrl = process.env.SUPABASE_URL?.trim();
      const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim();
      if (!supabaseUrl || !supabaseAnonKey) {
        return sendJson(res, 503, { error: "Supabase public configuration is not set." });
      }
      return sendJson(res, 200, { supabaseUrl, supabaseAnonKey });
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

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");

  try {
    const raw = readFileSync(envPath, "utf8");

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");

      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();

      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional in local development.
  }
}

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

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  let rawBody = "";

  for await (const chunk of req) {
    rawBody += chunk;
  }

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

function getBaseUrl(req) {
  const configuredBaseUrl = process.env.PUBLIC_BASE_URL;

  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/$/, "");
  }

  const host = req.headers.host || `localhost:${port}`;
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = forwardedProto || (host.includes("localhost") ? "http" : "https");

  return `${protocol}://${host}`;
}

async function createCheckoutSession(quote, req) {
  const stripeEndpoint = "https://api.stripe.com/v1/checkout/sessions";
  const baseUrl = getBaseUrl(req);
  const params = new URLSearchParams();

  params.set("mode", "payment");
  params.set("success_url", `${baseUrl}/cart.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  params.set("cancel_url", `${baseUrl}/cart.html?checkout=cancelled`);
  params.set("payment_method_types[0]", "card");
  params.set("billing_address_collection", "required");
  params.set("shipping_address_collection[allowed_countries][0]", "US");
  params.set("phone_number_collection[enabled]", "true");
  params.set("submit_type", "pay");
  params.set("metadata[store]", "saigoods");
  params.set("metadata[total_cases]", String(quote.totalCases));

  let lineIndex = 0;

  for (const item of quote.items) {
    const product = productMap.get(item.slug);
    const selectedSizes = Object.entries(item.quantities).filter(([, quantity]) => quantity > 0);

    for (const [size, quantity] of selectedSizes) {
      params.set(`line_items[${lineIndex}][price_data][currency]`, "usd");
      params.set(`line_items[${lineIndex}][price_data][product_data][name]`, `${item.name} (${size})`);
      params.set(
        `line_items[${lineIndex}][price_data][product_data][description]`,
        `${product.shortName} gloves, ${size} size, priced per case.`,
      );
      params.set(`line_items[${lineIndex}][price_data][unit_amount]`, String(item.priceCents));
      params.set(`line_items[${lineIndex}][quantity]`, String(quantity));
      lineIndex += 1;
    }
  }

  const response = await fetch(stripeEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const session = await response.json();

  if (!response.ok || !session.url) {
    const error = new Error(session.error?.message || "Stripe checkout could not be created.");
    error.statusCode = response.status || 500;
    throw error;
  }

  return session;
}
