import { getBundleDef, normaliseBundleLines } from "./bundles.js";
import { normalizeQuantities } from "./quote.js";
import { getProductMap, getSupportedSizesForProduct } from "./store.js";
import { getPackSpec } from "./shippo-parcel-packs.js";

function coerceJsonb(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const p = JSON.parse(value);
      if (p && typeof p === "object") {
        return p;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @typedef {object} LogicalParcelUnit
 * @property {string} packKey
 * @property {string} slug
 * @property {string} size
 * @property {string} [bundleId]
 * @property {string} [type] case_split
 * @property {string} [innerPackKey]
 * @property {number} [parcels]
 * @property {string[]} [sizeMix]
 */

function buildSizeQueue(quantities, sizes) {
  const map = normalizeQuantities(quantities || {}, sizes);
  const q = [];
  for (const size of sizes) {
    const n = Math.floor(Number(map[size]) || 0);
    for (let i = 0; i < n; i++) {
      q.push(size);
    }
  }
  return q;
}

/**
 * @param {object} item order.items row
 * @param {object} product from store
 * @param {string[]} knownSizes
 * @returns {LogicalParcelUnit[]}
 */
export function expandOrderLineToLogical(item, product, knownSizes) {
  const bundleLines = normaliseBundleLines(item.bundleLines);
  const boxQueue = buildSizeQueue(item.boxQuantities, knownSizes);
  const caseQueue = buildSizeQueue(item.quantities, knownSizes);

  if (bundleLines.length) {
    const acc = [];
    for (const bl of bundleLines) {
      for (let q = 0; q < bl.qty; q++) {
        acc.push(...expandOneBundlePurchase(bl.id, product, boxQueue, caseQueue));
      }
    }
    if (boxQueue.length || caseQueue.length) {
      const e = new Error(
        `Bundle/size allocation mismatch for ${product.slug}: leftover boxes=${boxQueue.length} cases=${caseQueue.length}`,
      );
      e.code = "PARCEL_ALLOCATION_MISMATCH";
      throw e;
    }
    return acc;
  }

  const out = [];
  while (boxQueue.length) {
    const size = boxQueue.shift();
    out.push({ packKey: "box_1", slug: product.slug, size, bundleId: null });
  }
  while (caseQueue.length) {
    const size = caseQueue.shift();
    out.push({ packKey: "case_1", slug: product.slug, size, bundleId: null });
  }
  return out;
}

/**
 * One bundle line quantity iteration (e.g. one "5 cases" bundle).
 */
function expandOneBundlePurchase(bundleId, product, boxQueue, caseQueue) {
  const def = getBundleDef(product, bundleId);
  if (!def) {
    const e = new Error(`Unknown bundle ${bundleId} for ${product.slug}`);
    e.code = "UNKNOWN_BUNDLE";
    throw e;
  }
  const kind = String(def.kind || "").toLowerCase();
  const units = Math.max(0, Math.floor(Number(def.units) || 0));
  const out = [];

  if (kind === "box") {
    if (bundleId === "box_1") {
      for (let i = 0; i < units; i++) {
        const size = boxQueue.shift();
        if (!size) {
          throw new Error(`Not enough per-size boxes for ${product.slug} ${bundleId}`);
        }
        out.push({ packKey: "box_1", slug: product.slug, size, bundleId });
      }
      return out;
    }
    if (bundleId === "box_5") {
      const mix = [];
      for (let i = 0; i < units; i++) {
        const s = boxQueue.shift();
        if (!s) {
          throw new Error(`Not enough per-size boxes for ${product.slug} ${bundleId}`);
        }
        mix.push(s);
      }
      out.push({
        packKey: "box_5",
        slug: product.slug,
        size: mix[0],
        bundleId,
        sizeMix: mix,
      });
      return out;
    }
  }

  if (kind === "case") {
    if (bundleId === "case_1") {
      for (let i = 0; i < units; i++) {
        const size = caseQueue.shift();
        if (!size) {
          throw new Error(`Not enough per-size cases for ${product.slug} ${bundleId}`);
        }
        out.push({ packKey: "case_1", slug: product.slug, size, bundleId });
      }
      return out;
    }
    if (bundleId === "case_5") {
      let first = null;
      for (let i = 0; i < 5; i++) {
        const s = caseQueue.shift();
        if (!s) {
          throw new Error(`Not enough per-size cases for ${product.slug} ${bundleId}`);
        }
        if (first === null) {
          first = s;
        }
      }
      out.push({ packKey: "case_5", slug: product.slug, size: first, bundleId });
      return out;
    }
    if (bundleId === "case_10") {
      let first = null;
      for (let i = 0; i < 10; i++) {
        const s = caseQueue.shift();
        if (!s) {
          throw new Error(`Not enough per-size cases for ${product.slug} ${bundleId}`);
        }
        if (first === null) {
          first = s;
        }
      }
      out.push({ packKey: "case_10", slug: product.slug, size: first, bundleId });
      return out;
    }
    if (bundleId === "case_20") {
      let first = null;
      for (let i = 0; i < 20; i++) {
        const s = caseQueue.shift();
        if (!s) {
          throw new Error(`Not enough per-size cases for ${product.slug} ${bundleId}`);
        }
        if (first === null) {
          first = s;
        }
      }
      out.push({ packKey: "case_20", slug: product.slug, size: first, bundleId });
      return out;
    }
  }

  throw new Error(`Unsupported bundle ${bundleId} (${kind}) for parcel expansion`);
}

/**
 * @returns {{ parcels: object[], audit: object[], source: string }}
 */
export function buildParcelsForOrder(orderRow) {
  const override = coerceJsonb(orderRow?.shippo_parcels_override_json);
  if (override && Array.isArray(override.parcels) && override.parcels.length) {
    const parcels = override.parcels.map((p) => normalizeParcelPayload(p));
    return {
      parcels,
      audit: [{ source: "admin_override", at: new Date().toISOString() }],
      source: "override",
    };
  }

  const productMap = getProductMap();
  const lines = Array.isArray(orderRow?.items) ? orderRow.items : [];
  const logical = [];

  for (const item of lines) {
    const product = productMap.get(item.slug);
    if (!product) {
      continue;
    }
    logical.push(...expandOrderLineToLogical(item, product, getSupportedSizesForProduct(product)));
  }

  if (!logical.length) {
    const e = new Error("No parcelable units derived from order line items.");
    e.code = "NO_PARCEL_UNITS";
    throw e;
  }

  return logicalUnitsToShippoParcels(logical);
}

function normalizeParcelPayload(p) {
  const o = p && typeof p === "object" ? p : {};
  return {
    length: String(o.length ?? "").trim(),
    width: String(o.width ?? "").trim(),
    height: String(o.height ?? "").trim(),
    distance_unit: String(o.distance_unit || "in").trim(),
    weight: String(o.weight ?? "").trim(),
    mass_unit: String(o.mass_unit || "lb").trim(),
    ...(o.metadata ? { metadata: String(o.metadata).slice(0, 100) } : {}),
  };
}

/**
 * @param {LogicalParcelUnit[]} logical
 */
export function logicalUnitsToShippoParcels(logical) {
  const parcels = [];
  const audit = [];

  for (const L of logical) {
    if (L.type === "case_split") {
      const spec = getPackSpec(L.slug, "Small", L.innerPackKey);
      if (!spec || spec.weightLb <= 0) {
        throw new Error(`Missing pack spec for split ${L.slug} ${L.innerPackKey}`);
      }
      for (let p = 0; p < L.parcels; p++) {
        const meta = `${L.slug}:${L.bundleId}:p${p + 1}of${L.parcels}`.slice(0, 100);
        parcels.push({
          length: String(spec.length),
          width: String(spec.width),
          height: String(spec.height),
          distance_unit: "in",
          weight: String(spec.weightLb),
          mass_unit: "lb",
          metadata: meta,
        });
        audit.push({
          rule: "case_bundle_split",
          bundleId: L.bundleId,
          innerPackKey: L.innerPackKey,
          splitIndex: p + 1,
          splitTotal: L.parcels,
          slug: L.slug,
          spec,
        });
      }
      continue;
    }

    const spec = getPackSpec(L.slug, L.size, L.packKey);
    if (!spec || spec.weightLb <= 0) {
      throw new Error(`Missing parcel pack spec for ${L.slug} size ${L.size} pack ${L.packKey}`);
    }
    const meta = `${L.slug}:${L.packKey}:${L.size}`.slice(0, 100);
    parcels.push({
      length: String(spec.length),
      width: String(spec.width),
      height: String(spec.height),
      distance_unit: "in",
      weight: String(spec.weightLb),
      mass_unit: "lb",
      metadata: meta,
    });
    audit.push({
      slug: L.slug,
      size: L.size,
      packKey: L.packKey,
      bundleId: L.bundleId || null,
      spec,
      sizeMix: L.sizeMix || null,
    });
  }

  return { parcels, audit, source: "computed" };
}
