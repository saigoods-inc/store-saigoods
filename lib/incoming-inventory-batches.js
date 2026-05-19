import { createClient } from "@supabase/supabase-js";

import { rpcIncomingBatchReceive } from "./inventory-repo.js";

/** Batches whose expected quantities count toward Incoming Stock KPI (excludes received, cancelled). */
const PIPELINE_STATUSES = ["planned", "in_transit", "arrived", "on_hold"];

/** Statuses that allow editing batch metadata and line CRUD (Phase B). */
export const INCOMING_BATCH_EDITABLE_STATUSES = new Set(["planned", "in_transit", "arrived", "on_hold"]);

const ALL_BATCH_STATUSES = new Set(["planned", "in_transit", "arrived", "on_hold", "received", "cancelled"]);

/** Create API: new shipment records start as planned or in_transit only (arrived via mark-arrived flow). */
const CREATE_BATCH_STATUSES = new Set(["planned", "in_transit"]);

/** Allowed status transitions — `received` only via receive RPC, not manual update. */
const VALID_STATUS_TRANSITIONS = {
  planned: new Set(["in_transit", "arrived", "on_hold", "cancelled"]),
  in_transit: new Set(["arrived", "on_hold", "cancelled"]),
  arrived: new Set(["in_transit", "on_hold", "cancelled"]),
  on_hold: new Set(["arrived", "cancelled"]),
};

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return null;
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function requireServiceClient() {
  const client = getServiceClient();
  if (!client) {
    throw Object.assign(new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for incoming inventory batches."), {
      statusCode: 503,
    });
  }
  return client;
}

function validationError(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

/**
 * @param {{ kind?: string, email?: string | null } | null | undefined} actor
 */
export function mapIncomingBatchActorEmail(actor) {
  if (!actor) {
    return null;
  }
  if (actor.kind === "user") {
    return actor.email || null;
  }
  if (actor.kind === "service") {
    return "internal";
  }
  return null;
}

/** @returns {undefined | string | null} `undefined` means omit; `null` clears to SQL null. */
function normalizeOptionalDate(raw) {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null) {
    return null;
  }
  const s = String(raw).trim();
  return s ? s : null;
}

function normalizeExpectedQuantities(input) {
  const product_slug = String(input?.product_slug ?? input?.productSlug ?? "").trim();
  const size = String(input?.size ?? "").trim();
  const expected_cases = Math.max(0, Math.floor(Number(input?.expected_cases ?? input?.expectedCases ?? 0) || 0));
  const expected_boxes = Math.max(0, Math.floor(Number(input?.expected_boxes ?? input?.expectedBoxes ?? 0) || 0));

  if (!product_slug) {
    throw validationError("product_slug is required.");
  }
  if (!size) {
    throw validationError("size is required.");
  }
  if (expected_cases <= 0 && expected_boxes <= 0) {
    throw validationError("At least one of expected_cases or expected_boxes must be greater than 0.");
  }

  return { product_slug, size, expected_cases, expected_boxes };
}

function assertValidStatusTransition(fromStatus, toStatus) {
  const from = String(fromStatus || "").trim();
  const to = String(toStatus || "").trim();
  if (from === to) {
    return;
  }
  if (to === "received") {
    throw validationError("Cannot set status to received until receiving is implemented (Phase C).");
  }
  const allowed = VALID_STATUS_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw validationError(`Invalid status transition from "${from}" to "${to}".`);
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} client
 * @param {string} id
 */
async function fetchBatchHeader(client, id) {
  const sid = String(id || "").trim();
  if (!sid) {
    return null;
  }
  const { data, error } = await client.from("incoming_inventory_batches").select("*").eq("id", sid).maybeSingle();
  if (error) {
    throw Object.assign(new Error(error.message || "Could not load batch."), { statusCode: 500 });
  }
  return data || null;
}

/**
 * @param {object} input
 * @param {{ kind?: string, email?: string | null } | null | undefined} actor
 */
