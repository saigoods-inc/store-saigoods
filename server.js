import { createReadStream, readFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enrichCartQuoteApiResponse } from "./lib/cart-api-response.js";
import { validateShippingAddressForCheckout } from "./lib/address-validation.js";
import { buildFullCheckoutQuote, formatShippingAddressForOrder } from "./lib/checkout-totals.js";
import { parseCheckoutPayBody, parseEstimateAddressBody } from "./lib/checkout-validation.js";
import {
  createPendingOrder,
  fetchNexusSummaryRows,
  fetchTaxSummaryTnRows,
} from "./lib/orders.js";
import { buildQuote } from "./lib/quote.js";
import { assertReportsAuthorized } from "./lib/reports-auth.js";
import { resolveShippingZip } from "./lib/shipping.js";
import { sendResendOrderConfirmation } from "./lib/resend-order-confirmation.js";
import { createCardPayment } from "./lib/square.js";

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
      return sendJson(res, 200, readStoreData());
    }

    if (pathname.startsWith("/api/products/") && req.method === "GET") {
      const slug = pathname.replace("/api/products/", "");
      const product = productMap.get(slug);

      if (!product) {
        return sendJson(res, 404, { error: "Product not found." });
      }

      return sendJson(res, 200, product);
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
      const items = Array.isArray(body.items) ? body.items : [];

      if (!items.length) {
        return sendJson(res, 400, { error: "Your cart is empty." });
      }

      const parsed = parseEstimateAddressBody(body);
      if (parsed.error) {
        return sendJson(res, 400, { error: parsed.error });
      }

      const quote = await buildFullCheckoutQuote(items, parsed.address);
      const warnings = [];

      if (!parsed.partial) {
        const v = await validateShippingAddressForCheckout(parsed.address);
        if (!v.ok) {
          return sendJson(res, 400, { error: v.error });
        }
        if (v.warning) {
          warnings.push(v.warning);
        }
      }

      return sendJson(res, 200, { ...quote, warnings });
    }

    if (pathname === "/api/checkout-pay" && req.method === "POST") {
      const body = await readJsonBody(req);
      const parsed = parseCheckoutPayBody(body);

      if (parsed.error) {
        return sendJson(res, 400, { error: parsed.error });
      }

      try {
        const addrCheck = await validateShippingAddressForCheckout(parsed.address);
        if (!addrCheck.ok) {
          return sendJson(res, 400, { error: addrCheck.error });
        }

        const quote = await buildFullCheckoutQuote(parsed.items, parsed.address);

        const pending = await createPendingOrder({
          quote,
          customer: {
            name: parsed.name,
            email: parsed.email,
            phone: parsed.phone,
            address: formatShippingAddressForOrder(parsed.address),
            shippingState: parsed.address.state,
          },
        });
        const { paymentId } = await createCardPayment({
          sourceId: parsed.sourceId,
          amountCents: quote.totalCents,
          locationId: process.env.SQUARE_LOCATION_ID?.trim(),
          orderId: pending.id,
          buyerEmail: parsed.email,
          idempotencyKey: `saigoods-pay-${pending.id}`,
        });

        void sendResendOrderConfirmation({
          pending,
          quote,
          customerEmail: parsed.email,
          customerName: parsed.name,
        }).catch((err) => console.error("Resend order confirmation failed:", err));

        return sendJson(res, 200, {
          success: true,
          paymentId,
          orderId: pending.id,
          orderRef: pending.order_ref,
          totalFormatted: quote.totalFormatted,
        });
      } catch (error) {
        console.error(error);

        return sendJson(res, error.statusCode || 500, {
          error: error.message || "Payment could not be completed.",
        });
      }
    }

    if (pathname === "/api/checkout" && req.method === "POST") {
      const body = await readJsonBody(req);
      const shippingZip = resolveShippingZip(body.customer);
      const quote = buildQuote(body.items, { zipCode: shippingZip || undefined });

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

    if (pathname === "/admin/tax" || pathname === "/admin/tax/" || pathname === "/admin/tax.html") {
      return serveFile(res, path.join(publicDir, "admin", "tax.html"), req.method);
    }

    if (pathname === "/admin/nexus" || pathname === "/admin/nexus/" || pathname === "/admin/nexus.html") {
      return serveFile(res, path.join(publicDir, "admin", "nexus.html"), req.method);
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
