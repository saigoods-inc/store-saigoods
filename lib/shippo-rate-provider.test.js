import assert from "node:assert/strict";
import test from "node:test";
import { getShippoRateQuoteForCheckout } from "./shippo-rate-provider.js";

function response(objectId, amount, rateId) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      object_id: objectId,
      rates: [
        {
          object_id: rateId,
          provider: "UPS",
          amount: String(amount),
          currency: "USD",
          estimated_days: 3,
          servicelevel: { token: "ups_ground", name: "Ground" },
        },
      ],
    }),
  };
}

test("multi-package checkout rates each parcel and sums the purchasable service", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = { ...process.env };
  const calls = [];
  try {
    process.env.SHIPPO_API_TOKEN = "shippo_test_contract";
    process.env.SHIPPO_FROM_NAME = "Warehouse";
    process.env.SHIPPO_FROM_STREET1 = "275 Eureka St";
    process.env.SHIPPO_FROM_CITY = "Savannah";
    process.env.SHIPPO_FROM_STATE = "TN";
    process.env.SHIPPO_FROM_ZIP = "38372";
    process.env.SHIPPO_FROM_COUNTRY = "US";
    delete process.env.SHIPPO_UPS_CARRIER_ACCOUNT_ID;
    delete process.env.SHIPPO_CARRIER_ACCOUNT_IDS;
    globalThis.fetch = async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return calls.length === 1 ? response("shipment-1", 9.25, "rate-1") : response("shipment-2", 11.5, "rate-2");
    };

    const result = await getShippoRateQuoteForCheckout({
      address: { line1: "2009 Ben Hill Ct", city: "Nolensville", state: "TN", postalCode: "37135", country: "US" },
      parcels: [
        { length: "10", width: "8", height: "6", distance_unit: "in", weight: "5", mass_unit: "lb" },
        { length: "12", width: "9", height: "7", distance_unit: "in", weight: "8", mass_unit: "lb" },
      ],
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].parcels.length, 1);
    assert.equal(calls[1].parcels.length, 1);
    assert.equal(result.bestRate.amountCents, 2075);
    assert.equal(result.bestRate.providerQuoteId, "package-set:ups:ups_ground:2");
    assert.deepEqual(result.raw.shippoShipmentIds, ["shipment-1", "shipment-2"]);
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previousEnv;
  }
});

test("multi-package checkout starts independent package ratings concurrently", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = { ...process.env };
  const calls = [];
  const pending = [];
  try {
    process.env.SHIPPO_API_TOKEN = "shippo_test_contract";
    process.env.SHIPPO_FROM_NAME = "Warehouse";
    process.env.SHIPPO_FROM_STREET1 = "275 Eureka St";
    process.env.SHIPPO_FROM_CITY = "Savannah";
    process.env.SHIPPO_FROM_STATE = "TN";
    process.env.SHIPPO_FROM_ZIP = "38372";
    process.env.SHIPPO_FROM_COUNTRY = "US";
    delete process.env.SHIPPO_UPS_CARRIER_ACCOUNT_ID;
    delete process.env.SHIPPO_CARRIER_ACCOUNT_IDS;
    globalThis.fetch = (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Promise((resolve) => pending.push(resolve));
    };

    const resultPromise = getShippoRateQuoteForCheckout({
      address: { line1: "2009 Ben Hill Ct", city: "Nolensville", state: "TN", postalCode: "37135", country: "US" },
      parcels: [
        { length: "10", width: "8", height: "6", distance_unit: "in", weight: "5", mass_unit: "lb" },
        { length: "12", width: "9", height: "7", distance_unit: "in", weight: "8", mass_unit: "lb" },
      ],
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2);
    pending[0](response("shipment-1", 9.25, "rate-1"));
    pending[1](response("shipment-2", 11.5, "rate-2"));

    const result = await resultPromise;
    assert.equal(result.bestRate.amountCents, 2075);
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previousEnv;
  }
});

