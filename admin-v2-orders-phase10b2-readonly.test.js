import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isManualOrder,
  isOrderCancelled,
  isOrderShipped,
  isPaymentPaid,
  isWalkInOrder,
  manualFulfillmentRecordComplete,
  orderLabelPurchased,
} from "./public/js/admin-fulfillment-workflow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RELEASED_V2_ROUTES = [
  "/admin-v2/summary",
  "/admin-v2/orders",
  "/admin-v2/walk-in-order",
  "/admin-v2/inventory",
  "/admin-v2/discount-codes",
  "/admin-v2/tax",
  "/admin-v2/nexus",
];

const PRIVATE_SECRET_MARKERS = [
  "INTERNAL_REPORTS_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SQUARE_ACCESS_TOKEN",
  "SHIPPO_API_TOKEN",
  "RESEND_API_KEY",
];

const EXPECTED_ORDER_POSTS = [
  "/api/admin-order-ship-from-display",
  "/api/admin-order-fulfillment-doc-links",
  "/api/admin-order-update-shipping-address",
  "/api/admin-order-fulfillment-addresses",
  "/api/admin-order-external-fulfillment-save",
  "/api/admin-order-fulfillment-handoff",
  "/api/admin-order-packing-slip-html",
  "/api/admin-order-buyer-shipping-notify",
  "/api/admin-order-shippo-sync",
  "/api/admin-order-shippo-refresh-status",
  "/api/admin-order-shippo-purchase-label",
  "/api/admin-order-shippo-buy-all-labels",
  "/api/admin-order-shippo-shipment-date",
  "/api/admin-manual-order-record-payment",
  "/api/admin-manual-order-send-link",
];

const ABSENT_ORDER_POSTS = [
  "/api/admin-order-shippo-preview",
  "/api/admin-order-parcel-override",
  "/api/admin-order-fulfillment-checkpoint",
];

const MUTATION_UI_MARKERS = [
  "data-od-save-ship-to",
  "data-od-save-ship-from",
  "data-od-clear-ship-from",
  "data-od-set-ship-date",
  "data-od-clear-ship-date",
  "data-od-shippo-sync",
  "data-od-shippo-refresh",
  "data-od-buy-label",
  "data-od-record-external-label",
  "data-od-mark-shipped",
  "data-od-record-payment",
  "data-od-send-payment-link",
  "data-od-buyer-notify",
  "data-od-buy-all-labels",
  "data-od-open-packing-slip",
];

const WORKFLOW_ADDITIVE_EXPORTS = [
  "isWalkInOrder",
  "isManualOrder",
  "isOnlineOrder",
  "isPaymentAwaiting",
  "normalizeSavedShippingAddress",
  "missingShippoAddressFields",
  "computeFulfillmentWorkflow",
];

const WORKFLOW_LEGACY_EXPORTS = [
  "orderLabelPurchased",
  "manualFulfillmentRecordComplete",
  "isOrderCancelled",
  "isPaymentPaid",
  "isOrderShipped",
  "deriveActiveFulfillmentStepIndex",
  "canNavigateToFulfillmentTab",
  "canEditFulfillmentTab",
  "fulfillmentTabDone",
  "fulfillmentVariantForRow",
  "fulfillmentBlockingIssue",
  "fulfillmentNextActionLabel",
  "fulfillmentSummaryTitle",
];

function read(rel) {
  return readFileSync(path.join(__dirname, rel), "utf8");
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error(`timeout fetching ${url}`));
    });
  });
}

async function withLocalServer(fn) {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: process.env.NODE_ENV || "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => {
    stdout += c;
  });
  child.stderr.on("data", (c) => {
    stderr += c;
  });

  try {
    await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (/running at/i.test(stdout)) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (child.exitCode != null) {
          clearInterval(timer);
          reject(new Error(`server exited early (${child.exitCode}): ${stderr || stdout}`));
          return;
        }
        if (Date.now() - startedAt > 8000) {
          clearInterval(timer);
          reject(new Error(`server start timeout. stdout=${stdout} stderr=${stderr}`));
        }
      }, 50);
      child.on("error", (err) => {
        clearInterval(timer);
        reject(err);
      });
    });

    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 2000);
      child.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

/* ------------------------------------------------------------------ A. recovery */

