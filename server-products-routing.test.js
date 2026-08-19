import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import productsHandler from "./api/products.js";
import squareConfigHandler from "./api/square-config.js";
import { mergeInventoryIntoStore } from "./lib/stock.js";
import { getStorePath } from "./lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(path.join(__dirname, "server.js"), "utf8");

/** Env keys the products handler and inventory helpers may read. */
const HANDLER_ENV_KEYS = [
  "INVENTORY_BACKEND",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SAIGOODS_DATA_DIR",
  "VERCEL",
  "AWS_LAMBDA_FUNCTION_NAME",
];

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const previous = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

function fileBackendEnv(extra = {}) {
  return {
    INVENTORY_BACKEND: "file",
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SAIGOODS_DATA_DIR: undefined,
    VERCEL: undefined,
    AWS_LAMBDA_FUNCTION_NAME: undefined,
    ...extra,
  };
}

function mockRes() {
  /** @type {{ statusCode?: number, body?: object, headers: Record<string, string> }} */
  const state = { headers: {} };
  return {
    state,
    status(code) {
      state.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      state.headers[String(name)] = String(value);
      return this;
    },
    json(body) {
      state.body = body;
      return this;
    },
  };
}

/** Mirrors server.js Express → Vercel adaptation for /api/products. */
async function invokeLocalProducts(method) {
  const res = mockRes();
  await productsHandler({ method }, res);
  return res.state;
}

/**
 * Mirrors server.js `adaptExpressStyleResponse` + `sendJson` exactly
 * (status / setHeader / single writeHead+end).
 */
function createServerAdapterCapture() {
  /** @type {{ statusCode?: number, headers?: Record<string, string>, body?: string, writeHeadCalls: number, endCalls: number }} */
  const captured = { writeHeadCalls: 0, endCalls: 0 };
  const fakeNodeRes = {
    writeHead(statusCode, headers) {
      captured.writeHeadCalls += 1;
      captured.statusCode = statusCode;
      captured.headers = headers;
    },
    end(body) {
      captured.endCalls += 1;
      captured.body = body;
    },
  };

  let statusCode = 200;
  /** @type {Record<string, string>} */
  const extraHeaders = {};
  const adapted = {
    status(c) {
      statusCode = c;
      return this;
    },
    setHeader(name, value) {
      extraHeaders[String(name)] = String(value);
      return this;
    },
    json(body) {
      // Same merge order as server.js sendJson.
      fakeNodeRes.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        ...extraHeaders,
      });
      fakeNodeRes.end(JSON.stringify(body));
    },
  };

  return { captured, adapted };
}

function inventoryFingerprint(storeBody) {
  const products = Array.isArray(storeBody?.products) ? storeBody.products : [];
  return products.map((p) => ({
    slug: p.slug,
    inventorySchemaVersion: storeBody.inventorySchemaVersion,
    globalOutOfStock: p?.inventory?.globalOutOfStock,
    lines: (p?.inventory?.lines || []).map((l) => ({
      productSlug: l.productSlug,
      size: l.size,
      channel: l.channel,
      onHand: l.onHand,
      reserved: l.reserved,
      incoming: l.incoming,
      damaged: l.damaged,
      available: l.available,
      track: l.track,
      active: l.active,
      status: l.status,
    })),
  }));
}

/**
 * Fresh Node process so SAIGOODS_DATA_DIR / mutable-dir cache cannot leak across tests.
 * Returns { statusCode, body, headers } from the Production products handler.
 */
