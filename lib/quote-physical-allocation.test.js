import assert from "node:assert/strict";
import test from "node:test";
import { assertCartItemsHaveValidSupportedSizeAllocation, rawSizeIntentTotalCount } from "./quote.js";
import { assertStockAvailableForItems } from "./stock.js";

const SLUG = "black-nitrile-general";

/** Deterministic file-backed stock for this suite (avoids Supabase in dev env). */
process.env.INVENTORY_BACKEND = "file";

test("rawSizeIntentTotalCount sums across arbitrary keys", () => {
  assert.equal(
    rawSizeIntentTotalCount({
      quantities: { S: 1, M: 0 },
      boxQuantities: { M: 2, L: 0 },
    }),
    3,
  );
  assert.equal(rawSizeIntentTotalCount({}), 0);
});

test("1 box (bundle) on M — no allocation assert error", () => {
  assert.doesNotThrow(() =>
    assertCartItemsHaveValidSupportedSizeAllocation([
      {
        slug: SLUG,
        bundleLines: [{ id: "box_1", qty: 1 }],
        quantities: {},
        boxQuantities: { M: 1, L: 0, S: 0, XL: 0 },
      },
    ]),
  );
});

test("1 box (bundle) on L — no allocation assert error", () => {
  assert.doesNotThrow(() =>
    assertCartItemsHaveValidSupportedSizeAllocation([
      {
        slug: SLUG,
        bundleLines: [{ id: "box_1", qty: 1 }],
        quantities: {},
        boxQuantities: { M: 0, L: 1 },
      },
    ]),
  );
});

test("bundle on S only — 400 and exact bundle message", () => {
  assert.throws(
    () =>
      assertCartItemsHaveValidSupportedSizeAllocation([
        {
          slug: SLUG,
          bundleLines: [{ id: "box_1", qty: 1 }],
          quantities: {},
          boxQuantities: { S: 1, M: 0, L: 0, XL: 0 },
        },
      ]),
    (e) =>
      e.statusCode === 400 &&
      e.message ===
        "Selected bundle has no valid supported size allocation. Please choose a supported size.",
  );
});

test("a-la-carte on S only (no bundle) — unsupported sizes message", () => {
  assert.throws(
    () =>
      assertCartItemsHaveValidSupportedSizeAllocation([
        {
          slug: SLUG,
          boxQuantities: { S: 1, M: 0, L: 0 },
        },
      ]),
    (e) => e.statusCode === 400 && e.message.includes("Quantity is set on sizes this product does not offer"),
  );
});

test("supported quantities without a bundle are rejected", () => {
  assert.throws(
    () =>
      assertCartItemsHaveValidSupportedSizeAllocation([
        {
          slug: SLUG,
          boxQuantities: { M: 2, L: 0 },
        },
      ]),
    (e) => e.statusCode === 400 && e.message === "Choose a 1 box or 1 carton bundle before checkout.",
  );
});

test("retired multi-unit bundles are rejected by the server", () => {
  assert.throws(
    () =>
      assertCartItemsHaveValidSupportedSizeAllocation([
        {
          slug: SLUG,
          bundleLines: [{ id: "box_5", qty: 1 }],
          boxQuantities: { M: 5, L: 0 },
        },
      ]),
    (e) => e.statusCode === 400 && e.message === "Unknown bundle: box_5",
  );
});

test("five 1-box bundles on M — no allocation assert error", () => {
  assert.doesNotThrow(() =>
    assertCartItemsHaveValidSupportedSizeAllocation([
      {
        slug: SLUG,
        bundleLines: [{ id: "box_1", qty: 5 }],
        quantities: {},
        boxQuantities: { M: 5, L: 0 },
      },
    ]),
  );
});

test("1 case (case_1) on M — no allocation assert error", () => {
  assert.doesNotThrow(() =>
    assertCartItemsHaveValidSupportedSizeAllocation([
      {
        slug: SLUG,
        bundleLines: [{ id: "case_1", qty: 1 }],
        quantities: { M: 1, L: 0 },
        boxQuantities: {},
      },
    ]),
  );
});

test("1 carton and 3 boxes on the same size are accepted together", () => {
  assert.doesNotThrow(() =>
    assertCartItemsHaveValidSupportedSizeAllocation([
      {
        slug: "nitrile-standard",
        bundleLines: [
          { id: "case_1", qty: 1 },
          { id: "box_1", qty: 3 },
        ],
        quantities: { S: 1, M: 0, L: 0, XL: 0 },
        boxQuantities: { S: 3, M: 0, L: 0, XL: 0 },
      },
    ]),
  );
});

test("bundle with no per-size lines at all — 400 (bundle message)", () => {
  assert.throws(
    () =>
      assertCartItemsHaveValidSupportedSizeAllocation([
        {
          slug: SLUG,
          bundleLines: [{ id: "box_1", qty: 1 }],
          quantities: {},
          boxQuantities: {},
        },
      ]),
    (e) =>
      e.statusCode === 400 &&
      e.message ===
        "Selected bundle has no valid supported size allocation. Please choose a supported size.",
  );
});

test("stock: 1 box on M with file inventory (200 cases M + boxes) — passes stock assert", async () => {
  await assertStockAvailableForItems([
    {
      slug: SLUG,
      bundleLines: [{ id: "box_1", qty: 1 }],
      quantities: {},
      boxQuantities: { M: 1, L: 0 },
    },
  ]);
});

test("stock: 1 box on L with file inventory — passes stock assert", async () => {
  await assertStockAvailableForItems([
    {
      slug: SLUG,
      bundleLines: [{ id: "box_1", qty: 1 }],
      quantities: {},
      boxQuantities: { M: 0, L: 1 },
    },
  ]);
});

test("stock: five 1-box bundles on M — passes when enough boxes/cartons are in stock", async () => {
  await assertStockAvailableForItems([
    {
      slug: SLUG,
      bundleLines: [{ id: "box_1", qty: 5 }],
      quantities: {},
      boxQuantities: { M: 5, L: 0 },
    },
  ]);
});

test("stock: 1 case on M — passes (case line)", async () => {
  await assertStockAvailableForItems([
    {
      slug: SLUG,
      bundleLines: [{ id: "case_1", qty: 1 }],
      quantities: { M: 1, L: 0 },
      boxQuantities: {},
    },
  ]);
});