export async function createIncomingInventoryBatch(input, actor) {
  const client = requireServiceClient();
  const raw = input && typeof input === "object" ? input : {};

  const batch_name = String(raw.batch_name ?? raw.batchName ?? "").trim();
  if (!batch_name) {
    throw validationError("batch_name is required.");
  }

  let status = String(raw.status ?? "planned").trim().toLowerCase();
  if (!status) {
    status = "planned";
  }
  if (!ALL_BATCH_STATUSES.has(status)) {
    throw validationError(`Invalid status "${status}".`);
  }
  if (!CREATE_BATCH_STATUSES.has(status)) {
    throw validationError(
      "Cannot create incoming batch with this status. New batches can only be created as planned or in_transit.",
    );
  }

  const email = mapIncomingBatchActorEmail(actor);
  const now = new Date().toISOString();

  const row = {
    batch_name,
    container_number: raw.container_number != null ? String(raw.container_number).trim() || null : null,
    po_number: raw.po_number != null ? String(raw.po_number).trim() || null : null,
    supplier: raw.supplier != null ? String(raw.supplier).trim() || null : null,
    status,
    notes: raw.notes != null ? String(raw.notes).trim() || null : null,
    created_by: email,
    updated_by: email,
    created_at: now,
    updated_at: now,
  };

  if (raw.eta_date !== undefined || raw.etaDate !== undefined) {
    const etaSrc = raw.eta_date !== undefined ? raw.eta_date : raw.etaDate;
    row.eta_date = normalizeOptionalDate(etaSrc);
  }
  if (raw.arrival_date !== undefined || raw.arrivalDate !== undefined) {
    const arrSrc = raw.arrival_date !== undefined ? raw.arrival_date : raw.arrivalDate;
    row.arrival_date = normalizeOptionalDate(arrSrc);
  }

  const { data, error } = await client.from("incoming_inventory_batches").insert(row).select("*").single();
  if (error) {
    throw Object.assign(new Error(error.message || "Could not create batch."), { statusCode: 500 });
  }

  const full = await getIncomingInventoryBatch(data.id);
  return full || data;
}

/**
 * @param {string} id
 * @param {object} input
 * @param {{ kind?: string, email?: string | null } | null | undefined} actor
 */
export async function updateIncomingInventoryBatch(id, input, actor) {
  const client = requireServiceClient();
  const sid = String(id || "").trim();
  if (!sid) {
    throw validationError("id is required.");
  }

  const existing = await fetchBatchHeader(client, sid);
  if (!existing) {
    throw Object.assign(new Error("Batch not found."), { statusCode: 404 });
  }

  const curStatus = String(existing.status || "").trim();
  if (curStatus === "received") {
    throw validationError("Cannot update a batch that has already been received.");
  }
  if (curStatus === "cancelled") {
    throw validationError("Cannot update a cancelled batch.");
  }

  const raw = input && typeof input === "object" ? input : {};
  /** @type {Record<string, unknown>} */
  const patch = {};

  if (raw.batch_name !== undefined) {
    const nm = String(raw.batch_name ?? raw.batchName ?? "").trim();
    if (!nm) {
      throw validationError("batch_name cannot be empty.");
    }
    patch.batch_name = nm;
  }
  if (raw.container_number !== undefined) {
    patch.container_number = raw.container_number != null ? String(raw.container_number).trim() || null : null;
  }
  if (raw.po_number !== undefined) {
    patch.po_number = raw.po_number != null ? String(raw.po_number).trim() || null : null;
  }
  if (raw.supplier !== undefined) {
    patch.supplier = raw.supplier != null ? String(raw.supplier).trim() || null : null;
  }
  if (raw.eta_date !== undefined || raw.etaDate !== undefined) {
    const etaSrc = raw.eta_date !== undefined ? raw.eta_date : raw.etaDate;
    patch.eta_date = normalizeOptionalDate(etaSrc);
  }
  if (raw.arrival_date !== undefined || raw.arrivalDate !== undefined) {
    const arrSrc = raw.arrival_date !== undefined ? raw.arrival_date : raw.arrivalDate;
    patch.arrival_date = normalizeOptionalDate(arrSrc);
  }
  if (raw.notes !== undefined) {
    patch.notes = raw.notes != null ? String(raw.notes).trim() || null : null;
  }

  let nextStatus = curStatus;
  if (raw.status !== undefined && raw.status !== null && String(raw.status).trim() !== "") {
    nextStatus = String(raw.status).trim().toLowerCase();
    if (!ALL_BATCH_STATUSES.has(nextStatus)) {
      throw validationError(`Invalid status "${nextStatus}".`);
    }
    assertValidStatusTransition(curStatus, nextStatus);
    patch.status = nextStatus;
  }

  if (nextStatus === "cancelled" && curStatus !== "cancelled") {
    patch.cancelled_at = existing.cancelled_at || new Date().toISOString();
  }

  patch.updated_by = mapIncomingBatchActorEmail(actor);
  patch.updated_at = new Date().toISOString();

  const { data, error } = await client.from("incoming_inventory_batches").update(patch).eq("id", sid).select("*").single();
  if (error) {
    throw Object.assign(new Error(error.message || "Could not update batch."), { statusCode: 500 });
  }
  if (!data) {
    throw Object.assign(new Error("Batch not found."), { statusCode: 404 });
  }

  return getIncomingInventoryBatch(sid);
}

