import assert from "node:assert/strict";
import test from "node:test";
import { assertDiscountCartonCondition, normalizeMinimumCartons } from "./discount-carton-condition.js";

const carton = (slug, count, size = "M") => ({ slug, quantities: { [size]: count }, bundleLines: [{ id: "case_1", qty: count }] });

test("minimum cartons is optional, whole, and nonnegative", () => {
  for (const value of [undefined, null, "", 0, "0"]) assert.equal(normalizeMinimumCartons(value), 0);
  assert.equal(normalizeMinimumCartons("5"), 5);
  for (const value of [-1, 1.5, "five", Infinity, true, {}, []]) {
    assert.throws(() => normalizeMinimumCartons(value), /whole number/);
  }
});

test("legacy codes have no minimum and cartons combine across products and sizes", () => {
  assert.equal(assertDiscountCartonCondition({ code: "OLD7" }, []).minCartons, 0);
  const result = assertDiscountCartonCondition({ code: "FRIYAY999", min_cartons: 5, percentOff: 10 }, [
    carton("nitrile-standard", 2), carton("black-nitrile-general", 2), carton("black-nitrile-general", 1, "L"),
  ]);
  assert.equal(result.cartonCount, 5);
  assert.equal(result.minCartons, 5);
});

test("below the minimum rejects without counting loose boxes or shipping units", () => {
  assert.throws(() => assertDiscountCartonCondition({ code: "FRIYAY999", min_cartons: 5, percentOff: 10 }, [
    carton("black-nitrile-general", 4),
    { slug: "nitrile-standard", quantities: {}, boxQuantities: { M: 10 }, bundleLines: [{ id: "box_1", qty: 10 }] },
  ]), (error) => {
    assert.equal(error.code, "DISCOUNT_MIN_CARTONS");
    assert.equal(error.statusCode, 400);
    assert.equal(error.discount.cartonCount, 4);
    assert.equal(error.discount.missingCartons, 1);
    assert.match(error.message, /requires at least 5 cartons/);
    return true;
  });
});

test("one carton qualifies, extra cartons qualify, and unknown products cannot qualify", () => {
  for (const count of [1, 6]) assert.equal(assertDiscountCartonCondition({ code: "PSD398O", min_cartons: 1 }, [carton("black-nitrile-general", count)]).cartonCount, count);
  assert.throws(() => assertDiscountCartonCondition({ code: "PSD398O", min_cartons: 1 }, [carton("not-a-product", 20)]), /requires at least 1 carton/);
});
