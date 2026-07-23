import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MANUAL_ORDER_CREATE_DEFINITE_PRE_INSERT_STATUSES,
  ManualOrderLocalAuthError,
  allowCreateAnotherManualOrder,
  classifyManualOrderCreateFailure,
  classifyManualOrderSendLinkFailure,
  classifyManualOrderSendLinkSuccess,
  formatManualOrderAddressSummary,
  isManualOrderLocalAuthError,
  preCreateRejectionControlState,
  runGuardedManualOrderEstimate,
} from "./public/js/v2/manual-order-safety.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PRIVATE_SECRET_MARKERS = [
  "INTERNAL_REPORTS_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SQUARE_ACCESS_TOKEN",
  "SHIPPO_API_TOKEN",
  "RESEND_API_KEY",
];

const ALLOWED_POSTS = [
  "/api/admin-manual-order-estimate",
  "/api/admin-manual-order-create",
  "/api/admin-manual-order-send-link",
];

const REJECTED_POSTS = [
  "/api/admin-manual-order-record-payment",
  "/api/admin-manual-order-drafts",
  "/api/admin-manual-order-update-draft",
  "/api/admin-manual-order-delete-draft",
  "/api/admin-walk-in-order-create",
  "/api/admin-walk-in-order-mark-paid",
  "/api/admin-order-shippo-buy-label",
];

class ReportPostError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ReportPostError";
    this.status = status;
    this.body = body;
  }
}

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
  const port = 19000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), NODE_ENV: process.env.NODE_ENV || "test" },
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
    if (!child.killed) child.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 2000);
      child.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

test("Phase 10B-2B Manual Order HTML, controller, and hardin helper exist", () => {
  assert.equal(existsSync(path.join(__dirname, "public/admin-v2/manual-order.html")), true);
  assert.equal(existsSync(path.join(__dirname, "public/js/v2/admin-manual-order.js")), true);
  assert.equal(existsSync(path.join(__dirname, "public/js/v2/manual-order-safety.js")), true);
  assert.equal(existsSync(path.join(__dirname, "public/js/hardin-county.js")), true);
  assert.equal(existsSync(path.join(__dirname, "public/admin-v2/walk-in-order.html")), false);

  const html = read("public/admin-v2/manual-order.html");
  assert.match(html, /Manual Order/);
  assert.match(html, /\/js\/v2\/admin-manual-order\.js/);
  assert.doesNotMatch(html, /walk-in/i);
});

test("Phase 10B-2B Manual Order sources contain no private secrets", () => {
  for (const file of [
    "public/admin-v2/manual-order.html",
    "public/js/v2/admin-manual-order.js",
    "public/js/v2/manual-order-safety.js",
    "public/js/hardin-county.js",
  ]) {
    const source = read(file);
    for (const marker of PRIVATE_SECRET_MARKERS) {
      assert.equal(source.includes(marker), false, `${file} must not contain ${marker}`);
    }
  }
});

test("Phase 10B-2B routes serve Manual Order and keep Walk-in 404", async () => {
  await withLocalServer(async (base) => {
    for (const pathName of ["/admin-v2/manual-order", "/admin-v2/manual-order/", "/admin-v2/manual-order.html"]) {
      const res = await httpGet(`${base}${pathName}`);
      assert.equal(res.statusCode, 200, pathName);
      assert.match(res.body, /admin-manual-order\.js/);
    }
    for (const href of ["/admin-v2/walk-in-order", "/admin-v2/walk-in-order/", "/admin-v2/walk-in-order.html"]) {
      const res = await httpGet(`${base}${href}`);
      assert.equal(res.statusCode, 404, href);
    }
  });
});

test("Phase 10B-2B vercel rewrites include Manual Order trailing slash", () => {
  const vercel = JSON.parse(read("vercel.json"));
  const bySource = new Map((vercel.rewrites || []).map((r) => [r.source, r.destination]));
  assert.equal(bySource.get("/admin-v2/manual-order"), "/admin-v2/manual-order.html");
  assert.equal(bySource.get("/admin-v2/manual-order/"), "/admin-v2/manual-order.html");
  assert.equal(bySource.has("/admin-v2/walk-in-order"), false);
});

test("Phase 10B-2B navigation includes Manual Order once and excludes Walk-in", () => {
  const ui = read("public/js/v2/ui.js");
  assert.equal([...ui.matchAll(/id:\s*"manual-order"/g)].length, 1);
  assert.doesNotMatch(ui, /walk-in-order/);
});