test("Phase 10B-2A Orders HTML and controller exist with expected assets", () => {
  assert.equal(existsSync(path.join(__dirname, "public/admin-v2/orders.html")), true);
  assert.equal(existsSync(path.join(__dirname, "public/js/v2/admin-orders.js")), true);

  const html = read("public/admin-v2/orders.html");
  assert.match(html, /Orders/);
  assert.match(html, /\/css\/v2\/tokens\.css/);
  assert.match(html, /\/css\/v2\/admin-v2\.css/);
  assert.match(html, /\/js\/v2\/admin-orders\.js/);
  assert.match(html, /sg-login/);
  assert.match(html, /sg-root/);
  assert.doesNotMatch(html, /\/admin-v2\/walk-in-order/);

  assert.equal(existsSync(path.join(__dirname, "public/css/v2/tokens.css")), true);
  assert.equal(existsSync(path.join(__dirname, "public/css/v2/admin-v2.css")), true);
  assert.equal(existsSync(path.join(__dirname, "public/js/v2/page-boot.js")), true);
  assert.equal(existsSync(path.join(__dirname, "public/js/admin-shared.js")), true);
  assert.equal(existsSync(path.join(__dirname, "public/js/admin-fulfillment-workflow.js")), true);
});

test("Phase 10B-2A fulfillment-workflow additive exports exist without removing legacy exports", () => {
  const source = read("public/js/admin-fulfillment-workflow.js");
  for (const name of WORKFLOW_LEGACY_EXPORTS) {
    assert.match(source, new RegExp(`export function ${name}\\s*\\(`), name);
  }
  for (const name of WORKFLOW_ADDITIVE_EXPORTS) {
    assert.match(source, new RegExp(`export function ${name}\\s*\\(`), name);
  }
  assert.match(source, /purely additive and does not alter any existing export/);
});

test("Phase 10B-2A Orders controller imports required workflow helpers", () => {
  const source = read("public/js/v2/admin-orders.js");
  for (const name of [
    "computeFulfillmentWorkflow",
    "isManualOrder",
    "isOrderCancelled",
    "isOrderShipped",
    "isPaymentAwaiting",
    "isPaymentPaid",
    "isWalkInOrder",
    "manualFulfillmentRecordComplete",
    "missingShippoAddressFields",
    "normalizeSavedShippingAddress",
    "orderLabelPurchased",
  ]) {
    assert.match(source, new RegExp(`\\b${name}\\b`));
  }
  assert.match(source, /bootAdminV2Page/);
  assert.match(source, /activeNav:\s*"orders"/);
});

/* ------------------------------------------------------------------ B. routes */

