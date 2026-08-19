import { getBundleDef } from "./bundles.js";
import { normalizeItemLineForOrderProcessing, normalizeQuantities } from "./quote.js";
import { getProductMap } from "./store.js";
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

function buildOverrideParcelPlan(orderRow) {
  const override = coerceJsonb(orderRow?.shippo_parcels_override_json);
  if (override && Array.isArray(override.parcels) && override.parcels.length) {
    const parcels = override.parcels.map((p) => normalizeParcelPayload(p));
    const source =
      override.source === "selected_fulfillment_packing_plan"
        ? "selected_packing_plan"
        : "override";
    return {
      parcels,
      audit: [
        {
          source,
          at: override.selectedAt || new Date().toISOString(),
          planId: override.planId || null,
          parcelContents: Array.isArray(override.parcelContents) ? override.parcelContents : null,
          fulfillmentUnits: Array.isArray(override.fulfillmentUnits) ? override.fulfillmentUnits : null,
        },
      ],
      source,
    };
  }
  return null;
}

function parcelPayloadComplete(parcel) {
  const p = parcel && typeof parcel === "object" ? parcel : {};
  for (const key of ["length", "width", "height", "weight"]) {
    const value = String(p[key] ?? "").trim();
    if (!value || !Number.isFinite(Number(value)) || Number(value) <= 0) {
      return false;
    }
  }
  return true;
}

function buildQuotedSnapshotParcelPlan(orderRow) {
  const snapshot = coerceJsonb(orderRow?.quoted_parcel_summary_json);
  const rawParcels = Array.isArray(snapshot?.parcels) ? snapshot.parcels : [];
  if (!rawParcels.length) {
    return null;
  }
  if (
    snapshot?.parcelCount != null &&
    Number.isFinite(Number(snapshot.parcelCount)) &&
    Math.max(0, Math.round(Number(snapshot.parcelCount))) !== rawParcels.length
  ) {
    return null;
  }
  const parcels = rawParcels.map((p) => normalizeParcelPayload(p));
  if (!parcels.every(parcelPayloadComplete)) {
    return null;
  }
  return {
    parcels,
    audit: [
      {
        source: "quoted_checkout_snapshot",
        quotedParcelCount:
          snapshot?.parcelCount != null && Number.isFinite(Number(snapshot.parcelCount))
            ? Math.max(0, Math.round(Number(snapshot.parcelCount)))
            : parcels.length,
        quotedSource: snapshot?.source || null,
        shippoRatingShipmentId: snapshot?.shippoRatingShipmentId || null,
      },
    ],
    source: "quoted_snapshot",
  };
}

/**
 * @typedef {object} LogicalParcelUnit
 * @property {string} packKey
 * @property {string} slug
 * @property {string} size
 * @property {string} [bundleId] storefront bundle id (e.g. case_5)
 * @property {string} [physicalPack] always the Shippo spec key: case_1 | box_1 | box_5
 * @property {number} [packageIndex] 1-based within the bundle line
 * @property {number} [packageCount] e.g. 5 for a case_5 line
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
 * @returns {LogicalParcelUnit[]}
 */
export function expandOrderLineToLogical(item, product) {
  const n = normalizeItemLineForOrderProcessing(item, product);
  if (!n.hasPhysicalDemand) {
    return [];
  }
  const bundleLines = n.bundleLines;
  const boxQueue = buildSizeQueue(n.boxQuantities, n.sizes);
  const caseQueue = buildSizeQueue(n.quantities, n.sizes);

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
    out.push({ packKey: "case_1", physicalPack: "case_1", slug: product.slug, size, bundleId: null });
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
    // Bundle ids are admin-defined. Physical expansion therefore follows the
    // catalog definition instead of recognizing only box_1 / box_5.
    if (units === 1) {
      for (let i = 0; i < units; i++) {
        const size = boxQueue.shift();
        if (!size) {
          throw new Error(`Not enough per-size boxes for ${product.slug} ${bundleId}`);
        }
        out.push({ packKey: "box_1", physicalPack: "box_1", slug: product.slug, size, bundleId });
      }
      return out;
    }
    if (units === 5) {
      const mix = [];
      for (let i = 0; i < units; i++) {
        const s = boxQueue.shift();
        if (!s) {
          throw new Error(`Not enough per-size boxes for ${product.slug} ${bundleId}`);
        }
        mix.push(s);
      }
      out.push({
        packKey: units === 5 ? "box_5" : "box_1",
        physicalPack: units === 5 ? "box_5" : "box_1",
        slug: product.slug,
        size: mix[0],
        bundleId,
        sizeMix: mix,
      });
      return out;
    }
    if (units > 1) {
      for (let i = 0; i < units; i++) {
        const size = boxQueue.shift();
        if (!size) throw new Error(`Not enough per-size boxes for ${product.slug} ${bundleId}`);
        out.push({ packKey: "box_1", physicalPack: "box_1", slug: product.slug, size, bundleId, packageIndex: i + 1, packageCount: units });
      }
      return out;
    }
  }

  if (kind === "case") {
    if (units > 0) {
      for (let i = 0; i < units; i++) {
        const size = caseQueue.shift();
        if (!size) {
          throw new Error(`Not enough per-size cases for ${product.slug} ${bundleId}`);
        }
        out.push({
          packKey: "case_1",
          physicalPack: "case_1",
          slug: product.slug,
          size,
          bundleId,
          packageIndex: i + 1,
          packageCount: units,
        });
      }
      return out;
    }
  }

  throw new Error(`Unsupported bundle ${bundleId} (${kind}) for parcel expansion`);
}