test("empty Shippo rates poll the created shipment instead of creating duplicate shipments", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = { ...process.env };
  const calls = [];
  try {
    process.env.SHIPPO_API_TOKEN = "shippo_test_contract";
    process.env.SHIPPO_FROM_NAME = "Warehouse";
    process.env.SHIPPO_FROM_STREET1 = "275 Eureka St";
    process.env.SHIPPO_FROM_CITY = "Savannah";
    process.env.SHIPPO_FROM_STATE = "TN";
    process.env.SHIPPO_FROM_ZIP = "38372";
    process.env.SHIPPO_FROM_COUNTRY = "US";
    delete process.env.SHIPPO_RATE_EMPTY_RETRY_COUNT;
    process.env.SHIPPO_RATE_EMPTY_RETRY_DELAY_MS = "100";
    delete process.env.SHIPPO_UPS_CARRIER_ACCOUNT_ID;
    delete process.env.SHIPPO_CARRIER_ACCOUNT_IDS;

    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      if (calls.length === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ object_id: "shipment-pending", rates: [] }),
        };
      }
      return response("shipment-pending", 9.25, "rate-ready");
    };

    const result = await getShippoRateQuoteForCheckout({
      address: { line1: "2009 Ben Hill Ct", city: "Nolensville", state: "TN", postalCode: "37135", country: "US" },
      parcels: [{ length: "10", width: "8", height: "6", distance_unit: "in", weight: "5", mass_unit: "lb" }],
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[1].method, "GET");
    assert.match(calls[1].url, /\/shipments\/shipment-pending\/$/);
    assert.equal(result.bestRate.providerQuoteId, "rate-ready");
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previousEnv;
  }
});

test("checkout waits through the sixth poll with one Shippo shipment POST", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = { ...process.env };
  const calls = [];
  try {
    process.env.SHIPPO_API_TOKEN = "shippo_test_contract";
    process.env.SHIPPO_FROM_NAME = "Warehouse";
    process.env.SHIPPO_FROM_STREET1 = "275 Eureka St";
    process.env.SHIPPO_FROM_CITY = "Savannah";
    process.env.SHIPPO_FROM_STATE = "TN";
    process.env.SHIPPO_FROM_ZIP = "38372";
    process.env.SHIPPO_FROM_COUNTRY = "US";
    delete process.env.SHIPPO_RATE_EMPTY_RETRY_COUNT;
    process.env.SHIPPO_RATE_EMPTY_RETRY_DELAY_MS = "100";
    delete process.env.SHIPPO_UPS_CARRIER_ACCOUNT_ID;
    delete process.env.SHIPPO_CARRIER_ACCOUNT_IDS;

    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      if (calls.length === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ object_id: "shipment-delayed", rates: [] }),
        };
      }
      if (calls.length < 7) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ object_id: "shipment-delayed", rates: [] }),
        };
      }
      return response("shipment-delayed", 13.32, "rate-sixth-poll");
    };

    const result = await getShippoRateQuoteForCheckout({
      address: { line1: "12685 Ulmerton Rd", city: "Largo", state: "FL", postalCode: "33774", country: "US" },
      parcels: [{ length: "10", width: "8", height: "6", distance_unit: "in", weight: "5", mass_unit: "lb" }],
    });

    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(calls.filter((call) => call.method === "GET").length, 6);
    assert.ok(calls.slice(1).every((call) => /\/shipments\/shipment-delayed\/$/.test(call.url)));
    assert.equal(result.bestRate.providerQuoteId, "rate-sixth-poll");
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previousEnv;
  }
});

