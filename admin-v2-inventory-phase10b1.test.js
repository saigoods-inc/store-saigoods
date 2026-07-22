import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PHASE10A_ROUTES = [
  { route: "/admin-v2/summary", script: "/js/v2/admin-summary.js" },
  { route: "/admin-v2/tax", script: "/js/v2/admin-tax.js" },
  { route: "/admin-v2/nexus", script: "/js/v2/admin-nexus.js" },
  { route: "/admin-v2/discount-codes", script: "/js/v2/admin-discount-codes.js" },
];

const UNRELEASED_V2_HREFS = ["/admin-v2/manual-order", "/admin-v2/walk-in-order"];

const PRIVATE_SECRET_MARKERS = [
  "INTERNAL_REPORTS_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SQUARE_ACCESS_TOKEN",
  "SHIPPO_API_TOKEN",
  "RESEND_API_KEY",
];

const SUPPORTED_ACTIONS = [
  "stock_patch",
  "incoming_batch_create",
  "incoming_batch_update",
  "incoming_batch_line_create",
  "incoming_batch_line_update",
  "incoming_batch_line_delete",
  "incoming_batch_receive",
  "channel_commitment_create",
  "channel_commitment_update",
  "channel_commitment_update_status",
  "channel_commitment_delete",
];

const DISABLED_PLACEHOLDER_ACTIONS = [
  "set_threshold",
  "manual_adjust",
  "mark_damaged",
  "toggle_track",
  "incoming_batch_delete",
  "create_shipment",
  "receive_shipment",
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

/* ------------------------------------------------------------------ A. static / routing */

test("Phase 10B-1 inventory HTML and controller exist with expected assets", () => {
  assert.equal(existsSync(path.join(__dirname, "public/admin-v2/inventory.html")), true);
  assert.equal(existsSync(path.join(__dirname, "public/js/v2/admin-inventory.js")), true);

  const html = read("public/admin-v2/inventory.html");
  assert.match(html, /Inventory/);
  assert.match(html, /\/css\/v2\/tokens\.css/);
  assert.match(html, /\/css\/v2\/admin-v2\.css/);
  assert.match(html, /\/js\/v2\/admin-inventory\.js/);
  assert.match(html, /sg-login/);
  assert.match(html, /sg-root/);
});

test("Phase 10B-1 server.js serves inventory and keeps Phase 10A + legacy inventory", () => {
  const serverSource = read("server.js");
  assert.match(serverSource, /\/admin-v2\/inventory/);
  assert.match(serverSource, /admin-v2",\s*"inventory\.html"/);

  for (const page of PHASE10A_ROUTES) {
    assert.match(serverSource, new RegExp(page.route.replace(/\//g, "\\/")));
  }

  assert.match(serverSource, /\/admin\/inventory/);
  assert.match(serverSource, /admin",\s*"inventory\.html"/);

  for (const href of UNRELEASED_V2_HREFS) {
    assert.doesNotMatch(serverSource, new RegExp(href.replace(/\//g, "\\/")));
  }
});

test("Phase 10B-1 vercel.json adds inventory rewrite without removing Phase 10A or legacy", () => {
  const vercel = JSON.parse(read("vercel.json"));
  const bySource = new Map((vercel.rewrites || []).map((r) => [r.source, r.destination]));

  assert.equal(bySource.get("/admin-v2/inventory"), "/admin-v2/inventory.html");
  assert.equal(bySource.get("/admin-v2/summary"), "/admin-v2/summary.html");
  assert.equal(bySource.get("/admin-v2/tax"), "/admin-v2/tax.html");
  assert.equal(bySource.get("/admin-v2/nexus"), "/admin-v2/nexus.html");
  assert.equal(bySource.get("/admin-v2/discount-codes"), "/admin-v2/discount-codes.html");
  assert.equal(bySource.get("/admin/inventory"), "/admin/inventory.html");

  for (const href of UNRELEASED_V2_HREFS) {
    assert.equal(bySource.has(href), false, `unexpected rewrite for ${href}`);
  }
});

test("Phase 10B-1 navigation includes Inventory and excludes unreleased routes", () => {
  const ui = read("public/js/v2/ui.js");
  assert.match(ui, /href:\s*"\/admin-v2\/inventory"/);
  assert.match(ui, /id:\s*"inventory"/);
  assert.match(ui, /href:\s*"\/admin-v2\/summary"/);
  assert.match(ui, /href:\s*"\/admin-v2\/discount-codes"/);
  assert.match(ui, /href:\s*"\/admin-v2\/tax"/);
  assert.match(ui, /href:\s*"\/admin-v2\/nexus"/);
  assert.match(ui, /href="\/admin\/summary\.html"/);
  assert.match(ui, /Legacy admin/);

  for (const href of UNRELEASED_V2_HREFS) {
    assert.doesNotMatch(ui, new RegExp(href.replace(/\//g, "\\/")));
  }
});

test("Phase 10B-1 Summary inventory CTA points at admin-v2 inventory", () => {
  const summary = read("public/js/v2/admin-summary.js");
  assert.match(summary, /href="\/admin-v2\/inventory"/);
  assert.doesNotMatch(summary, /href="\/admin\/inventory\.html"/);
  assert.match(summary, /Review inventory/);
});

test("Phase 10B-1 browser inventory sources contain no private secrets", () => {
  const files = ["public/admin-v2/inventory.html", "public/js/v2/admin-inventory.js", "public/js/v2/ui.js", "public/js/v2/admin-summary.js"];
  for (const file of files) {
    const source = read(file);
    for (const marker of PRIVATE_SECRET_MARKERS) {
      assert.equal(source.includes(marker), false, `${file} must not contain ${marker}`);
    }
  }
});

/* ---------------------------------------------------------- B. mutation contracts */

test("Phase 10B-1 controller uses only supported Production inventory actions", () => {
  const source = read("public/js/v2/admin-inventory.js");

  assert.match(source, /fetchReportJson\(\s*"\/api\/admin-stock"/);
  assert.match(source, /fetchReportPost\(\s*"\/api\/admin-inventory"/);

  for (const action of SUPPORTED_ACTIONS) {
    assert.match(source, new RegExp(`action:\\s*"${action}"`), `missing action ${action}`);
  }

  for (const action of DISABLED_PLACEHOLDER_ACTIONS) {
    assert.doesNotMatch(
      source,
      new RegExp(`action:\\s*"${action}"`),
      `disabled placeholder ${action} must not be POSTed`,
    );
  }

  // No invented status-only action name.
  assert.doesNotMatch(source, /action:\s*"incoming_batch_status"/);
});

test("Phase 10B-1 stock_patch has dedicated in-flight guard and non-optimistic failure path", () => {
  const source = read("public/js/v2/admin-inventory.js");

  assert.match(source, /let stockPatchInFlight = false/);
  assert.match(source, /async function submitStockOverride/);
  assert.match(source, /if \(stockPatchInFlight\) return/);
  assert.match(source, /stockPatchInFlight = true/);
  assert.match(source, /stockPatchInFlight = false/);
  assert.match(source, /Saving…/);
  assert.match(source, /source:\s*"physical_stock_override"/);

  // Success path refetches; failure path restores controls without mutating stockData first.
  const submit = source.slice(source.indexOf("async function submitStockOverride"));
  const fn = submit.slice(0, submit.indexOf("\nasync function ") > 0 ? submit.indexOf("\nasync function ") : 3500);
  assert.match(fn, /await loadStock\(\)/);
  assert.match(fn, /finally \{\s*stockPatchInFlight = false/);
  assert.doesNotMatch(fn, /stockData\s*=/);
});

test("Phase 10B-1 zero-stock confirmation warns explicitly", () => {
  const source = read("public/js/v2/admin-inventory.js");
  assert.match(source, /Zero stock warning/);
  assert.match(source, /0 cases and 0 boxes/);
  assert.match(source, /Override physical stock\?/);
});

test("Phase 10B-1 arrival requires typed physical-count confirmation and offers hold", () => {
  const source = read("public/js/v2/admin-inventory.js");
  assert.match(source, /ARRIVAL_CONFIRM_PHRASE\s*=\s*"COUNTS REVIEWED"/);
  assert.match(source, /requiresPhysicalConfirm:\s*true/);
  assert.match(source, /ss-arrival-phrase/);
  assert.match(source, /physically received/i);
  assert.match(source, /Place on hold/);
  assert.match(source, /automatically verify expected versus actual counts/);
  assert.match(source, /phrase\.toUpperCase\(\)\s*!==\s*ARRIVAL_CONFIRM_PHRASE/);
});

test("Phase 10B-1 receive remains arrived-only with in-flight guard and refetch", () => {
  const source = read("public/js/v2/admin-inventory.js");
  assert.match(source, /let receiveInFlight = false/);
  assert.match(source, /if \(receiveInFlight\) return/);
  assert.match(source, /st === "arrived"/);
  assert.match(source, /Only arrived shipments can be received/);
  assert.match(source, /action:\s*"incoming_batch_receive"/);
  assert.match(source, /cannot be repeated/i);

  const receiveSubmit = source.slice(source.indexOf("async function submitReceive"));
  const fn = receiveSubmit.slice(0, 2200);
  assert.match(fn, /await loadStock\(\)/);
  assert.match(fn, /receiveInFlight = false/);
});

test("Phase 10B-1 commitment mutations keep in-flight guard and accurate wording", () => {
  const source = read("public/js/v2/admin-inventory.js");
  assert.match(source, /let commitInFlight = false/);
  assert.match(source, /if \(commitInFlight\) return/);
  assert.match(source, /Amazon FBM commitments/);
  assert.match(source, /does not write physical stock|do <strong>not<\/strong> change physical|does not change physical stock/i);
  assert.match(source, /Over-commitment is not blocked|does not block over-commitment/i);
  assert.match(source, /Advisory:/);
});

/**
 * Extract the submitAddCommitment function body for structural contract checks.
 * @param {string} source
 */
function extractSubmitAddCommitment(source) {
  const start = source.indexOf("async function submitAddCommitment");
  assert.ok(start >= 0, "submitAddCommitment missing");
  const next = source.indexOf("\n/* -- Edit External Commitment", start);
  assert.ok(next > start, "could not bound submitAddCommitment");
  return source.slice(start, next);
}

/**
 * Minimal control-flow harness mirroring submitAddCommitment error/partial paths
 * without importing the browser module. Tracks which panel would be visible.
 */
async function runCommitCreateHarness({ getToken, postLine, loadStock, lines }) {
  let commitInFlight = false;
  let drawerClosed = false;
  let confirmDisabled = true;
  let backDisabled = true;
  let formError = "";
  let confirmError = "";
  let confirmPanelVisible = true;
  let formPanelVisible = false;
  const draft = { lines: lines.map((l) => ({ ...l })) };
  let created = 0;
  const posts = [];

  commitInFlight = true;

  try {
    const token = await getToken();
    while (draft.lines.length) {
      const ln = draft.lines[0];
      posts.push({ action: "channel_commitment_create", product_slug: ln.product_slug, size: ln.size });
      await postLine(token, ln);
      draft.lines.shift();
      created += 1;
    }
    drawerClosed = true;
    await loadStock();
  } catch (error) {
    const base = error?.message || "Could not save the commitment.";
    const prefix = created ? `Saved ${created} line${created === 1 ? "" : "s"}. ` : "";
    const detail = `${prefix}${base}`;
    const formDetail = created
      ? `${created} line${created === 1 ? "" : "s"} already saved. Remaining lines below still need saving. ${base}`
      : base;
    confirmError = detail;
    formError = formDetail;
    confirmDisabled = false;
    backDisabled = false;
    // Mirror UI: hide confirm, show form with visible commit-err.
    confirmPanelVisible = false;
    formPanelVisible = true;
    if (created) {
      try {
        await loadStock();
      } catch {
        /* preserve draft + error */
      }
    }
  } finally {
    commitInFlight = false;
  }

  return {
    draft,
    created,
    posts,
    commitInFlight,
    drawerClosed,
    confirmDisabled,
    backDisabled,
    formError,
    confirmError,
    confirmPanelVisible,
    formPanelVisible,
  };
}

test("Phase 10B-1 submitAddCommitment gets token inside try and cleans up on token failure", async () => {
  const fn = extractSubmitAddCommitment(read("public/js/v2/admin-inventory.js"));

  // Structural: token is acquired only after entering try (not before).
  const tryIdx = fn.indexOf("try {");
  const tokenIdx = fn.indexOf("const token = await getToken()");
  const catchIdx = fn.indexOf("} catch (error)");
  assert.ok(tryIdx >= 0 && tokenIdx > tryIdx && tokenIdx < catchIdx, "getToken must be inside try");
  assert.doesNotMatch(fn.slice(0, tryIdx), /await getToken\(\)/);

  // finally always clears the in-flight guard; catch always writes visible form error.
  assert.match(fn, /finally \{\s*commitInFlight = false;/);
  assert.match(fn, /const formDetail = created/);
  assert.match(fn, /commitSetErr\(\s*"commit-err",\s*formDetail\s*\)/);

  const result = await runCommitCreateHarness({
    lines: [{ product_slug: "tea", size: "M", _cases: 1, _boxes: 0 }],
    getToken: async () => {
      throw new Error("session expired");
    },
    postLine: async () => {
      throw new Error("should not POST");
    },
    loadStock: async () => {
      throw new Error("should not refetch on zero creates");
    },
  });

  assert.equal(result.commitInFlight, false);
  assert.equal(result.drawerClosed, false);
  assert.equal(result.confirmPanelVisible, false);
  assert.equal(result.formPanelVisible, true);
  assert.equal(result.confirmDisabled, false);
  assert.equal(result.backDisabled, false);
  assert.equal(result.created, 0);
  assert.equal(result.posts.length, 0);
  assert.equal(result.draft.lines.length, 1);
  assert.match(result.formError, /session expired/);
});

test("Phase 10B-1 first commitment POST failure shows form error with intact draft", async () => {
  const result = await runCommitCreateHarness({
    lines: [
      { product_slug: "tea", size: "S", _cases: 1, _boxes: 0 },
      { product_slug: "tea", size: "M", _cases: 1, _boxes: 0 },
    ],
    getToken: async () => "tok",
    postLine: async () => {
      throw new Error("server rejected first line");
    },
    loadStock: async () => {
      throw new Error("should not refetch on zero creates");
    },
  });

  assert.equal(result.drawerClosed, false);
  assert.equal(result.confirmPanelVisible, false);
  assert.equal(result.formPanelVisible, true);
  assert.equal(result.commitInFlight, false);
  assert.equal(result.created, 0);
  assert.equal(result.posts.length, 1);
  assert.equal(result.draft.lines.length, 2);
  assert.deepEqual(
    result.draft.lines.map((l) => l.size),
    ["S", "M"],
  );
  assert.match(result.formError, /server rejected first line/);
  assert.doesNotMatch(result.formError, /already saved/);
});

test("Phase 10B-1 partial commitment create refetches and preserves remaining draft", async () => {
  const fn = extractSubmitAddCommitment(read("public/js/v2/admin-inventory.js"));
  // Partial-success path must refetch authoritative inventory inside catch.
  assert.match(fn, /if \(created\) \{[\s\S]*?await loadStock\(\)/);
  assert.match(fn, /already saved\. Remaining lines below still need saving/);
  // Still a single create action per line — no duplicate/extra POST action introduced.
  assert.equal([...fn.matchAll(/action:\s*"channel_commitment_create"/g)].length, 1);

  let loadCount = 0;
  const result = await runCommitCreateHarness({
    lines: [
      { product_slug: "tea", size: "S", _cases: 1, _boxes: 0 },
      { product_slug: "tea", size: "M", _cases: 2, _boxes: 0 },
      { product_slug: "tea", size: "L", _cases: 3, _boxes: 0 },
    ],
    getToken: async () => "tok",
    postLine: async (_token, ln) => {
      if (ln.size === "M") throw new Error("server rejected line M");
    },
    loadStock: async () => {
      loadCount += 1;
    },
  });

  assert.equal(result.commitInFlight, false);
  assert.equal(result.drawerClosed, false);
  assert.equal(result.confirmPanelVisible, false);
  assert.equal(result.formPanelVisible, true);
  assert.equal(result.created, 1);
  assert.equal(result.posts.length, 2); // one success + one failing attempt; no automatic retry POST
  assert.deepEqual(
    result.posts.map((p) => p.size),
    ["S", "M"],
  );
  assert.equal(result.draft.lines.length, 2);
  assert.deepEqual(
    result.draft.lines.map((l) => l.size),
    ["M", "L"],
  );
  assert.match(result.formError, /1 line already saved/);
  assert.match(result.formError, /server rejected line M/);
  assert.equal(loadCount, 1, "partial create must refetch once");
});

test("Phase 10B-1 partial commitment refetch failure preserves draft and error", async () => {
  const result = await runCommitCreateHarness({
    lines: [
      { product_slug: "tea", size: "S", _cases: 1, _boxes: 0 },
      { product_slug: "tea", size: "M", _cases: 1, _boxes: 0 },
    ],
    getToken: async () => "tok",
    postLine: async (_token, ln) => {
      if (ln.size === "M") throw new Error("line M failed");
    },
    loadStock: async () => {
      throw new Error("refetch failed");
    },
  });

  assert.equal(result.drawerClosed, false);
  assert.equal(result.formPanelVisible, true);
  assert.equal(result.confirmPanelVisible, false);
  assert.equal(result.commitInFlight, false);
  assert.equal(result.draft.lines.length, 1);
  assert.equal(result.draft.lines[0].size, "M");
  assert.match(result.formError, /1 line already saved/);
  assert.match(result.formError, /line M failed/);
});


test("Phase 10B-1 labels distinguish Amazon KPI and estimated availability", () => {
  const source = read("public/js/v2/admin-inventory.js");
  assert.match(source, /Physical on hand/);
  assert.match(source, /Open website orders/);
  assert.match(source, /Amazon FBM commitments/);
  assert.match(source, /Estimated available/);
  assert.doesNotMatch(source, /label:\s*"External Channel Reserved"/);
  assert.match(source, /does not subtract sales-channel commitments/i);
});

test("Phase 10B-1 batch save reports failed step and does not claim transactional success", () => {
  const source = read("public/js/v2/admin-inventory.js");
  assert.match(source, /Save incomplete \(failed at:/);
  assert.match(source, /not transactional/i);
  assert.match(source, /create batch header|update batch header|create line/);
});

test("Phase 10B-1 successful mutations refetch authoritative inventory", () => {
  const source = read("public/js/v2/admin-inventory.js");
  for (const fnName of [
    "submitStockOverride",
    "submitIncomingShipment",
    "submitStatusChange",
    "submitReceive",
    "submitAddCommitment",
  ]) {
    assert.match(source, new RegExp(`async function ${fnName}`), fnName);
  }
  // Each mutation path ends with loadStock on success (contract: refetch after POST).
  assert.match(source, /toast\("Physical stock updated\."[\s\S]{0,120}await loadStock\(\)/);
  assert.match(source, /toast\("Incoming shipment saved\."[\s\S]{0,80}await loadStock\(\)/);
  assert.match(source, /toast\(built\.successMsg[\s\S]{0,80}await loadStock\(\)/);
  assert.match(source, /toast\("Shipment received into physical stock\."[\s\S]{0,80}await loadStock\(\)/);
});

test("Phase 10B-1 placeholder controls remain disabled", () => {
  const source = read("public/js/v2/admin-inventory.js");
  assert.match(source, /disabledIconBtn\("Set threshold"/);
  assert.match(source, /Reorder thresholds arrive in a later phase/);
  assert.match(source, /Still NOT connected \(remain clearly-disabled placeholders\)/);
});

/* ---------------------------------------------------------- D. runtime routes */

test("Phase 10B-1 local server serves inventory and coexistence routes", async () => {
  await withLocalServer(async (base) => {
    for (const pathName of ["/admin-v2/inventory", "/admin-v2/inventory/", "/admin-v2/inventory.html"]) {
      const res = await httpGet(`${base}${pathName}`);
      assert.equal(res.statusCode, 200, pathName);
      assert.match(String(res.headers["content-type"] || ""), /text\/html/i);
      assert.match(res.body, /<!doctype html>/i);
      assert.match(res.body, /\/js\/v2\/admin-inventory\.js/);
      assert.match(res.body, /sg-login/);
    }

    const legacy = await httpGet(`${base}/admin/inventory.html`);
    assert.equal(legacy.statusCode, 200);
    assert.match(legacy.body, /<!doctype html>/i);

    for (const page of PHASE10A_ROUTES) {
      const res = await httpGet(`${base}${page.route}`);
      assert.equal(res.statusCode, 200, page.route);
      assert.match(res.body, new RegExp(page.script.replace(/\./g, "\\.")));
    }

    // Orders is released in 10B-2A; Manual/Walk-in stay 404 (checked via UNRELEASED_V2_HREFS below when present).
    const ordersRes = await httpGet(`${base}/admin-v2/orders`);
    assert.equal(ordersRes.statusCode, 200);
    for (const href of UNRELEASED_V2_HREFS) {
      const missing = await httpGet(`${base}${href}`);
      assert.equal(missing.statusCode, 404, href);
    }
  });
});
