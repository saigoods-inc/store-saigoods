import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APPROVED_V2_PAGES = [
  { route: "/admin-v2/summary", htmlFile: "summary.html", script: "/js/v2/admin-summary.js", titlePart: "Dashboard" },
  { route: "/admin-v2/tax", htmlFile: "tax.html", script: "/js/v2/admin-tax.js", titlePart: "Sales Tax" },
  { route: "/admin-v2/nexus", htmlFile: "nexus.html", script: "/js/v2/admin-nexus.js", titlePart: "Nexus" },
  {
    route: "/admin-v2/discount-codes",
    htmlFile: "discount-codes.html",
    script: "/js/v2/admin-discount-codes.js",
    titlePart: "Discount Codes",
  },
];

const LEGACY_ADMIN_ROUTES = [
  { route: "/admin/summary", fileHint: "admin/summary.html" },
  { route: "/admin/tax", fileHint: "admin/tax.html" },
  { route: "/admin/nexus", fileHint: "admin/nexus.html" },
  { route: "/admin/discount-codes", fileHint: "admin/discount-codes.html" },
];

const UNRELEASED_V2_HREFS = [
  "/admin-v2/orders",
  "/admin-v2/manual-order",
  "/admin-v2/walk-in-order",
];

const PRIVATE_SECRET_MARKERS = [
  "INTERNAL_REPORTS_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SQUARE_ACCESS_TOKEN",
  "SHIPPO_API_TOKEN",
  "RESEND_API_KEY",
];

const CONTROLLER_READ_APIS = {
  "admin-summary.js": ["/api/admin-summary"],
  "admin-tax.js": ["/api/tax-summary"],
  "admin-nexus.js": ["/api/nexus-summary"],
  "admin-discount-codes.js": ["/api/admin-discount-codes"],
};

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
      // Keep auth fail-closed without contacting real services for static HTML checks.
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

test("Phase 10A approved admin-v2 HTML shells exist with expected assets", () => {
  for (const page of APPROVED_V2_PAGES) {
    const htmlPath = path.join(__dirname, "public/admin-v2", page.htmlFile);
    assert.equal(existsSync(htmlPath), true, `missing ${page.htmlFile}`);
    const html = read(`public/admin-v2/${page.htmlFile}`);
    assert.match(html, new RegExp(page.titlePart));
    assert.match(html, /\/css\/v2\/tokens\.css/);
    assert.match(html, /\/css\/v2\/admin-v2\.css/);
    assert.match(html, new RegExp(page.script.replace(/\./g, "\\.")));
    assert.doesNotMatch(html, /\/admin-v2\/(orders|manual-order|walk-in-order)/);
  }
  assert.equal(existsSync(path.join(__dirname, "public/css/v2/tokens.css")), true);
  assert.equal(existsSync(path.join(__dirname, "public/css/v2/admin-v2.css")), true);
  assert.equal(existsSync(path.join(__dirname, "public/js/v2/page-boot.js")), true);
  assert.equal(existsSync(path.join(__dirname, "public/js/v2/ui.js")), true);
});

test("Phase 10A does not restore unreleased admin-v2 page files", () => {
  // Inventory is released in Phase 10B-1; Orders / Manual / Walk-in remain unreleased.
  for (const name of ["orders", "manual-order", "walk-in-order"]) {
    assert.equal(existsSync(path.join(__dirname, "public/admin-v2", `${name}.html`)), false);
    assert.equal(existsSync(path.join(__dirname, "public/js/v2", `admin-${name}.js`)), false);
  }
  assert.equal(existsSync(path.join(__dirname, "public/js/hardin-county.js")), false);
});

test("vercel.json adds four admin-v2 rewrites without removing legacy admin rewrites", () => {
  const vercel = JSON.parse(read("vercel.json"));
  const rewrites = vercel.rewrites || [];
  const bySource = new Map(rewrites.map((r) => [r.source, r.destination]));

  for (const legacy of [
    "/admin/orders",
    "/admin/tax",
    "/admin/nexus",
    "/admin/discount-codes",
    "/admin/manual-order",
    "/admin/walk-in-order",
    "/admin/inventory",
  ]) {
    assert.ok(bySource.has(legacy), `missing legacy rewrite ${legacy}`);
  }

  assert.equal(bySource.get("/admin-v2/summary"), "/admin-v2/summary.html");
  assert.equal(bySource.get("/admin-v2/tax"), "/admin-v2/tax.html");
  assert.equal(bySource.get("/admin-v2/nexus"), "/admin-v2/nexus.html");
  assert.equal(bySource.get("/admin-v2/discount-codes"), "/admin-v2/discount-codes.html");

  for (const href of UNRELEASED_V2_HREFS) {
    assert.equal(bySource.has(href), false, `unexpected rewrite for unreleased ${href}`);
  }
});