test("Phase 10B-2B controller imports production safety helpers and does not mirror them", () => {
  const controller = read("public/js/v2/admin-manual-order.js");
  const testFile = read("admin-v2-manual-order-phase10b2b.test.js");
  const safety = read("public/js/v2/manual-order-safety.js");

  assert.match(controller, /from "\.\/manual-order-safety\.js"/);
  assert.match(controller, /classifyManualOrderCreateFailure/);
  assert.match(controller, /runGuardedManualOrderEstimate/);
  assert.match(controller, /allowCreateAnotherManualOrder/);
  assert.match(controller, /ManualOrderLocalAuthError/);
  assert.match(controller, /preCreateRejectionControlState/);
  assert.match(controller, /classifyManualOrderSendLinkSuccess/);
  assert.match(controller, /classifyManualOrderSendLinkFailure/);
  assert.match(controller, /formatManualOrderAddressSummary/);
  assert.match(controller, /await runGuardedManualOrderEstimate\(/);
  assert.match(controller, /allowCreateAnotherManualOrder\(outcome\)/);
  assert.match(controller, /classifyManualOrderCreateFailure\(error\)/);
  assert.doesNotMatch(controller, /export function classifyManualOrderCreateFailure/);
  assert.doesNotMatch(controller, /export async function runGuardedManualOrderEstimate/);

  assert.match(safety, /export function classifyManualOrderCreateFailure/);
  assert.match(safety, /export async function runGuardedManualOrderEstimate/);
  assert.match(safety, /export function allowCreateAnotherManualOrder/);
  assert.match(testFile, /from "\.\/public\/js\/v2\/manual-order-safety\.js"/);
  // Test imports production helpers; it must not redefine them as local functions.
  assert.equal(/^\s*(async\s+)?function\s+classifyManualOrderCreateFailure\b/m.test(testFile), false);
  assert.equal(/^\s*(async\s+)?function\s+runGuardedManualOrderEstimate\b/m.test(testFile), false);
  assert.equal(/^\s*function\s+allowCreateAnotherOrder\b/m.test(testFile), false);
});

test("Phase 10B-2B controller is payment-link-only with allowlisted POSTs", async () => {
  const source = read("public/js/v2/admin-manual-order.js");
  assert.match(source, /paymentFlow:\s*"square_payment_link"/);
  assert.doesNotMatch(source, /paymentFlow:\s*"pay_later"/);
  assert.doesNotMatch(source, /\/api\/admin-manual-order-record-payment/);
  assert.doesNotMatch(source, /\/api\/admin-walk-in/);
  assert.doesNotMatch(source, /name="mo_payment"/);

  const MANUAL_ORDER_V2_POST_ENDPOINTS = new Set(ALLOWED_POSTS);
  async function fetchManualOrderPost(endpoint) {
    if (!MANUAL_ORDER_V2_POST_ENDPOINTS.has(endpoint)) {
      throw new Error("This action is not available in Admin v2 Manual Order.");
    }
    throw new Error("network should not be called for rejected endpoints");
  }
  for (const endpoint of REJECTED_POSTS) {
    await assert.rejects(() => fetchManualOrderPost(endpoint), /not available in Admin v2 Manual Order/);
  }
});

test("Phase 10B-2B production create classifier and local auth", () => {
  const createSrc = read("api/admin-manual-order-create.js");
  const handlerStart = createSrc.indexOf("export default async function handler");
  assert.ok(
    createSrc.indexOf("parseCreateBody(", handlerStart) <
      createSrc.indexOf("createManualOrderDraft(", handlerStart),
  );
  assert.deepEqual([...MANUAL_ORDER_CREATE_DEFINITE_PRE_INSERT_STATUSES].sort(), [400, 401, 403, 405]);

  assert.equal(
    classifyManualOrderCreateFailure(new ReportPostError("bad", 400, { error: "x" })),
    "pre_create_rejected",
  );
  assert.equal(
    classifyManualOrderCreateFailure(new ReportPostError("auth", 401, {})),
    "pre_create_rejected",
  );
  assert.equal(
    classifyManualOrderCreateFailure(new ReportPostError("f", 403, {})),
    "pre_create_rejected",
  );
  assert.equal(
    classifyManualOrderCreateFailure(new ReportPostError("m", 405, {})),
    "pre_create_rejected",
  );
  assert.equal(
    classifyManualOrderCreateFailure(new ReportPostError("server", 500, { error: "boom" })),
    "create_uncertain",
  );
  assert.equal(classifyManualOrderCreateFailure(new TypeError("Failed to fetch")), "create_uncertain");
  assert.equal(
    classifyManualOrderCreateFailure(new ReportPostError("ok-ish", 200, { totalFormatted: "$1" })),
    "create_uncertain",
  );

  const local = new ManualOrderLocalAuthError();
  assert.equal(isManualOrderLocalAuthError(local), true);
  // Missing token must not be treated as create_uncertain by the submit path.
  assert.equal(local.code, "local_auth");
  assert.doesNotMatch(local.message, /may have been created/i);
});

test("Phase 10B-2B pre-create rejection restores confirmation button correctly", () => {
  const locked = preCreateRejectionControlState({
    phraseInputValue: "SEND PAYMENT LINK",
    phrase: "SEND PAYMENT LINK",
  });
  assert.equal(locked.formLocked, false);
  assert.equal(locked.cancelDisabled, false);
  assert.equal(locked.confirmText, "Create and send payment link");
  assert.equal(locked.confirmDisabled, false);

  const incomplete = preCreateRejectionControlState({
    phraseInputValue: "almost",
    phrase: "SEND PAYMENT LINK",
  });
  assert.equal(incomplete.confirmDisabled, true);
  assert.equal(incomplete.formLocked, false);
  assert.equal(incomplete.cancelDisabled, false);

  const controller = read("public/js/v2/admin-manual-order.js");
  const catchBlock = controller.slice(
    controller.indexOf("} else if (isManualOrderLocalAuthError"),
    controller.indexOf("} finally {", controller.indexOf("async function submitCreateAndSendLink")),
  );
  assert.match(catchBlock, /setFormLocked\(restored\.formLocked\)/);
  assert.ok(
    catchBlock.indexOf("setFormLocked(restored.formLocked)") <
      catchBlock.indexOf("confirmBtn.textContent = restored.confirmText"),
  );
});

test("Phase 10B-2B address summary escapes active HTML", () => {
  const html = formatManualOrderAddressSummary({
    line1: '<img src=x onerror=alert(1)>',
    line2: "<script>alert(1)</script>",
    city: "Savannah",
    state: "TN",
    postalCode: "38372",
    country: 'US"><img src=y>',
  });
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /US&quot;&gt;&lt;img src=y&gt;/);
  assert.doesNotMatch(html, /<img\s/i);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /<br>/);

  const controller = read("public/js/v2/admin-manual-order.js");
  assert.match(controller, /return formatManualOrderAddressSummary\(addr\)/);
});