/**
 * @param {string} id
 */
export async function deleteIncomingInventoryBatch(id) {
  const client = requireServiceClient();
  const sid = String(id || "").trim();
  if (!sid) {
    throw validationError("id is required.");
  }

  const existing = await fetchBatchHeader(client, sid);
  if (!existing) {
    throw Object.assign(new Error("Batch not found."), { statusCode: 404 });
  }
  if (String(existing.status || "").trim() !== "planned") {
    throw validationError("Only batches in planned status can be deleted.");
  }

  const { error } = await client.from("incoming_inventory_batches").delete().eq("id", sid);
  if (error) {
    throw Object.assign(new Error(error.message || "Could not delete batch."), { statusCode: 500 });
  }
}

/**
 * @param {string} batchId
 * @param {object} input
 */
export async function createIncomingInventoryBatchLine(batchId, input) {
  const client = requireServiceClient();
  const bid = String(batchId || "").trim();
  if (!bid) {
    throw validationError("batch_id is required.");
  }

  const batch = await fetchBatchHeader(client, bid);
  if (!batch) {
    throw Object.assign(new Error("Batch not found."), { statusCode: 404 });
  }
  const st = String(batch.status || "").trim();
  if (!INCOMING_BATCH_EDITABLE_STATUSES.has(st)) {
    throw validationError("Cannot add lines to a batch that is received or cancelled.");
  }

  const { product_slug, size, expected_cases, expected_boxes } = normalizeExpectedQuantities(input);

  const now = new Date().toISOString();
  const lineRow = {
    batch_id: bid,
    product_slug,
    size,
    expected_cases,
    expected_boxes,
    received_cases: 0,
    received_boxes: 0,
    created_at: now,
    updated_at: now,
  };

  const { data, error } = await client.from("incoming_inventory_batch_lines").insert(lineRow).select("*").single();
  if (error) {
    throw Object.assign(new Error(error.message || "Could not create batch line."), { statusCode: 500 });
  }
  return data;
}

/**
 * @param {string} lineId
 * @param {object} input
 */
