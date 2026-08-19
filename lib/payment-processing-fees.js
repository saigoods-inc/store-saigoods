import { getSupabaseServiceRoleClient } from "./supabase-admin.js";

export const PAYMENT_FEE_SETTING_KEY = "payment_processing_fees";
export const DEFAULT_PAYMENT_FEE_CONFIG = Object.freeze({
  version: 1,
  currency: "USD",
  profiles: {
    online: { label: "Square online / payment link", percentBps: 330, fixedCents: 30 },
    cardPresent: { label: "Square card present", percentBps: 260, fixedCents: 15 },
    noFee: { label: "Cash / check", percentBps: 0, fixedCents: 0 },
  },
});

function nonNegativeInt(value, fallback = 0) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function normalizePaymentFeeConfig(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const incoming = source.profiles && typeof source.profiles === "object" ? source.profiles : {};
  const profiles = {};
  for (const [key, fallback] of Object.entries(DEFAULT_PAYMENT_FEE_CONFIG.profiles)) {
    const profile = incoming[key] || {};
    profiles[key] = {
      label: String(profile.label || fallback.label),
      percentBps: nonNegativeInt(profile.percentBps, fallback.percentBps),
      fixedCents: nonNegativeInt(profile.fixedCents, fallback.fixedCents),
    };
  }
  return { version: 1, currency: "USD", profiles };
}

export function feeProfileKeyForOrder(row) {
  const source = String(row?.order_source || "").toLowerCase();
  const method = String(row?.payment_method || "").toLowerCase();
  if (source === "walk_in" && (!method || method === "cash" || method === "check")) return "noFee";
  if (method === "card_present") return "cardPresent";
  return "online";
}

export function estimateProcessingFeeCents(totalCents, profile) {
  const total = nonNegativeInt(totalCents);
  const percentBps = nonNegativeInt(profile?.percentBps);
  const fixedCents = nonNegativeInt(profile?.fixedCents);
  if (!total || (!percentBps && !fixedCents)) return 0;
  return Math.round((total * percentBps) / 10_000) + fixedCents;
}

export function processingFeeSnapshotForOrder(row, config = DEFAULT_PAYMENT_FEE_CONFIG) {
  const normalized = normalizePaymentFeeConfig(config);
  const profileKey = feeProfileKeyForOrder(row);
  const profile = normalized.profiles[profileKey];
  const totalCents = nonNegativeInt(row?.total_cents ?? row?.totalCents);
  return {
    estimated_processing_fee_cents: estimateProcessingFeeCents(totalCents, profile),
    processing_fee_status: profileKey === "noFee" ? "actual" : "estimated",
    processing_fee_profile: profileKey,
    processing_fee_details_json: { source: "configured_estimate", profile: { ...profile }, chargeCents: totalCents },
  };
}

export function actualProcessingFeeFromSquarePayment(payment) {
  const fees = Array.isArray(payment?.processing_fee) ? payment.processing_fee : [];
  if (!fees.length) return null;
  let cents = 0;
  for (const fee of fees) {
    const amount = Number(fee?.amount_money?.amount);
    if (Number.isFinite(amount)) cents += amount;
  }
  // Square currently reports processing costs as positive amounts; tolerate
  // accounts/API versions that expose the cost with the opposite sign.
  return Math.max(0, Math.abs(Math.round(cents)));
}

export function effectiveProcessingFeeCents(row, config = DEFAULT_PAYMENT_FEE_CONFIG) {
  const actual = Number(row?.actual_processing_fee_cents);
  if (row?.actual_processing_fee_cents != null && Number.isFinite(actual) && actual >= 0) {
    return Math.round(actual);
  }
  const estimated = Number(row?.estimated_processing_fee_cents);
  if (row?.estimated_processing_fee_cents != null && Number.isFinite(estimated) && estimated >= 0) {
    return Math.round(estimated);
  }
  return processingFeeSnapshotForOrder(row, config).estimated_processing_fee_cents;
}

function missingSettings(error) {
  return error?.code === "42P01" || /admin_runtime_settings/i.test(String(error?.message || ""));
}

export async function loadPaymentFeeConfig() {
  try {
    const client = getSupabaseServiceRoleClient();
    const { data, error } = await client.from("admin_runtime_settings").select("setting_value, updated_at").eq("setting_key", PAYMENT_FEE_SETTING_KEY).maybeSingle();
    if (error) {
      if (missingSettings(error)) return { config: normalizePaymentFeeConfig(), source: "bundled_default", migrationRequired: true };
      throw error;
    }
    return { config: normalizePaymentFeeConfig(data?.setting_value), source: data?.setting_value ? "supabase" : "bundled_default", migrationRequired: false, updatedAt: data?.updated_at || null };
  } catch (error) {
    if (!missingSettings(error)) console.error("[payment-fees] Using defaults.", error);
    return { config: normalizePaymentFeeConfig(), source: "bundled_default", migrationRequired: missingSettings(error) };
  }
}

export async function savePaymentFeeConfig(value) {
  const config = normalizePaymentFeeConfig(value);
  const client = getSupabaseServiceRoleClient();
  const { data, error } = await client.from("admin_runtime_settings").upsert({ setting_key: PAYMENT_FEE_SETTING_KEY, setting_value: config, updated_at: new Date().toISOString() }).select("setting_value, updated_at").single();
  if (error) throw error;
  return { config: normalizePaymentFeeConfig(data.setting_value), source: "supabase", updatedAt: data.updated_at };
}