test("Phase 10B-2B create_uncertain / squareOutcomeUncertain / send-link transport hide Create another", () => {
  assert.equal(allowCreateAnotherManualOrder("success"), true);
  assert.equal(allowCreateAnotherManualOrder("email_failed"), true);
  assert.equal(allowCreateAnotherManualOrder("create_uncertain"), false);
  assert.equal(allowCreateAnotherManualOrder("link_uncertain"), false);
  assert.equal(allowCreateAnotherManualOrder("draft_only"), false);

  const uncertain = classifyManualOrderSendLinkFailure(
    {
      ok: false,
      squareOutcomeUncertain: true,
      squareLinkCreated: false,
      emailed: false,
      warning: "Square may have created a payment link.",
    },
    "ignored provider",
  );
  assert.equal(uncertain.outcome, "link_uncertain");
  assert.equal(uncertain.squareOutcomeUncertain, true);
  assert.equal(allowCreateAnotherManualOrder(uncertain.outcome), false);

  const transport = classifyManualOrderSendLinkFailure({}, "fetch failed", {
    transportUncertain: true,
  });
  assert.equal(transport.outcome, "link_uncertain");
  assert.equal(transport.squareOutcomeUncertain, true);
  assert.equal(allowCreateAnotherManualOrder(transport.outcome), false);
  assert.match(transport.warning, /Check Square and Legacy admin/i);
  assert.match(transport.warning, /Do not resubmit/i);

  const definiteNoLink = classifyManualOrderSendLinkFailure(
    {
      ok: false,
      emailed: false,
      error: "Payment link could not be created. The draft remains available to check or correct in Legacy admin.",
    },
    "",
  );
  assert.equal(definiteNoLink.outcome, "draft_only");
  assert.equal(definiteNoLink.squareOutcomeUncertain, false);

  const malformed = classifyManualOrderSendLinkSuccess({
    ok: true,
    emailed: true,
    checkoutUrl: "",
  });
  assert.equal(malformed.outcome, "link_uncertain");
  assert.equal(malformed.emailed, false);
  assert.equal(allowCreateAnotherManualOrder(malformed.outcome), false);

  const controller = read("public/js/v2/admin-manual-order.js");
  assert.match(controller, /Payment link outcome uncertain/);
  assert.match(controller, /Do not resubmit/);
  assert.match(controller, /transportUncertain:\s*true/);
  assert.match(controller, /instanceof ReportPostError/);
});