export async function updateIncomingInventoryBatchLine(lineId, input) {
  const client = requireServiceClient();
  const lid = String(lineId || "").trim();
  if (!lid) {
    throw validationError("id is required.");
  }

  const { data: line, error: lErr } = await client.from("incoming_inventory_batch_lines").select("*").eq("id", lid).maybeSingle();
  if (lErr) {
    throw Object.assign(new Error(lErr.message || "Could not load line."), { statusCode: 500 });
  }
  if (!line) {
    throw Object.assign(new Error("Batch line not found."), { statusCode: 404 });
  }

  const batch = await fetchBatchHeader(client, String(line.batch_id));
  if (!batch) {
    throw Object.assign(new Error("Batch not found."), { statusCode: 404 });
  }
  const st = String(batch.status || "").trim();
  if (!INCOMING_BATCH_EDITABLE_STATUSES.has(st)) {
    throw validationError("Cannot edit lines on a batch that is received or cancelled.");
  }

  const raw = input && typeof input === "object" ? input : {};
  const merged = {
    product_slug: raw.product_slug !== undefined ? raw.product_slug : line.product_slug,
    size: raw.size !== undefined ? raw.size : line.size,
    expected_cases: raw.expected_cases !== undefined ? raw.expected_cases : line.expected_cases,
    expected_boxes: raw.expected_boxes !== undefined ? raw.expected_boxes : line.expected_boxes,
  };
  const { product_slug, size, expected_cases, expected_boxes } = normalizeExpectedQuantities(merged);

  const now = new Date().toISOString();
  const { data, error } = await client
    .from("incoming_inventory_batch_lines")
    .update({
      product_slug,
      size,
      expected_cases,
      expected_boxes,
      updated_at: now,
    })
    .eq("id", lid)
    .select("*")
    .single();

  if (error) {
    throw Object.assign(new Error(error.message || "Could not update batch line."), { statusCode: 500 });
  }
  return data;
}

/**
 * @param {string} lineId
 */
export async function deleteIncomingInventoryBatchLine(lineId) {
  const client = requireServiceClient();
  const lid = String(lineId || "").trim();
  if (!lid) {
    throw validationError("id is required.");
  }

  const { data: line, error: lErr } = await client.from("incoming_inventory_batch_lines").select("batch_id").eq("id", lid).maybeSingle();
  if (lErr) {
    throw Object.assign(new Error(lErr.message || "Could not load line."), { statusCode: 500 });
  }
  if (!line) {
    throw Object.assign(new Error("Batch line not found."), { statusCode: 404 });
  }

  const batch = await fetchBatchHeader(client, String(line.batch_id));
  if (!batch) {
    throw Object.assign(new Error("Batch not found."), { statusCode: 404 });
  }
  const st = String(batch.status || "").trim();
  if (!INCOMING_BATCH_EDITABLE_STATUSES.has(st)) {
    throw validationError("Cannot delete lines on a batch that is received or cancelled.");
  }

  const { error } = await client.from("incoming_inventory_batch_lines").delete().eq("id", lid);
  if (error) {
    throw Object.assign(new Error(error.message || "Could not delete batch line."), { statusCode: 500 });
  }
}

/**
 * Receive an arrived batch into physical stock (Phase C). Atomic in Postgres via `incoming_batch_receive` RPC.
 *
 * @param {string} batchId
 * @param {{ lines?: object[], note?: string | null, reason?: string | null }} payload
 * @param {{ kind?: string, email?: string | null } | null | undefined} actor
 */
export async function receiveIncomingInventoryBatch(batchId, payload = {}, actor) {
  const sid = String(batchId || "").trim();
  if (!sid) {
    throw validationError("id is required.");
  }

  requireServiceClient();

  const batch = await getIncomingInventoryBatch(sid);
  if (!batch) {
    throw Object.assign(new Error("Batch not found."), { statusCode: 404 });
  }

  const dbLines = Array.isArray(batch.lines) ? batch.lines : [];
  if (!dbLines.length) {
    throw validationError("Batch has no lines to receive.");
  }

  const rawLines = payload?.lines;
  /** @type {{ line_id: string, received_cases: number, received_boxes: number }[]} */
  let receipts;

  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    receipts = dbLines.map((l) => ({
      line_id: String(l.id),
      received_cases: Math.max(0, Math.floor(Number(l.expected_cases) || 0)),
      received_boxes: Math.max(0, Math.floor(Number(l.expected_boxes) || 0)),
    }));
  } else {
    const dbIds = new Set(dbLines.map((l) => String(l.id)));
    if (rawLines.length !== dbIds.size) {
      throw validationError(`Receipt payload must include exactly ${dbIds.size} line(s).`);
    }
    receipts = [];
    const seen = new Set();
    for (const raw of rawLines) {
      const line_id = String(raw.line_id ?? raw.lineId ?? "").trim();
      if (!line_id || !dbIds.has(line_id)) {
        throw validationError("Each receipt must include a valid line_id belonging to this batch.");
      }
      if (seen.has(line_id)) {
        throw validationError("Duplicate line_id in receipt payload.");
      }
      seen.add(line_id);
      receipts.push({
        line_id,
        received_cases: Math.max(0, Math.floor(Number(raw.received_cases ?? raw.receivedCases ?? 0) || 0)),
        received_boxes: Math.max(0, Math.floor(Number(raw.received_boxes ?? raw.receivedBoxes ?? 0) || 0)),
      });
    }
    if (seen.size !== dbIds.size) {
      throw validationError("Receipt payload must include every line on the batch.");
    }
  }

  let totalRecv = 0;
  for (const r of receipts) {
    totalRecv += r.received_cases + r.received_boxes;
  }
  if (totalRecv < 1) {
    throw validationError("At least one received_cases or received_boxes must be greater than 0 across all lines.");
  }

  const noteRaw = payload?.note ?? payload?.reason;
  const note = noteRaw != null ? String(noteRaw).trim() || null : null;

  await rpcIncomingBatchReceive(sid, receipts, mapIncomingBatchActorEmail(actor), note);

  const updated = await getIncomingInventoryBatch(sid);
  return updated || batch;
}

