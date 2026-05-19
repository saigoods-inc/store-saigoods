import assert from "node:assert/strict";
import test from "node:test";
import { collectInventoryAlertsFromEditor, stockLineKey } from "./stock.js";

function stockIndex(entries) {
  const index = new Map();
  for (const e of entries) {
    index.set(stockLineKey(e.slug, e.size, e.channel), {
      productSlug: e.slug,
      size: e.size,
      channel: e.channel,
      productName: "Test Product",
      active: true,
      track: true,
      onHand: e.onHand,
      reserved: e.reserved ?? 0,
      incoming: 0,
      damaged: 0,
    });
  }
  return index;
}

function editorForVariants(variants) {
  return {
    groups: [
      {
        productSlug: "test-gloves",
        catalogProductName: "Black Nitrile",
        boxesPerCase: 10,
        rows: variants.map((v) => ({
          productSlug: "test-gloves",
          catalogProductName: "Black Nitrile",
          size: v.size,
          casesOnHand: v.casesOnHand ?? 0,
          boxesOnHand: v.boxesOnHand ?? 0,
          trackCases: true,
          trackBoxes: true,
        })),
      },
    ],
  };
}

test("collectInventoryAlertsFromEditor flags empty and low sellable variants", () => {
  const index = stockIndex([
    { slug: "test-gloves", size: "M", channel: "case", onHand: 0 },
    { slug: "test-gloves", size: "M", channel: "box", onHand: 0 },
    { slug: "test-gloves", size: "L", channel: "case", onHand: 0 },
    { slug: "test-gloves", size: "L", channel: "box", onHand: 3 },
  ]);

  const editor = editorForVariants([
    { size: "M", casesOnHand: 0, boxesOnHand: 0 },
    { size: "L", casesOnHand: 0, boxesOnHand: 3 },
  ]);

  const alerts = collectInventoryAlertsFromEditor(editor, index);

  assert.equal(alerts.inventoryOutOfStock.count, 1);
  assert.equal(alerts.inventoryOutOfStock.rows[0].size, "M");
  assert.match(alerts.inventoryOutOfStock.rows[0].displayText, /0 available/);

  assert.equal(alerts.lowInventory.count, 1);
  assert.equal(alerts.lowInventory.rows[0].size, "L");
  assert.match(alerts.lowInventory.rows[0].displayText, /3 boxes available/);
});

test("collectInventoryAlertsFromEditor skips untracked variants", () => {
  const index = stockIndex([]);
  const editor = editorForVariants([{ size: "M", casesOnHand: 0, boxesOnHand: 0 }]);

  const alerts = collectInventoryAlertsFromEditor(editor, index);
  assert.equal(alerts.inventoryOutOfStock.count, 0);
  assert.equal(alerts.lowInventory.count, 0);
});

test("low inventory threshold is one case worth of boxes (boxesPerCase)", () => {
  const index = stockIndex([
    { slug: "test-gloves", size: "XL", channel: "case", onHand: 1 },
    { slug: "test-gloves", size: "XL", channel: "box", onHand: 0 },
  ]);
  const editor = editorForVariants([{ size: "XL", casesOnHand: 1, boxesOnHand: 0 }]);
  editor.groups[0].boxesPerCase = 10;

  const alerts = collectInventoryAlertsFromEditor(editor, index);
  assert.equal(alerts.inventoryOutOfStock.count, 0);
  assert.equal(alerts.lowInventory.count, 1);
  assert.equal(alerts.lowInventory.rows[0].displayText, "Black Nitrile / XL: 1 case available");
});