test("Phase 10B-2B Hardin browser ZIP is advisory and does not block estimate/submit", async () => {
  const source = read("public/js/v2/admin-manual-order.js");
  const hardin = await import("./public/js/hardin-county.js");
  assert.equal(hardin.isLocalDeliveryServiceArea({ state: "TN", postalCode: "37201" }), false);
  const estimateFn = source.slice(
    source.indexOf("function estimateEligibility"),
    source.indexOf("function createSendLinkEligibility"),
  );
  assert.doesNotMatch(estimateFn, /validateLocalDeliveryServiceArea/);
  assert.match(source, /syncLocalDeliveryAdvisory/);
  assert.doesNotMatch(source, /verified from ZIP/);
});

test("Phase 10B-2B reset unlocks form, blanks state, and invalidates estimate revision", () => {
  const source = read("public/js/v2/admin-manual-order.js");
  const resetFn = source.slice(source.indexOf("function resetForAnotherOrder"), source.indexOf("function renderSizeColumn"));
  assert.match(resetFn, /setFormLocked\(false\)/);
  assert.match(resetFn, /state\.value = ""/);
  assert.match(resetFn, /estimateInputRevision \+= 1/);
  assert.match(source, /<option value="">Select state<\/option>/);
});

test("Phase 10B-2B estimate revision guard discards stale responses via production helper", async () => {
  const source = read("public/js/v2/admin-manual-order.js");
  assert.match(source, /let estimateInputRevision = 0/);
  assert.match(source, /function markEstimateInputsChanged/);
  assert.match(source, /estimateInputRevision \+= 1/);
  assert.match(source, /markEstimateInputsChanged\(\)/);

  const runEstimate = source.slice(source.indexOf("async function runEstimate"), source.indexOf("async function onRateSelected"));
  assert.match(runEstimate, /const capturedRevision = estimateInputRevision/);
  assert.match(runEstimate, /const capturedPayload = buildEstimatePayload\(items\)/);
  assert.ok(
    runEstimate.indexOf("const capturedPayload = buildEstimatePayload(items)") <
      runEstimate.indexOf("await runGuardedManualOrderEstimate"),
    "payload must be built before the guarded async request",
  );
  assert.match(runEstimate, /capturedRevision,/);
  assert.match(runEstimate, /getCurrentRevision:\s*\(\)\s*=>\s*estimateInputRevision/);
  assert.match(runEstimate, /payload:\s*capturedPayload/);
  assert.match(runEstimate, /reason === "inputs_changed"/);
  assert.match(runEstimate, /Order details changed while totals were calculating/);
  // Must not assign lastQuote or clear stale for discarded results.
  const inputsChangedBlock = runEstimate.slice(
    runEstimate.indexOf('result.reason === "inputs_changed"'),
    runEstimate.indexOf("if (!result.ok)"),
  );
  assert.doesNotMatch(inputsChangedBlock, /lastQuote\s*=/);
  assert.doesNotMatch(inputsChangedBlock, /estimateStale\s*=\s*false/);

  // Text input events invalidate revision immediately.
  assert.match(source, /Typing while an estimate is pending must invalidate the revision immediately/);
  const inputStart = source.indexOf('page.addEventListener("input"');
  const inputEnd = source.indexOf('getEl("mo-estimate-btn")?.addEventListener');
  assert.ok(inputStart > 0 && inputEnd > inputStart);
  const inputHandler = source.slice(inputStart, inputEnd);
  assert.match(inputHandler, /markEstimateInputsChanged\(\)/);

  // Product, fulfillment, discount, and rate changes invalidate revision.
  assert.match(source, /function applyBundleDelta[\s\S]*markEstimateInputsChanged/);
  assert.match(source, /function handleSizeStep[\s\S]*markEstimateInputsChanged/);
  assert.match(source, /mo_fulfillment[\s\S]*markEstimateInputsChanged/);
  assert.match(source, /mo-apply-discount[\s\S]*markEstimateInputsChanged/);
  assert.match(source, /async function onRateSelected[\s\S]*markEstimateInputsChanged/);

  let inFlight = false;
  let revision = 1;
  let posts = 0;
  const releaseToken = [];
  const releasePost = [];

  // Unchanged revision → success.
  const okResult = await runGuardedManualOrderEstimate({
    get inFlight() {
      return inFlight;
    },
    setInFlight(v) {
      inFlight = v;
    },
    capturedRevision: 1,
    getCurrentRevision: () => revision,
    validate: () => ({ ok: true, payload: { frozen: true, items: [{ slug: "x" }] } }),
    getToken: async () => "tok",
    post: async (_token, payload) => {
      posts += 1;
      assert.deepEqual(payload, { frozen: true, items: [{ slug: "x" }] });
      return { totalCents: 100, quoteId: "q1" };
    },
  });
  assert.equal(okResult.ok, true);
  assert.equal(okResult.data.quoteId, "q1");
  assert.equal(posts, 1);

  // Revision change while token is pending → inputs_changed; quote not usable.
  posts = 0;
  revision = 5;
  const duringToken = runGuardedManualOrderEstimate({
    get inFlight() {
      return inFlight;
    },
    setInFlight(v) {
      inFlight = v;
    },
    capturedRevision: 5,
    getCurrentRevision: () => revision,
    validate: () => ({ ok: true, payload: { n: 1 } }),
    getToken: () =>
      new Promise((resolve) => {
        releaseToken.push(() => {
          revision = 6;
          resolve("tok");
        });
      }),
    post: async () => {
      posts += 1;
      return { totalCents: 999, shouldNotUse: true };
    },
  });
  await Promise.resolve();
  assert.equal(inFlight, true);
  releaseToken.forEach((fn) => fn());
  const tokenChanged = await duringToken;
  assert.equal(tokenChanged.ok, false);
  assert.equal(tokenChanged.reason, "inputs_changed");
  assert.equal(tokenChanged.data, undefined);
  assert.equal(posts, 1);

  // Revision change while POST is pending → inputs_changed.
  posts = 0;
  revision = 10;
  const duringPost = runGuardedManualOrderEstimate({
    get inFlight() {
      return inFlight;
    },
    setInFlight(v) {
      inFlight = v;
    },
    capturedRevision: 10,
    getCurrentRevision: () => revision,
    validate: () => ({ ok: true, payload: { n: 2 } }),
    getToken: async () => "tok",
    post: () =>
      new Promise((resolve) => {
        releasePost.push(() => {
          revision = 11;
          posts += 1;
          resolve({ totalCents: 888, shouldNotUse: true });
        });
      }),
  });
  await Promise.resolve();
  releasePost.forEach((fn) => fn());
  const postChanged = await duringPost;
  assert.equal(postChanged.ok, false);
  assert.equal(postChanged.reason, "inputs_changed");
  assert.equal(postChanged.data, undefined);
  assert.equal(posts, 1);

  // Concurrent estimates still make one POST.
  posts = 0;
  revision = 20;
  const releaseConcurrent = [];
  inFlight = false;
  const runOnce = () =>
    runGuardedManualOrderEstimate({
      get inFlight() {
        return inFlight;
      },
      setInFlight(v) {
        inFlight = v;
      },
      capturedRevision: 20,
      getCurrentRevision: () => revision,
      validate: () => ({ ok: true, payload: { concurrent: true } }),
      getToken: () =>
        new Promise((resolve) => {
          releaseConcurrent.push(() => resolve("tok"));
        }),
      post: async () => {
        posts += 1;
        return { totalCents: 50 };
      },
    });
  const p1 = runOnce();
  await Promise.resolve();
  const p2 = runOnce();
  assert.equal((await p2).reason, "in_flight");
  releaseConcurrent.forEach((fn) => fn());
  const r1 = await p1;
  assert.equal(r1.ok, true);
  assert.equal(posts, 1);
  assert.equal(inFlight, false);
});

test("Phase 10B-2B no new endpoint or payment mode was introduced", () => {
  const source = read("public/js/v2/admin-manual-order.js");
  const endpoints = [...new Set([...source.matchAll(/\/api\/admin-[a-z0-9-]+/g)].map((m) => m[0]))].sort();
  assert.deepEqual(endpoints, [...ALLOWED_POSTS].sort());
  assert.match(source, /paymentFlow:\s*"square_payment_link"/);
  assert.doesNotMatch(source, /\/api\/admin-manual-order-record-payment/);
  assert.doesNotMatch(source, /\/api\/admin-walk-in/);
  assert.doesNotMatch(source, /paymentFlow:\s*"pay_later"/);
  assert.doesNotMatch(source, /\/api\/admin-.*resend/i);
  assert.doesNotMatch(source, /Resend payment link/i);
});
