import assert from "node:assert/strict";
import test from "node:test";
import { normaliseBundleLinesForCart } from "./cart-store.js";

test("saved multi-unit bundles migrate to canonical single-unit quantities", () => {
  assert.deepEqual(
    normaliseBundleLinesForCart([
      { id: "box_5", qty: 2 },
      { id: "box_1", qty: 1 },
      { id: "case_10", qty: 1 },
      { id: "case_5", qty: 2 },
    ]),
    [
      { id: "box_1", qty: 11 },
      { id: "case_1", qty: 20 },
    ],
  );
});

test("unknown bundle identifiers remain visible to server validation", () => {
  assert.deepEqual(normaliseBundleLinesForCart([{ id: "special_offer", qty: 2 }]), [
    { id: "special_offer", qty: 2 },
  ]);
});
