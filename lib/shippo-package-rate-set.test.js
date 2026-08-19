import assert from "node:assert/strict";
import test from "node:test";
import { aggregateShippoPackageRates } from "./shippo-package-rate-set.js";

function rate(id, service, amount, days = null, provider = "UPS") {
  return {
    object_id: id,
    provider,
    amount: String(amount),
    currency: "USD",
    estimated_days: days,
    servicelevel: { token: service, name: service === "ground" ? "Ground" : "Air" },
  };
}

test("aggregates only services available for every package", () => {
  const result = aggregateShippoPackageRates([
    [rate("p1-ground", "ground", 10, 2), rate("p1-air", "air", 20, 1)],
    [rate("p2-ground", "ground", 12, 4)],
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].object_id, "package-set:ups:ground:2");
  assert.equal(result[0].amount, "22.00");
  assert.equal(result[0].estimated_days, 4);
  assert.deepEqual(result[0].package_rate_object_ids, ["p1-ground", "p2-ground"]);
});

test("uses the cheapest duplicate service per package", () => {
  const result = aggregateShippoPackageRates([
    [rate("expensive", "ground", 15), rate("cheap", "ground", 9)],
    [rate("second", "ground", 8)],
  ]);
  assert.equal(result[0].amount, "17.00");
  assert.deepEqual(result[0].package_rate_object_ids, ["cheap", "second"]);
});

test("returns no option when packages have no common service", () => {
  assert.deepEqual(
    aggregateShippoPackageRates([[rate("ground", "ground", 10)], [rate("air", "air", 20)]]),
    [],
  );
});
