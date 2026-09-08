import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function read(rel) {
  return readFileSync(path.join(__dirname, rel), "utf8");
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error(`timeout fetching ${url}`)));
  });
}

async function withLocalServer(run) {
  const port = 21000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (/running at/i.test(stdout)) {
          clearInterval(timer);
          resolve();
        } else if (child.exitCode != null || Date.now() - startedAt > 8000) {
          clearInterval(timer);
          reject(new Error(`server failed to start: ${stderr || stdout}`));
        }
      }, 50);
      child.on("error", (error) => {
        clearInterval(timer);
        reject(error);
      });
    });
    await run(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGTERM");
  }
}

test("Vercel exposes one canonical admin app and redirects retired versions", () => {
  const config = JSON.parse(read("vercel.json"));
  const rewrites = new Map(config.rewrites.map(({ source, destination }) => [source, destination]));
  const redirects = new Map(config.redirects.map(({ source, destination }) => [source, destination]));

  for (const route of [
    "summary", "reset-password", "orders", "internal-label", "order-builder",
    "inventory", "discount-codes", "tax", "nexus", "advanced",
  ]) {
    assert.equal(rewrites.get(`/admin/${route}`), "/admin/index.html");
  }

  assert.equal(redirects.get("/admin-v2.5/:path*"), "/admin/:path*");
  assert.equal(redirects.get("/admin-v2/:path*"), "/admin/:path*");
  assert.equal(redirects.get("/admin/:page.html"), "/admin/:page");
  assert.equal(redirects.get("/admin/manual-order"), "/admin/order-builder");
  assert.equal(redirects.get("/admin/walk-in-order"), "/admin/order-builder");
  assert.equal(config.rewrites.some(({ source }) => source.startsWith("/admin-v2")), false);
});

test("local server serves canonical admin routes and permanently redirects legacy URLs", async () => {
  await withLocalServer(async (base) => {
    for (const route of ["summary", "orders", "order-builder", "reset-password", "advanced"]) {
      const response = await httpGet(`${base}/admin/${route}`);
      assert.equal(response.statusCode, 200, route);
      assert.match(String(response.headers["content-type"] || ""), /text\/html/i);
      assert.match(response.body, /<div id="root"><\/div>/);
      assert.match(response.body, /\/admin\/assets\//);
    }

    const cases = new Map([
      ["/admin", "/admin/summary"],
      ["/admin/orders.html", "/admin/orders"],
      ["/admin/manual-order", "/admin/order-builder"],
      ["/admin-v2", "/admin/summary"],
      ["/admin-v2/orders.html", "/admin/orders"],
      ["/admin-v2.5/walk-in-order", "/admin/order-builder"],
      ["/admin-v2.5/reset-password?code=example", "/admin/reset-password?code=example"],
    ]);

    for (const [source, destination] of cases) {
      const response = await httpGet(`${base}${source}`);
      assert.equal(response.statusCode, 308, source);
      assert.equal(response.headers.location, destination, source);
    }
  });
});