test("Phase 10B-2A server.js and vercel.json expose Orders trailing-slash routes", () => {
  const serverSource = read("server.js");
  assert.match(serverSource, /\/admin-v2\/orders/);
  assert.match(serverSource, /admin-v2",\s*"orders\.html"/);
  assert.match(serverSource, /\/admin\/orders/);
  assert.match(serverSource, /admin",\s*"orders\.html"/);

  assert.match(serverSource, /\/admin-v2\/walk-in-order/);

  const vercel = JSON.parse(read("vercel.json"));
  const bySource = new Map((vercel.rewrites || []).map((r) => [r.source, r.destination]));
  assert.equal(bySource.get("/admin-v2/orders"), "/admin-v2/orders.html");
  assert.equal(bySource.get("/admin-v2/orders/"), "/admin-v2/orders.html");
  assert.equal(bySource.get("/admin-v2/summary"), "/admin-v2/summary.html");
  assert.equal(bySource.get("/admin-v2/summary/"), "/admin-v2/summary.html");
  assert.equal(bySource.get("/admin-v2/inventory"), "/admin-v2/inventory.html");
  assert.equal(bySource.get("/admin-v2/inventory/"), "/admin-v2/inventory.html");
  assert.equal(bySource.get("/admin-v2/walk-in-order"), "/admin-v2/walk-in-order.html");
  assert.equal(bySource.get("/admin-v2/walk-in-order/"), "/admin-v2/walk-in-order.html");
  assert.equal(bySource.get("/admin/orders"), "/admin/orders.html");
});

test("Phase 10B-2A Orders and Walk-in HTML shells stay wired", () => {
  const ordersHtml = read("public/admin-v2/orders.html");
  assert.match(ordersHtml, /<!doctype html>/i);
  assert.match(ordersHtml, /sg-body--orders/);
  assert.match(ordersHtml, /manage orders/i);
  assert.match(ordersHtml, /\/js\/v2\/admin-orders\.js/);
  assert.match(ordersHtml, /sg-login/);

  const walkInHtml = read("public/admin-v2/walk-in-order.html");
  assert.match(walkInHtml, /admin-walk-in-order\.js/);

  const legacyHtml = read("public/admin/orders.html");
  assert.match(legacyHtml, /<!doctype html>/i);
});

/* ------------------------------------------------------------------ C. navigation */

test("Phase 10B-2A navigation includes Orders and the combined Order Builder", () => {
  const ui = read("public/js/v2/ui.js");
  assert.match(ui, /id:\s*"orders"/);
  assert.match(ui, /href:\s*"\/admin-v2\/orders"/);
  assert.match(ui, /id:\s*"order-builder"/);
  assert.match(ui, /label:\s*"Order Builder"/);
  assert.match(ui, /href:\s*"\/admin-v2\/manual-order"/);
  assert.match(ui, /iconName:\s*"clipboard-list"/);
  assert.doesNotMatch(ui, /id:\s*"manual-order"/);
  assert.doesNotMatch(ui, /id:\s*"walk-in-order"/);
  assert.match(ui, /href:\s*"\/admin-v2\/summary"/);
  assert.match(ui, /href:\s*"\/admin-v2\/inventory"/);
  assert.match(ui, /href:\s*"\/admin-v2\/discount-codes"/);
  assert.match(ui, /href:\s*"\/admin-v2\/tax"/);
  assert.match(ui, /href:\s*"\/admin-v2\/nexus"/);
  assert.match(ui, /href="\/admin\/summary\.html"/);
  assert.match(ui, /Legacy admin/);

  const summary = read("public/js/v2/admin-summary.js");
  assert.match(summary, /href="\/admin-v2\/orders"/);
  assert.doesNotMatch(summary, /href="\/admin\/orders\.html"/);
});

/* ---------------------------------------------------------- D. runtime boundary */

test("Phase 10B-2A Orders controller uses authenticated report POST helpers for mutations", () => {
  const source = read("public/js/v2/admin-orders.js");
  assert.match(source, /async function postOrderAction\(endpoint, body\)/);
  assert.match(source, /throw new Error\("Sign in again to continue\."\)/);
  assert.match(source, /return fetchReportPost\(endpoint, token, body\)/);
  assert.match(source, /mutateOrderAndRefresh/);
  for (const endpoint of EXPECTED_ORDER_POSTS) {
    assert.match(source, new RegExp(endpoint.replace(/\//g, "\\/")));
  }
});
test("Phase 10B-2A controller uses only SELECT for Supabase and allowlisted POSTs", () => {
  const source = read("public/js/v2/admin-orders.js");

  assert.match(source, /from\("orders"\)\.select\("\*"\)/);
  assert.match(source, /from\("order_shippo_labels"\)\s*\n\s*\.select\("\*"\)/);
  assert.doesNotMatch(source, /\.insert\s*\(/);
  assert.doesNotMatch(source, /\.update\s*\(/);
  assert.doesNotMatch(source, /\.upsert\s*\(/);
  assert.doesNotMatch(source, /\.delete\s*\(/);
  assert.doesNotMatch(source, /\.rpc\s*\(/);

  assert.match(source, /\/api\/products/);
  for (const endpoint of EXPECTED_ORDER_POSTS) {
    assert.match(source, new RegExp(endpoint.replace(/\//g, "\\/")));
  }
  for (const endpoint of ABSENT_ORDER_POSTS) {
    assert.equal(source.includes(endpoint), false, `forbidden endpoint present: ${endpoint}`);
  }
  assert.match(source, /fetchReportPost\s*\(/);
  assert.doesNotMatch(source, /READ_ONLY_ORDER_POST_ENDPOINTS/);
});

test("Phase 10B-2A page open / drawer / refresh paths bind writable order controls", () => {
  const source = read("public/js/v2/admin-orders.js");
  for (const marker of MUTATION_UI_MARKERS) {
    assert.equal(source.includes(marker), true, marker);
  }
  assert.doesNotMatch(source, /window\.[A-Za-z0-9_]*\s*=/);
  assert.match(source, /bindDrawerActions/);
  assert.match(source, /setDrawerCloseGuard/);
  assert.match(source, /customSelect\(/);
  assert.match(source, /onRefresh:\s*\(\)\s*=>\s*loadOrders\(\)/);
  assert.match(source, /hydrateDrawerHelpers/);
  assert.match(source, /reloadOrdersAndReopen/);
});

/* ---------------------------------------------------------- E. mutation UI absence */

test("Phase 10B-2A rendered copy presents mutation primary actions", () => {
  const source = read("public/js/v2/admin-orders.js");
  assert.match(source, /Manage payment status, fulfillment, shipping, and buyer communication/);
  assert.match(source, />Buy all labels</);
  assert.match(source, />Buy selected label</);
  assert.match(source, />Mark as shipped</);
  assert.match(source, />Record payment</);
  assert.match(source, />Send payment link</);
  assert.match(source, />Email buyer</);
  assert.match(source, />Sync to Shippo</);
  assert.match(source, />Save label records</);
  assert.doesNotMatch(source, /Orders v2 is currently read-only/);
  assert.doesNotMatch(source, /Open Legacy admin Orders/);
});

/* ------------------------------------------------------------------ F. security */

test("Phase 10B-2A Orders sources contain no private secrets and require boot auth", () => {
  const files = [
    "public/admin-v2/orders.html",
    "public/js/v2/admin-orders.js",
    "public/js/v2/ui.js",
    "public/js/v2/admin-summary.js",
  ];
  for (const file of files) {
    const source = read(file);
    for (const marker of PRIVATE_SECRET_MARKERS) {
      assert.equal(source.includes(marker), false, `${file} must not contain ${marker}`);
    }
  }

  const controller = read("public/js/v2/admin-orders.js");
  assert.match(controller, /bootAdminV2Page/);
  assert.match(controller, /Not signed in/);
  assert.match(controller, /getAccessToken|getToken/);
  assert.doesNotMatch(controller, /export (async )?function submit/);
  assert.doesNotMatch(controller, /export (async )?function openBuy/);
  assert.doesNotMatch(controller, /export (async )?function submitBuy/);
  assert.doesNotMatch(controller, /export (async )?function submitMark/);
  assert.doesNotMatch(controller, /export (async )?function submitBuyer/);
});

/* -------------------------------------------------- G. correction harnesses */

/** Mirrors exported fetchOrdersAndLabelsReadOnly (atomic; throws on any labels batch error). */
async function harnessFetchOrdersAndLabelsReadOnly(supabase) {
  const { data, error } = await supabase.from("orders").select("*").order("created_at", { ascending: false });
  if (error) throw new Error(error.message || "Could not load orders.");
  const nextOrders = Array.isArray(data) ? data : [];

  const nextLabels = new Map();
  const ids = nextOrders.map((r) => r.id).filter((id) => id != null && id !== "");
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    const { data: lbls, error: lblErr } = await supabase
      .from("order_shippo_labels")
      .select("*")
      .in("order_id", slice);
    if (lblErr) throw new Error(lblErr.message || "Could not load shipping labels.");
    for (const lab of Array.isArray(lbls) ? lbls : []) {
      const oid = String(lab.order_id);
      if (!nextLabels.has(oid)) nextLabels.set(oid, []);
      nextLabels.get(oid).push(lab);
    }
  }
  for (const arr of nextLabels.values()) {
    arr.sort((a, b) => (Number(a.parcel_index) || 0) - (Number(b.parcel_index) || 0));
  }
  return { orders: nextOrders, labels: nextLabels };
}

function harnessCountPaidNotShippedOrders(orders) {
  let n = 0;
  for (const r of orders || []) {
    if (isOrderCancelled(r)) continue;
    if (!isPaymentPaid(r)) continue;
    if (isOrderShipped(r)) continue;
    n += 1;
  }
  return n;
}

function harnessHasLabelRecord(row, labelsByOrderId = new Map()) {
  if (manualFulfillmentRecordComplete(row) || orderLabelPurchased(row)) return true;
  const labels = labelsByOrderId.get(String(row.id)) || [];
  return labels.some((l) => String(l.status || "") === "purchased");
}

/** Same signal as admin-orders.js / computeFulfillmentWorkflow / shippingSummary. */
function harnessIsPickupOrLocalNoCarrier(row) {
  return row?.shippo_label_required === false;
}

function harnessBuildStepperSteps(row, labelsByOrderId = new Map()) {
  const cancelled = isOrderCancelled(row);
  const paid = isPaymentPaid(row);
  const shipped = isOrderShipped(row);
  let steps;
  if (isWalkInOrder(row)) {
    steps = [
      { label: "Order created", state: "done" },
      { label: "Payment received", state: paid ? "done" : cancelled ? "skip" : "active" },
      { label: "Completed", state: shipped ? "done" : paid && !cancelled ? "active" : "pending" },
    ];
  } else if (harnessIsPickupOrLocalNoCarrier(row)) {
    steps = [
      { label: "Order created", state: "done" },
      { label: "Payment received", state: paid ? "done" : cancelled ? "skip" : "active" },
      {
        label: "Handed off / delivered",
        state: shipped ? "done" : paid && !cancelled ? "active" : "pending",
      },
    ];
  } else {
    const labelDone = harnessHasLabelRecord(row, labelsByOrderId);
    steps = [
      { label: "Order created", state: "done" },
      { label: "Payment received", state: paid ? "done" : cancelled ? "skip" : "active" },
      { label: "Label recorded", state: labelDone ? "done" : paid && !cancelled ? "active" : "pending" },
      { label: "Shipped", state: shipped ? "done" : "pending" },
    ];
  }
  if (cancelled) {
    for (const s of steps) if (s.state !== "done") s.state = "skip";
  }
  return steps;
}

function harnessOrderDrawerMainSectionKeys(row) {
  if (isWalkInOrder(row)) {
    return ["overview", "items", "customer", "docs", "payment"];
  }
  if (harnessIsPickupOrLocalNoCarrier(row)) {
    return ["overview", "items", "customer", "shipTo", "docs", "payment"];
  }
  if (isOrderShipped(row)) {
    return [
      "overview",
      "items",
      "customer",
      "shipTo",
      "shipping",
      "externalLabel",
      "docs",
      "workflow",
      "readiness",
      "payment",
    ];
  }
  return [
    "overview",
    "items",
    "customer",
    "shipTo",
    "shipFrom",
    "plannedDate",
    "readiness",
    "workflow",
    "availableRates",
    "shipping",
    "externalLabel",
    "docs",
    "payment",
  ];
}

function makeFakeSupabase({ ordersResult, labelsResults }) {
  let labelsCall = 0;
  return {
    from(table) {
      if (table === "orders") {
        return {
          select() {
            return {
              order() {
                return Promise.resolve(ordersResult);
              },
            };
          },
        };
      }
      if (table === "order_shippo_labels") {
        return {
          select() {
            return {
              in() {
                const result = labelsResults[labelsCall] ?? { data: [], error: null };
                labelsCall += 1;
                return Promise.resolve(result);
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

/** Simulates loadOrders commit/preserve rules without DOM. */
async function harnessLoadOrdersCycle({
  supabase,
  alreadyLoaded,
  priorOrders,
  priorLabels,
}) {
  let ordersCache = priorOrders;
  let labelsCache = priorLabels;
  let pageReplacedWithError = false;
  let toastMessage = null;
  let refreshWarn = false;
  let rendered = false;

  try {
    const { orders: nextOrders, labels: nextLabels } = await harnessFetchOrdersAndLabelsReadOnly(supabase);
    ordersCache = nextOrders;
    labelsCache = nextLabels;
    rendered = true;
  } catch (error) {
    const message = error?.message || "Could not load orders.";
    if (!alreadyLoaded) {
      pageReplacedWithError = true;
      toastMessage = message;
    } else {
      toastMessage = message;
      refreshWarn = true;
    }
  }

  return {
    ordersCache,
    labelsCache,
    pageReplacedWithError,
    toastMessage,
    refreshWarn,
    rendered,
  };
}

test("Phase 10B-2A atomic labels failure does not commit partial caches", async () => {
  const source = read("public/js/v2/admin-orders.js");
  assert.match(source, /export async function fetchOrdersAndLabelsReadOnly/);
  assert.match(source, /if \(lblErr\) throw new Error/);
  assert.match(source, /ordersCache = nextOrders/);
  assert.match(source, /labelsCache = nextLabels/);
  assert.doesNotMatch(source, /if \(lblErr\) break/);

  const priorOrders = [{ id: 1, order_ref: "OLD" }];
  const priorLabels = new Map([["1", [{ order_id: 1, parcel_index: 0 }]]]);

  // 101 ids → two label batches of 100 + 1; second batch fails after first populated temp map.
  const manyOrders = Array.from({ length: 101 }, (_, i) => ({ id: i + 1 }));
  const failingSupabase = () =>
    makeFakeSupabase({
      ordersResult: { data: manyOrders, error: null },
      labelsResults: [
        { data: [{ order_id: 1, parcel_index: 0 }], error: null },
        { data: null, error: { message: "labels batch failed" } },
      ],
    });

  await assert.rejects(() => harnessFetchOrdersAndLabelsReadOnly(failingSupabase()), /labels batch failed/);

  const cycle = await harnessLoadOrdersCycle({
    supabase: failingSupabase(),
    alreadyLoaded: true,
    priorOrders,
    priorLabels,
  });

  assert.equal(cycle.ordersCache, priorOrders);
  assert.equal(cycle.labelsCache, priorLabels);
  assert.equal(cycle.rendered, false);
  assert.equal(cycle.pageReplacedWithError, false);
  assert.match(cycle.toastMessage, /labels batch failed/);
  assert.equal(cycle.refreshWarn, true);
});

test("Phase 10B-2A successful full read commits orders and labels together", async () => {
  const supabase = makeFakeSupabase({
    ordersResult: {
      data: [
        { id: 10, order_ref: "A" },
        { id: 11, order_ref: "B" },
      ],
      error: null,
    },
    labelsResults: [
      {
        data: [
          { order_id: 10, parcel_index: 1 },
          { order_id: 10, parcel_index: 0 },
          { order_id: 11, parcel_index: 0 },
        ],
        error: null,
      },
    ],
  });

  const { orders, labels } = await harnessFetchOrdersAndLabelsReadOnly(supabase);
  assert.equal(orders.length, 2);
  assert.deepEqual(
    labels.get("10").map((l) => l.parcel_index),
    [0, 1],
  );
  assert.equal(labels.get("11").length, 1);

  const cycle = await harnessLoadOrdersCycle({
    supabase: makeFakeSupabase({
      ordersResult: {
        data: [
          { id: 10, order_ref: "A" },
          { id: 11, order_ref: "B" },
        ],
        error: null,
      },
      labelsResults: [{ data: [{ order_id: 10, parcel_index: 0 }], error: null }],
    }),
    alreadyLoaded: false,
    priorOrders: [],
    priorLabels: new Map(),
  });
  assert.equal(cycle.rendered, true);
  assert.equal(cycle.ordersCache.length, 2);
  assert.equal(cycle.labelsCache.get("10").length, 1);
  assert.equal(cycle.pageReplacedWithError, false);
});

test("Phase 10B-2A failed initial load is visibly reported without committing", async () => {
  const cycle = await harnessLoadOrdersCycle({
    supabase: makeFakeSupabase({
      ordersResult: { data: null, error: { message: "orders down" } },
      labelsResults: [],
    }),
    alreadyLoaded: false,
    priorOrders: [],
    priorLabels: new Map(),
  });
  assert.equal(cycle.pageReplacedWithError, true);
  assert.match(cycle.toastMessage, /orders down/);
  assert.equal(cycle.ordersCache.length, 0);
  assert.equal(cycle.labelsCache.size, 0);
  assert.equal(cycle.rendered, false);

  const source = read("public/js/v2/admin-orders.js");
  assert.match(source, /page\.innerHTML = `<div class="sg-error"/);
  assert.match(source, /alreadyLoaded/);
  assert.match(source, /Showing previously loaded orders/);
});

test("Phase 10B-2A shipped external-fulfillment drawer includes External label section", () => {
  const source = read("public/js/v2/admin-orders.js");
  assert.match(source, /export function orderDrawerMainSectionKeys/);
  assert.match(source, /externalLabelSectionHtml\(row\)/);

  const shippedExternal = {
    id: 9,
    order_source: "web",
    status: "paid",
    order_status: "shipped",
    admin_handoff_at: "2026-07-01T00:00:00Z",
    admin_external_carrier: "UPS",
    admin_external_tracking_number: "1Z999\n1Z888",
    admin_external_shipped_date: "2026-07-01",
    admin_external_label_cost_cents: 1250,
    admin_external_label_storage_path: "a.pdf\nb.pdf",
  };
  const keys = harnessOrderDrawerMainSectionKeys(shippedExternal);
  assert.ok(keys.includes("externalLabel"));
  assert.ok(keys.includes("shipping"));
  assert.equal(isWalkInOrder(shippedExternal), false);
  assert.equal(isOrderShipped(shippedExternal), true);

  // Display helpers render carrier + tracking when present.
  assert.match(source, /admin_external_carrier/);
  assert.match(source, /admin_external_tracking_number/);
  assert.match(source, /External label record/);
  assert.match(source, /No external\/manual label record yet/);
});

test("Phase 10B-2A walk-in stepper has no Label recorded step and correct states", () => {
  const source = read("public/js/v2/admin-orders.js");
  assert.match(source, /export function buildStepperSteps/);
  assert.match(source, /label: "Completed"/);

  const unpaid = { order_type: "walk_in", order_source: "walk_in", status: "pending", order_status: "draft" };
  const paidOpen = {
    order_type: "walk_in",
    order_source: "walk_in",
    status: "paid",
    order_status: "paid",
  };
  const completed = {
    order_type: "walk_in",
    order_source: "walk_in",
    status: "paid",
    order_status: "shipped",
    admin_handoff_at: "2026-07-01T00:00:00Z",
  };
  const cancelled = {
    order_type: "walk_in",
    order_source: "walk_in",
    status: "pending",
    order_status: "cancelled",
  };

  for (const row of [unpaid, paidOpen, completed, cancelled]) {
    const steps = harnessBuildStepperSteps(row);
    assert.deepEqual(
      steps.map((s) => s.label),
      ["Order created", "Payment received", "Completed"],
    );
    assert.equal(steps.some((s) => s.label === "Label recorded"), false);
  }

  assert.equal(harnessBuildStepperSteps(unpaid)[1].state, "active");
  assert.equal(harnessBuildStepperSteps(unpaid)[2].state, "pending");
  assert.equal(harnessBuildStepperSteps(paidOpen)[1].state, "done");
  assert.equal(harnessBuildStepperSteps(paidOpen)[2].state, "active");
  assert.equal(harnessBuildStepperSteps(completed)[2].state, "done");
  assert.equal(harnessBuildStepperSteps(cancelled)[1].state, "skip");
  assert.equal(harnessBuildStepperSteps(cancelled)[2].state, "skip");
});

test("Phase 10B-2A non-walk-in stepper retains Label recorded step", () => {
  const web = { order_source: "web", status: "paid", order_status: "ready_to_ship" };
  const steps = harnessBuildStepperSteps(web);
  assert.ok(steps.some((s) => s.label === "Label recorded"));
  assert.deepEqual(
    steps.map((s) => s.label),
    ["Order created", "Payment received", "Label recorded", "Shipped"],
  );
  assert.equal(isManualOrder(web), false);
});

test("Phase 10B-2A pickup/local stepper omits Label recorded and uses Handed off / delivered", () => {
  const source = read("public/js/v2/admin-orders.js");
  assert.match(source, /shippo_label_required === false/);
  assert.match(source, /label: "Handed off \/ delivered"/);
  assert.match(source, /isPickupOrLocalNoCarrier/);

  const unpaid = {
    id: 101,
    order_source: "manual",
    fulfillment_method: "pickup",
    shippo_label_required: false,
    status: "pending",
    order_status: "awaiting_payment",
  };
  const paidOpen = {
    id: 102,
    order_source: "manual",
    fulfillment_method: "local_delivery",
    shippo_label_required: false,
    status: "paid",
    order_status: "ready_for_local_delivery",
  };
  const completed = {
    id: 103,
    order_source: "manual",
    fulfillment_method: "pickup",
    shippo_label_required: false,
    status: "paid",
    order_status: "shipped",
    admin_handoff_at: "2026-07-01T00:00:00Z",
  };
  const cancelled = {
    id: 104,
    order_source: "manual",
    fulfillment_method: "pickup",
    shippo_label_required: false,
    status: "pending",
    order_status: "cancelled",
  };

  for (const row of [unpaid, paidOpen, completed, cancelled]) {
    const steps = harnessBuildStepperSteps(row);
    assert.deepEqual(
      steps.map((s) => s.label),
      ["Order created", "Payment received", "Handed off / delivered"],
    );
    assert.equal(steps.some((s) => s.label === "Label recorded"), false);
  }

  assert.equal(harnessBuildStepperSteps(unpaid)[1].state, "active");
  assert.equal(harnessBuildStepperSteps(unpaid)[2].state, "pending");
  assert.equal(harnessBuildStepperSteps(paidOpen)[1].state, "done");
  assert.equal(harnessBuildStepperSteps(paidOpen)[2].state, "active");
  assert.equal(harnessBuildStepperSteps(completed)[2].state, "done");
  assert.equal(harnessBuildStepperSteps(cancelled)[1].state, "skip");
  assert.equal(harnessBuildStepperSteps(cancelled)[2].state, "skip");
});

test("Phase 10B-2A pickup/local drawer omits carrier-only sections", () => {
  const source = read("public/js/v2/admin-orders.js");
  assert.match(source, /isPickupOrLocalNoCarrier\(row\)/);
  assert.match(source, /Skip ship-from when the drawer has no ship-from target/);

  const carrierOnly = [
    "shipFrom",
    "plannedDate",
    "readiness",
    "workflow",
    "availableRates",
    "shipping",
    "externalLabel",
  ];

  const pickupUnshipped = {
    id: 201,
    order_source: "manual",
    fulfillment_method: "pickup",
    shippo_label_required: false,
    status: "paid",
    order_status: "ready_for_pickup",
  };
  const localShipped = {
    id: 202,
    order_source: "manual",
    fulfillment_method: "local_delivery",
    shippo_label_required: false,
    status: "paid",
    order_status: "shipped",
    admin_handoff_at: "2026-07-01T00:00:00Z",
  };

  for (const row of [pickupUnshipped, localShipped]) {
    const keys = harnessOrderDrawerMainSectionKeys(row);
    assert.deepEqual(keys, ["overview", "items", "customer", "shipTo", "docs", "payment"]);
    for (const k of carrierOnly) {
      assert.equal(keys.includes(k), false, k);
    }
  }

  // Carrier contracts unchanged.
  const carrierUnshipped = {
    id: 301,
    order_source: "web",
    status: "paid",
    order_status: "ready_to_ship",
  };
  const carrierShipped = {
    id: 302,
    order_source: "web",
    status: "paid",
    order_status: "shipped",
    admin_handoff_at: "2026-07-01T00:00:00Z",
    admin_external_carrier: "UPS",
  };
  assert.deepEqual(harnessOrderDrawerMainSectionKeys(carrierUnshipped), [
    "overview",
    "items",
    "customer",
    "shipTo",
    "shipFrom",
    "plannedDate",
    "readiness",
    "workflow",
    "availableRates",
    "shipping",
    "externalLabel",
    "docs",
    "payment",
  ]);
  assert.deepEqual(harnessOrderDrawerMainSectionKeys(carrierShipped), [
    "overview",
    "items",
    "customer",
    "shipTo",
    "shipping",
    "externalLabel",
    "docs",
    "workflow",
    "readiness",
    "payment",
  ]);

  // Walk-in unchanged.
  const walkIn = { order_type: "walk_in", order_source: "walk_in", status: "paid", order_status: "paid" };
  assert.deepEqual(harnessOrderDrawerMainSectionKeys(walkIn), [
    "overview",
    "items",
    "customer",
    "docs",
    "payment",
  ]);
});

test("Phase 10B-2A Paid · Not Shipped KPI is factual and label-agnostic", () => {
  const source = read("public/js/v2/admin-orders.js");
  assert.match(source, /Paid · Not Shipped/);
  assert.match(source, /export function countPaidNotShippedOrders/);
  assert.doesNotMatch(source, /label: "Ready to Ship"/);
  assert.match(source, /Paid orders still open/);

  const rows = [
    { id: 1, status: "pending", order_status: "awaiting_payment" }, // unpaid
    { id: 2, status: "paid", order_status: "ready_to_ship" }, // count
    { id: 3, status: "paid", order_status: "need_label_records" }, // count (even if workflow says need labels)
    {
      id: 4,
      status: "paid",
      order_status: "shipped",
      admin_handoff_at: "2026-07-01T00:00:00Z",
    }, // shipped
    { id: 5, status: "paid", order_status: "cancelled" }, // cancelled
    { id: 6, status: "paid", order_status: "partial_label_purchase" }, // count
  ];
  assert.equal(harnessCountPaidNotShippedOrders(rows), 3);

  // Package-label completeness must not affect the KPI.
  const withPackages = [
    {
      id: 7,
      status: "paid",
      order_status: "label_purchased",
      shippo_label_url: "https://example/label.pdf",
      shippo_transaction_status: "SUCCESS",
    },
  ];
  assert.equal(harnessCountPaidNotShippedOrders(withPackages), 1);
  assert.equal(orderLabelPurchased(withPackages[0]), true);
});

test("Phase 10B-2A writable Orders still avoids direct client-side Supabase mutations", () => {
  const source = read("public/js/v2/admin-orders.js");
  for (const endpoint of EXPECTED_ORDER_POSTS) {
    assert.equal(source.includes(endpoint), true, endpoint);
  }
  for (const endpoint of ABSENT_ORDER_POSTS) {
    assert.equal(source.includes(endpoint), false, endpoint);
  }
  assert.doesNotMatch(source, /\.insert\s*\(/);
  assert.doesNotMatch(source, /\.update\s*\(/);
  assert.doesNotMatch(source, /\.upsert\s*\(/);
  assert.doesNotMatch(source, /\.delete\s*\(/);
  assert.doesNotMatch(source, /\.rpc\s*\(/);
  assert.match(source, /postOrderAction/);
  assert.match(source, /mutateOrderAndRefresh/);
  assert.match(source, /fetchReportPost/);
});