/**
 * @returns {{ parcels: object[], audit: object[], source: string }}
 */
export function buildParcelsForOrder(orderRow) {
  const overridePlan = buildOverrideParcelPlan(orderRow);
  if (overridePlan) {
    return overridePlan;
  }

  const productMap = getProductMap();
  const lines = Array.isArray(orderRow?.items) ? orderRow.items : [];
  const logical = [];

  for (const item of lines) {
    const product = productMap.get(item.slug);
    if (!product) {
      continue;
    }
    logical.push(...expandOrderLineToLogical(item, product));
  }

  if (!logical.length) {
    const e = new Error("No parcelable units derived from order line items.");
    e.code = "NO_PARCEL_UNITS";
    throw e;
  }

  return logicalUnitsToShippoParcels(logical);
}

/**
 * Fulfillment resolver: use the exact parcel set quoted at checkout when present,
 * unless staff provided an override. Older orders still fall back to computed parcels.
 * @returns {{ parcels: object[], audit: object[], source: string }}
 */
export function resolveParcelsForFulfillment(orderRow) {
  const overridePlan = buildOverrideParcelPlan(orderRow);
  if (overridePlan) {
    return overridePlan;
  }
  const quotedPlan = buildQuotedSnapshotParcelPlan(orderRow);
  if (quotedPlan) {
    return quotedPlan;
  }
  return buildParcelsForOrder(orderRow);
}

function normalizeParcelPayload(p) {
  const o = p && typeof p === "object" ? p : {};
  return {
    length: String(o.length ?? "").trim(),
    width: String(o.width ?? "").trim(),
    height: String(o.height ?? "").trim(),
    distance_unit: String(o.distance_unit || o.distanceUnit || "in").trim(),
    weight: String(o.weight ?? "").trim(),
    mass_unit: String(o.mass_unit || o.massUnit || "lb").trim(),
    ...(o.metadata ? { metadata: String(o.metadata).slice(0, 100) } : {}),
  };
}

/**
 * @param {LogicalParcelUnit & { slug: string, packKey: string, size: string }} L
 */
function buildShippoParcelMetadata(L) {
  const slug = String(L.slug || "").trim();
  const pk = String(L.packKey || "").trim();
  const size = String(L.size || "").trim();
  if (L.packageCount && L.packageIndex) {
    return `${slug}:phy=case_1:bd=${String(L.bundleId || "")}:pkg=${L.packageIndex}of${L.packageCount}:${size}`.slice(0, 100);
  }
  if (L.bundleId) {
    return `${slug}:${pk}:${size}:bd=${String(L.bundleId)}`.slice(0, 100);
  }
  return `${slug}:${pk}:${size}`.slice(0, 100);
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
    const meta = buildShippoParcelMetadata(L);
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
      physicalPack: L.physicalPack || L.packKey,
      bundleId: L.bundleId || null,
      packageIndex: L.packageIndex != null ? L.packageIndex : null,
      packageCount: L.packageCount != null ? L.packageCount : null,
      spec,
      sizeMix: L.sizeMix || null,
    });
  }

  return { parcels, audit, source: "computed" };
}
