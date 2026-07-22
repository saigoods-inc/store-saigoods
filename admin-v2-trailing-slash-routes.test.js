import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RELEASED_V2_ROUTES = [
  { canonical: "/admin-v2/summary", trailing: "/admin-v2/summary/", html: "/admin-v2/summary.html" },
  { canonical: "/admin-v2/orders", trailing: "/admin-v2/orders/", html: "/admin-v2/orders.html" },
  { canonical: "/admin-v2/inventory", trailing: "/admin-v2/inventory/", html: "/admin-v2/inventory.html" },
  { canonical: "/admin-v2/discount-codes", trailing: "/admin-v2/discount-codes/", html: "/admin-v2/discount-codes.html" },
  { canonical: "/admin-v2/tax", trailing: "/admin-v2/tax/", html: "/admin-v2/tax.html" },
  { canonical: "/admin-v2/nexus", trailing: "/admin-v2/nexus/", html: "/admin-v2/nexus.html" },
];

const UNRELEASED_TRAILING = ["/admin-v2/manual-order/", "/admin-v2/walk-in-order/"];

const LEGACY_REWRITES = [
  "/admin/orders",
  "/admin/tax",
  "/admin/nexus",
  "/admin/discount-codes",
  "/admin/manual-order",
  "/admin/walk-in-order",
  "/admin/inventory",
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

test("vercel.json is valid JSON with released admin-v2 trailing-slash rewrites", () => {
  const raw = read("vercel.json");
  const vercel = JSON.parse(raw);
  assert.ok(Array.isArray(vercel.rewrites));

  const bySource = new Map(vercel.rewrites.map((r) => [r.source, r.destination]));

  for (const route of RELEASED_V2_ROUTES) {
    assert.equal(bySource.get(route.canonical), route.html, `missing canonical rewrite ${route.canonical}`);
    assert.equal(bySource.get(route.trailing), route.html, `missing trailing-slash rewrite ${route.trailing}`);
  }

  for (const href of UNRELEASED_TRAILING) {
    assert.equal(bySource.has(href), false, `unexpected unreleased rewrite ${href}`);
    assert.equal(bySource.has(href.replace(/\/$/, "")), false, `unexpected unreleased rewrite ${href.slice(0, -1)}`);
  }

  for (const legacy of LEGACY_REWRITES) {
    assert.ok(bySource.has(legacy), `missing legacy rewrite ${legacy}`);
  }

  // No global trailingSlash policy — keep storefront/API behavior unchanged.
  assert.equal(Object.prototype.hasOwnProperty.call(vercel, "trailingSlash"), false);
});

test("local server serves released admin-v2 trailing-slash routes and keeps unreleased absent", async () => {
  await withLocalServer(async (base) => {
    for (const route of RELEASED_V2_ROUTES) {
      const res = await httpGet(`${base}${route.trailing}`);
      assert.equal(res.statusCode, 200, route.trailing);
      assert.match(String(res.headers["content-type"] || ""), /text\/html/i);
      assert.match(res.body, /<!doctype html>/i);
    }

    for (const href of UNRELEASED_TRAILING) {
      const res = await httpGet(`${base}${href}`);
      assert.equal(res.statusCode, 404, href);
    }
  });
});
