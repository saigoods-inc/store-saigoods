import test from "node:test";
import assert from "node:assert/strict";

import { buildProductLineItemsBlocksHtml } from "./payment-link-email-order-details.js";

test("payment link email bundle line keeps bundle label separate from quantity", () => {
  const html = buildProductLineItemsBlocksHtml({
    items: [
      {
        slug: "nitrile-standard",
        name: "Nitrile Examination - Standard",
        bundleLines: [{ id: "box_1", qty: 2 }],
        quantities: {},
        boxQuantities: { S: 1, M: 1 },
        lineTotalFormatted: "$17.98",
      },
    ],
  });

  assert.match(html, /Bundle: 1 box/);
  assert.match(html, /Size: Small, Medium/);
  assert.match(html, /Quantity: 2x/);
  assert.doesNotMatch(html, /Bundle: 2x 1 box/);
});

test("payment link email humanizes a dynamic bundle id when the catalog label is unavailable", () => {
  const html = buildProductLineItemsBlocksHtml({
    items: [
      {
        slug: "nitrile-standard",
        name: "Nitrile Examination - Standard",
        bundleLines: [{ id: "5_boxes", qty: 1 }],
        quantities: {},
        boxQuantities: { M: 5 },
      },
    ],
  });

  assert.match(html, /Bundle: 5 boxes/);
  assert.doesNotMatch(html, /5_boxes/);
});