function invokeProductsInSubprocess(env, method = "GET") {
  const script = `
import productsHandler from ${JSON.stringify(path.join(__dirname, "api/products.js"))};

const state = { headers: {} };
const res = {
  status(code) { state.statusCode = code; return this; },
  setHeader(name, value) { state.headers[String(name)] = String(value); return this; },
  json(body) { state.body = body; },
};
await productsHandler({ method: ${JSON.stringify(method)} }, res);
process.stdout.write(JSON.stringify(state));
`;
  const childEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === "") {
      delete childEnv[key];
    } else {
      childEnv[key] = String(value);
    }
  }
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: __dirname,
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `products subprocess failed (status ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout);
}

test("server.js imports and invokes the existing products handler", () => {
  assert.match(
    serverSource,
    /import\s+productsHandler\s+from\s+["']\.\/api\/products\.js["']/,
  );
  assert.match(serverSource, /pathname\s*===\s*["']\/api\/products["']/);
  assert.match(serverSource, /await\s+productsHandler\s*\(/);
  assert.match(serverSource, /adaptExpressStyleResponse\s*\(\s*res\s*\)/);
});

test("server.js no longer inlines /api/products catalog merge", () => {
  assert.equal(serverSource.includes("mergeInventoryIntoStore"), false);
  assert.equal(
    /pathname\s*===\s*["']\/api\/products["']\s*&&\s*req\.method\s*===\s*["']GET["']/.test(
      serverSource,
    ),
    false,
  );
  assert.equal(
    /sendJson\(\s*res,\s*200,\s*await\s+mergeInventoryIntoStore/.test(serverSource),
    false,
  );
});

test("server.js cart quote, checkout, square-config, and supabase-public-config delegation remain unchanged", () => {
  assert.match(
    serverSource,
    /import\s+cartQuoteHandler\s+from\s+["']\.\/api\/cart-quote\.js["']/,
  );
  assert.match(
    serverSource,
    /pathname\s*===\s*["']\/api\/cart\/quote["']\s*&&\s*req\.method\s*===\s*["']POST["']/,
  );
  assert.match(serverSource, /await\s+cartQuoteHandler\s*\(/);
  assert.match(
    serverSource,
    /import\s+checkoutHandler\s+from\s+["']\.\/api\/checkout\.js["']/,
  );
  assert.match(
    serverSource,
    /pathname\s*===\s*["']\/api\/checkout["']\s*&&\s*req\.method\s*===\s*["']POST["']/,
  );
  assert.match(serverSource, /await\s+checkoutHandler\s*\(/);
  assert.match(
    serverSource,
    /import\s+squareConfigHandler\s+from\s+["']\.\/api\/square-config\.js["']/,
  );
  assert.match(serverSource, /pathname\s*===\s*["']\/api\/square-config["']/);
  assert.match(serverSource, /await\s+squareConfigHandler\s*\(/);
  assert.match(
    serverSource,
    /import\s+supabasePublicConfigHandler\s+from\s+["']\.\/api\/supabase-public-config\.js["']/,
  );
  assert.match(
    serverSource,
    /pathname\s*===\s*["']\/api\/supabase-public-config["']/,
  );
  assert.match(serverSource, /await\s+supabasePublicConfigHandler\s*\(/);
});

test("adaptExpressStyleResponse supports setHeader used by products handler", () => {
  assert.match(serverSource, /setHeader\s*\(\s*name\s*,\s*value\s*\)/);
  assert.match(serverSource, /sendJson\(\s*res,\s*statusCode,\s*body,\s*extraHeaders\s*\)/);
});

test("GET /api/products returns expected store shape with stable product order", async () => {
  await withEnv(fileBackendEnv(), async () => {
    const state = await invokeLocalProducts("GET");
    assert.equal(state.statusCode, 200);
    assert.equal(state.headers["Cache-Control"], "no-store");
    assert.ok(state.body && typeof state.body === "object");
    assert.ok(state.body.site && typeof state.body.site === "object");
    assert.equal(state.body.inventorySchemaVersion, 2);
    assert.ok(Array.isArray(state.body.products));
    assert.ok(state.body.products.length >= 1);

    const store = JSON.parse(readFileSync(getStorePath(), "utf8"));
    assert.deepEqual(
      state.body.products.map((p) => p.slug),
      store.products.map((p) => p.slug),
    );
    for (const product of state.body.products) {
      assert.ok(product.slug);
      assert.ok(product.inventory && typeof product.inventory === "object");
      assert.equal(product.inventory.schemaVersion, 2);
      assert.ok(Array.isArray(product.inventory.lines));
    }
  });
});

test("inventory/stock fields match Production handler under file backend", async () => {
  await withEnv(fileBackendEnv(), async () => {
    const state = await invokeLocalProducts("GET");
    assert.equal(state.statusCode, 200);

    const store = JSON.parse(readFileSync(getStorePath(), "utf8"));
    const productionBody = await mergeInventoryIntoStore(store);

    assert.deepEqual(
      state.body.products.map((p) => p.slug),
      productionBody.products.map((p) => p.slug),
    );
    assert.deepEqual(inventoryFingerprint(state.body), inventoryFingerprint(productionBody));

    const withLines = state.body.products.find((p) => p.inventory.lines.length > 0);
    assert.ok(withLines, "expected at least one product with inventory lines");
    const line = withLines.inventory.lines[0];
    for (const key of [
      "productSlug",
      "size",
      "channel",
      "onHand",
      "reserved",
      "available",
      "status",
      "track",
      "active",
    ]) {
      assert.ok(key in line, `missing inventory field ${key}`);
    }
  });
});

test("empty inventory file yields empty lines like Production (subprocess isolation)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "saigoods-products-empty-"));
  try {
    writeFileSync(
      path.join(dir, "stock.json"),
      `${JSON.stringify({ schemaVersion: 2, lines: [] }, null, 2)}\n`,
      "utf8",
    );
    const state = invokeProductsInSubprocess(fileBackendEnv({ SAIGOODS_DATA_DIR: dir }));
    assert.equal(state.statusCode, 200);
    assert.equal(state.headers["Cache-Control"], "no-store");
    assert.ok(Array.isArray(state.body.products));
    for (const product of state.body.products) {
      assert.deepEqual(product.inventory.lines, []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed inventory file returns 500 like Production (subprocess isolation)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "saigoods-products-bad-"));
  try {
    writeFileSync(path.join(dir, "stock.json"), "{not-valid-json", "utf8");
    const state = invokeProductsInSubprocess(fileBackendEnv({ SAIGOODS_DATA_DIR: dir }));
    assert.equal(state.statusCode, 500);
    assert.deepEqual(state.body, { error: "Failed to load products." });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsupported methods match Production (POST and HEAD → 405)", async () => {
  await withEnv(fileBackendEnv(), async () => {
    for (const method of ["POST", "HEAD", "PUT", "DELETE"]) {
      const state = await invokeLocalProducts(method);
      assert.equal(state.statusCode, 405, method);
      assert.deepEqual(state.body, { error: "Method not allowed." });
    }
  });
});

test("Content-Type and Cache-Control preserved through adaptExpressStyleResponse path", async () => {
  await withEnv(fileBackendEnv(), async () => {
    const { captured, adapted } = createServerAdapterCapture();
    await productsHandler({ method: "GET" }, adapted);
    assert.equal(captured.writeHeadCalls, 1);
    assert.equal(captured.endCalls, 1);
    assert.equal(captured.statusCode, 200);
    assert.equal(captured.headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal(captured.headers["Cache-Control"], "no-store");
    assert.deepEqual(Object.keys(captured.headers).sort(), [
      "Cache-Control",
      "Content-Type",
    ]);
    const parsed = JSON.parse(captured.body);
    assert.ok(Array.isArray(parsed.products));
  });
});

test("handlers without setHeader keep Content-Type-only headers (square-config)", async () => {
  await withEnv(
    {
      SQUARE_APPLICATION_ID: "sandbox-sq0idb-dummy-app-id",
      SQUARE_LOCATION_ID: "LDUMMYLOCATIONID",
      SQUARE_ENVIRONMENT: "sandbox",
      ADDRESS_VALIDATION: undefined,
      NODE_ENV: "development",
    },
    async () => {
      const { captured, adapted } = createServerAdapterCapture();
      await squareConfigHandler({ method: "GET" }, adapted);
      assert.equal(captured.writeHeadCalls, 1);
      assert.equal(captured.endCalls, 1);
      assert.equal(captured.statusCode, 200);
      assert.equal(
        captured.headers["Content-Type"],
        "application/json; charset=utf-8",
      );
      assert.equal(captured.headers["Cache-Control"], undefined);
      assert.deepEqual(Object.keys(captured.headers), ["Content-Type"]);
      const parsed = JSON.parse(captured.body);
      assert.equal(parsed.squareApplicationId, "sandbox-sq0idb-dummy-app-id");
      assert.equal(parsed.squareLocationId, "LDUMMYLOCATIONID");
    },
  );
});

test("environment changes made by products routing tests are restored", async () => {
  const before = {};
  for (const key of HANDLER_ENV_KEYS) {
    before[key] = process.env[key];
  }

  await withEnv(
    fileBackendEnv({
      SUPABASE_URL: "https://example-must-not-be-used.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "secret-must-not-leak",
    }),
    async () => {
      const state = await invokeLocalProducts("GET");
      assert.equal(state.statusCode, 200);
      const serialized = JSON.stringify(state.body);
      assert.equal(serialized.includes("secret-must-not-leak"), false);
      assert.equal(serialized.includes("example-must-not-be-used"), false);
    },
  );

  for (const key of HANDLER_ENV_KEYS) {
    assert.equal(process.env[key], before[key], `env ${key} not restored`);
  }
});