test("exhausted delayed rates never create another Shippo shipment", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = { ...process.env };
  const calls = [];
  try {
    process.env.SHIPPO_API_TOKEN = "shippo_test_contract";
    process.env.SHIPPO_FROM_NAME = "Warehouse";
    process.env.SHIPPO_FROM_STREET1 = "275 Eureka St";
    process.env.SHIPPO_FROM_CITY = "Savannah";
    process.env.SHIPPO_FROM_STATE = "TN";
    process.env.SHIPPO_FROM_ZIP = "38372";
    process.env.SHIPPO_FROM_COUNTRY = "US";
    delete process.env.SHIPPO_RATE_EMPTY_RETRY_COUNT;
    process.env.SHIPPO_RATE_EMPTY_RETRY_DELAY_MS = "100";
    delete process.env.SHIPPO_UPS_CARRIER_ACCOUNT_ID;
    delete process.env.SHIPPO_CARRIER_ACCOUNT_IDS;

    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      return {
        ok: true,
        status: 200,
        json: async () => ({ object_id: "shipment-still-pending", rates: [] }),
      };
    };

    await assert.rejects(
      getShippoRateQuoteForCheckout({
        address: { line1: "12685 Ulmerton Rd", city: "Largo", state: "FL", postalCode: "33774", country: "US" },
        parcels: [{ length: "10", width: "8", height: "6", distance_unit: "in", weight: "5", mass_unit: "lb" }],
      }),
      (error) => error?.code === "SHIPPO_NO_RATES",
    );

    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(calls.filter((call) => call.method === "GET").length, 8);
    assert.ok(calls.slice(1).every((call) => /\/shipments\/shipment-still-pending\/$/.test(call.url)));
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previousEnv;
  }
});

test("checkout retries a carrier rate limit with a new Shippo shipment POST", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = { ...process.env };
  const calls = [];
  try {
    process.env.SHIPPO_API_TOKEN = "shippo_test_contract";
    process.env.SHIPPO_FROM_NAME = "Warehouse";
    process.env.SHIPPO_FROM_STREET1 = "275 Eureka St";
    process.env.SHIPPO_FROM_CITY = "Savannah";
    process.env.SHIPPO_FROM_STATE = "TN";
    process.env.SHIPPO_FROM_ZIP = "38372";
    process.env.SHIPPO_FROM_COUNTRY = "US";
    process.env.SHIPPO_RATE_LIMIT_RETRY_COUNT = "1";
    process.env.SHIPPO_RATE_LIMIT_RETRY_DELAY_MS = "100";
    delete process.env.SHIPPO_UPS_CARRIER_ACCOUNT_ID;
    delete process.env.SHIPPO_CARRIER_ACCOUNT_IDS;

    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      if (calls.length === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            object_id: "shipment-limited",
            rates: [],
            messages: [{ source: "UPS", code: "10429", text: "Hard: Too Many Requests" }],
          }),
        };
      }
      return response("shipment-retried", 9.25, "rate-after-limit");
    };

    const result = await getShippoRateQuoteForCheckout({
      address: { line1: "2009 Ben Hill Ct", city: "Nolensville", state: "TN", postalCode: "37135", country: "US" },
      parcels: [{ length: "10", width: "8", height: "6", distance_unit: "in", weight: "5", mass_unit: "lb" }],
    });

    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.method === "POST"));
    assert.equal(result.bestRate.providerQuoteId, "rate-after-limit");
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previousEnv;
  }
});

test("missing Shippo shipment ID fails without another POST", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = { ...process.env };
  let calls = 0;
  try {
    process.env.SHIPPO_API_TOKEN = "shippo_test_contract";
    process.env.SHIPPO_FROM_NAME = "Warehouse";
    process.env.SHIPPO_FROM_STREET1 = "275 Eureka St";
    process.env.SHIPPO_FROM_CITY = "Savannah";
    process.env.SHIPPO_FROM_STATE = "TN";
    process.env.SHIPPO_FROM_ZIP = "38372";
    process.env.SHIPPO_FROM_COUNTRY = "US";
    delete process.env.SHIPPO_RATE_EMPTY_RETRY_COUNT;
    process.env.SHIPPO_RATE_EMPTY_RETRY_DELAY_MS = "100";
    delete process.env.SHIPPO_UPS_CARRIER_ACCOUNT_ID;
    delete process.env.SHIPPO_CARRIER_ACCOUNT_IDS;
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ rates: [] }) };
    };

    await assert.rejects(
      getShippoRateQuoteForCheckout({
        address: { line1: "12685 Ulmerton Rd", city: "Largo", state: "FL", postalCode: "33774", country: "US" },
        parcels: [{ length: "10", width: "8", height: "6", distance_unit: "in", weight: "5", mass_unit: "lb" }],
      }),
      (error) => error?.code === "SHIPPO_SHIPMENT_ID_MISSING",
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    process.env = previousEnv;
  }
});
