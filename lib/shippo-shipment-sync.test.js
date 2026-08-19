import assert from "node:assert/strict";
import test from "node:test";
import { postShippoShipmentCreate } from "./shippo-shipment-sync.js";

function shippoResponse(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(json),
  };
}

test("admin shipment rating polls the created shipment instead of posting duplicates", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = { ...process.env };
  const calls = [];
  try {
    process.env.SHIPPO_API_TOKEN = "shippo_test_contract";
    process.env.SHIPPO_API_BASE_URL = "https://shippo.test";
    delete process.env.SHIPPO_RATE_EMPTY_RETRY_COUNT;
    process.env.SHIPPO_RATE_EMPTY_RETRY_DELAY_MS = "100";
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      if (calls.length === 1) {
        return shippoResponse({ object_id: "shipment-pending", rates: [] });
      }
      return shippoResponse({
        object_id: "shipment-pending",
        rates: [{ object_id: "rate-ready", amount: "9.25", currency: "USD" }],
      });
    };

    const result = await postShippoShipmentCreate({ parcels: [{ weight: "1" }] });

    assert.deepEqual(
      calls.map((call) => call.method),
      ["POST", "GET"],
    );
    assert.match(calls[1].url, /\/shipments\/shipment-pending\/$/);
    assert.equal(result.ok, true);
    assert.equal(result.shipmentId, "shipment-pending");
    assert.equal(result.rates[0].object_id, "rate-ready");
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previousEnv;
  }
});

test("admin shipment rating stops after bounded polling without another POST", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = { ...process.env };
  const calls = [];
  try {
    process.env.SHIPPO_API_TOKEN = "shippo_test_contract";
    process.env.SHIPPO_API_BASE_URL = "https://shippo.test";
    process.env.SHIPPO_RATE_EMPTY_RETRY_COUNT = "2";
    process.env.SHIPPO_RATE_EMPTY_RETRY_DELAY_MS = "100";
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      return shippoResponse({ object_id: "shipment-pending", rates: [] });
    };

    const result = await postShippoShipmentCreate({ parcels: [{ weight: "1" }] });

    assert.deepEqual(
      calls.map((call) => call.method),
      ["POST", "GET", "GET"],
    );
    assert.equal(result.ok, true);
    assert.equal(result.rates.length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previousEnv;
  }
});

test("admin shipment rating waits through delayed sandbox rates without another POST", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = { ...process.env };
  const calls = [];
  try {
    process.env.SHIPPO_API_TOKEN = "shippo_test_contract";
    process.env.SHIPPO_API_BASE_URL = "https://shippo.test";
    delete process.env.SHIPPO_RATE_EMPTY_RETRY_COUNT;
    process.env.SHIPPO_RATE_EMPTY_RETRY_DELAY_MS = "100";
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      if (calls.length < 7) {
        return shippoResponse({ object_id: "shipment-delayed", rates: [] });
      }
      return shippoResponse({
        object_id: "shipment-delayed",
        rates: [{ object_id: "rate-delayed", amount: "7.73", currency: "USD" }],
      });
    };

    const result = await postShippoShipmentCreate({ parcels: [{ weight: "1.27" }] });

    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(calls.filter((call) => call.method === "GET").length, 6);
    assert.equal(result.ok, true);
    assert.equal(result.rates[0].object_id, "rate-delayed");
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previousEnv;
  }
});

test("admin shipment rating retries a UPS carrier rate limit", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = { ...process.env };
  const calls = [];
  try {
    process.env.SHIPPO_API_TOKEN = "shippo_test_contract";
    process.env.SHIPPO_API_BASE_URL = "https://shippo.test";
    process.env.SHIPPO_RATE_LIMIT_RETRY_COUNT = "1";
    process.env.SHIPPO_RATE_LIMIT_RETRY_DELAY_MS = "100";
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      if (calls.length === 1) {
        return shippoResponse({
          object_id: "shipment-limited",
          rates: [],
          messages: [{ source: "UPS", code: "10429", text: "Hard: Too Many Requests" }],
        });
      }
      return shippoResponse({
        object_id: "shipment-retried",
        rates: [{ object_id: "rate-ready", amount: "9.25", currency: "USD" }],
      });
    };

    const result = await postShippoShipmentCreate({ parcels: [{ weight: "1" }] });

    assert.deepEqual(calls.map((call) => call.method), ["POST", "POST"]);
    assert.equal(result.ok, true);
    assert.equal(result.shipmentId, "shipment-retried");
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previousEnv;
  }
});

test("admin shipment rating marks an exhausted UPS rate limit retryable", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = { ...process.env };
  const calls = [];
  try {
    process.env.SHIPPO_API_TOKEN = "shippo_test_contract";
    process.env.SHIPPO_API_BASE_URL = "https://shippo.test";
    process.env.SHIPPO_RATE_LIMIT_RETRY_COUNT = "1";
    process.env.SHIPPO_RATE_LIMIT_RETRY_DELAY_MS = "100";
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      return shippoResponse({
        object_id: "shipment-limited",
        rates: [],
        messages: [{ source: "UPS", code: "10429", text: "Hard: Too Many Requests" }],
      });
    };

    const result = await postShippoShipmentCreate({ parcels: [{ weight: "1" }] });

    assert.deepEqual(calls.map((call) => call.method), ["POST", "POST"]);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "SHIPPO_RATE_LIMITED");
    assert.equal(result.retryable, true);
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previousEnv;
  }
});
