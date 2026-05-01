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

test("5-box bundle (box_5) on M with sizes — no allocation assert error", () => {
  assert.doesNotThrow(() =>
    assertCartItemsHaveValidSupportedSizeAllocation([
      {
        slug: SLUG,
        bundleLines: [{ id: "box_5", qty: 1 }],
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

test("stock: 5-box bundle (M×5) — passes when enough boxes/cases in file stock", async () => {
  await assertStockAvailableForItems([
    {
      slug: SLUG,
      bundleLines: [{ id: "box_5", qty: 1 }],
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
