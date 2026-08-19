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
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }, 2000);
      child.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

test("vercel.json and server.js map /admin-v2 and /admin-v2/ to summary.html", () => {
  const vercel = JSON.parse(read("vercel.json"));
  const bySource = new Map(vercel.rewrites.map((r) => [r.source, r.destination]));
  assert.equal(bySource.get("/admin-v2"), "/admin-v2/summary.html");
  assert.equal(bySource.get("/admin-v2/"), "/admin-v2/summary.html");
  assert.equal(bySource.get("/admin-v2/summary"), "/admin-v2/summary.html");
  assert.equal(bySource.get("/admin-v2/summary/"), "/admin-v2/summary.html");
  assert.equal(Object.prototype.hasOwnProperty.call(vercel, "trailingSlash"), false);

  const server = read("server.js");
  assert.match(server, /pathname === "\/admin-v2" \|\| pathname === "\/admin-v2\/"/);
  assert.match(server, /admin-v2", "summary\.html"/);
  assert.match(server, /\/admin-v2\/walk-in-order/);
});

test("local server serves Admin-v2 root as Summary and exposes Walk-in", async () => {
  await withLocalServer(async (base) => {
    for (const href of ["/admin-v2", "/admin-v2/"]) {
      const res = await httpGet(`${base}${href}`);
      assert.equal(res.statusCode, 200, href);
      assert.match(String(res.headers["content-type"] || ""), /text\/html/i);
      assert.match(res.body, /admin-summary\.js/);
      assert.match(res.body, /Dashboard|Summary/i);
    }

    for (const href of ["/admin-v2/summary", "/admin-v2/summary/", "/admin-v2/summary.html"]) {
      const res = await httpGet(`${base}${href}`);
      assert.equal(res.statusCode, 200, href);
      assert.match(res.body, /admin-summary\.js/);
    }

    for (const href of ["/admin-v2/walk-in-order", "/admin-v2/walk-in-order/", "/admin-v2/walk-in-order.html"]) {
      const res = await httpGet(`${base}${href}`);
      assert.equal(res.statusCode, 200, href);
      assert.match(res.body, /admin-walk-in-order\.js/);
    }

    const legacy = await httpGet(`${base}/admin/summary.html`);
    assert.equal(legacy.statusCode, 200);
    assert.match(legacy.body, /<!doctype html>/i);
  });
});
