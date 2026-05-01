/**
 * Asserts Shippo parcel expansion for bundle SKUs: one physical case = one parcel max.
 * Run: node scripts/test-parcel-bundle-expansion.mjs
 */
import { buildParcelsForOrder } from "../lib/shippo-order-parcels.js";

const SLUG = "nitrile-standard";

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg || "assertion failed");
  }
}

function run(name, orderRow, expect) {
  const { parcels, audit, source } = buildParcelsForOrder(orderRow);
  assert(source === "computed", "source computed");
  assert(parcels.length === expect.count, `${name}: expected ${expect.count} parcels, got ${parcels.length}`);
  if (expect.allPackKeys) {
    const pks = audit.map((a) => a.packKey);
    for (const pk of expect.allPackKeys) {
      assert(pks.every((x) => x === pk), `${name}: all packKey should be ${pk}`);
    }
  }
  if (expect.metadataIncludes) {
    for (const sub of expect.metadataIncludes) {
      assert(
        parcels.some((p) => String(p.metadata || "").includes(sub)),
        `${name}: metadata should include ${sub}, got ${parcels.map((p) => p.metadata).join(" | ")}`,
      );
    }
  }
  console.log(`ok: ${name} (${parcels.length} parcel(s))`);
}

const base = { items: [{ slug: SLUG }] };

run(
  "5 boxes only",
  {
    items: [
      {
        ...base.items[0],
        quantities: {},
        boxQuantities: { M: 5 },
        bundleLines: [{ id: "box_5", qty: 1 }],
      },
    ],
  },
  { count: 1, allPackKeys: ["box_5"], metadataIncludes: [":box_5:"] },
);

run(
  "1 case only (bundle)",
  {
    items: [
      {
        ...base.items[0],
        quantities: { M: 1 },
        boxQuantities: {},
        bundleLines: [{ id: "case_1", qty: 1 }],
      },
    ],
  },
  { count: 1, allPackKeys: ["case_1"], metadataIncludes: [":case_1:", "bd=case_1"] },
);

run(
  "5 cases only",
  {
    items: [
      {
        ...base.items[0],
        quantities: { M: 5 },
        boxQuantities: {},
        bundleLines: [{ id: "case_5", qty: 1 }],
      },
    ],
  },
  { count: 5, allPackKeys: ["case_1"], metadataIncludes: [":bd=case_5:", "pkg=1of5", "pkg=5of5"] },
);

run(
  "10 cases only",
  {
    items: [
      {
        ...base.items[0],
        quantities: { M: 10 },
        boxQuantities: {},
        bundleLines: [{ id: "case_10", qty: 1 }],
      },
    ],
  },
  { count: 10, allPackKeys: ["case_1"], metadataIncludes: [":bd=case_10:", "pkg=1of10", "pkg=10of10"] },
);

run(
  "20 cases only",
  {
    items: [
      {
        ...base.items[0],
        quantities: { M: 20 },
        boxQuantities: {},
        bundleLines: [{ id: "case_20", qty: 1 }],
      },
    ],
  },
  { count: 20, allPackKeys: ["case_1"], metadataIncludes: [":bd=case_20:", "pkg=1of20", "pkg=20of20"] },
);

/* A la carte 3 cases = 3 parcels, no multi-case bundle id */
const { parcels: ala, audit: alaAudit } = buildParcelsForOrder({
  items: [{ slug: SLUG, quantities: { M: 3 }, boxQuantities: {}, bundleLines: [] }],
});
assert(ala.length === 3, "a la carte 3 cases");
assert(alaAudit.every((a) => a.packKey === "case_1"), "a la carte all case_1");
assert(!String(ala[0].metadata).includes("bd=case_5"), "a la carte no bundle id");
console.log("ok: 3 a la carte cases (3 parcels, no multi-case metadata)");

console.log("PASS: parcel bundle expansion");