function emptyByStatus() {
  return {
    planned: { incomingCases: 0, incomingBoxes: 0 },
    in_transit: { incomingCases: 0, incomingBoxes: 0 },
    arrived: { incomingCases: 0, incomingBoxes: 0 },
    on_hold: { incomingCases: 0, incomingBoxes: 0 },
  };
}

function emptyAggregate() {
  return {
    summary: { incomingCases: 0, incomingBoxes: 0 },
    byStatus: emptyByStatus(),
  };
}

/**
 * Sum expected cases/boxes for pipeline batches (planned, in_transit, arrived, on_hold — not received, not cancelled).
 * @param {object[]} batches
 * @param {Map<string, object[]>} linesByBatchId
 */
function computePipelineAggregates(batches, linesByBatchId) {
  const pipeline = new Set(PIPELINE_STATUSES);
  const byStatus = emptyByStatus();
  let incomingCases = 0;
  let incomingBoxes = 0;

  for (const b of batches) {
    const st = String(b?.status || "").trim();
    if (!pipeline.has(st)) {
      continue;
    }
    const lines = linesByBatchId.get(String(b.id)) || [];
    let bc = 0;
    let bb = 0;
    for (const ln of lines) {
      bc += Math.max(0, Math.floor(Number(ln.expected_cases) || 0));
      bb += Math.max(0, Math.floor(Number(ln.expected_boxes) || 0));
    }
    incomingCases += bc;
    incomingBoxes += bb;
    if (byStatus[st]) {
      byStatus[st].incomingCases += bc;
      byStatus[st].incomingBoxes += bb;
    }
  }

  return {
    summary: { incomingCases, incomingBoxes },
    byStatus,
  };
}

/**
 * @param {{ status?: string } | undefined} filters
 * @returns {Promise<object[]>}
 */
export async function listIncomingInventoryBatches(filters = {}) {
  const client = getServiceClient();
  if (!client) {
    return [];
  }

  let q = client.from("incoming_inventory_batches").select("*").order("updated_at", { ascending: false });

  const status = filters.status != null ? String(filters.status).trim() : "";
  if (status) {
    q = q.eq("status", status);
  }

  const { data, error } = await q;
  if (error) {
    throw Object.assign(new Error(error.message || "Could not list incoming inventory batches."), { statusCode: 500 });
  }
  return Array.isArray(data) ? data : [];
}

/**
 * @param {string} id
 * @returns {Promise<object | null>} batch row or null
 */