test("server.js serves four approved admin-v2 pages and keeps legacy admin routes", () => {
  const serverSource = read("server.js");

  for (const page of APPROVED_V2_PAGES) {
    assert.match(serverSource, new RegExp(page.route.replace(/\//g, "\\/")));
    assert.match(
      serverSource,
      new RegExp(`admin-v2",\\s*"${page.htmlFile.replace(".", "\\.")}"`),
    );
  }

  for (const href of UNRELEASED_V2_HREFS) {
    assert.doesNotMatch(serverSource, new RegExp(href.replace(/\//g, "\\/")));
  }

  for (const legacy of LEGACY_ADMIN_ROUTES) {
    assert.match(serverSource, new RegExp(legacy.route.replace(/\//g, "\\/")));
  }

  // Additive only: do not restore safety-branch inlined public API handlers.
  assert.match(serverSource, /import\s+taxSummaryHandler\s+from\s+["']\.\/api\/tax-summary\.js["']/);
  assert.match(serverSource, /import\s+nexusSummaryHandler\s+from\s+["']\.\/api\/nexus-summary\.js["']/);
});

test("admin-v2 navigation exposes only approved routes", () => {
  const ui = read("public/js/v2/ui.js");
  assert.match(ui, /export const ADMIN_V2_NAV\s*=\s*\[/);

  for (const page of APPROVED_V2_PAGES) {
    assert.match(ui, new RegExp(`href:\\s*"${page.route}"`));
  }
  for (const href of UNRELEASED_V2_HREFS) {
    assert.doesNotMatch(ui, new RegExp(href.replace(/\//g, "\\/")));
  }

  // Optional coexistence link back to legacy admin.
  assert.match(ui, /href="\/admin\/summary\.html"/);
  assert.match(ui, /Legacy admin/);
});

test("restored admin-v2 sources contain no links to unreleased v2 pages", () => {
  const files = [
    "public/js/v2/ui.js",
    "public/js/v2/page-boot.js",
    "public/js/v2/admin-summary.js",
    "public/js/v2/admin-tax.js",
    "public/js/v2/admin-nexus.js",
    "public/js/v2/admin-discount-codes.js",
    "public/admin-v2/summary.html",
    "public/admin-v2/tax.html",
    "public/admin-v2/nexus.html",
    "public/admin-v2/discount-codes.html",
  ];
  for (const file of files) {
    const source = read(file);
    for (const href of UNRELEASED_V2_HREFS) {
      assert.equal(source.includes(href), false, `${file} must not link to ${href}`);
    }
  }
});

test("approved controllers call only their intended read APIs (no mutations)", () => {
  for (const [file, expected] of Object.entries(CONTROLLER_READ_APIS)) {
    const source = read(`public/js/v2/${file}`);
    assert.doesNotMatch(source, /fetchReportPost/);
    assert.doesNotMatch(source, /method:\s*["']POST["']/);
    for (const api of expected) {
      assert.match(source, new RegExp(api.replace(/\//g, "\\/")), `${file} must call ${api}`);
    }
    // No other staff API prefixes beyond the intended read endpoint.
    const otherAdminApis = [...source.matchAll(/\/api\/admin-[a-z0-9-]+/g)].map((m) => m[0]);
    const otherReportApis = [...source.matchAll(/\/api\/(?:tax|nexus)-summary/g)].map((m) => m[0]);
    const found = [...new Set([...otherAdminApis, ...otherReportApis])];
    assert.deepEqual(found.sort(), [...expected].sort(), file);
  }

  const pageBoot = read("public/js/v2/page-boot.js");
  assert.match(pageBoot, /\/api\/supabase-public-config/);
  assert.doesNotMatch(pageBoot, /fetchReportPost/);
});

test("discount codes page remains read-only (generation disabled)", () => {
  const source = read("public/js/v2/admin-discount-codes.js");
  assert.match(source, /disabled title="Code generation isn't supported yet"/);
  assert.doesNotMatch(source, /fetchReportPost/);
  assert.match(source, /read-only/i);
});

test("browser admin-v2 sources do not embed private credentials", () => {
  const files = [
    "public/js/v2/page-boot.js",
    "public/js/v2/ui.js",
    "public/js/v2/admin-summary.js",
    "public/js/v2/admin-tax.js",
    "public/js/v2/admin-nexus.js",
    "public/js/v2/admin-discount-codes.js",
    "public/admin-v2/summary.html",
    "public/admin-v2/tax.html",
    "public/admin-v2/nexus.html",
    "public/admin-v2/discount-codes.html",
  ];
  for (const file of files) {
    const source = read(file);
    for (const marker of PRIVATE_SECRET_MARKERS) {
      assert.equal(source.includes(marker), false, `${file} must not contain ${marker}`);
    }
  }
});

test("local server resolves approved admin-v2 routes to HTML shells", async () => {
  await withLocalServer(async (base) => {
    for (const page of APPROVED_V2_PAGES) {
      const res = await httpGet(`${base}${page.route}`);
      assert.equal(res.statusCode, 200, page.route);
      assert.match(String(res.headers["content-type"] || ""), /text\/html/i);
      assert.match(res.body, /<!doctype html>/i);
      assert.match(res.body, new RegExp(page.script.replace(/\./g, "\\.")));
      assert.match(res.body, /sg-login/);
    }

    // Extensionless legacy routes still served.
    const legacySummary = await httpGet(`${base}/admin/summary`);
    assert.equal(legacySummary.statusCode, 200);
    assert.match(legacySummary.body, /<!doctype html>/i);
    assert.match(legacySummary.body, /admin-page|Staff login|Summary/i);

    // Unreleased v2 pages are not routed.
    const missing = await httpGet(`${base}/admin-v2/orders`);
    assert.equal(missing.statusCode, 404);
  });
});