export async function getIncomingInventoryBatch(id) {
  const client = getServiceClient();
  if (!client) {
    return null;
  }

  const sid = String(id || "").trim();
  if (!sid) {
    return null;
  }

  const { data: batch, error: bErr } = await client
    .from("incoming_inventory_batches")
    .select("*")
    .eq("id", sid)
    .maybeSingle();

  if (bErr) {
    throw Object.assign(new Error(bErr.message || "Could not load incoming batch."), { statusCode: 500 });
  }
  if (!batch) {
    return null;
  }

  const { data: lines, error: lErr } = await client
    .from("incoming_inventory_batch_lines")
    .select("*")
    .eq("batch_id", sid)
    .order("created_at", { ascending: true });

  if (lErr) {
    throw Object.assign(new Error(lErr.message || "Could not load batch lines."), { statusCode: 500 });
  }

  return { ...batch, lines: Array.isArray(lines) ? lines : [] };
}

/**
 * Aggregate expected quantities for batches in planned / in_transit / arrived / on_hold (not received, not cancelled).
 * @returns {Promise<{ summary: { incomingCases: number, incomingBoxes: number }, byStatus: Record<string, { incomingCases: number, incomingBoxes: number }> }>}
 */
export async function aggregateIncomingInventory() {
  const client = getServiceClient();
  if (!client) {
    return emptyAggregate();
  }

  try {
    const { data: batches, error: bErr } = await client
      .from("incoming_inventory_batches")
      .select("id, status")
      .in("status", PIPELINE_STATUSES);

    if (bErr) {
      throw bErr;
    }
    const list = Array.isArray(batches) ? batches : [];
    if (!list.length) {
      return emptyAggregate();
    }

    const ids = list.map((b) => b.id).filter(Boolean);
    const { data: lineRows, error: lErr } = await client
      .from("incoming_inventory_batch_lines")
      .select("batch_id, expected_cases, expected_boxes")
      .in("batch_id", ids);

    if (lErr) {
      throw lErr;
    }

    /** @type {Map<string, object[]>} */
    const linesByBatchId = new Map();
    for (const row of Array.isArray(lineRows) ? lineRows : []) {
      const bid = String(row.batch_id || "");
      if (!bid) {
        continue;
      }
      if (!linesByBatchId.has(bid)) {
        linesByBatchId.set(bid, []);
      }
      linesByBatchId.get(bid).push(row);
    }

    return computePipelineAggregates(list, linesByBatchId);
  } catch (e) {
    console.error("[incoming-inventory-batches] aggregateIncomingInventory", e);
    return emptyAggregate();
  }
}

/**
 * Payload for GET /api/admin-stock (Phase A): batches with lines + pipeline aggregates.
 */
export async function buildIncomingInventoryPayloadForAdminStock() {
  const client = getServiceClient();
  if (!client) {
    return {
      rows: [],
      summary: { incomingCases: 0, incomingBoxes: 0 },
      byStatus: emptyByStatus(),
    };
  }

  try {
    const batches = await listIncomingInventoryBatches();
    if (!batches.length) {
      return {
        rows: [],
        summary: { incomingCases: 0, incomingBoxes: 0 },
        byStatus: emptyByStatus(),
      };
    }

    const ids = batches.map((b) => b.id).filter(Boolean);
    const { data: lineRows, error: lErr } = await client
      .from("incoming_inventory_batch_lines")
      .select("*")
      .in("batch_id", ids)
      .order("batch_id", { ascending: true })
      .order("created_at", { ascending: true });

    if (lErr) {
      throw lErr;
    }

    /** @type {Map<string, object[]>} */
    const linesByBatchId = new Map();
    for (const row of Array.isArray(lineRows) ? lineRows : []) {
      const bid = String(row.batch_id || "");
      if (!bid) {
        continue;
      }
      if (!linesByBatchId.has(bid)) {
        linesByBatchId.set(bid, []);
      }
      linesByBatchId.get(bid).push(row);
    }

    const { summary, byStatus } = computePipelineAggregates(batches, linesByBatchId);

    const rows = batches.map((b) => ({
      batch: b,
      lines: linesByBatchId.get(String(b.id)) || [],
    }));

    return { rows, summary, byStatus };
  } catch (e) {
    console.error("[incoming-inventory-batches] buildIncomingInventoryPayloadForAdminStock", e);
    return {
      rows: [],
      summary: { incomingCases: 0, incomingBoxes: 0 },
      byStatus: emptyByStatus(),
    };
  }
}
