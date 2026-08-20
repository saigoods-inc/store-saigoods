import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { useAuth } from "../auth/AuthProvider";
import { useAdminShellHeaderMeta } from "../components/layout/AdminShell";
import { CustomSelect } from "../components/ui/CustomSelect";
import { ApiError, cancelAndRefundOrder, checkCancelledOrderRefundStatus, completeOrderHandoff, confirmOrderProductShipped, fetchInventoryDashboard, fetchMarketplaceOrders, fetchOrderShipFromDisplay, notifyBuyerShipping, postMarketplaceOrderAction, previewOrderPackingPlan, purchaseOrderShippoAllLabels, purchaseOrderShippoLabel, saveOrderExternalFulfillment, sendCancelledOrderRefundEmail, sendManualOrderLink, syncOrderToShippo, updateOrderPackingPlan } from "../lib/api";
import type { AdminOrderPackingPlanResponse, AdminOrderShipFromDisplayResponse, InventoryVariantRow, MarketplaceOrder, PackingPlanContent, PackingPlanParcel, PackingPlanSummary } from "../lib/api";
import { formatDateTime, formatNumber, formatUsdCents } from "../lib/format";
import { Icon } from "../lib/icons";

type OrderTypeFilter = "all" | "online" | "manual" | "walkin";
type StatusFilter = "all" | "awaiting_payment" | "paid_not_shipped" | "shipped" | "needs_attention" | "cancelled";
type TimeFilter = "all" | "today" | "week" | "month";
type Tone = "neutral" | "blue" | "green" | "red" | "amber";
type OrderActionKey = "sync" | `purchase:${string}` | "packingPreview" | "packingSave" | "packingClear" | "notify" | "arrivalLink" | "externalFulfillment" | "ship" | "cancel" | "refundStatus" | "refundEmail";
type PurchaseIntent = {
  orderId: string;
  rateObjectId: string;
  parcelCount: number;
  remainingCount: number;
  carrier: string;
  service: string;
  cost: string;
  costCents: number | null;
  customerShippingBudgetCents: number | null;
} | null;
type ShipIntent = { orderId: string; mode: "carrier" | "handoff" | "external"; proofName?: string; paymentProofName?: string } | null;
type NotifyIntent = { orderId: string } | null;
type CancelIntent = { orderId: string; orderRef: string; totalCents: number; purchasedLabels: number } | null;
type HandoffProof = { name: string; sizeLabel: string; dataUrl: string } | null;
const HANDOFF_PROOF_STORAGE_PREFIX = "sg25-handoff-proof:";
const ACTIVE_ORDERS_REFRESH_MS = 30_000;

async function fileToExternalPayload(file: File) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
  return { name: file.name, base64: dataUrl.split(",")[1] || "" };
}

interface OrderRow {
  id: string | number;
  order_ref?: string | null;
  created_at?: string | null;
  customer_name?: string | null;
  customer_email?: string | null;
  customer_phone?: string | null;
  order_source?: string | null;
  order_status?: string | null;
  status?: string | null;
  fulfillment_method?: string | null;
  payment_method?: string | null;
  total_cents?: number | null;
  subtotal_cents?: number | null;
  shipping_cents?: number | null;
  tax_cents?: number | null;
  shippo_label_required?: boolean | null;
  shippo_label_url?: string | null;
  shippo_tracking_number?: string | null;
  shippo_tracking_status?: string | null;
  shippo_transaction_status?: string | null;
  items?: unknown;
  cart_items?: unknown;
  [key: string]: unknown;
}

interface LabelRow {
  order_id?: string | number | null;
  orderId?: string | number | null;
  status?: string | null;
  carrier?: string | null;
  servicelevel_name?: string | null;
  servicelevel_token?: string | null;
  servicelevelName?: string | null;
  servicelevelToken?: string | null;
  tracking_number?: string | null;
  label_url?: string | null;
  parcel_index?: number | null;
  parcel_count?: number | null;
  amount_cents?: number | null;
  error_message?: string | null;
  trackingNumber?: string | null;
  labelUrl?: string | null;
  parcelIndex?: number | null;
  parcelCount?: number | null;
  amountCents?: number | null;
  errorMessage?: string | null;
  [key: string]: unknown;
}

interface OrdersPayload {
  orders: OrderRow[];
  labelsByOrderId: Map<string, LabelRow[]>;
}

type MarketplaceDraftLine = {
  id: string;
  productSlug: string;
  size: string;
  unit: "cases" | "boxes";
  quantity: string;
  unitSalePrice: string;
};

function newMarketplaceDraftLine(): MarketplaceDraftLine {
  return { id: `marketplace-item-${Date.now()}-${Math.random().toString(36).slice(2)}`, productSlug: "", size: "", unit: "boxes", quantity: "1", unitSalePrice: "" };
}

type MarketplaceRecordInput = {
  marketplace: string;
  externalOrderId: string;
  lines: Array<{ productSlug: string; size: string; quantityCases: number; quantityBoxes: number; unitSalePriceCents: number }>;
  shippingChargedCents: number;
  discountCents: number;
  taxCollectedCents: number;
  marketplaceFeeCents: number;
  paymentProcessingFeeCents: number;
  shippingCostCents: number;
  otherCostCents: number;
  refundCents: number;
  netPayoutCents: number | null;
  notes: string;
};

const marketplaceProductMeta = [
  { slug: "nitrile-standard", label: "Nitrile Examination – Standard" },
  { slug: "black-nitrile-general", label: "Black Nitrile – General" },
  { slug: "black-nitrile-heavy-duty", label: "Black Nitrile – Heavy Duty" },
] as const;

function dollarsToCents(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : 0;
}

const marketplaceSizeOrder = new Map(["S", "M", "L", "XL"].map((size, index) => [size, index]));

function compareMarketplaceSizes(left: string, right: string) {
  const leftRank = marketplaceSizeOrder.get(left.toUpperCase()) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = marketplaceSizeOrder.get(right.toUpperCase()) ?? Number.MAX_SAFE_INTEGER;
  return leftRank - rightRank || left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function marketplaceStockForVariant(variants: InventoryVariantRow[], productSlug: string, size: string) {
  const caseRow = variants.find((row) => row.productSlug === productSlug && row.size === size && row.channel === "case");
  const boxRow = variants.find((row) => row.productSlug === productSlug && row.size === size && row.channel === "box");
  const boxesPerCase = Math.max(1, Math.floor(Number(caseRow?.boxesPerCase ?? boxRow?.boxesPerCase) || 10));
  const intactCases = Math.max(0, Math.floor(Number(caseRow?.availableIntactCases ?? boxRow?.availableIntactCases ?? caseRow?.availableFinite ?? caseRow?.onHand) || 0));
  const looseBoxes = Math.max(0, Math.floor(Number(caseRow?.availableLooseBoxes ?? boxRow?.availableLooseBoxes ?? boxRow?.availableFinite ?? boxRow?.onHand) || 0));
  const boxEquivalent = Math.max(0, Math.floor(Number(caseRow?.availableBoxesEquivalent ?? boxRow?.availableBoxesEquivalent) || (intactCases * boxesPerCase + looseBoxes)));
  return { intactCases, looseBoxes, boxesPerCase, boxEquivalent };
}

function marketplaceAvailabilityLabel(stock: ReturnType<typeof marketplaceStockForVariant>, unit: MarketplaceDraftLine["unit"]) {
  if (unit === "cases") {
    return `${stock.intactCases} intact ${stock.intactCases === 1 ? "carton" : "cartons"} available · ${stock.boxesPerCase} boxes each`;
  }
  return `${stock.boxEquivalent} boxes available · ${stock.intactCases} ${stock.intactCases === 1 ? "carton" : "cartons"} + ${stock.looseBoxes} loose`;
}

const timeOptions: Array<{ value: TimeFilter; label: string }> = [
  { value: "all", label: "All Time" },
  { value: "today", label: "Today" },
  { value: "week", label: "Last 7 Days" },
  { value: "month", label: "This Month" },
];

const statusOptions: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All Status" },
  { value: "awaiting_payment", label: "Awaiting Payment" },
  { value: "paid_not_shipped", label: "Paid, Not Shipped" },
  { value: "shipped", label: "Shipped" },
  { value: "needs_attention", label: "Needs Attention" },
  { value: "cancelled", label: "Cancelled" },
];

async function fetchOrdersAndLabels(client: SupabaseClient): Promise<OrdersPayload> {
  const { data, error } = await client.from("orders").select("*").order("created_at", { ascending: false });
  if (error) throw new Error(error.message || "Could not load orders.");

  const orders = Array.isArray(data) ? (data as OrderRow[]) : [];
  const labelsByOrderId = new Map<string, LabelRow[]>();
  const orderIds = orders.map((order) => String(order.id || "")).filter(Boolean);

  for (let index = 0; index < orderIds.length; index += 100) {
    const slice = orderIds.slice(index, index + 100);
    const labelResult = await client.from("order_shippo_labels").select("*").in("order_id", slice);
    if (labelResult.error) throw new Error(labelResult.error.message || "Could not load order labels.");

    const labels = Array.isArray(labelResult.data) ? (labelResult.data as LabelRow[]) : [];
    labels.forEach((label) => {
      const key = String(label.order_id || "");
      if (!key) return;
      const current = labelsByOrderId.get(key) || [];
      current.push(label);
      labelsByOrderId.set(key, current);
    });
  }

  return { orders, labelsByOrderId };
}

function normalize(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function isPaid(order: OrderRow) {
  return normalize(order.status) === "paid";
}

function isCancelled(order: OrderRow) {
  return normalize(order.order_status) === "cancelled";
}

function orderType(order: OrderRow): OrderTypeFilter {
  const source = normalize(order.order_source);
  if (source === "walk_in" || source === "walkin" || source === "walk-in") return "walkin";
  if (source === "manual" || source === "admin") return "manual";
  return "online";
}

function orderTypeLabel(order: OrderRow) {
  const type = orderType(order);
  if (type === "walkin") return "Walk-in";
  if (type === "manual") return "Manual";
  return "Online";
}

function labelStatusValue(label: LabelRow) {
  return label.status;
}

function labelUrlValue(label: LabelRow) {
  return String(label.label_url || label.labelUrl || "").trim();
}

function labelTrackingValue(label: LabelRow) {
  return String(label.tracking_number || label.trackingNumber || "").trim();
}

function labelServiceNameValue(label: LabelRow) {
  return String(label.servicelevel_name || label.servicelevelName || "").trim();
}

function labelServiceTokenValue(label: LabelRow) {
  return String(label.servicelevel_token || label.servicelevelToken || "").trim();
}

function labelCarrierValue(label: LabelRow) {
  return String(label.carrier || "").trim();
}

function labelErrorValue(label: LabelRow) {
  return String(label.error_message || label.errorMessage || "").trim();
}

function labelParcelIndexValue(label: LabelRow) {
  const value = Number(label.parcel_index ?? label.parcelIndex);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function labelParcelCountValue(label: LabelRow) {
  const value = Number(label.parcel_count ?? label.parcelCount);
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : null;
}

function hasPurchasedLabel(order: OrderRow, labels: LabelRow[]) {
  if (normalize(order.order_status) === "partial_label_purchase") return false;
  const expectedPackageCount = labels.reduce((max, label) => Math.max(max, labelParcelCountValue(label) || 0), 0);
  if (expectedPackageCount > 1) {
    const purchasedIndexes = new Set(
      labels
        .filter((label) => normalize(labelStatusValue(label)) === "purchased" && Boolean(labelUrlValue(label)))
        .map(labelParcelIndexValue)
        .filter((index): index is number => index != null),
    );
    return purchasedIndexes.size >= expectedPackageCount;
  }
  if (normalize(order.shippo_transaction_status) === "success" || order.shippo_label_url) return true;
  return labels.some((label) => normalize(labelStatusValue(label)) === "purchased" || Boolean(labelUrlValue(label)));
}

function hasPurchasedShippoLabelRow(labels: LabelRow[]) {
  return labels.some((label) => normalize(labelStatusValue(label)) === "purchased" || Boolean(labelUrlValue(label)));
}

function purchasedPackageCount(labels: LabelRow[]) {
  return new Set(
    labels
      .filter((label) => normalize(labelStatusValue(label)) === "purchased" && Boolean(labelUrlValue(label)))
      .map(labelParcelIndexValue)
      .filter((index): index is number => index != null),
  ).size;
}

function isShipped(order: OrderRow) {
  const status = normalize(order.order_status);
  const tracking = normalize(order.shippo_tracking_status);
  return status === "shipped" || tracking === "delivered" || tracking === "in_transit";
}

function needsAttention(order: OrderRow) {
  const status = normalize(order.order_status);
  const tracking = normalize(order.shippo_tracking_status);
  if (isCancelled(order)) {
    const labelCode = normalize(fieldText(order, ["label_workflow_error_code"]));
    const paymentError = normalize(fieldText(order, ["payment_reconciliation_error"]));
    return labelCode.includes("attention") || (Boolean(paymentError) && paymentError !== "square refund is pending settlement.");
  }
  return status.includes("failed") || status.includes("error") || tracking === "failure" || tracking === "unknown";
}

function isAttentionOrder(order: OrderRow, labels: LabelRow[]) {
  return needsAttention(order) || (!isCancelled(order) && fulfillmentState(order, labels).tone === "red");
}

function cancellationLabelRefundState(order: OrderRow, labels: LabelRow[]): "complete" | "pending" | "attention" | "not_applicable" {
  const labelCodes = labels.map((label) => normalize(label.last_error_code)).filter(Boolean);
  const orderCode = normalize(fieldText(order, ["label_workflow_error_code"]));
  const codes = labelCodes.length ? labelCodes : orderCode ? [orderCode] : [];
  if (!codes.length) return "not_applicable";
  if (codes.some((code) => code.includes("attention"))) return "attention";
  if (labelCodes.length && labelCodes.every((code) => code.includes("refunded") && !code.includes("pending"))) return "complete";
  if (!labelCodes.length && orderCode.includes("refunded") && !orderCode.includes("pending")) return "complete";
  return "pending";
}

function attentionReason(order: OrderRow, labels: LabelRow[]) {
  const fulfillment = fulfillmentState(order, labels);
  if (fulfillment.tone === "red") return fulfillment.label;
  const status = String(order.order_status || "").trim().replaceAll("_", " ");
  const tracking = String(order.shippo_tracking_status || "").trim().replaceAll("_", " ");
  return status || tracking || "Address or label needs review";
}

function paymentState(order: OrderRow): { label: string; tone: Tone } {
  const workflow = normalize(order.order_status);
  const paymentStatus = normalize(order.status);
  const flow = normalize(fieldText(order, ["payment_flow"]));
  const manualMethod = normalize(fieldText(order, ["manual_payment_method"]));
  if (paymentStatus === "cancellation_pending") return { label: "Cancellation in progress", tone: "amber" };
  if (paymentStatus === "refund_pending") return { label: "Refund pending", tone: "amber" };
  if (paymentStatus === "refunded") return { label: "Refunded", tone: "red" };
  if (isPaid(order)) {
    const method = normalize(order.payment_method);
    if (method === "cash") return { label: "Paid cash", tone: "green" };
    if (method === "check") return { label: "Paid check", tone: "green" };
    return { label: "Paid", tone: "green" };
  }
  if (workflow === "payment_link_sent") return { label: "Payment link sent", tone: "amber" };
  if (isCancelled(order)) return { label: "Cancelled", tone: "red" };
  if (flow === "pay_later" && manualMethod === "arrival_payment_link") return { label: "Send link upon arrival", tone: "amber" };
  if (flow === "pay_later") return { label: "Pay later", tone: "amber" };
  if (flow === "square_payment_link") return { label: "Send payment link", tone: "amber" };
  if (workflow === "draft") return { label: "Draft", tone: "neutral" };
  return { label: "Awaiting payment", tone: "amber" };
}

function fulfillmentState(order: OrderRow, labels: LabelRow[]): { label: string; tone: Tone } {
  if (isCancelled(order)) return { label: "Cancelled", tone: "neutral" };
  if (isShipped(order)) return { label: "Shipped", tone: "green" };
  if (isLocalPayLaterOrder(order)) return { label: "Local delivery pending", tone: "amber" };
  if (!isPaid(order)) return { label: "Await payment", tone: "amber" };
  if (order.shippo_label_required === false) return { label: localFulfillmentLabel(order), tone: "neutral" };
  const workflow = normalize(order.order_status);
  const expected = parcelCountFromOrder(order, labels);
  const purchased = purchasedPackageCount(labels);
  if (workflow === "paid_label_pending" || workflow === "label_processing") return { label: "Paid - purchasing labels", tone: "amber" };
  if (workflow === "paid_label_retry") return { label: "Paid - retrying label purchase", tone: "amber" };
  if (workflow === "label_purchase_unknown") return { label: "Label status unknown - reconciling", tone: "red" };
  if (workflow === "admin_review_required") return { label: "Admin review required", tone: "red" };
  if (workflow === "partial_label_failure" || workflow === "partial_label_purchase") {
    return { label: `${purchased} of ${expected} labels purchased`, tone: "red" };
  }
  if (workflow === "labels_purchased" || workflow === "ready_to_fulfill") return { label: "Labels purchased", tone: "blue" };
  if (hasPurchasedLabel(order, labels)) return { label: "Label purchased", tone: "blue" };
  if (needsAttention(order)) return { label: "Needs attention", tone: "red" };
  return { label: "Label pending", tone: "amber" };
}

function isB2bShippingOrder(order: OrderRow) {
  const method = normalize(order.fulfillment_method);
  return method === "b2b_shipping" || method === "b2b" || method === "b2b shipping";
}

function localFulfillmentLabel(order: OrderRow) {
  const method = normalize(order.fulfillment_method);
  if (method === "pickup") return "Pickup";
  if (method === "b2b_shipping" || method === "b2b" || method === "b2b shipping") return "B2B shipping";
  return "Local delivery";
}

function isLocalPayLaterOrder(order: OrderRow) {
  const flow = normalize(fieldText(order, ["payment_flow"]));
  const method = normalize(fieldText(order, ["payment_method", "manual_payment_method"]));
  return (
    order.shippo_label_required === false &&
    orderType(order) !== "walkin" &&
    !isB2bShippingOrder(order) &&
    !isPaid(order) &&
    (flow === "pay_later" || method === "cash" || method === "check")
  );
}

function nextAction(order: OrderRow, labels: LabelRow[]) {
  const payment = paymentState(order).label;
  const fulfillment = fulfillmentState(order, labels).label;
  if (isCancelled(order)) {
    if (normalize(order.status) === "refund_pending") return "Wait for refund settlement";
    if (cancellationLabelRefundState(order, labels) === "pending") return "Wait for label credit";
    return needsAttention(order) ? "Review refund status" : "No action required";
  }
  if (isLocalPayLaterOrder(order)) return "Deliver and collect payment";
  if (!isPaid(order) && !isCancelled(order)) return "Record payment when received";
  if (payment === "Awaiting payment") return "Collect payment";
  if (payment === "Payment link sent") return "Wait for payment";
  if (fulfillment === "Label pending") {
    return isOnlineStoreOrder(order) || isAutomaticManualLabelOrder(order)
      ? "Labels will be purchased automatically"
      : "Purchase label";
  }
  if (fulfillment.includes("purchasing labels")) return "Automatic label purchase in progress";
  if (fulfillment.includes("retrying")) return "Automatic retry scheduled";
  if (fulfillment.includes("unknown")) return "Reconcile label result";
  if (fulfillment.includes("Admin review")) return "Review package label failure";
  if (fulfillment === "Label purchased") return "Confirm shipment";
  if (fulfillment === "Shipped") return "Monitor delivery";
  if (fulfillment === "Pickup" || fulfillment === "Local delivery") return "Complete handoff";
  return "Review order";
}

function shippingSummary(order: OrderRow, labels: LabelRow[]) {
  if (order.shippo_label_required === false) return localFulfillmentLabel(order);
  const purchased = labelRecords(labels);
  if (purchased.length) {
    const carriers = Array.from(new Set(purchased.map((label) => labelCarrierValue(label)).filter(Boolean)));
    return `${formatNumber(purchased.length)} label${purchased.length === 1 ? "" : "s"}${carriers.length ? ` · ${carriers.join(", ")}` : ""}`;
  }
  const tracking = trackingDisplayValue(order);
  if (tracking) return tracking;
  return "-";
}

function trackingValue(order: OrderRow) {
  const trackingNumber = String(order.shippo_tracking_number || "").trim();
  if (trackingNumber) return trackingNumber;
  const trackingStatus = normalize(order.shippo_tracking_status);
  if (trackingStatus && trackingStatus !== "unknown") return String(order.shippo_tracking_status);
  return "";
}

function trackingDisplayValue(order: OrderRow) {
  const tracking = trackingValue(order);
  if (!tracking) return "";
  if (/^1Z[X]+$/i.test(tracking)) return `${tracking} (Shippo sandbox test number)`;
  return tracking;
}

function shippoOrderSyncDisplay(order: OrderRow) {
  const status = fieldText(order, ["shippo_sync_status"]);
  const shippoOrderId = fieldText(order, ["shippo_order_id"]);
  if (normalize(status) === "pending" && !shippoOrderId) return "Order sync disabled";
  return detailValue(status);
}

function passesTimeFilter(order: OrderRow, filter: TimeFilter) {
  if (filter === "all") return true;
  if (!order.created_at) return false;
  const created = new Date(order.created_at);
  if (Number.isNaN(created.getTime())) return false;

  const now = new Date();
  if (filter === "today") {
    return created.toDateString() === now.toDateString();
  }
  if (filter === "week") {
    const start = new Date(now);
    start.setDate(now.getDate() - 7);
    return created >= start;
  }
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return created >= monthStart;
}

function passesStatusFilter(order: OrderRow, labels: LabelRow[], filter: StatusFilter) {
  if (filter === "all") return true;
  if (filter === "awaiting_payment") return !isPaid(order) && !isCancelled(order);
  if (filter === "paid_not_shipped") return isPaid(order) && !isShipped(order) && !isCancelled(order);
  if (filter === "shipped") return isShipped(order);
  if (filter === "needs_attention") return needsAttention(order);
  if (filter === "cancelled") return isCancelled(order);
  return fulfillmentState(order, labels).label.toLowerCase() === filter;
}

function parseItems(order: OrderRow) {
  const candidates = [order.items, order.cart_items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (typeof candidate === "string") {
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        continue;
      }
    }
  }
  return [];
}

function itemSummary(order: OrderRow) {
  const items = parseItems(order);
  if (!items.length) return "-";
  return items
    .slice(0, 3)
    .map((item) => {
      if (!item || typeof item !== "object") return "Item";
      const record = item as Record<string, unknown>;
      const name = String(record.name || record.title || record.product_name || record.slug || "Item");
      const quantity = Number(record.quantity || record.qty || 1);
      return `${quantity > 1 ? `${quantity}x ` : ""}${name}`;
    })
    .join(", ");
}

function itemRows(order: OrderRow) {
  const items = parseItems(order);
  const singleItemFallbackTotal = items.length === 1 ? Number(order.subtotal_cents) || Number(order.total_cents) || 0 : 0;
  const prettySize = (value: string) => {
    const raw = String(value || "").trim();
    return ({ S: "Small", M: "Medium", L: "Large", XL: "X Large" } as Record<string, string>)[raw] || raw;
  };
  const bundleLabel = (id: string) => {
    const raw = String(id || "").trim();
    const match = /^(box|case)_(\d+)$/i.exec(raw);
    if (!match) return raw;
    const count = Number(match[2]) || 1;
    const unit = match[1].toLowerCase() === "case" ? "case" : "box";
    return `${count}-${unit}`;
  };
  const formatQuantityMap = (map: unknown, unit: "box" | "case") => {
    if (!map || typeof map !== "object" || Array.isArray(map)) return [];
    return Object.entries(map as Record<string, unknown>)
      .filter(([, value]) => Number(value) > 0)
      .map(([sizeKey, value]) => {
        const qty = Math.floor(Number(value) || 0);
        return {
          size: prettySize(sizeKey),
          qty,
          unit,
          label: `${prettySize(sizeKey)}: ${qty} ${unit}${qty === 1 ? "" : "es"}`,
        };
      });
  };
  return items
    .map((item, index) => {
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const name = String(record.name || record.title || record.product_name || record.slug || `Item ${index + 1}`);
      const caseAllocations = formatQuantityMap(record.quantities, "case");
      const boxAllocations = formatQuantityMap(record.boxQuantities, "box");
      const allocationDetails = [...caseAllocations, ...boxAllocations];
      const allocatedSizes = allocationDetails.map((line) => line.size).filter(Boolean);
      const size =
        String(record.size || record.variant || record.option || "").trim() ||
        Array.from(new Set(allocatedSizes)).join(", ") ||
        "-";
      const quantity = Number(record.quantity || record.qty || 1);
      const rawTotal = Number(record.line_total_cents || record.total_cents || 0);
      const unitTotal = Number(record.price_cents || record.unit_price_cents || 0) * (Number.isFinite(quantity) && quantity > 0 ? quantity : 1);
      const totalCents = rawTotal || unitTotal || singleItemFallbackTotal;
      const bundleLines = Array.isArray(record.bundleLines) ? record.bundleLines : [];
      const bundleQuantity = bundleLines.reduce((sum, line) => {
        const lineRecord = line && typeof line === "object" ? (line as Record<string, unknown>) : {};
        return sum + Math.max(0, Math.floor(Number(lineRecord.qty) || 0));
      }, 0);
      const displayQuantity = Number.isFinite(quantity) && quantity > 0 ? quantity : bundleQuantity || 1;
      const bundleDetails = bundleLines
        .map((line) => {
          const lineRecord = line && typeof line === "object" ? (line as Record<string, unknown>) : {};
          const id = String(lineRecord.id || "").trim();
          const qty = Math.max(0, Math.floor(Number(lineRecord.qty) || 0));
          if (!id || !qty) return "";
          return qty === 1 ? bundleLabel(id) : `${bundleLabel(id)} x ${qty}`;
        })
        .filter(Boolean);
      const legacyBundle = String(record.bundle || record.bundle_label || record.bundleLabel || "").trim();
      const sizeDetail = String(record.size_label || record.sizeLabel || "").trim();
      return {
        name,
        size,
        sizeLines: allocationDetails.length
          ? allocationDetails.map((line) => `${line.size}: ${line.qty}`)
          : sizeDetail
            ? [sizeDetail]
            : size && size !== "-"
              ? [size]
              : [],
        packLines: allocationDetails.map((line) => line.label),
        bundle: bundleDetails.join(", ") || legacyBundle || "-",
        quantity: displayQuantity,
        total: formatUsdCents(totalCents),
      };
    })
    .filter((item) => item.name.trim());
}

function detailValue(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  return text || "-";
}

function fieldText(order: OrderRow, keys: string[]) {
  for (const key of keys) {
    const value = order[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function fieldCents(order: OrderRow, keys: string[]) {
  for (const key of keys) {
    const value = Number(order[key]);
    if (Number.isFinite(value)) return Math.round(value);
  }
  return null;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function parseArray(value: unknown): Array<Record<string, unknown>> {
  const raw = typeof value === "string" && value.trim() ? (() => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  })() : value;
  if (Array.isArray(raw)) return raw.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  const record = parseRecord(raw);
  if (record && Array.isArray(record.rates)) {
    return record.rates.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  }
  return [];
}

function parcelCountFromOrder(order: OrderRow, labels: LabelRow[]) {
  const candidates = [
    Number(order.quoted_parcel_count),
    Number(order.selected_shipping_parcel_count),
    Number(order.shippo_parcel_count),
  ];
  for (const key of ["shippo_parcels_override_json", "quoted_parcel_summary_json", "shippo_parcel_audit_json"]) {
    const record = parseRecord(order[key]);
    candidates.push(Number(record?.parcelCount));
    if (Array.isArray(record?.parcels)) {
      candidates.push(record.parcels.length);
    }
    if (Array.isArray(record?.requestParcels)) {
      candidates.push(record.requestParcels.length);
    }
  }
  for (const label of labels) {
    const labelParcelCount = labelParcelCountValue(label);
    if (labelParcelCount) candidates.push(labelParcelCount);
  }
  const count = Math.max(0, ...candidates.filter((value) => Number.isFinite(value) && value > 0).map((value) => Math.floor(value)));
  return count || 1;
}

function addressRecord(order: OrderRow) {
  const candidates = [
    order.shipping_address_json,
    order.shippo_to_address_json,
    order.customer_address_json,
    order.shipping_address,
    order.customer_address,
  ];
  for (const candidate of candidates) {
    const record = parseRecord(candidate);
    if (record) return record;
  }
  return {};
}

function addressLine(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function shipToLines(order: OrderRow) {
  const address = addressRecord(order);
  const name = addressLine(address, ["name", "fullName", "full_name"]) || fieldText(order, ["customer_name"]);
  const email = addressLine(address, ["email"]) || fieldText(order, ["customer_email"]);
  const phone = addressLine(address, ["phone"]) || fieldText(order, ["customer_phone"]);
  const line1 = addressLine(address, ["line1", "street1", "address1", "street"]);
  const line2 = addressLine(address, ["line2", "street2", "address2"]);
  const city = addressLine(address, ["city"]);
  const state = addressLine(address, ["state", "province"]);
  const postalCode = addressLine(address, ["postalCode", "postal_code", "zip", "zipCode"]);
  const country = addressLine(address, ["country", "countryCode", "country_code"]);

  return [
    name,
    email,
    phone,
    [line1, line2].filter(Boolean).join(", "),
    [city, state, postalCode].filter(Boolean).join(", "),
    country,
  ].filter(Boolean);
}

function openInternalLabel(order: OrderRow, rows: ReturnType<typeof itemRows>, shipTo: string[], print = false) {
  const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const payload = {
    orderRef: detailValue(order.order_ref || order.id),
    customer: detailValue(order.customer_name),
    shipTo,
    items: rows.map((item) => ({
      name: item.name,
      size: item.size,
      quantity: item.quantity,
    })),
  };
  sessionStorage.setItem(`sai-internal-label:${key}`, JSON.stringify(payload));
  const url = `${window.location.origin}/admin-v2.5/internal-label?key=${encodeURIComponent(key)}${print ? "&print=1" : ""}`;
  window.open(url, "_blank");
}

function plannedShipDate(order: OrderRow) {
  const raw = fieldText(order, ["shippo_shipment_date", "planned_ship_date", "planned_shipping_date"]);
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    if (!Number.isNaN(date.getTime())) return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  return raw;
}

function shippoRates(order: OrderRow) {
  return parseArray(order.shippo_shipment_rates_json);
}

function rateLabel(rate: Record<string, unknown>) {
  const serviceLevel = parseRecord(rate.servicelevel);
  const carrier = String(rate.provider_name || rate.provider || rate.carrier || "").trim() || "-";
  const service = String(serviceLevel?.name || serviceLevel?.token || rate.servicelevel_name || rate.service || "").trim();
  const amount = Number(rate.amount);
  const cost = Number.isFinite(amount)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: String(rate.currency || "USD") }).format(amount)
    : "-";
  return { carrier, service: service || "-", cost };
}

function rateEta(rate: Record<string, unknown>) {
  const days = Number(rate.estimated_days);
  if (Number.isFinite(days) && days > 0) {
    const rounded = Math.max(1, Math.round(days));
    return `Estimated delivery ${formatDeliveryDate(addBusinessDays(new Date(), rounded))}`;
  }
  const durationTerms = String(rate.duration_terms || "").trim();
  if (durationTerms) {
    return durationTerms;
  }
  return "";
}

function addBusinessDays(start: Date, days: number) {
  const date = new Date(start);
  let remaining = days;
  while (remaining > 0) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) {
      remaining -= 1;
    }
  }
  return date;
}

function formatDeliveryDate(date: Date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function rateObjectId(rate: Record<string, unknown>) {
  return String(rate.object_id || rate.id || "").trim();
}

function rateCostCents(rate: Record<string, unknown>) {
  const amount = Number.parseFloat(String(rate.amount ?? ""));
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
}

function cheapestAvailableRate(rates: Record<string, unknown>[]) {
  return rates
    .filter((rate) => Boolean(rateObjectId(rate)) && rateCostCents(rate) != null)
    .sort((a, b) => Number(rateCostCents(a)) - Number(rateCostCents(b)))[0] || null;
}

function isOnlineStoreOrder(order: OrderRow) {
  return normalize(fieldText(order, ["order_source"])) === "web" || normalize(fieldText(order, ["order_type"])) === "online";
}

function isAutomaticManualLabelOrder(order: OrderRow) {
  return (
    normalize(fieldText(order, ["order_source"])) === "manual" &&
    normalize(fieldText(order, ["payment_flow"])) === "square_payment_link" &&
    normalize(fieldText(order, ["fulfillment_method"]) || "carrier") === "carrier" &&
    order.shippo_label_required !== false
  );
}

function shippingProviderDisplayName(provider: string) {
  const normalized = normalize(provider);
  if (normalized === "fallback") return "Backup estimate";
  if (normalized === "shippo") return "Shippo";
  if (normalized === "ups") return "UPS";
  return provider || "-";
}

function selectedRateSummary(order: OrderRow, rates: Record<string, unknown>[]) {
  const selectedId = fieldText(order, ["quoted_shipping_provider_quote_id"]);
  const selectedRate = selectedId
    ? rates.find((rate) => rateObjectId(rate) === selectedId)
    : null;
  const display = selectedRate ? rateLabel(selectedRate) : null;
  const provider = fieldText(order, ["quoted_shipping_provider"]) || display?.carrier || "";
  const service = fieldText(order, ["quoted_shipping_service_label", "quoted_shipping_service_code"]) || display?.service || "";
  const rawCost =
    fieldCents(order, ["quoted_shipping_base_amount_cents", "quoted_shipping_amount_cents"]);
  const cost = rawCost == null ? display?.cost || "" : formatUsdCents(rawCost);
  if (!display && (!service || rawCost == null || rawCost <= 0)) return null;
  if (!provider && !service && !cost && !selectedId) return null;
  return {
    provider: shippingProviderDisplayName(provider || ""),
    providerCode: provider || "",
    service: service || "-",
    cost: cost || "-",
    id: selectedId || "",
  };
}

function drawerShippoError(order: OrderRow) {
  return fieldText(order, ["shippo_shipment_sync_error", "shippo_label_sync_error", "shippo_last_error", "shippo_sync_error"]);
}

function paymentFlowLabel(order: OrderRow) {
  const flow = fieldText(order, ["payment_flow"]);
  const manualMethod = normalize(fieldText(order, ["manual_payment_method"]));
  if (flow === "square_payment_link") return "Square payment link";
  if (flow === "pay_later" && manualMethod === "arrival_payment_link") return "Send link upon arrival";
  if (flow === "pay_later") return "Pay later";
  return flow ? flow.replace(/_/g, " ") : "";
}

function orderStepState(index: number, order: OrderRow, labels: LabelRow[]): "done" | "active" | "pending" {
  if (isCancelled(order)) {
    if (index === 0 || index === 3) return "done";
    if (index === 1) return normalize(order.status) === "refunded" ? "done" : "active";
    const labelState = cancellationLabelRefundState(order, labels);
    return ["complete", "not_applicable"].includes(labelState) ? "done" : labelState === "attention" ? "active" : "pending";
  }
  const paid = isPaid(order);
  const labelDone = hasPurchasedLabel(order, labels);
  const shipped = isShipped(order);
  if (isLocalPayLaterOrder(order)) {
    if (index === 0) return "done";
    return shipped ? "done" : "active";
  }
  if (index === 0) return "done";
  if (index === 1) return paid ? "done" : "active";
  if (index === 2) {
    if (order.shippo_label_required === false) return shipped ? "done" : paid ? "active" : "pending";
    return labelDone ? "done" : paid ? "active" : "pending";
  }
  return shipped ? "done" : labelDone ? "active" : "pending";
}

function orderSteps(order: OrderRow, labels: LabelRow[]) {
  if (isCancelled(order)) return ["Order created", "Customer refund", "Label credit", "Cancelled"];
  if (isLocalPayLaterOrder(order)) {
    return ["Order created", "Deliver + collect payment"];
  }
  if (order.shippo_label_required === false || orderType(order) === "walkin") {
    return ["Order created", "Payment received", "Handed off"];
  }
  return ["Order created", "Payment received", "Label purchased", "Shipped"];
}

type OrderProgressState = "done" | "active" | "pending";

function timelineItems(order: OrderRow, labels: LabelRow[]): Array<{ label: string; detail: string; state: OrderProgressState }> {
  const paid = isPaid(order);
  const labelDone = hasPurchasedLabel(order, labels);
  const shipped = isShipped(order);
  const localOrder = order.shippo_label_required === false || orderType(order) === "walkin";
  const purchasedLabels = labelRecords(labels);
  const expectedPackageCount = labels.reduce((max, label) => Math.max(max, labelParcelCountValue(label) || 0), 0);
  const partialLabels = normalize(order.order_status) === "partial_label_purchase";
  const firstLabel = purchasedLabels[0];
  const orderTracking = trackingDisplayValue(order);
  const orderCarrier = fieldText(order, ["shippo_label_carrier"]);

  if (isCancelled(order)) {
    const squareComplete = normalize(order.status) === "refunded";
    const labelState = cancellationLabelRefundState(order, labels);
    const labelComplete = labelState === "complete";
    const labelAttention = labelState === "attention";
    const labelNotApplicable = labelState === "not_applicable";
    return [
      { label: "Order created", detail: formatDateTime(order.created_at), state: "done" },
      {
        label: squareComplete ? "Customer refund completed" : "Customer refund pending",
        detail: squareComplete ? "Square confirmed the refund." : "Square accepted the refund and is processing it.",
        state: squareComplete ? "done" : "active",
      },
      {
        label: labelComplete ? "Shipping-label credit completed" : labelAttention ? "Shipping-label credit needs review" : labelNotApplicable ? "No shipping-label credit" : "Shipping-label credit pending",
        detail: labelComplete ? "Shippo confirmed every label credit." : labelAttention ? "Review this refund in Shippo." : labelNotApplicable ? "This order has no purchased carrier label." : "Shippo accepted the label-refund request.",
        state: labelComplete || labelNotApplicable ? "done" : labelAttention ? "active" : "pending",
      },
      { label: "Order cancelled", detail: "Inventory restored.", state: "done" },
    ];
  }

  if (isLocalPayLaterOrder(order)) {
    return [
      { label: "Order created", detail: formatDateTime(order.created_at), state: "done" },
      {
        label: "Delivery + payment pending",
        detail: "Collect payment and upload delivery proof.",
        state: "active",
      },
    ];
  }

  const labelDetail =
    detailValue(firstLabel?.tracking_number) !== "-"
      ? detailValue(firstLabel?.tracking_number)
      : detailValue(firstLabel?.carrier) !== "-"
        ? `${detailValue(firstLabel?.carrier)} label on file`
        : orderTracking
          ? orderTracking
          : orderCarrier
            ? `${orderCarrier} label on file`
            : "Waiting for label";

  const shippedDetail =
    detailValue(trackingDisplayValue(order)) !== "-"
      ? detailValue(trackingDisplayValue(order))
        : "Not yet shipped";

  return [
    { label: "Order created", detail: formatDateTime(order.created_at), state: "done" },
    {
      label: paid ? "Payment received" : "Payment pending",
      detail: paid ? formatDateTime(order.created_at) : "Waiting for payment",
      state: paid ? "done" : "active",
    },
    localOrder
      ? {
          label: shipped ? "Handed off" : "Handoff pending",
          detail: shipped ? "Completed" : "Waiting for handoff",
          state: shipped ? "done" : paid ? "active" : "pending",
        }
      : {
          label: labelDone ? "Label purchased" : partialLabels ? "Labels incomplete" : "Label pending",
          detail: labelDone
            ? labelDetail
            : partialLabels
              ? `${purchasedLabels.length} of ${expectedPackageCount || "all"} labels purchased`
              : "Waiting for label",
          state: labelDone ? "done" : paid ? "active" : "pending",
        },
    ...(localOrder
      ? []
      : [
          {
            label: shipped ? "Shipped" : "Shipped",
            detail: shipped ? shippedDetail : "Not yet shipped",
            state: shipped ? "done" : labelDone ? "active" : "pending",
          } as const,
        ]),
  ];
}

function labelRecords(labels: LabelRow[]) {
  return labels.filter(
    (label) => normalize(labelStatusValue(label)) === "purchased" || labelUrlValue(label) || labelTrackingValue(label),
  );
}

function serviceTokenFromRate(rate: Record<string, unknown>) {
  const serviceLevel = parseRecord(rate.servicelevel);
  return String(serviceLevel?.token || rate.servicelevel_token || "").trim().toLowerCase();
}

function serviceNameFromRate(rate: Record<string, unknown>) {
  const serviceLevel = parseRecord(rate.servicelevel);
  return String(serviceLevel?.name || rate.servicelevel_name || rate.service || "").trim().toLowerCase();
}

function carrierFromRate(rate: Record<string, unknown>) {
  return String(rate.provider || rate.provider_name || rate.carrier || "").trim().toLowerCase();
}

function rateMatchesPurchasedLabels(rate: Record<string, unknown>, purchasedLabels: LabelRow[]) {
  const token = serviceTokenFromRate(rate);
  const service = serviceNameFromRate(rate);
  const carrier = carrierFromRate(rate);
  return purchasedLabels.some((label) => {
    const labelToken = labelServiceTokenValue(label).toLowerCase();
    const labelService = labelServiceNameValue(label).toLowerCase();
    const labelCarrier = labelCarrierValue(label).toLowerCase();
    const carrierMatches = !carrier || !labelCarrier || carrier.includes(labelCarrier) || labelCarrier.includes(carrier);
    return carrierMatches && ((token && labelToken && token === labelToken) || (service && labelService && service === labelService));
  });
}

function legacySinglePackageLabel(order: OrderRow, expectedParcelCount: number): LabelRow | null {
  if (expectedParcelCount !== 1 || !hasPurchasedLabel(order, [])) return null;
  return {
    parcel_index: 0,
    parcel_count: 1,
    status: "purchased",
    carrier: fieldText(order, ["shippo_label_carrier"]),
    servicelevel_name: fieldText(order, ["shippo_label_service"]),
    tracking_number: trackingValue(order),
    label_url: fieldText(order, ["shippo_label_url"]),
  };
}

function displayLabelRows(order: OrderRow, labels: LabelRow[], expectedParcelCount: number) {
  const byIndex = new Map<number, LabelRow>();
  for (const label of labels) {
    const index = labelParcelIndexValue(label);
    if (index !== null) {
      byIndex.set(index, label);
    }
  }
  const count = Math.max(expectedParcelCount, byIndex.size || 0);
  const legacyLabel = legacySinglePackageLabel(order, count);
  return Array.from({ length: count }, (_, index) => byIndex.get(index) || (index === 0 && legacyLabel) || {
      parcel_index: index,
      parcel_count: count,
      status: "not_purchased",
    });
}

function labelStatusDisplay(status: unknown) {
  const value = normalize(status);
  if (value === "purchased") return "Purchased";
  if (value === "failed") return "Failed";
  if (value === "processing") return "Processing";
  if (value === "not_purchased") return "Not purchased";
  return value ? readableSlug(value) : "Not purchased";
}

function statusChipClass(tone: Tone) {
  const classes: Record<Tone, string> = {
    neutral: "bg-sg-input-bg text-sg-muted",
    blue: "bg-sky-100 text-sky-800",
    green: "bg-emerald-50 text-emerald-700",
    red: "bg-sg-danger-soft text-sg-danger",
    amber: "bg-sg-warning-soft text-sg-warning",
  };
  return classes[tone];
}

function statusChipRadiusClass(label: string) {
  return label.trim().includes(" ") ? "rounded-[8px]" : "rounded-full";
}

function storedHandoffProofKey(orderId: string) {
  return `${HANDOFF_PROOF_STORAGE_PREFIX}${orderId}`;
}

function loadStoredHandoffProofs(orderId: string): { delivery: HandoffProof; payment: HandoffProof } {
  if (!orderId || typeof window === "undefined") return { delivery: null, payment: null };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storedHandoffProofKey(orderId)) || "{}");
    return {
      delivery: parsed?.delivery?.dataUrl ? parsed.delivery : null,
      payment: parsed?.payment?.dataUrl ? parsed.payment : null,
    };
  } catch {
    return { delivery: null, payment: null };
  }
}

function saveStoredHandoffProofs(orderId: string, delivery: HandoffProof, payment: HandoffProof) {
  if (!orderId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storedHandoffProofKey(orderId), JSON.stringify({ delivery, payment }));
  } catch {
    // Large photos can exceed browser storage. The order can still be completed.
  }
}

function SelectField<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) || options[0];

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative min-w-0 shrink-0">
      <button
        type="button"
        className="sg25-pill-field flex h-[36px] w-full min-w-[116px] items-center justify-between gap-2 px-3 pr-2.5 text-left text-[12px] md:w-auto"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="truncate">{selectedOption?.label || ""}</span>
        <Icon name="chevron" className={`h-3.5 w-3.5 shrink-0 text-sg-muted transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          role="listbox"
          className="absolute right-0 top-[calc(100%+6px)] z-30 w-max min-w-full max-w-[calc(100vw-2rem)] rounded-[7px] border border-sg-border bg-white px-1.5 py-1.5 shadow-[0_18px_40px_rgba(31,27,24,0.14)]"
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                className={`flex w-full items-center justify-between gap-3 rounded-[5px] px-3.5 py-2 text-left text-[12px] transition ${
                  active ? "bg-sg-primary-soft text-sg-primary" : "text-sg-text hover:bg-sg-input-bg"
                }`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="truncate">{option.label}</span>
                {active ? <span className="h-2 w-2 shrink-0 rounded-full bg-current" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function shortenRef(value: string | number | null | undefined) {
  const raw = String(value || "");
  return raw.length > 18 ? `${raw.slice(0, 4)}${raw.slice(-10)}` : raw || "-";
}

function formatOrderDate(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function KpiCard({
  label,
  value,
  description,
  icon,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  description: string;
  icon: "cart" | "clock" | "package" | "truck" | "alert";
  tone: Tone;
  onClick?: () => void;
}) {
  const iconClass = tone === "red" ? "bg-sg-danger-soft text-sg-danger" : tone === "amber" ? "bg-sg-warning-soft text-sg-warning" : "bg-sg-primary-soft text-sg-primary";
  return (
    <article
      className={`sg25-card min-w-0 p-5 lg:min-h-[122px] ${onClick ? "cursor-pointer transition hover:-translate-y-0.5 hover:shadow-md" : ""}`}
      onClick={onClick}
      onKeyDown={onClick ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } } : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold leading-tight text-sg-muted xl:text-[14px]">{label}</p>
          <p className="mt-3 text-3xl font-bold leading-none xl:text-4xl">{value}</p>
          <p className="mt-3 text-[12.5px] leading-snug text-sg-muted xl:text-[13px]">{description}</p>
        </div>
        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full xl:h-12 xl:w-12 ${iconClass}`}>
          <Icon name={icon} className="h-5 w-5 xl:h-6 xl:w-6" />
        </span>
      </div>
    </article>
  );
}

function ViewIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function DrawerSectionTitle({ icon, children }: { icon: Parameters<typeof Icon>[0]["name"]; children: string }) {
  return (
    <h3 className="flex items-center gap-2 text-[13px] font-semibold leading-none tracking-normal text-sg-muted">
      <Icon name={icon} className="h-3.5 w-3.5 shrink-0 text-sg-primary" />
      <span>{children}</span>
    </h3>
  );
}

function DrawerDisclosureTitle({ icon, children }: { icon: Parameters<typeof Icon>[0]["name"]; children: string }) {
  return (
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 [&::-webkit-details-marker]:hidden">
      <span className="flex items-center gap-2 text-[13px] font-semibold leading-none text-sg-muted">
        <Icon name={icon} className="h-3.5 w-3.5 shrink-0 text-sg-primary" />
        <span>{children}</span>
      </span>
      <Icon name="chevron" className="h-4 w-4 shrink-0 text-sg-muted transition-transform group-open:rotate-180" />
    </summary>
  );
}

function OrderCreatedModal({ onClose }: { onClose: () => void }) {
  const modal = (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-24" role="dialog" aria-modal="true" aria-labelledby="order-created-title" onClick={onClose}>
      <div className="w-full max-w-sm rounded-[10px] border border-sg-border bg-white p-5 text-center shadow-[0_24px_80px_rgba(31,27,24,0.22)]" onClick={(event) => event.stopPropagation()}>
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-sg-success-soft text-sg-success">
          <span className="text-lg font-bold">✓</span>
        </div>
        <h2 id="order-created-title" className="mt-3 text-lg font-bold">Order has been created!</h2>
        <button type="button" className="sg25-btn sg25-btn-ghost mt-4 h-9 px-5 text-[12px]" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function PurchaseLabelModal({
  onCancel,
  onConfirm,
  busy,
  parcelCount,
  remainingCount,
  carrier,
  service,
  cost,
  costCents,
  customerShippingBudgetCents,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  parcelCount: number;
  remainingCount: number;
  carrier: string;
  service: string;
  cost: string;
  costCents: number | null;
  customerShippingBudgetCents: number | null;
}) {
  const multi = parcelCount > 1;
  const resuming = multi && remainingCount < parcelCount;
  const overageCents = costCents != null && customerShippingBudgetCents != null
    ? costCents - customerShippingBudgetCents
    : 0;
  const modal = (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 px-4" role="dialog" aria-modal="true" aria-labelledby="purchase-label-title">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Cancel label purchase" onClick={busy ? undefined : onCancel} />
      <div className="relative w-full max-w-md rounded-[10px] border border-sg-border bg-white p-5 shadow-[0_24px_80px_rgba(31,27,24,0.24)]">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sg-warning-soft text-sg-warning">
            <Icon name="receipt" className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 id="purchase-label-title" className="text-lg font-bold leading-tight">
              {resuming ? `Complete ${remainingCount} remaining label${remainingCount === 1 ? "" : "s"}?` : multi ? `Purchase ${parcelCount} Shippo labels?` : "Purchase Shippo label?"}
            </h2>
            <p className="mt-2 text-[13px] leading-5 text-sg-muted">
              {resuming
                ? "Labels already purchased for this order will be skipped. Only incomplete packages will be processed."
                : multi
                ? "This creates one label transaction for each package in the selected packing plan."
                : "This creates a label transaction in the configured Shippo environment."}
            </p>
          </div>
        </div>
        <div className="mt-4 rounded-[8px] border border-sg-border bg-sg-input-bg px-3 py-3 text-[13px]">
          <div className="flex items-center justify-between gap-3">
            <span className="font-semibold">{[carrier, service].filter(Boolean).join(" · ") || "Selected Shippo service"}</span>
            <span className="shrink-0 font-bold">{cost || "-"}</span>
          </div>
          {overageCents > 0 ? (
            <p className="mt-2 rounded-[6px] bg-sg-warning-soft px-2.5 py-2 text-[12px] font-semibold leading-4 text-sg-warning">
              This label costs {formatUsdCents(overageCents)} more than the customer paid for shipping.
            </p>
          ) : null}
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="sg25-btn sg25-btn-ghost h-10 px-5 text-[12px]" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="sg25-btn sg25-btn-primary h-10 px-5 text-[12px]" disabled={busy} onClick={onConfirm}>
            {busy ? "Purchasing" : resuming ? `Complete ${remainingCount} label${remainingCount === 1 ? "" : "s"}` : multi ? `Purchase ${parcelCount} labels` : "Purchase label"}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function ResendNotificationModal({
  onCancel,
  onConfirm,
  busy,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const modal = (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 px-4" role="dialog" aria-modal="true" aria-labelledby="resend-notification-title">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Cancel notification resend" onClick={busy ? undefined : onCancel} />
      <div className="relative w-full max-w-md rounded-[10px] border border-sg-border bg-white p-5 shadow-[0_24px_80px_rgba(31,27,24,0.24)]">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sg-warning-soft text-sg-warning">
            <Icon name="alert" className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 id="resend-notification-title" className="text-lg font-bold leading-tight">Resend shipping notification?</h2>
            <p className="mt-2 text-[13px] leading-5 text-sg-muted">
              The buyer has already been notified. Confirming will send another shipping email for this order.
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="sg25-btn sg25-btn-ghost h-10 px-5 text-[12px]" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="sg25-btn sg25-btn-primary h-10 px-5 text-[12px]" disabled={busy} onClick={onConfirm}>
            {busy ? "Sending" : "Resend notification"}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function CancelOrderModal({ intent, busy, onCancel, onConfirm }: {
  intent: NonNullable<CancelIntent>;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const ready = reason.trim().length >= 3 && confirmation.trim().toUpperCase() === "CANCEL";
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 px-4" role="dialog" aria-modal="true" aria-labelledby="cancel-order-title">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Close cancellation" onClick={busy ? undefined : onCancel} />
      <div className="relative w-full max-w-lg rounded-[10px] border border-sg-border bg-white p-5 shadow-[0_24px_80px_rgba(31,27,24,0.24)]">
        <h2 id="cancel-order-title" className="text-lg font-bold text-sg-danger">Cancel and refund {intent.orderRef}?</h2>
        <p className="mt-2 text-[13px] leading-5 text-sg-muted">
          The system will refund or void {formatUsdCents(intent.totalCents)}, restore inventory, request refunds for {intent.purchasedLabels} purchased shipping label{intent.purchasedLabels === 1 ? "" : "s"}, and email the customer.
        </p>
        <p className="mt-3 rounded-[8px] bg-sg-warning-soft px-3 py-2 text-[12px] font-semibold leading-5 text-sg-warning">
          Square processing fees are not returned. Shippo or UPS label credits may remain pending and will be shown for manual follow-up.
        </p>
        <label className="mt-4 block text-[13px] font-semibold">Cancellation reason
          <textarea className="sg25-input mt-1 min-h-20 w-full p-3" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Customer requested cancellation" />
        </label>
        <label className="mt-3 block text-[13px] font-semibold">Type CANCEL to confirm
          <input className="sg25-input mt-1 h-10 w-full px-3" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" />
        </label>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="sg25-btn sg25-btn-ghost h-10 px-5 text-[12px]" disabled={busy} onClick={onCancel}>Keep order</button>
          <button type="button" className="sg25-btn h-10 bg-sg-danger px-5 text-[12px] text-white hover:opacity-90 disabled:opacity-50" disabled={busy || !ready} onClick={() => onConfirm(reason.trim())}>
            {busy ? "Cancelling and refunding" : "Cancel and refund"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ProductShippedModal({
  onCancel,
  onConfirm,
  busy,
  mode,
  proofName,
  paymentProofName,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  mode: "carrier" | "handoff" | "external";
  proofName?: string;
  paymentProofName?: string;
}) {
  const isHandoff = mode === "handoff";
  const isExternal = mode === "external";
  const modal = (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 px-4" role="dialog" aria-modal="true" aria-labelledby="product-shipped-title">
      <button type="button" className="absolute inset-0 cursor-default" aria-label={isHandoff ? "Cancel handoff confirmation" : "Cancel shipment confirmation"} onClick={busy ? undefined : onCancel} />
      <div className="relative w-full max-w-md rounded-[10px] border border-sg-border bg-white p-5 shadow-[0_24px_80px_rgba(31,27,24,0.24)]">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sg-success-soft text-sg-success">
            <Icon name="truck" className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 id="product-shipped-title" className="text-lg font-bold leading-tight">{isHandoff ? "Complete handoff?" : isExternal ? "Confirm B2B shipment?" : "Confirm product shipped?"}</h2>
            <p className="mt-2 text-[13px] leading-5 text-sg-muted">
              {isHandoff
                ? "Use this after delivery and payment collection are documented. This marks the order complete."
                : isExternal
                  ? "Use this after the external label is attached and the shipment has been handed to the carrier. This marks the order shipped and emails the buyer."
                : "Use this after the label is on the carton and the package has been dropped off. This marks the order shipped and emails the buyer."}
            </p>
            {isHandoff && proofName ? <p className="mt-2 text-[12px] font-semibold text-sg-text">Delivery photo: {proofName}</p> : null}
            {isHandoff && paymentProofName ? <p className="mt-1 text-[12px] font-semibold text-sg-text">Payment photo: {paymentProofName}</p> : null}
          </div>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="sg25-btn sg25-btn-ghost h-10 px-5 text-[12px]" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="sg25-btn sg25-btn-primary h-10 px-5 text-[12px]" disabled={busy} onClick={onConfirm}>
            {busy ? "Confirming" : isHandoff ? "Complete order" : "Confirm and notify buyer"}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function HandoffPhotoPreviewModal({
  proof,
  title = "Handoff photo",
  onClose,
}: {
  proof: NonNullable<HandoffProof>;
  title?: string;
  onClose: () => void;
}) {
  const modal = (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 px-4" role="dialog" aria-modal="true" aria-labelledby="handoff-photo-title">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Close handoff photo preview" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-[10px] border border-sg-border bg-white p-5 shadow-[0_24px_80px_rgba(31,27,24,0.24)]">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="handoff-photo-title" className="text-lg font-bold leading-tight">{title}</h2>
            <p className="mt-1 break-words text-[12px] font-semibold text-sg-muted">
              {proof.name} · {proof.sizeLabel}
            </p>
          </div>
          <button type="button" className="sg25-btn sg25-btn-ghost h-9 w-9 shrink-0 px-0" onClick={onClose} aria-label="Close">
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 overflow-hidden rounded-[8px] border border-sg-border bg-sg-input-bg">
          <img src={proof.dataUrl} alt="Handoff proof preview" className="max-h-[70vh] w-full object-contain" />
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}


function selectedPackingPlanFromOrder(order: OrderRow): PackingPlanSummary | null {
  const plan = parseRecord(order.shippo_parcels_override_json);
  if (!plan || plan.source !== "selected_fulfillment_packing_plan") return null;
  const parcels = Array.isArray(plan.parcels) ? (plan.parcels as PackingPlanParcel[]) : [];
  const parcelContents = Array.isArray(plan.parcelContents) ? (plan.parcelContents as PackingPlanContent[]) : [];
  return {
    source: String(plan.source || ""),
    planId: typeof plan.planId === "string" ? plan.planId : null,
    parcelCount: typeof plan.parcelCount === "number" ? plan.parcelCount : parcels.length,
    selectedAt: typeof plan.selectedAt === "string" ? plan.selectedAt : null,
    selectedBy: typeof plan.selectedBy === "string" ? plan.selectedBy : null,
    parcels,
    parcelContents,
  };
}

function packingPlanFromOrderSnapshots(order: OrderRow): PackingPlanSummary | null {
  const selected = selectedPackingPlanFromOrder(order);
  if (selected) return selected;
  for (const key of ["shippo_parcels_override_json", "quoted_parcel_summary_json", "shippo_parcel_audit_json"]) {
    const record = parseRecord(order[key]);
    if (!record) continue;
    const rawParcels = Array.isArray(record.parcels)
      ? record.parcels
      : Array.isArray(record.requestParcels)
        ? record.requestParcels
        : [];
    if (!rawParcels.length) continue;
    const parcelContents = Array.isArray(record.parcelContents) ? (record.parcelContents as PackingPlanContent[]) : [];
    return {
      source: String(record.source || key),
      planId: typeof record.planId === "string" ? record.planId : null,
      parcelCount: Number(record.parcelCount) || rawParcels.length,
      selectedAt: typeof record.selectedAt === "string" ? record.selectedAt : null,
      selectedBy: typeof record.selectedBy === "string" ? record.selectedBy : null,
      parcels: rawParcels as PackingPlanParcel[],
      parcelContents,
    };
  }
  return null;
}

function packingParcelSummary(parcel: PackingPlanParcel, index: number) {
  const length = String(parcel.length || "").trim();
  const width = String(parcel.width || "").trim();
  const height = String(parcel.height || "").trim();
  const weight = String(parcel.weight || "").trim();
  const dims = length && width && height ? `${length} x ${width} x ${height} in` : "Dimensions missing";
  const wt = weight ? `${weight} ${parcel.mass_unit || "lb"}` : "Weight missing";
  return `Package ${index + 1}: ${dims}, ${wt}`;
}

function readableSlug(value: unknown) {
  const raw = String(value || "").trim();
  const productNames: Record<string, string> = {
    "nitrile-standard": "Nitrile Examination - Standard",
    "nitrile-examination-standard": "Nitrile Examination - Standard",
    "black-nitrile-general": "Black Nitrile - General",
    "black-nitrile-heavy-duty": "Black Nitrile - Heavy Duty",
    "latex-standard": "Latex Examination - Standard",
  };
  if (productNames[raw]) return productNames[raw];
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function readableCarton(value: unknown) {
  const raw = String(value || "").trim();
  const cartonNames: Record<string, string> = {
    loose_1_box_carton: "1-box corrugated carton",
    loose_2_box_carton: "2-box corrugated carton",
    loose_3_5_box_carton: "3-5 box corrugated carton",
    standard_10_box_factory_carton: "Standard 10-box carton",
    general_10_box_factory_carton: "General 10-box carton",
    heavy_duty_10_box_factory_carton: "Heavy Duty 10-box carton",
  };
  return cartonNames[raw] || readableSlug(raw);
}

function packingItemLines(items: PackingPlanContent["contents"]) {
  if (!Array.isArray(items) || !items.length) return [];
  const groups = new Map<string, { slug: string; size: string; count: number }>();
  for (const item of items) {
    const slug = detailValue(item.slug);
    const size = detailValue(item.size);
    const key = `${slug}||${size}`;
    const current = groups.get(key);
    if (current) {
      current.count += 1;
    } else {
      groups.set(key, { slug, size, count: 1 });
    }
  }
  return Array.from(groups.values())
    .map((group) => `${readableSlug(group.slug)} ${group.size} x${group.count}`);
}

function packingCartonType(content: PackingPlanContent | undefined) {
  if (!content) return "Pending";
  if (content.type === "factory_case") {
    return content.cartonId ? readableCarton(content.cartonId) : `${readableSlug(content.slug)} factory carton`;
  }
  return readableCarton(content.cartonId);
}

function packingItems(content: PackingPlanContent | undefined) {
  if (!content) return ["Contents pending"];
  if (content.type === "factory_case") {
    return [`${readableSlug(content.slug)} ${detailValue(content.size)} x1 carton`];
  }
  const items = packingItemLines(content.contents);
  if (items.length) return items;
  const count = Number(content.retailBoxCount || 0);
  return [`${count || "Loose"} retail box${count === 1 ? "" : "es"}`];
}

function PackingPlanPanel({
  plan,
  selectedPlan,
  loading,
  error,
  locked,
  actionBusy,
  onRefresh,
  onSave,
  onClear,
}: {
  plan: PackingPlanSummary | null;
  selectedPlan: PackingPlanSummary | null;
  loading: boolean;
  error: string;
  locked: boolean;
  actionBusy: OrderActionKey | null;
  onRefresh: () => void;
  onSave: () => void;
  onClear: () => void;
}) {
  const activePlan = plan || selectedPlan;
  const parcels = Array.isArray(activePlan?.parcels) ? activePlan.parcels : [];
  const contents = Array.isArray(activePlan?.parcelContents) ? activePlan.parcelContents : [];
  const selectedCount = Number(selectedPlan?.parcelCount || selectedPlan?.parcels?.length || 0);
  const recommendedCount = Number(plan?.parcelCount || plan?.parcels?.length || 0);
  return (
    <section className="rounded-[10px] border border-sg-border p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <DrawerSectionTitle icon="package">Recommended Packing Plan</DrawerSectionTitle>
          <p className="mt-1 text-[12px] leading-5 text-sg-muted">
            Save this before refreshing rates or buying labels so Shippo uses the warehouse package set.
          </p>
        </div>
        <span className={`inline-flex w-fit shrink-0 rounded-full px-3 py-1 text-[12px] font-semibold ${selectedPlan ? "bg-sg-success-soft text-sg-success" : "bg-sg-input-bg text-sg-muted"}`}>
          {selectedPlan ? `${selectedCount || recommendedCount} selected` : recommendedCount ? `${recommendedCount} recommended` : "Not selected"}
        </span>
      </div>

      {error ? <p className="mt-3 rounded-[8px] bg-sg-danger-soft px-3 py-2 text-[13px] font-semibold text-sg-danger">{error}</p> : null}
      {!error && loading ? <p className="mt-3 rounded-[8px] border border-sg-border bg-sg-input-bg px-3 py-3 text-[13px] text-sg-muted">Loading packing plan...</p> : null}
      {!error && !loading && !parcels.length ? <p className="mt-3 rounded-[8px] border border-sg-border bg-sg-input-bg px-3 py-3 text-[13px] text-sg-muted">No packing plan is available for this order yet.</p> : null}

      {parcels.length ? (
        <div className="mt-3 space-y-2">
          {parcels.map((parcel, index) => (
            <div key={`${parcel.metadata || "parcel"}-${index}`} className="rounded-[8px] border border-sg-border bg-sg-input-bg px-3 py-3 text-[13px]">
              <p className="font-bold text-sg-text">{packingParcelSummary(parcel, index)}</p>
              <p className="mt-2 font-semibold text-sg-text">Carton Type: {packingCartonType(contents[index])}</p>
              <p className="mt-2 font-semibold text-sg-text">Item(s) to pack:</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sg-muted">
                {packingItems(contents[index]).map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      {locked ? <p className="mt-3 text-[12px] font-semibold text-sg-muted">Locked because a Shippo label has already been purchased.</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="sg25-btn sg25-btn-ghost h-9 px-4 text-[12px]" disabled={loading || actionBusy === "packingPreview"} onClick={onRefresh}>
          <Icon name="refresh" className={`h-4 w-4 ${loading || actionBusy === "packingPreview" ? "animate-spin" : ""}`} />
          Refresh plan
        </button>
        <button type="button" className="sg25-btn sg25-btn-primary h-9 px-4 text-[12px]" disabled={locked || !recommendedCount || actionBusy === "packingSave"} onClick={onSave}>
          {actionBusy === "packingSave" ? "Saving" : selectedPlan ? "Re-save selected plan" : "Use recommended plan"}
        </button>
        {selectedPlan ? (
          <button type="button" className="sg25-btn sg25-btn-ghost h-9 px-4 text-[12px]" disabled={locked || actionBusy === "packingClear"} onClick={onClear}>
            {actionBusy === "packingClear" ? "Clearing" : "Clear selected plan"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function OrderDrawer({
  order,
  labels,
  onClose,
  onSyncShippo,
  onLoadShipFrom,
  onPreviewPackingPlan,
  onSavePackingPlan,
  onClearPackingPlan,
  onPurchaseLabel,
  onRequestNotifyBuyer,
  onSendArrivalPaymentLink,
  onSaveExternalFulfillment,
  onRequestConfirmShipped,
  onRequestCancel,
  onCheckCancellationStatus,
  onSendRefundEmail,
  actionBusy,
  actionStatus,
}: {
  order: OrderRow;
  labels: LabelRow[];
  onClose: () => void;
  onSyncShippo: (orderId: string) => Promise<void>;
  onLoadShipFrom: (orderId: string) => Promise<AdminOrderShipFromDisplayResponse>;
  onPreviewPackingPlan: (orderId: string) => Promise<AdminOrderPackingPlanResponse>;
  onSavePackingPlan: (orderId: string) => Promise<void>;
  onClearPackingPlan: (orderId: string) => Promise<void>;
  onPurchaseLabel: (orderId: string, rateObjectId: string) => Promise<void>;
  onRequestNotifyBuyer: (orderId: string) => void;
  onSendArrivalPaymentLink: (orderId: string) => Promise<void>;
  onSaveExternalFulfillment: (body: Parameters<typeof saveOrderExternalFulfillment>[0]) => Promise<void>;
  onRequestConfirmShipped: (intent: NonNullable<ShipIntent>) => void;
  onRequestCancel: (intent: NonNullable<CancelIntent>) => void;
  onCheckCancellationStatus: (orderId: string) => Promise<void>;
  onSendRefundEmail: (orderId: string) => Promise<void>;
  actionBusy: OrderActionKey | null;
  actionStatus: { tone: "success" | "error"; message: string } | null;
}) {
  const payment = paymentState(order);
  const fulfillment = fulfillmentState(order, labels);
  const steps = orderSteps(order, labels);
  const rows = itemRows(order);
  const purchasedLabels = labelRecords(labels);
  const paid = isPaid(order);
  const next = nextAction(order, labels);
  const timeline = timelineItems(order, labels);
  const shipTo = shipToLines(order);
  const plannedDate = plannedShipDate(order);
  const rates = shippoRates(order);
  const onlineStoreOrder = isOnlineStoreOrder(order);
  const automaticManualLabel = isAutomaticManualLabelOrder(order);
  const automaticLabelOrder = onlineStoreOrder || automaticManualLabel;
  const automaticWorkflow = normalize(order.order_status);
  const automaticExceptionRetryAllowed = automaticLabelOrder && ["paid_label_retry", "partial_label_failure", "partial_label_purchase", "admin_review_required"].includes(automaticWorkflow);
  const customerShippingBudgetCents = fieldCents(order, ["paid_shipping_amount_cents", "quoted_shipping_total_cents", "shipping_cents"]) ?? 0;
  const customerShippingChargeCents = fieldCents(order, ["paid_shipping_amount_cents", "quoted_shipping_total_cents", "shipping_cents"]);
  const recommendedRate = cheapestAvailableRate(rates);
  const recommendedRateId = recommendedRate ? rateObjectId(recommendedRate) : "";
  const recommendedRateCostCents = recommendedRate ? rateCostCents(recommendedRate) : null;
  const selectedRate = selectedRateSummary(order, rates);
  const shippoError = drawerShippoError(order);
  const orderId = String(order.id || "");
  const expectedParcelCount = parcelCountFromOrder(order, labels);
  const remainingLabelCount = Math.max(0, expectedParcelCount - purchasedPackageCount(labels));
  const labelRows = displayLabelRows(order, labels, expectedParcelCount);
  const carrierOrder = order.shippo_label_required !== false && orderType(order) !== "walkin";
  const b2bShippingOrder = isB2bShippingOrder(order);
  const localHandoffOrder = order.shippo_label_required === false && orderType(order) !== "walkin" && !b2bShippingOrder;
  const anyLabelPurchased = hasPurchasedLabel(order, labels);
  const allExpectedLabelsPurchased = expectedParcelCount > 1 ? purchasedLabels.length >= expectedParcelCount : anyLabelPurchased;
  const labelPurchased = allExpectedLabelsPurchased;
  const purchasedRateObjectId = fieldText(order, ["shippo_selected_rate_object_id"]);
  const purchasedRate = labelPurchased
    ? rates.find((rate) => {
        const objectId = rateObjectId(rate);
        return (Boolean(objectId) && objectId === purchasedRateObjectId) || rateMatchesPurchasedLabels(rate, purchasedLabels);
      }) || null
    : null;
  const purchasedRateDisplay = purchasedRate ? rateLabel(purchasedRate) : null;
  const purchasedRateEta = purchasedRate ? rateEta(purchasedRate) : "";
  const labelUrl = fieldText(order, ["shippo_label_url"]) || (purchasedLabels[0] ? labelUrlValue(purchasedLabels[0]) : "");
  const labelDocuments = purchasedLabels
    .map((label, index) => ({
      key: `${labelUrlValue(label) || labelTrackingValue(label) || index}`,
      label: purchasedLabels.length > 1 ? `Label ${index + 1}` : "Label",
      url: labelUrlValue(label),
      tracking: labelTrackingValue(label),
      carrier: labelCarrierValue(label),
      service: labelServiceNameValue(label),
      parcelIndex: labelParcelIndexValue(label),
    }))
    .filter((label) => label.url || label.tracking);
  const documentUrls = labelDocuments.filter((label) => label.url);
  if (!documentUrls.length && labelUrl) {
    documentUrls.push({ key: labelUrl, label: "Label", url: labelUrl, tracking: "", carrier: "", service: "", parcelIndex: null });
  }
  const trackingText = detailValue(trackingDisplayValue(order));
  const shippingSummaryText = detailValue(shippingSummary(order, labels));
  const showSeparateShippingSummary = shippingSummaryText !== "-" && shippingSummaryText !== trackingText;
  const shipped = isShipped(order);
  const cancelled = isCancelled(order);
  const paymentLinkUrl = fieldText(order, ["payment_link_url"]);
  const arrivalLinkOrder = normalize(fieldText(order, ["manual_payment_method"])) === "arrival_payment_link";
  const localPayLaterPending = isLocalPayLaterOrder(order);
  const requiresPaymentProof = localPayLaterPending && !arrivalLinkOrder;
  const canSyncShippo = carrierOrder && paid && !labelPurchased;
  const canConfirmShipped = carrierOrder && labelPurchased && !shipped && !cancelled;
  const canResendNotify = carrierOrder && labelPurchased && shipped;
  const canCompleteHandoff = localHandoffOrder && !shipped && (paid || (localPayLaterPending && !arrivalLinkOrder));
  const externalCarrier = fieldText(order, ["admin_external_carrier"]);
  const externalService = fieldText(order, ["admin_external_service"]);
  const externalTracking = fieldText(order, ["admin_external_tracking_number"]);
  const externalShipDate = fieldText(order, ["admin_external_shipped_date"]);
  const externalLabelCost = fieldCents(order, ["admin_external_label_cost_cents"]);
  const hasExternalLabelRecord = Boolean(externalCarrier || externalService || externalTracking || externalShipDate || externalLabelCost != null);
  const hasExternalLabelFile = Boolean(fieldText(order, ["admin_external_label_storage_path"]));
  const externalRecordComplete = Boolean(externalCarrier && externalTracking && hasExternalLabelFile);
  const canConfirmExternalShipped = b2bShippingOrder && paid && externalRecordComplete && !shipped && !cancelled;
  const cancelStatus = normalize(order.status);
  const canCancelAndRefund = Boolean(fieldText(order, ["payment_id"])) && orderType(order) !== "walkin" && !shipped &&
    cancelStatus === "paid";
  const customerRefundComplete = cancelStatus === "refunded";
  const labelRefundState = cancellationLabelRefundState(order, labels);
  const labelRefundComplete = labelRefundState === "complete";
  const labelRefundAttention = labelRefundState === "attention";
  const labelRefundNotApplicable = labelRefundState === "not_applicable";
  const showCancellationStatus = cancelled && Boolean(fieldText(order, ["payment_id"]));
  const [externalForm, setExternalForm] = useState({
    carrier: externalCarrier,
    service: externalService,
    trackingNumber: externalTracking,
    shippedDate: externalShipDate,
    labelCost: externalLabelCost == null ? "" : (externalLabelCost / 100).toFixed(2),
  });
  const [externalLabelFiles, setExternalLabelFiles] = useState<File[]>([]);
  const [externalPackingFiles, setExternalPackingFiles] = useState<File[]>([]);
  const [externalFormError, setExternalFormError] = useState("");
  const paymentFlow = paymentFlowLabel(order);
  const paymentLinkSentAt = fieldText(order, ["payment_link_sent_at"]);
  const paymentLinkExpiresAt = fieldText(order, ["payment_link_expires_at"]);
  const paymentLinkExpired = Boolean(paymentLinkExpiresAt) && new Date(paymentLinkExpiresAt).getTime() <= Date.now();
  const paymentLinkNeedsResend = automaticManualLabel && !paid && (
    paymentLinkExpired || normalize(fieldText(order, ["payment_link_status"])) === "expired"
  );
  const paymentDetailRows = [
    { label: "Method", value: fieldText(order, ["payment_method", "manual_payment_method"]) },
    { label: "Payment flow", value: paymentFlow },
    { label: "Link sent", value: paymentLinkSentAt ? formatDateTime(paymentLinkSentAt) : "" },
    { label: "Link expires", value: paymentLinkExpiresAt ? formatDateTime(paymentLinkExpiresAt) : "" },
    { label: "Discount", value: fieldText(order, ["manual_discount_label", "discount_code_used"]) },
    {
      label: "Processing fee",
      value: fieldCents(order, ["actual_processing_fee_cents"]) != null
        ? `${formatUsdCents(fieldCents(order, ["actual_processing_fee_cents"]))} · actual`
        : fieldCents(order, ["estimated_processing_fee_cents"]) != null
          ? `${formatUsdCents(fieldCents(order, ["estimated_processing_fee_cents"]))} · estimated`
          : "",
    },
    {
      label: "Fee reconciliation",
      value: fieldText(order, ["processing_fee_status"])
        .replaceAll("_", " ")
        .replace(/^./, (value) => value.toUpperCase()),
    },
  ].filter((row) => Boolean(row.value));
  const [handoffProof, setHandoffProof] = useState<HandoffProof>(null);
  const [handoffPaymentProof, setHandoffPaymentProof] = useState<HandoffProof>(null);
  const [savedHandoffProof, setSavedHandoffProof] = useState<HandoffProof>(null);
  const [savedHandoffPaymentProof, setSavedHandoffPaymentProof] = useState<HandoffProof>(null);
  const [handoffProofError, setHandoffProofError] = useState("");
  const [handoffPhotoPreview, setHandoffPhotoPreview] = useState<{ title: string; proof: NonNullable<HandoffProof> } | null>(null);
  const handoffInputRef = useRef<HTMLInputElement | null>(null);
  const handoffPaymentInputRef = useRef<HTMLInputElement | null>(null);
  const handoffReady = Boolean(handoffProof) && (!requiresPaymentProof || Boolean(handoffPaymentProof));
  const deliveryPreviewProof = handoffProof || savedHandoffProof;
  const paymentPreviewProof = handoffPaymentProof || savedHandoffPaymentProof;
  const arrivalDeliveryReady = !arrivalLinkOrder || paid || Boolean(paymentLinkUrl);
  const canSendArrivalLink = localHandoffOrder && arrivalLinkOrder && !paid;
  const [packingPlan, setPackingPlan] = useState<PackingPlanSummary | null>(null);
  const [selectedPackingPlan, setSelectedPackingPlan] = useState<PackingPlanSummary | null>(() => packingPlanFromOrderSnapshots(order));
  const [packingPlanLoading, setPackingPlanLoading] = useState(false);
  const [packingPlanError, setPackingPlanError] = useState("");
  const [shipFromLines, setShipFromLines] = useState<string[]>([]);
  const [shipFromLoading, setShipFromLoading] = useState(false);
  const [shipFromError, setShipFromError] = useState("");
  const activePackingPlan = packingPlan || selectedPackingPlan;
  const packingParcels = Array.isArray(activePackingPlan?.parcels) ? activePackingPlan.parcels : [];
  const packingContents = Array.isArray(activePackingPlan?.parcelContents) ? activePackingPlan.parcelContents : [];
  // Labels must always be matched to the parcel snapshot that was selected for this order.
  // A freshly calculated recommendation may reflect later packaging-setting changes.
  const savedLabelPackingPlan = selectedPackingPlan || packingPlanFromOrderSnapshots(order);
  const savedLabelParcels = Array.isArray(savedLabelPackingPlan?.parcels) ? savedLabelPackingPlan.parcels : [];
  const savedLabelContents = Array.isArray(savedLabelPackingPlan?.parcelContents) ? savedLabelPackingPlan.parcelContents : [];

  async function refreshPackingPlan() {
    if (!carrierOrder) return;
    setPackingPlanLoading(true);
    setPackingPlanError("");
    try {
      const result = await onPreviewPackingPlan(orderId);
      setPackingPlan(result.packingPlan || null);
      setSelectedPackingPlan(result.selectedPackingPlan || packingPlanFromOrderSnapshots(order));
    } catch (error) {
      const message = error instanceof ApiError || error instanceof Error ? error.message : "Could not load packing plan.";
      setPackingPlanError(message);
    } finally {
      setPackingPlanLoading(false);
    }
  }

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    setPackingPlan(null);
    setSelectedPackingPlan(packingPlanFromOrderSnapshots(order));
    setPackingPlanError("");
  }, [order]);

  useEffect(() => {
    if (!carrierOrder) return;
    void refreshPackingPlan();
  }, [orderId, carrierOrder]);

  useEffect(() => {
    if (!carrierOrder) return;
    let active = true;
    setShipFromLoading(true);
    setShipFromError("");
    void onLoadShipFrom(orderId)
      .then((result) => {
        if (!active) return;
        setShipFromLines(Array.isArray(result.lines) ? result.lines.filter(Boolean) : []);
      })
      .catch((error) => {
        if (!active) return;
        setShipFromLines([]);
        setShipFromError(error instanceof Error ? error.message : "Could not load warehouse address.");
      })
      .finally(() => {
        if (active) setShipFromLoading(false);
      });
    return () => {
      active = false;
    };
  }, [orderId, carrierOrder, onLoadShipFrom]);

  useEffect(() => {
    const stored = loadStoredHandoffProofs(orderId);
    setHandoffProof(null);
    setHandoffPaymentProof(null);
    setSavedHandoffProof(stored.delivery);
    setSavedHandoffPaymentProof(stored.payment);
    setHandoffProofError("");
    setHandoffPhotoPreview(null);
  }, [orderId]);

  function handleProofFileChange(file: File | null | undefined, setProof: (proof: HandoffProof) => void) {
    setHandoffProofError("");
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setProof(null);
      setHandoffProofError("Upload a photo file.");
      return;
    }
    const maxBytes = 8 * 1024 * 1024;
    if (file.size > maxBytes) {
      setProof(null);
      setHandoffProofError("Photo must be 8 MB or smaller.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result) {
        setHandoffProofError("Could not read the photo.");
        return;
      }
      setProof({
        name: file.name,
        sizeLabel: `${Math.max(1, Math.round(file.size / 1024))} KB`,
        dataUrl: result,
      });
    };
    reader.onerror = () => setHandoffProofError("Could not read the photo.");
    reader.readAsDataURL(file);
  }

  function handleHandoffProofChange(file: File | null | undefined) {
    handleProofFileChange(file, setHandoffProof);
  }

  function handlePaymentProofChange(file: File | null | undefined) {
    handleProofFileChange(file, setHandoffPaymentProof);
  }

  const drawer = (
    <div className="sg25-drawer-backdrop-in fixed inset-0 z-50 flex h-dvh justify-end overflow-hidden bg-black/45" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Close order details" onClick={onClose} />
      <aside className="sg25-drawer-slide-in relative flex h-dvh w-full max-w-[980px] flex-col overflow-hidden border-l border-sg-border bg-white shadow-[0_24px_80px_rgba(31,27,24,0.22)]">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-sg-border bg-white px-5 py-5 sm:px-7">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 break-words text-xl font-bold leading-tight">{order.order_ref || order.id}</h2>
              <span className="inline-flex rounded-full bg-sg-blue-soft px-3 py-1 text-[12px] font-semibold text-sg-blue">{orderTypeLabel(order)}</span>
              <span className={`inline-flex rounded-full px-3 py-1 text-[12px] font-semibold ${statusChipClass(payment.tone)}`}>{payment.label}</span>
            </div>
            <p className="mt-1.5 text-[13px] text-sg-muted">
              <span className="font-semibold text-sg-text">{detailValue(order.customer_name)}</span>
              {order.customer_email ? <span> · {order.customer_email}</span> : null}
              <span> · Created {formatDateTime(order.created_at)}</span>
            </p>
          </div>
          <button type="button" className="sg25-btn sg25-btn-ghost h-11 w-11 shrink-0 px-0" onClick={onClose} aria-label="Close">
            <Icon name="x" className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div className="overflow-x-auto border-b border-sg-border bg-sg-input-bg/25 px-5 py-4 sm:px-7">
            <ol className="flex min-w-[680px] items-center gap-3">
              {steps.map((step, index) => {
                const state = orderStepState(index, order, labels);
                const nextState = index < steps.length - 1 ? orderStepState(index + 1, order, labels) : "pending";
                const dotClass =
                  state === "done"
                    ? "border-emerald-600 bg-emerald-600 text-white"
                    : state === "active"
                      ? "border-sg-primary bg-sg-primary text-white"
                      : "border-sg-border bg-sg-input-bg text-sg-muted";
                const labelClass =
                  state === "done" ? "text-emerald-700" : state === "active" ? "text-sg-primary" : "text-sg-muted";
                const lineClass = state === "done" && nextState === "done" ? "bg-emerald-200" : "bg-sg-border";
                return (
                  <li key={step} className="flex min-w-0 flex-1 items-center gap-3 last:flex-none">
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[12px] font-bold ${dotClass}`}>
                      {state === "done" ? "✓" : index + 1}
                    </span>
                    <span className={`shrink-0 text-[13px] font-semibold ${labelClass}`}>{step}</span>
                    {index < steps.length - 1 ? <span className={`h-px min-w-10 flex-1 ${lineClass}`} /> : null}
                  </li>
                );
              })}
            </ol>
          </div>

          <div className="grid gap-4 px-5 py-5 sm:px-7 lg:grid-cols-[minmax(0,1.75fr)_minmax(280px,1fr)]">
            <div className="space-y-4">
              <section className="rounded-[10px] border border-sg-border p-4">
                <DrawerSectionTitle icon="clipboard">Order Overview</DrawerSectionTitle>
                <div className="mt-3 divide-y divide-sg-border/30 text-[13px]">
                  <div className="grid gap-x-8 py-2 first:pt-0 sm:grid-cols-[150px_minmax(0,1fr)]"><span className="text-sg-muted">Order</span><span className="break-words font-semibold">{detailValue(order.order_ref || order.id)}</span></div>
                  <div className="grid gap-x-8 py-2 sm:grid-cols-[150px_minmax(0,1fr)]"><span className="text-sg-muted">Created</span><span className="font-semibold">{formatDateTime(order.created_at)}</span></div>
                  <div className="grid gap-x-8 py-2 sm:grid-cols-[150px_minmax(0,1fr)]"><span className="text-sg-muted">Type</span><span className="font-semibold">{orderTypeLabel(order)}</span></div>
                  <div className="grid gap-x-8 py-2 sm:grid-cols-[150px_minmax(0,1fr)]"><span className="text-sg-muted">Payment type</span><span className="font-semibold">{detailValue(paymentFlow || payment.label)}</span></div>
                  <div className="grid gap-x-8 py-2 sm:grid-cols-[150px_minmax(0,1fr)]"><span className="text-sg-muted">Payment status</span><span className="font-semibold">{paid ? "Paid" : "Unpaid"}</span></div>
                  <div className="grid gap-x-8 py-2 sm:grid-cols-[150px_minmax(0,1fr)]"><span className="text-sg-muted">Fulfillment</span><span className="font-semibold">{fulfillment.label}</span></div>
                  <div className="grid gap-x-8 py-2 sm:grid-cols-[150px_minmax(0,1fr)]"><span className="text-sg-muted">Next action</span><span className="font-semibold">{next}</span></div>
                  <div className="grid gap-x-8 pb-0 pt-2 sm:grid-cols-[150px_minmax(0,1fr)]"><span className="text-sg-muted">Planned ship date</span><span className="font-semibold">{plannedDate || "Not set"}</span></div>
                </div>
              </section>

              <section className="rounded-[10px] border border-sg-border p-4">
                <DrawerSectionTitle icon="package">Items Purchased</DrawerSectionTitle>
                <div className="mt-4 w-full max-w-full overflow-x-auto">
                  <table className="w-full min-w-[420px] text-left text-[13px]">
                    <thead className="text-[11px] uppercase text-sg-muted">
                      <tr>
                        <th className="border-b border-sg-border pb-2 font-bold">Product</th>
                        <th className="border-b border-sg-border pb-2 font-bold">Bundle</th>
                        <th className="border-b border-sg-border pb-2 text-center font-bold">Qty</th>
                        <th className="border-b border-sg-border pb-2 text-right font-bold">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length ? (
                        rows.map((item, index) => (
                          <tr key={`${item.name}-${index}`}>
                            <td className="border-b border-sg-border py-3 pr-3">
                              <p className="font-semibold">{item.name}</p>
                              {item.sizeLines.length ? item.sizeLines.map((detail) => <p key={detail} className="mt-0.5 text-[12px] text-sg-muted">{detail}</p>) : null}
                            </td>
                            <td className="border-b border-sg-border py-3 pr-3 font-semibold">{item.bundle}</td>
                            <td className="border-b border-sg-border py-3 pr-3 text-center font-semibold">{item.quantity}</td>
                            <td className="border-b border-sg-border py-3 text-right font-semibold">{item.total}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td className="py-3 text-sg-muted" colSpan={4}>No item detail available.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {packingParcels.length || packingPlanLoading || packingPlanError ? (
                  <div className="mt-5">
                    <p className="text-[14px] font-bold text-sg-muted">Pack this</p>
                    {packingPlanLoading ? (
                      <p className="mt-3 rounded-[8px] border border-sg-border bg-sg-input-bg px-3 py-3 text-[13px] text-sg-muted">Loading package plan...</p>
                    ) : null}
                    {packingPlanError ? (
                      <p className="mt-3 rounded-[8px] bg-sg-danger-soft px-3 py-2 text-[13px] font-semibold text-sg-danger">{packingPlanError}</p>
                    ) : null}
                    {packingParcels.length ? (
                      <div className="mt-3 space-y-2">
                        {packingParcels.map((parcel, index) => (
                          <div key={`${parcel.metadata || "parcel"}-${index}`} className="rounded-[8px] border border-sg-border bg-sg-input-bg px-3 py-3 text-[13px]">
                            <p className="font-bold text-sg-text">{packingParcelSummary(parcel, index)}</p>
                            <p className="mt-2 font-semibold text-sg-text">Carton Type: {packingCartonType(packingContents[index])}</p>
                            <p className="mt-2 font-semibold text-sg-text">Item(s) to pack:</p>
                            <ul className="mt-1 list-disc space-y-1 pl-5 text-sg-muted">
                              {packingItems(packingContents[index]).map((item) => <li key={item}>{item}</li>)}
                            </ul>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>

              <section className="rounded-[10px] border border-sg-border p-4">
                <DrawerSectionTitle icon="user">Customer</DrawerSectionTitle>
                <div className="mt-3 grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[70px_minmax(0,1fr)]">
                  <span className="text-sg-muted">Name</span><span className="font-semibold">{detailValue(order.customer_name)}</span>
                  <span className="text-sg-muted">Email</span><span className="break-words font-semibold">{detailValue(order.customer_email)}</span>
                  {order.customer_phone ? <><span className="text-sg-muted">Phone</span><span className="font-semibold">{detailValue(order.customer_phone)}</span></> : null}
                </div>
              </section>

              <section className="rounded-[10px] border border-sg-border p-4">
                <DrawerSectionTitle icon="pin">Ship-to Address</DrawerSectionTitle>
                {shipTo.length ? (
                  <address className="mt-3 space-y-1 text-[13px] not-italic text-sg-text">
                    {shipTo.map((line) => <p key={line}>{line}</p>)}
                  </address>
                ) : (
                  <p className="mt-3 text-[13px] text-sg-muted">No address on file.</p>
                )}
              </section>

              {order.shippo_label_required === false || orderType(order) === "walkin" ? null : (
                <>
                  <section className="rounded-[10px] border border-sg-border p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <DrawerSectionTitle icon="package">Ship-from Warehouse</DrawerSectionTitle>
                      <span className="inline-flex w-fit shrink-0 rounded-full bg-sg-input-bg px-3 py-1 text-[12px] font-semibold text-sg-muted">
                        {parseRecord(order.shippo_from_address_override_json) ? "Custom override" : "Default warehouse"}
                      </span>
                    </div>
                    {shipFromLoading ? <p className="mt-3 text-[13px] text-sg-muted">Loading warehouse address...</p> : null}
                    {shipFromError ? <p className="mt-3 rounded-[8px] bg-sg-danger-soft px-3 py-2 text-[13px] font-semibold text-sg-danger">{shipFromError}</p> : null}
                    {!shipFromLoading && !shipFromError && shipFromLines.length ? (
                      <address className="mt-3 space-y-1 text-[13px] not-italic text-sg-text">
                        {shipFromLines.map((line, index) => <p key={line} className={index === 0 ? "font-bold" : undefined}>{line}</p>)}
                      </address>
                    ) : null}
                  </section>

                  {b2bShippingOrder ? (
                    <section className="rounded-[10px] border border-sg-border p-4">
                      <DrawerSectionTitle icon="truck">Label Method</DrawerSectionTitle>
                      <div className="mt-3 rounded-[8px] border border-sg-primary bg-sg-primary-soft px-3 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-[13px] font-bold text-sg-primary">External label</p>
                            <p className="mt-1 text-[12px] leading-5 text-sg-muted">Use a label bought outside this admin flow.</p>
                          </div>
                          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-sg-primary">B2B</span>
                        </div>
                      </div>
                      {hasExternalLabelRecord ? (
                        <div className="mt-3 grid gap-x-8 gap-y-2 rounded-[8px] border border-sg-border bg-sg-input-bg px-3 py-3 text-[13px] sm:grid-cols-[150px_minmax(0,1fr)]">
                          <span className="text-sg-muted">Carrier</span><span className="font-semibold">{detailValue(externalCarrier)}</span>
                          <span className="text-sg-muted">Service</span><span className="font-semibold">{detailValue(externalService)}</span>
                          <span className="text-sg-muted">Tracking</span><span className="break-words font-semibold">{detailValue(externalTracking)}</span>
                          <span className="text-sg-muted">Shipment date</span><span className="font-semibold">{detailValue(externalShipDate)}</span>
                          <span className="text-sg-muted">Label cost</span><span className="font-semibold">{externalLabelCost == null ? "-" : formatUsdCents(externalLabelCost)}</span>
                        </div>
                      ) : null}
                    </section>
                  ) : null}

                  {!labelPurchased && (!automaticManualLabel || Boolean(shippoError)) ? (
                    <section className="rounded-[10px] border border-sg-border p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <DrawerSectionTitle icon="receipt">Purchase Shipping Label</DrawerSectionTitle>
                      </div>
                      <button
                        type="button"
                        className="sg25-btn sg25-btn-ghost h-9 whitespace-nowrap px-4 text-[12px]"
                        disabled={!canSyncShippo || actionBusy === "sync"}
                        onClick={() => void onSyncShippo(orderId)}
                      >
                        <Icon name="refresh" className={`h-4 w-4 ${actionBusy === "sync" ? "animate-spin" : ""}`} />
                        {actionBusy === "sync" ? "Refreshing" : rates.length ? "Refresh current rates" : "Get current rates"}
                      </button>
                    </div>
                    {actionStatus ? (
                      <p
                        className={`mt-3 rounded-[8px] px-3 py-2 text-[13px] font-semibold ${
                          actionStatus.tone === "success" ? "bg-sg-success-soft text-sg-success" : "bg-sg-danger-soft text-sg-danger"
                        }`}
                      >
                        {actionStatus.message}
                      </p>
                    ) : null}
                    {rates.length && recommendedRateCostCents != null ? (
                      <p className="mt-3 rounded-[8px] bg-sg-success-soft px-3 py-2 text-[12px] font-semibold text-sg-success">
                        Lowest-price service: {formatUsdCents(recommendedRateCostCents)}.
                        {automaticLabelOrder ? ` Customer paid ${formatUsdCents(customerShippingBudgetCents)} for shipping.` : ""}
                      </p>
                    ) : null}
                    {rates.length ? (
                      <details className="group mt-3" open={!labelPurchased || !purchasedRate}>
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-[8px] border border-sg-border bg-sg-input-bg px-3 py-3 text-[13px] [&::-webkit-details-marker]:hidden">
                          {purchasedRateDisplay ? (
                            <span className="grid min-w-0 flex-1 gap-x-4 gap-y-1 sm:grid-cols-[70px_minmax(0,1fr)_auto] sm:items-center">
                              <span className="font-semibold">{purchasedRateDisplay.carrier}</span>
                              <span className="min-w-0">
                                <span className="flex flex-wrap items-center gap-2">
                                  <span className="text-sg-muted">{purchasedRateDisplay.service}</span>
                                  <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">Purchased</span>
                                </span>
                                {purchasedRateEta ? <span className="mt-0.5 block text-[11px] text-sg-muted">{purchasedRateEta}</span> : null}
                              </span>
                              <span className="font-semibold">{purchasedRateDisplay.cost}</span>
                            </span>
                          ) : (
                            <span className="text-sg-muted">{rates.length} service{rates.length === 1 ? "" : "s"} available</span>
                          )}
                          <Icon name="chevron" className="h-4 w-4 shrink-0 text-sg-muted transition-transform group-open:rotate-180" />
                        </summary>
                        <div className="mt-2 w-full max-w-full overflow-x-auto">
                        <table className="w-full min-w-[420px] text-left text-[13px]">
                          <thead className="text-[11px] uppercase text-sg-muted">
                            <tr>
                              <th className="border-b border-sg-border pb-2 font-bold">Carrier</th>
                              <th className="border-b border-sg-border pb-2 font-bold">Service</th>
                              <th className="border-b border-sg-border pb-2 text-right font-bold">Cost</th>
                              <th className="border-b border-sg-border pb-2 text-right font-bold">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rates.map((rate, index) => {
                              const display = rateLabel(rate);
                              const eta = rateEta(rate);
                              const objectId = rateObjectId(rate);
                              const purchaseKey = `purchase:${objectId}` as const;
                              const isRecommendedRate = Boolean(objectId) && objectId === recommendedRateId;
                              const isPurchasedRate =
                                labelPurchased &&
                                ((Boolean(objectId) && objectId === purchasedRateObjectId) || rateMatchesPurchasedLabels(rate, purchasedLabels));
                              return (
                                <tr
                                  key={`${display.carrier}-${display.service}-${index}`}
                                  className={isPurchasedRate ? "bg-sg-success-soft/70" : ""}
                                >
                                  <td className="border-b border-sg-border py-3 pr-3 font-semibold">{display.carrier}</td>
                                  <td className="border-b border-sg-border py-3 pr-3 text-sg-muted">
                                    <div className="space-y-1">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span>{display.service}</span>
                                        {isRecommendedRate ? (
                                          <span className="inline-flex rounded-full bg-sg-success-soft px-2 py-0.5 text-[10px] font-bold text-sg-success">
                                            Recommended
                                          </span>
                                        ) : null}
                                        {isPurchasedRate ? (
                                          <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                                            Purchased
                                          </span>
                                        ) : null}
                                      </div>
                                      {eta ? <p className="text-[11px] leading-snug text-sg-muted">{eta}</p> : null}
                                      {isPurchasedRate ? (
                                        <p className="text-[11px] leading-snug text-emerald-700">Label purchased with this rate.</p>
                                      ) : null}
                                    </div>
                                  </td>
                                  <td className="border-b border-sg-border py-3 text-right font-semibold">{display.cost}</td>
                                  <td className="border-b border-sg-border py-3 pl-3 text-right">
                                    <button
                                      type="button"
                                      className={`sg25-btn h-8 min-w-[104px] whitespace-nowrap px-3 text-[11px] ${
                                        isPurchasedRate
                                          ? "border border-emerald-200 bg-emerald-100 text-emerald-800 opacity-100 hover:bg-emerald-100 disabled:opacity-100"
                                          : "sg25-btn-ghost"
                                      }`}
                                      disabled={!paid || labelPurchased || !objectId || actionBusy === purchaseKey || (automaticLabelOrder && !automaticExceptionRetryAllowed)}
                                      onClick={() => void onPurchaseLabel(orderId, objectId)}
                                    >
                                      {actionBusy === purchaseKey
                                        ? "Purchasing"
                                        : isPurchasedRate
                                          ? "Purchased"
                                          : automaticLabelOrder && !automaticExceptionRetryAllowed
                                            ? automaticWorkflow === "label_purchase_unknown"
                                              ? "Reconciling"
                                              : automaticWorkflow === "admin_review_required"
                                                ? "Review required"
                                                : "Automatic"
                                          : automaticExceptionRetryAllowed
                                            ? "Retry pending"
                                            : labelPurchased
                                              ? "Locked"
                                            : expectedParcelCount > 1
                                              ? remainingLabelCount < expectedParcelCount
                                                ? `Complete ${remainingLabelCount} label${remainingLabelCount === 1 ? "" : "s"}`
                                                : `Purchase ${expectedParcelCount} labels`
                                              : "Purchase label"}
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        </div>
                      </details>
                    ) : (
                      <p className="mt-3 rounded-[8px] border border-sg-border bg-sg-input-bg px-3 py-3 text-[13px] leading-5 text-sg-muted">
                        No current label rates stored yet.
                      </p>
                    )}
                    </section>
                  ) : null}
                </>
              )}

              <section className="rounded-[10px] border border-sg-border p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <DrawerSectionTitle icon="truck">Shipping / Label Records</DrawerSectionTitle>
                  {documentUrls.length ? (
                    <button
                      type="button"
                      className="sg25-btn sg25-btn-primary h-9 shrink-0 px-4 text-[12px]"
                      onClick={() => {
                        documentUrls.forEach((label) => {
                          window.open(label.url, "_blank", "noopener,noreferrer");
                        });
                      }}
                    >
                      <Icon name="receipt" className="h-4 w-4" />
                      {documentUrls.length > 1 ? "Print labels" : "Print label"}
                    </button>
                  ) : null}
                </div>
                <div className="mt-3 space-y-3 text-[13px]">
                  {carrierOrder ? (
                    <>
                      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-[120px_minmax(0,1fr)]">
                        <span className="text-sg-muted">Label lifecycle</span><span className="font-semibold">{fulfillment.label}</span>
                        <span className="text-sg-muted">Quoted carrier</span><span className="font-semibold">{detailValue(selectedRate?.provider)}</span>
                        <span className="text-sg-muted">Quoted service</span><span className="font-semibold">{detailValue(selectedRate?.service)}</span>
                        <span className="text-sg-muted">Shippo quoted label cost</span><span className="font-semibold">{detailValue(selectedRate?.cost)}</span>
                        <span className="text-sg-muted">Customer shipping charge</span><span className="font-semibold">{customerShippingChargeCents == null ? "-" : formatUsdCents(customerShippingChargeCents)}</span>
                      </div>
                      <p className="text-[12px] text-sg-muted">Shippo rates are sandbox quotes and not production carrier prices.</p>
                      <details className="group text-[12px]">
                        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 py-1 text-sg-muted/70 transition-colors hover:text-sg-muted [&::-webkit-details-marker]:hidden">
                          <Icon name="chevron" className="h-3 w-3 transition-transform group-open:rotate-180" />
                          <span>Technical details</span>
                        </summary>
                        <div className="mt-2 grid gap-x-6 gap-y-2 rounded-[8px] border border-sg-border/70 bg-sg-input-bg/50 px-3 py-3 sm:grid-cols-[120px_minmax(0,1fr)]">
                          <span className="text-sg-muted">Shippo order sync</span><span className="font-semibold">{shippoOrderSyncDisplay(order)}</span>
                          <span className="text-sg-muted">Shippo order ID</span><span className="break-words font-semibold">{detailValue(fieldText(order, ["shippo_order_id"]))}</span>
                          <span className="text-sg-muted">Quoted rate ID</span><span className="break-words font-semibold">{detailValue(selectedRate?.id)}</span>
                          <span className="text-sg-muted">Purchased rate ID</span><span className="break-words font-semibold">{detailValue(purchasedRateObjectId)}</span>
                        </div>
                      </details>
                      {shippoError ? (
                        <p className="rounded-[8px] bg-sg-danger-soft px-3 py-2 font-semibold text-sg-danger">
                          {shippoError}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                  {b2bShippingOrder ? (
                    <div className="space-y-3 rounded-[8px] border border-sg-border bg-sg-input-bg p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-bold">External B2B shipment</p>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${externalRecordComplete ? "bg-sg-success-soft text-sg-success" : "bg-white text-sg-muted"}`}>
                          {externalRecordComplete ? "Ready to ship" : "Record required"}
                        </span>
                      </div>
                      {!paid ? <p className="text-[12px] text-sg-muted">Fulfillment details can be saved after payment is received.</p> : null}
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="space-y-1 text-[12px] font-semibold">Carrier / freight agent
                          <input className="sg25-input h-10 w-full" value={externalForm.carrier} onChange={(event) => setExternalForm((current) => ({ ...current, carrier: event.target.value }))} placeholder="UPS Freight" />
                        </label>
                        <label className="space-y-1 text-[12px] font-semibold">Service
                          <input className="sg25-input h-10 w-full" value={externalForm.service} onChange={(event) => setExternalForm((current) => ({ ...current, service: event.target.value }))} placeholder="Ground freight" />
                        </label>
                        <label className="space-y-1 text-[12px] font-semibold">Tracking number
                          <textarea className="sg25-input min-h-20 w-full py-2" value={externalForm.trackingNumber} onChange={(event) => setExternalForm((current) => ({ ...current, trackingNumber: event.target.value }))} placeholder="One per line" />
                        </label>
                        <div className="grid gap-3">
                          <label className="space-y-1 text-[12px] font-semibold">Shipment date
                            <input className="sg25-input h-10 w-full" type="date" value={externalForm.shippedDate} onChange={(event) => setExternalForm((current) => ({ ...current, shippedDate: event.target.value }))} />
                          </label>
                          <label className="space-y-1 text-[12px] font-semibold">Actual label cost
                            <input className="sg25-input h-10 w-full" inputMode="decimal" value={externalForm.labelCost} onChange={(event) => setExternalForm((current) => ({ ...current, labelCost: event.target.value }))} placeholder="0.00" />
                          </label>
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="space-y-1 text-[12px] font-semibold">Shipping label
                          <input className="block w-full text-[12px] text-sg-muted" type="file" accept=".pdf,.png,.jpg,.jpeg" multiple onChange={(event) => setExternalLabelFiles(Array.from(event.target.files || []))} />
                        </label>
                        <label className="space-y-1 text-[12px] font-semibold">Packing slip (optional)
                          <input className="block w-full text-[12px] text-sg-muted" type="file" accept=".pdf,.png,.jpg,.jpeg" multiple onChange={(event) => setExternalPackingFiles(Array.from(event.target.files || []))} />
                        </label>
                      </div>
                      {externalFormError ? <p className="text-[12px] font-semibold text-sg-danger">{externalFormError}</p> : null}
                      <button
                        type="button"
                        className="sg25-btn sg25-btn-primary h-9 px-4 text-[12px]"
                        disabled={!paid || actionBusy === "externalFulfillment"}
                        onClick={() => void (async () => {
                          setExternalFormError("");
                          if (!externalForm.carrier.trim() || !externalForm.trackingNumber.trim()) {
                            setExternalFormError("Carrier and at least one tracking number are required.");
                            return;
                          }
                          if (!hasExternalLabelFile && !externalLabelFiles.length) {
                            setExternalFormError("Upload at least one shipping label.");
                            return;
                          }
                          const labelFiles = await Promise.all(externalLabelFiles.map(fileToExternalPayload));
                          const packingSlipFiles = await Promise.all(externalPackingFiles.map(fileToExternalPayload));
                          await onSaveExternalFulfillment({
                            orderId,
                            carrier: externalForm.carrier.trim(),
                            service: externalForm.service.trim(),
                            trackingNumber: externalForm.trackingNumber.trim(),
                            shippedDate: externalForm.shippedDate || null,
                            labelCostCents: externalForm.labelCost.trim() ? Math.max(0, Math.round(Number(externalForm.labelCost) * 100)) : null,
                            labelFiles,
                            packingSlipFiles,
                          });
                          setExternalLabelFiles([]);
                          setExternalPackingFiles([]);
                        })()}
                      >
                        <Icon name="receipt" className="h-4 w-4" />
                        {actionBusy === "externalFulfillment" ? "Saving" : "Save fulfillment record"}
                      </button>
                    </div>
                  ) : null}
                  {showSeparateShippingSummary ? (
                    <p><span className="block text-sg-muted">Summary</span><span className="font-semibold">{shippingSummaryText}</span></p>
                  ) : null}
                  {!labelRows.length ? (
                    <p><span className="block text-sg-muted">Tracking</span><span className="break-words font-semibold">{trackingText}</span></p>
                  ) : null}
                  {localHandoffOrder ? (
                    <div className="rounded-[8px] border border-sg-border bg-sg-input-bg px-3 py-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="text-[13px] font-bold">SAI internal label</p>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <button
                            type="button"
                            className="sg25-btn sg25-btn-primary h-9 px-4 text-[12px]"
                            onClick={() => openInternalLabel(order, rows, shipTo, true)}
                          >
                            <Icon name="receipt" className="h-4 w-4" />
                            Print SAI label
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {labelRows.length ? (
                    <div className="space-y-2">
                      {labelRows.map((label, index) => {
                        const rowLabelUrl = labelUrlValue(label);
                        const rowTracking = labelTrackingValue(label);
                        const rowCarrier = labelCarrierValue(label);
                        const rowService = labelServiceNameValue(label);
                        const rowError = labelErrorValue(label);
                        const rowParcelIndex = labelParcelIndexValue(label) ?? index;
                        const savedParcel = savedLabelParcels[rowParcelIndex];
                        const savedContents = savedLabelContents[rowParcelIndex];
                        return (
                        <div key={`${rowTracking || rowLabelUrl || index}`} className="rounded-[8px] border border-sg-border bg-sg-input-bg px-3 py-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-semibold">
                              Package {rowParcelIndex + 1} of {labelParcelCountValue(label) || expectedParcelCount}
                              <span className="ml-2 text-sg-muted">· {labelStatusDisplay(labelStatusValue(label))}</span>
                            </p>
                            {rowLabelUrl ? (
                              <button
                                type="button"
                                className="sg25-btn sg25-btn-ghost h-8 min-w-[104px] shrink-0 whitespace-nowrap px-3 text-[11px]"
                                onClick={() => window.open(rowLabelUrl, "_blank", "noopener,noreferrer")}
                              >
                                Open label
                              </button>
                            ) : null}
                          </div>
                          <p className="mt-1 break-words text-sg-muted">
                            {detailValue(rowCarrier)}{rowService ? ` • ${rowService}` : ""}{rowTracking ? ` • ${rowTracking}` : ""}
                          </p>
                          {savedParcel || savedContents ? (
                            <div className="mt-2 space-y-1 border-l-2 border-sg-border pl-2 text-[12px] leading-5 text-sg-muted">
                              <p><span className="font-semibold text-sg-text">Carton Type:</span> {packingCartonType(savedContents)}</p>
                              <p><span className="font-semibold text-sg-text">Contents:</span> {packingItems(savedContents).join(" · ")}</p>
                              {savedParcel ? <p><span className="font-semibold text-sg-text">Declared parcel:</span> {packingParcelSummary(savedParcel, rowParcelIndex).replace(/^Package \d+: /, "")}</p> : null}
                            </div>
                          ) : null}
                          {rowError ? <p className="mt-1 break-words font-semibold text-sg-danger">{rowError}</p> : null}
                        </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </section>

              {paymentLinkUrl ? (
                <details className="group rounded-[10px] border border-sg-border">
                  <DrawerDisclosureTitle icon="clipboard">Documents</DrawerDisclosureTitle>
                  <div className="grid gap-x-8 gap-y-2 border-t border-sg-border px-4 pb-4 pt-3 text-[13px] sm:grid-cols-[150px_minmax(0,1fr)]">
                    <span className="text-sg-muted">Payment link</span>
                    <span className={`font-semibold ${paymentLinkExpired ? "text-sg-danger" : "text-sg-success"}`}>
                      {paymentLinkExpired ? "Expired — resend required" : "Active · valid for 48 hours"}
                    </span>
                    {paymentLinkNeedsResend ? (
                      <div className="sm:col-span-2 sm:pl-[182px]">
                        <button
                          type="button"
                          className="sg25-btn sg25-btn-ghost h-9 whitespace-nowrap px-4 text-[12px]"
                          disabled={actionBusy === "arrivalLink"}
                          onClick={() => void onSendArrivalPaymentLink(orderId)}
                        >
                          <Icon name="arrow-up-right" className="h-4 w-4" />
                          {actionBusy === "arrivalLink" ? "Resending link" : "Resend 48-hour payment link"}
                        </button>
                      </div>
                    ) : null}
                  </div>
                </details>
              ) : null}

              {paymentDetailRows.length ? (
                <details className="group rounded-[10px] border border-sg-border">
                  <DrawerDisclosureTitle icon="receipt">Payment Details</DrawerDisclosureTitle>
                  <div className="grid gap-x-8 gap-y-2 border-t border-sg-border px-4 pb-4 pt-3 text-[13px] sm:grid-cols-[150px_minmax(0,1fr)]">
                    {paymentDetailRows.map((row) => (
                      <div key={row.label} className="contents">
                        <span className="text-sg-muted">{row.label}</span><span className="break-words font-semibold">{row.value}</span>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>

            <div className="space-y-4">
              <section className="rounded-[10px] border border-sg-border p-4">
                <DrawerSectionTitle icon="clock">Activity Timeline</DrawerSectionTitle>
                <div className="mt-4 space-y-0">
                  {timeline.map((item, index) => {
                    const markerClass =
                      item.state === "done"
                        ? "bg-emerald-600 text-white"
                        : item.state === "active"
                          ? "bg-sg-primary text-white"
                          : "border-2 border-sg-border bg-sg-input-bg text-sg-muted";
                    const connectorClass = item.state === "done" || item.state === "active" ? "bg-sg-border" : "bg-sg-border/60";
                    return (
                      <div key={`${item.label}-${index}`} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${markerClass}`}>
                            {item.state === "done" ? "✓" : item.state === "active" ? <span className="h-2 w-2 rounded-full bg-white" /> : null}
                          </span>
                          {index < timeline.length - 1 ? <span className={`mt-1 w-px flex-1 ${connectorClass}`} /> : null}
                        </div>
                        <div className="min-w-0 pb-5">
                          <p className={`text-[14px] font-semibold ${item.state === "pending" ? "text-sg-muted" : "text-sg-text"}`}>{item.label}</p>
                          <p className="mt-0.5 break-words text-[13px] text-sg-muted">{item.detail}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-[10px] border border-sg-border p-4">
                <DrawerSectionTitle icon="receipt">Order Total</DrawerSectionTitle>
                <p className="mt-3 text-2xl font-bold">{formatUsdCents(order.total_cents)}</p>
                <div className="mt-4 space-y-2 text-[13px]">
                  <p className="flex justify-between gap-3"><span className="text-sg-muted">Subtotal</span><span className="font-semibold">{formatUsdCents(order.subtotal_cents)}</span></p>
                  <p className="flex justify-between gap-3"><span className="text-sg-muted">Shipping</span><span className="font-semibold">{formatUsdCents(order.shipping_cents)}</span></p>
                  <p className="flex justify-between gap-3"><span className="text-sg-muted">Tax</span><span className="font-semibold">{formatUsdCents(order.tax_cents)}</span></p>
                </div>
                <div className="mt-4 border-t border-sg-border pt-4">
                  {shipped ? (
                    <span className="inline-flex rounded-full bg-sg-success-soft px-3 py-1 text-[12px] font-bold text-sg-success">
                      Order Completed
                    </span>
                  ) : null}
                  {localHandoffOrder && deliveryPreviewProof ? (
                    <button
                      type="button"
                      className="sg25-btn sg25-btn-ghost mt-3 h-9 w-full px-4 text-[12px]"
                      onClick={() => setHandoffPhotoPreview({ title: "Delivery photo", proof: deliveryPreviewProof })}
                    >
                      <Icon name="package" className="h-4 w-4" />
                      Preview delivery photo
                    </button>
                  ) : null}
                  {localHandoffOrder && paymentPreviewProof ? (
                    <button
                      type="button"
                      className="sg25-btn sg25-btn-ghost mt-2 h-9 w-full px-4 text-[12px]"
                      onClick={() => setHandoffPhotoPreview({ title: "Payment photo", proof: paymentPreviewProof })}
                    >
                      <Icon name="receipt" className="h-4 w-4" />
                      Preview payment photo
                    </button>
                  ) : null}
                  {canConfirmShipped ? (
                    <button
                      type="button"
                      className="sg25-btn sg25-btn-primary mt-4 h-9 w-full px-4 text-[12px]"
                      disabled={actionBusy === "ship"}
                      onClick={() => onRequestConfirmShipped({ orderId, mode: "carrier" })}
                    >
                      <Icon name="truck" className="h-4 w-4" />
                      Product shipped
                    </button>
                  ) : null}
                  {canConfirmExternalShipped ? (
                    <button
                      type="button"
                      className="sg25-btn sg25-btn-primary mt-4 h-9 w-full px-4 text-[12px]"
                      disabled={actionBusy === "ship"}
                      onClick={() => onRequestConfirmShipped({ orderId, mode: "external" })}
                    >
                      <Icon name="truck" className="h-4 w-4" />
                      Confirm B2B shipment
                    </button>
                  ) : null}
                  {canResendNotify ? (
                    <div className="mt-4 space-y-2">
                      <button
                        type="button"
                        className="sg25-btn sg25-btn-ghost h-9 w-full px-4 text-[12px]"
                        disabled={actionBusy === "notify"}
                        onClick={() => onRequestNotifyBuyer(orderId)}
                      >
                        <Icon name="truck" className="h-4 w-4" />
                        {actionBusy === "notify" ? "Sending notice" : "Resend notification"}
                      </button>
                      <p className="text-center text-[12px] font-medium text-sg-muted">Notification sent already.</p>
                    </div>
                  ) : null}
                  {canCancelAndRefund ? (
                    <div className="mt-4 border-t border-sg-border pt-4">
                      <button
                        type="button"
                        className="sg25-btn h-9 w-full border border-sg-danger bg-white px-4 text-[12px] font-semibold text-sg-danger hover:bg-sg-danger-soft"
                        disabled={actionBusy === "cancel"}
                        onClick={() => onRequestCancel({ orderId, orderRef: String(order.order_ref || order.id), totalCents: Math.max(0, Number(order.total_cents) || 0), purchasedLabels: purchasedLabels.length })}
                      >
                        <Icon name="x" className="h-4 w-4" />
                        Cancel and refund
                      </button>
                    </div>
                  ) : null}
                  {showCancellationStatus ? (
                    <div className="mt-4 space-y-3 border-t border-sg-border pt-4">
                      <div className="rounded-[8px] bg-sg-input-bg p-3 text-[12px] leading-5">
                        <p className="flex justify-between gap-3"><span className="text-sg-muted">Customer refund</span><strong>{customerRefundComplete ? "Completed" : "Pending in Square"}</strong></p>
                        <p className="mt-1 flex justify-between gap-3"><span className="text-sg-muted">Shipping-label credit</span><strong>{labelRefundComplete ? "Completed" : labelRefundAttention ? "Needs review" : labelRefundNotApplicable ? "Not applicable" : "Pending in Shippo"}</strong></p>
                        <p className="mt-1 flex justify-between gap-3"><span className="text-sg-muted">Inventory</span><strong>Restored</strong></p>
                      </div>
                      <button
                        type="button"
                        className="sg25-btn sg25-btn-ghost h-9 w-full px-4 text-[12px]"
                        disabled={actionBusy === "refundStatus"}
                        onClick={() => void onCheckCancellationStatus(orderId)}
                      >
                        <Icon name="refresh" className={`h-4 w-4 ${actionBusy === "refundStatus" ? "animate-spin" : ""}`} />
                        {actionBusy === "refundStatus" ? "Checking providers" : "Check refund status"}
                      </button>
                      <p className="text-center text-[11px] leading-4 text-sg-muted">This only checks Square and Shippo. It cannot submit another refund.</p>
                      <button
                        type="button"
                        className="sg25-btn sg25-btn-ghost h-9 w-full px-4 text-[12px]"
                        disabled={actionBusy === "refundEmail" || !fieldText(order, ["customer_email"])}
                        onClick={() => void onSendRefundEmail(orderId)}
                      >
                        <Icon name="receipt" className="h-4 w-4" />
                        {actionBusy === "refundEmail" ? "Sending refund email" : "Send refund email"}
                      </button>
                      <p className="text-center text-[11px] leading-4 text-sg-muted">
                        {fieldText(order, ["customer_email"])
                          ? "Sends the current refund status to the customer. No refund or cancellation is submitted."
                          : "No customer email is saved for this order."}
                      </p>
                    </div>
                  ) : null}
                </div>
              </section>

              {localHandoffOrder && !shipped ? (
                <section className="rounded-[10px] border border-sg-border p-4">
                  <DrawerSectionTitle icon="truck">Handoff</DrawerSectionTitle>
                  <p className="mt-3 text-[13px] leading-5 text-sg-muted">
                    {arrivalLinkOrder
                      ? "Send the payment link when admin arrives, then upload the delivery photo after the customer has the link."
                      : requiresPaymentProof
                      ? "Upload the delivery photo and cash/check payment photo after the carton has been delivered."
                      : `Upload a ${localFulfillmentLabel(order).toLowerCase()} photo, then complete the handoff after the carton has been handed over.`}
                  </p>
                  <input
                    ref={handoffInputRef}
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(event) => {
                      handleHandoffProofChange(event.target.files?.[0]);
                      event.currentTarget.value = "";
                    }}
                  />
                  {requiresPaymentProof ? (
                    <input
                      ref={handoffPaymentInputRef}
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(event) => {
                        handlePaymentProofChange(event.target.files?.[0]);
                        event.currentTarget.value = "";
                      }}
                    />
                  ) : null}
                  <div className="mt-3 space-y-2">
                    {arrivalLinkOrder ? (
                      <button
                        type="button"
                        className="sg25-btn sg25-btn-ghost h-9 w-full justify-center px-4 text-[12px]"
                        disabled={!canSendArrivalLink || actionBusy === "arrivalLink"}
                        onClick={() => void onSendArrivalPaymentLink(orderId)}
                      >
                        <Icon name="arrow-up-right" className="h-4 w-4" />
                        {actionBusy === "arrivalLink" ? "Sending link" : paymentLinkUrl ? "Resend payment link" : "Send payment link"}
                      </button>
                    ) : null}
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                      <button
                        type="button"
                        className={`sg25-btn h-9 w-full justify-center px-4 text-[12px] ${handoffProof ? "sg25-btn-primary" : "sg25-btn-ghost"}`}
                        disabled={!arrivalDeliveryReady}
                        onClick={() => {
                          if (!arrivalDeliveryReady) return;
                          handoffInputRef.current?.click();
                        }}
                      >
                        <Icon name="package" className="h-4 w-4" />
                        {handoffProof ? "Replace delivery photo" : "Upload delivery photo"}
                      </button>
                      {handoffProof ? (
                        <button
                          type="button"
                          className="sg25-btn sg25-btn-ghost h-9 w-9 px-0"
                          aria-label="Remove delivery photo"
                          onClick={() => {
                            setHandoffProof(null);
                            setHandoffProofError("");
                          }}
                        >
                          <Icon name="x" className="h-4 w-4" />
                        </button>
                      ) : null}
                    </div>
                    {requiresPaymentProof ? (
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                        <button
                          type="button"
                          className={`sg25-btn h-9 w-full justify-center px-4 text-[12px] ${handoffPaymentProof ? "sg25-btn-primary" : "sg25-btn-ghost"}`}
                          onClick={() => handoffPaymentInputRef.current?.click()}
                        >
                          <Icon name="receipt" className="h-4 w-4" />
                          {handoffPaymentProof ? "Replace payment photo" : "Upload payment photo"}
                        </button>
                        {handoffPaymentProof ? (
                          <button
                            type="button"
                            className="sg25-btn sg25-btn-ghost h-9 w-9 px-0"
                            aria-label="Remove payment photo"
                            onClick={() => {
                              setHandoffPaymentProof(null);
                              setHandoffProofError("");
                            }}
                          >
                            <Icon name="x" className="h-4 w-4" />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  {arrivalLinkOrder && !arrivalDeliveryReady ? <p className="mt-2 text-center text-[12px] font-medium text-sg-muted">Send the payment link before uploading the delivery photo.</p> : null}
                  {handoffProof ? (
                    <div className="mt-3 overflow-hidden rounded-[8px] border border-sg-border bg-sg-input-bg">
                      <img src={handoffProof.dataUrl} alt="" className="h-36 w-full object-cover" />
                      <div className="px-3 py-2 text-[12px]">
                        <p className="break-words font-semibold">{handoffProof.name}</p>
                        <p className="mt-0.5 text-sg-muted">{handoffProof.sizeLabel}</p>
                      </div>
                    </div>
                  ) : null}
                  {handoffPaymentProof ? (
                    <div className="mt-3 overflow-hidden rounded-[8px] border border-sg-border bg-sg-input-bg">
                      <img src={handoffPaymentProof.dataUrl} alt="" className="h-36 w-full object-cover" />
                      <div className="px-3 py-2 text-[12px]">
                        <p className="break-words font-semibold">{handoffPaymentProof.name}</p>
                        <p className="mt-0.5 text-sg-muted">{handoffPaymentProof.sizeLabel}</p>
                      </div>
                    </div>
                  ) : null}
                  {handoffProofError ? <p className="mt-2 text-[12px] font-semibold text-sg-danger">{handoffProofError}</p> : null}
                  {actionStatus ? (
                    <p
                      className={`mt-3 rounded-[8px] px-3 py-2 text-[13px] font-semibold ${
                        actionStatus.tone === "success" ? "bg-sg-success-soft text-sg-success" : "bg-sg-danger-soft text-sg-danger"
                      }`}
                    >
                      {actionStatus.message}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="sg25-btn sg25-btn-primary mt-4 h-9 w-full px-4 text-[12px]"
                    disabled={!canCompleteHandoff || !handoffReady || actionBusy === "ship"}
                    onClick={() => {
                      saveStoredHandoffProofs(orderId, handoffProof, handoffPaymentProof);
                      setSavedHandoffProof(handoffProof);
                      setSavedHandoffPaymentProof(handoffPaymentProof);
                      onRequestConfirmShipped({ orderId, mode: "handoff", proofName: handoffProof?.name, paymentProofName: handoffPaymentProof?.name });
                    }}
                  >
                    <Icon name="truck" className="h-4 w-4" />
                    {requiresPaymentProof ? "Complete delivery and payment" : "Hand off complete"}
                  </button>
                  {!handoffProof ? <p className="mt-2 text-center text-[12px] font-medium text-sg-muted">Upload a delivery photo to complete.</p> : null}
                  {requiresPaymentProof && handoffProof && !handoffPaymentProof ? <p className="mt-2 text-center text-[12px] font-medium text-sg-muted">Upload a payment photo to complete.</p> : null}
                </section>
              ) : null}
            </div>
          </div>
        </div>
      </aside>
      {handoffPhotoPreview ? (
        <HandoffPhotoPreviewModal title={handoffPhotoPreview.title} proof={handoffPhotoPreview.proof} onClose={() => setHandoffPhotoPreview(null)} />
      ) : null}
    </div>
  );

  return createPortal(drawer, document.body);
}

function MarketplaceOrdersSection({
  orders,
  variants,
  error,
  onRecord,
  onTransition,
  onRetry,
}: {
  orders: MarketplaceOrder[];
  variants: InventoryVariantRow[];
  error?: string | null;
  onRecord: (body: MarketplaceRecordInput) => Promise<void>;
  onTransition: (id: string, status: "packed" | "shipped" | "cancelled") => Promise<void>;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [marketplace, setMarketplace] = useState("amazon");
  const [externalOrderId, setExternalOrderId] = useState("");
  const [lines, setLines] = useState<MarketplaceDraftLine[]>(() => [newMarketplaceDraftLine()]);
  const [notes, setNotes] = useState("");
  const [shippingCharged, setShippingCharged] = useState("0.00");
  const [discount, setDiscount] = useState("0.00");
  const [taxCollected, setTaxCollected] = useState("0.00");
  const [marketplaceFee, setMarketplaceFee] = useState("");
  const [processingFee, setProcessingFee] = useState("0.00");
  const [shippingCost, setShippingCost] = useState("");
  const [otherCost, setOtherCost] = useState("0.00");
  const [refund, setRefund] = useState("0.00");
  const [netPayout, setNetPayout] = useState("");
  const choices = useMemo(() => variants.filter((row) => row.active !== false && row.track !== false), [variants]);
  const productOptions = useMemo(() => {
    const available = new Set(choices.map((row) => String(row.productSlug || "")));
    return [
      { value: "", label: "Select product" },
      ...marketplaceProductMeta.filter((product) => available.has(product.slug)).map((product) => ({ value: product.slug, label: product.label })),
    ];
  }, [choices]);

  const financialPreview = useMemo(() => {
    const merchandise = lines.reduce((sum, line) => sum + Math.max(0, Math.floor(Number(line.quantity) || 0)) * dollarsToCents(line.unitSalePrice), 0);
    const revenue = Math.max(0, merchandise - dollarsToCents(discount) - dollarsToCents(refund) + dollarsToCents(shippingCharged));
    const variableCosts = dollarsToCents(marketplaceFee) + dollarsToCents(processingFee) + dollarsToCents(shippingCost) + dollarsToCents(otherCost);
    return { merchandise, revenue, variableCosts };
  }, [discount, lines, marketplaceFee, otherCost, processingFee, refund, shippingCharged, shippingCost]);

  function updateLine(id: string, patch: Partial<MarketplaceDraftLine>) {
    setLines((current) => current.map((line) => line.id === id ? { ...line, ...patch } : line));
  }

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  async function submit() {
    if (!externalOrderId.trim()) {
      setFormError("Marketplace order ID is required.");
      return;
    }
    if (lines.some((line) => !line.productSlug || !line.size || Math.floor(Number(line.quantity) || 0) < 1 || !line.unitSalePrice.trim())) {
      setFormError("Complete the product, size, quantity, and selling price for every item.");
      return;
    }
    if (!marketplaceFee.trim() || !shippingCost.trim()) {
      setFormError("Marketplace fees and shipping cost are required. Enter 0.00 when there was no charge.");
      return;
    }
    const normalizedLines = lines.map((line) => ({ productSlug: line.productSlug, size: line.size, quantityCases: line.unit === "cases" ? Math.max(0, Math.floor(Number(line.quantity) || 0)) : 0, quantityBoxes: line.unit === "boxes" ? Math.max(0, Math.floor(Number(line.quantity) || 0)) : 0, unitSalePriceCents: dollarsToCents(line.unitSalePrice) }));
    const requestedByVariant = new Map<string, { productSlug: string; size: string; requestedCases: number; requestedBoxes: number }>();
    for (const line of lines) {
      const requested = Math.max(0, Math.floor(Number(line.quantity) || 0));
      const key = `${line.productSlug}\t${line.size}`;
      const current = requestedByVariant.get(key) || { productSlug: line.productSlug, size: line.size, requestedCases: 0, requestedBoxes: 0 };
      if (line.unit === "cases") current.requestedCases += requested;
      else current.requestedBoxes += requested;
      requestedByVariant.set(key, current);
    }
    for (const request of requestedByVariant.values()) {
      if (!request.productSlug || !request.size) continue;
      const stock = marketplaceStockForVariant(choices, request.productSlug, request.size);
      if (request.requestedCases > stock.intactCases) {
        setFormError(`Not enough intact cartons for ${request.productSlug} / ${request.size}: ${stock.intactCases} available, ${request.requestedCases} requested.`);
        return;
      }
      const boxesAfterCartons = (stock.intactCases - request.requestedCases) * stock.boxesPerCase + stock.looseBoxes;
      if (request.requestedBoxes > boxesAfterCartons) {
        setFormError(`Not enough stock for ${request.productSlug} / ${request.size}: ${boxesAfterCartons} boxes available after carton items, ${request.requestedBoxes} requested.`);
        return;
      }
    }
    setBusy(true); setFormError(null);
    try {
      await onRecord({
        marketplace,
        externalOrderId,
        lines: normalizedLines,
        shippingChargedCents: dollarsToCents(shippingCharged),
        discountCents: dollarsToCents(discount),
        taxCollectedCents: dollarsToCents(taxCollected),
        marketplaceFeeCents: dollarsToCents(marketplaceFee),
        paymentProcessingFeeCents: dollarsToCents(processingFee),
        shippingCostCents: dollarsToCents(shippingCost),
        otherCostCents: dollarsToCents(otherCost),
        refundCents: dollarsToCents(refund),
        netPayoutCents: netPayout.trim() ? dollarsToCents(netPayout) : null,
        notes,
      });
      setOpen(false);
      setExternalOrderId("");
      setLines([newMarketplaceDraftLine()]);
      setNotes("");
      setShippingCharged("0.00"); setDiscount("0.00"); setTaxCollected("0.00"); setMarketplaceFee("");
      setProcessingFee("0.00"); setShippingCost(""); setOtherCost("0.00"); setRefund("0.00"); setNetPayout("");
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not record marketplace order.");
    } finally { setBusy(false); }
  }

  async function transition(id: string, status: "packed" | "shipped" | "cancelled") {
    setBusy(true);
    setActionError(null);
    try {
      await onTransition(id, status);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not update marketplace order.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="sg25-card overflow-hidden p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2"><Icon name="clipboard" className="h-4 w-4 text-sg-primary" /><h2 className="text-sm font-bold">Marketplace Orders</h2></div>
      <button type="button" className="sg25-btn sg25-btn-primary h-9 px-4 text-[12px]" onClick={() => { setFormError(null); setOpen(true); }}><Icon name="clipboard" className="h-4 w-4" />Record marketplace order</button>
    </div>
    {error ? <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[8px] bg-sg-input-bg p-3 text-sm text-sg-muted"><p>Marketplace records are not available yet. Refresh after the marketplace setup is connected.</p><button type="button" className="sg25-btn sg25-btn-ghost h-8 px-3 text-[11px]" onClick={onRetry}>Retry</button></div> : null}
    {actionError ? <p className="mt-3 rounded-[8px] bg-sg-danger-soft p-3 text-sm text-sg-danger">{actionError}</p> : null}
    {!error && !orders.length ? <p className="mt-4 text-sm text-sg-muted">No marketplace orders recorded yet.</p> : null}
    {orders.length ? <div className="mt-4 space-y-2">{orders.map((order) => {
      const status = String(order.status || "new").toLowerCase();
      const quantity = (order.lines || []).map((line) => `${line.quantity_cases || 0} cartons · ${line.quantity_boxes || 0} boxes`).join(" · ");
      return <div key={String(order.id)} className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-sg-border bg-sg-input-bg px-3 py-3">
        <div className="min-w-0"><p className="font-semibold capitalize">{order.marketplace} · {order.external_order_id}</p><p className="mt-1 truncate text-[12px] text-sg-muted">{(order.lines || []).map((line) => `${line.product_slug} / ${line.size}`).join(" · ")} {quantity ? `— ${quantity}` : ""}</p><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-sg-muted"><span>Revenue <strong className="text-sg-text">{formatUsdCents(Math.max(0, Number(order.merchandise_subtotal_cents || 0) - Number(order.discount_cents || 0) - Number(order.refund_cents || 0) + Number(order.shipping_charged_cents || 0)))}</strong></span><span>Fees <strong className="text-sg-text">{formatUsdCents(Number(order.marketplace_fee_cents || 0) + Number(order.payment_processing_fee_cents || 0))}</strong></span><span>Shipping <strong className="text-sg-text">{formatUsdCents(order.shipping_cost_cents)}</strong></span></div></div>
        <div className="flex flex-wrap items-center gap-2"><span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${status === "shipped" ? "bg-sg-success-soft text-sg-success" : status === "cancelled" ? "bg-sg-danger-soft text-sg-danger" : status === "packed" ? "bg-sg-primary-soft text-sg-primary" : "bg-amber-50 text-amber-700"}`}>{status === "new" ? "New" : status[0].toUpperCase() + status.slice(1)}</span>
          {status === "new" ? <button type="button" disabled={busy} className="sg25-btn sg25-btn-ghost h-8 px-3 text-[11px]" onClick={() => void transition(String(order.id), "packed")}>Mark packed</button> : null}
          {(status === "new" || status === "packed") ? <button type="button" disabled={busy} className="sg25-btn sg25-btn-primary h-8 px-3 text-[11px]" onClick={() => void transition(String(order.id), "shipped")}>Mark shipped</button> : null}
          {(status === "new" || status === "packed") ? <button type="button" disabled={busy} className="sg25-btn sg25-btn-ghost h-8 px-3 text-[11px]" onClick={() => void transition(String(order.id), "cancelled")}>Cancel</button> : null}
        </div>
      </div>;
    })}</div> : null}
    {open ? createPortal(<div className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Record marketplace order"><section className="max-h-[calc(100dvh-2rem)] w-full max-w-5xl overflow-y-auto rounded-[14px] bg-white p-5 shadow-xl"><div className="flex items-start justify-between gap-4"><div><h2 className="text-xl font-bold">Record marketplace order</h2><p className="mt-1 text-sm text-sg-muted">Record the order and seller-portal financials together. Stock is reduced now; cancelling restores it.</p></div><button type="button" className="sg25-btn sg25-btn-ghost inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-sg-border p-0" onClick={() => setOpen(false)} aria-label="Close"><Icon name="x" className="h-4 w-4" /></button></div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2"><label className="text-sm font-medium">Marketplace <span className="text-sg-danger" aria-hidden="true">*</span><CustomSelect value={marketplace} options={[{ value: "amazon", label: "Amazon FBM" }, { value: "walmart", label: "Walmart" }]} onChange={setMarketplace} ariaLabel="Marketplace (required)" className="mt-1 w-full" triggerClassName="!h-10 !w-full !rounded-[8px] !px-[7px] !pr-[7px] text-sm font-normal" panelClassName="left-0 right-auto" /></label><label className="text-sm font-medium">Marketplace order ID <span className="text-sg-danger" aria-hidden="true">*</span><input required aria-label="Marketplace order ID" className="sg25-input mt-1 h-10 w-full px-2.5" value={externalOrderId} onChange={(event) => setExternalOrderId(event.target.value)} /></label></div>
      <div className="mt-5"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-bold">Items</h3><p className="mt-1 text-[12px] text-sg-muted">Use the actual marketplace selling price for each unit.</p></div><button type="button" className="sg25-btn sg25-btn-ghost h-8 px-3 text-[11px]" onClick={() => setLines((current) => [...current, newMarketplaceDraftLine()])}>Add item</button></div><div className="mt-3 space-y-3">{lines.map((line, index) => { const sizeOptions = [{ value: "", label: "Select size" }, ...[...new Set(choices.filter((row) => row.productSlug === line.productSlug).map((row) => String(row.size || "")))].filter(Boolean).sort(compareMarketplaceSizes).map((sizeOption) => ({ value: sizeOption, label: sizeOption }))]; const stock = marketplaceStockForVariant(choices, line.productSlug, line.size); const availableLabel = marketplaceAvailabilityLabel(stock, line.unit); return <div key={line.id} className="rounded-[10px] border border-sg-border bg-sg-input-bg p-3"><div className="mb-2 flex items-center justify-between gap-3"><p className="text-[12px] font-semibold text-sg-muted">Item {index + 1}</p>{lines.length > 1 ? <button type="button" className="text-[12px] font-semibold text-sg-danger" onClick={() => setLines((current) => current.filter((candidate) => candidate.id !== line.id))}>Remove</button> : null}</div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><label className="text-sm font-medium lg:col-span-1">Product <span className="text-sg-danger" aria-hidden="true">*</span><CustomSelect value={line.productSlug} options={productOptions} onChange={(productSlug) => updateLine(line.id, { productSlug, size: "" })} ariaLabel={`Product for item ${index + 1} (required)`} className="mt-1 w-full" triggerClassName="!h-10 !w-full !rounded-[8px] !px-[7px] !pr-[7px] text-sm font-normal" panelClassName="left-0 right-auto" /></label><label className="text-sm font-medium">Size <span className="text-sg-danger" aria-hidden="true">*</span><CustomSelect value={line.size} options={sizeOptions} onChange={(size) => updateLine(line.id, { size })} ariaLabel={`Size for item ${index + 1} (required)`} className="mt-1 w-full" triggerClassName="!h-10 !w-full !rounded-[8px] !px-[7px] !pr-[7px] text-sm font-normal" panelClassName="left-0 right-auto" /></label><label className="text-sm font-medium">Unit <span className="text-sg-danger" aria-hidden="true">*</span><CustomSelect value={line.unit} options={[{ value: "boxes", label: "Boxes" }, { value: "cases", label: "Cartons" }]} onChange={(unit) => updateLine(line.id, { unit })} ariaLabel={`Unit for item ${index + 1} (required)`} className="mt-1 w-full" triggerClassName="!h-10 !w-full !rounded-[8px] !px-[7px] !pr-[7px] text-sm font-normal" panelClassName="left-0 right-auto" /></label><label className="text-sm font-medium">Quantity <span className="text-sg-danger" aria-hidden="true">*</span><input required min="1" inputMode="numeric" aria-label={`Quantity for item ${index + 1}`} className="sg25-input mt-1 h-10 w-full px-2.5" value={line.quantity} onChange={(event) => updateLine(line.id, { quantity: event.target.value })} />{line.productSlug && line.size ? <span className="mt-1 block text-[11px] font-normal text-sg-muted">{availableLabel}</span> : null}</label><label className="text-sm font-medium">Selling price / unit <span className="text-sg-danger" aria-hidden="true">*</span><div className="relative mt-1"><span className="pointer-events-none absolute left-2.5 top-2.5 text-sm text-sg-muted">$</span><input required min="0" step="0.01" inputMode="decimal" aria-label={`Selling price for item ${index + 1}`} className="sg25-input h-10 w-full pl-6 pr-2.5" value={line.unitSalePrice} onChange={(event) => updateLine(line.id, { unitSalePrice: event.target.value })} /></div></label></div></div>; })}</div></div>
      <div className="mt-5 rounded-[10px] border border-sg-border p-3"><h3 className="text-sm font-bold">Marketplace financials</h3><p className="mt-1 text-[12px] text-sg-muted">Enter the seller-portal amounts. Tax is tracked but excluded from revenue and profit.</p><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[
        ["Shipping charged", shippingCharged, setShippingCharged, true], ["Discount", discount, setDiscount, false], ["Sales tax collected", taxCollected, setTaxCollected, false], ["Marketplace fees", marketplaceFee, setMarketplaceFee, true], ["Processing fees", processingFee, setProcessingFee, false], ["Shipping cost", shippingCost, setShippingCost, true], ["Other costs", otherCost, setOtherCost, false], ["Refunds", refund, setRefund, false], ["Net payout", netPayout, setNetPayout, false],
      ].map(([label, value, setter, required]) => <label key={String(label)} className="text-sm font-medium">{String(label)} {required ? <span className="text-sg-danger" aria-hidden="true">*</span> : null}<div className="relative mt-1"><span className="pointer-events-none absolute left-2.5 top-2.5 text-sm text-sg-muted">$</span><input min="0" step="0.01" inputMode="decimal" className="sg25-input h-10 w-full pl-6 pr-2.5" value={String(value)} onChange={(event) => (setter as (next: string) => void)(event.target.value)} /></div></label>)}</div><div className="mt-4 grid gap-2 rounded-[8px] bg-sg-input-bg p-3 text-[12px] sm:grid-cols-3"><span>Merchandise <strong className="block text-sm text-sg-text">{formatUsdCents(financialPreview.merchandise)}</strong></span><span>Dashboard revenue <strong className="block text-sm text-sg-text">{formatUsdCents(financialPreview.revenue)}</strong></span><span>Fees + shipping costs <strong className="block text-sm text-sg-text">{formatUsdCents(financialPreview.variableCosts)}</strong></span></div></div>
      <label className="mt-3 block text-sm font-medium">Notes <textarea className="sg25-input mt-1 min-h-20 w-full p-[7px]" value={notes} onChange={(event) => setNotes(event.target.value)} /></label>{formError ? <p className="mt-3 rounded-[8px] bg-sg-danger-soft p-3 text-sm text-sg-danger">{formError}</p> : null}<div className="mt-5 flex justify-end gap-2"><button type="button" className="sg25-btn sg25-btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="sg25-btn sg25-btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? "Recording" : "Record order"}</button></div>
    </section></div>, document.body) : null}
  </section>;
}

export function OrdersPage() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [createdNoticeOrderId, setCreatedNoticeOrderId] = useState<string | null>(null);
  const [drawerActionBusy, setDrawerActionBusy] = useState<OrderActionKey | null>(null);
  const [drawerActionStatus, setDrawerActionStatus] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [purchaseIntent, setPurchaseIntent] = useState<PurchaseIntent>(null);
  const [shipIntent, setShipIntent] = useState<ShipIntent>(null);
  const [notifyIntent, setNotifyIntent] = useState<NotifyIntent>(null);
  const [cancelIntent, setCancelIntent] = useState<CancelIntent>(null);
  const [orderPage, setOrderPage] = useState(0);
  const [attentionOpen, setAttentionOpen] = useState(false);

  const ordersQuery = useQuery({
    queryKey: ["admin-v2.5-orders"],
    queryFn: () => {
      if (!auth.client) throw new Error("Supabase client is not ready.");
      return fetchOrdersAndLabels(auth.client);
    },
    enabled: Boolean(auth.client && auth.session),
    refetchInterval: ACTIVE_ORDERS_REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const marketplaceOrdersQuery = useQuery({
    queryKey: ["admin-v2.5-marketplace-orders"],
    queryFn: async () => fetchMarketplaceOrders(await auth.getAccessToken()),
    enabled: Boolean(auth.client && auth.session),
    refetchInterval: ACTIVE_ORDERS_REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const marketplaceInventoryQuery = useQuery({
    queryKey: ["admin-v2.5-marketplace-order-catalog"],
    queryFn: async () => fetchInventoryDashboard(await auth.getAccessToken()),
    enabled: Boolean(auth.client && auth.session),
  });

  useAdminShellHeaderMeta(
    ordersQuery.dataUpdatedAt ? <span>Updated {formatDateTime(new Date(ordersQuery.dataUpdatedAt).toISOString())}</span> : null,
  );

  const payload = ordersQuery.data || { orders: [], labelsByOrderId: new Map<string, LabelRow[]>() };

  useEffect(() => {
    const state = location.state as { openOrderId?: string; orderCreated?: boolean } | null;
    const openOrderId = String(state?.openOrderId || "").trim();
    if (!openOrderId) return;
    if (state?.orderCreated) {
      setSelectedOrderId(null);
      setCreatedNoticeOrderId(openOrderId);
    } else {
      setSelectedOrderId(openOrderId);
      setCreatedNoticeOrderId(null);
    }
    navigate("/orders", { replace: true, state: null });
  }, [location.state, navigate]);

  useEffect(() => {
    setDrawerActionStatus(null);
    setDrawerActionBusy(null);
    setPurchaseIntent(null);
    setShipIntent(null);
    setNotifyIntent(null);
    setCancelIntent(null);
  }, [selectedOrderId]);

  function mergeActionResponse(response: unknown) {
    const record = response && typeof response === "object" && !Array.isArray(response) ? response as Record<string, unknown> : null;
    const order = record?.order && typeof record.order === "object" && !Array.isArray(record.order) ? record.order as OrderRow : null;
    const labels = Array.isArray(record?.labels)
      ? record.labels.filter((item): item is LabelRow => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      : [];
    if (!order && !labels.length) return;
    queryClient.setQueryData<OrdersPayload>(["admin-v2.5-orders"], (current) => {
      const base = current || { orders: [], labelsByOrderId: new Map<string, LabelRow[]>() };
      const orderId = String(order?.id || labels[0]?.order_id || selectedOrderId || "");
      const orders = order ? base.orders.map((row) => String(row.id) === String(order.id) ? { ...row, ...order } : row) : base.orders;
      const labelsByOrderId = new Map(base.labelsByOrderId);
      if (orderId && labels.length) {
        labelsByOrderId.set(orderId, labels);
      }
      return { orders, labelsByOrderId };
    });
  }

  async function runDrawerAction(action: OrderActionKey, task: (token?: string) => Promise<unknown>, successMessage: string) {
    setDrawerActionBusy(action);
    setDrawerActionStatus(null);
    try {
      const token = await auth.getAccessToken();
      const result = await task(token);
      mergeActionResponse(result);
      await ordersQuery.refetch();
      setDrawerActionStatus({ tone: "success", message: successMessage });
    } catch (error) {
      const message = error instanceof ApiError || error instanceof Error ? error.message : "Action failed.";
      await ordersQuery.refetch();
      setDrawerActionStatus({ tone: "error", message });
    } finally {
      setDrawerActionBusy(null);
    }
  }

  async function handleSyncShippo(orderId: string) {
    await runDrawerAction("sync", (token) => syncOrderToShippo(orderId, token), "Shippo rates are ready.");
  }

  async function handleRecordMarketplaceOrder(body: MarketplaceRecordInput) {
    const token = await auth.getAccessToken();
    await postMarketplaceOrderAction({
      action: "record",
      order: body,
    }, token);
    await Promise.all([
      marketplaceOrdersQuery.refetch(),
      marketplaceInventoryQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: ["admin-v2.5-summary"] }),
    ]);
  }

  async function handleMarketplaceTransition(id: string, status: "packed" | "shipped" | "cancelled") {
    const token = await auth.getAccessToken();
    await postMarketplaceOrderAction({ action: "transition", id, status }, token);
    await Promise.all([
      marketplaceOrdersQuery.refetch(),
      marketplaceInventoryQuery.refetch(),
    ]);
  }

  const handleLoadShipFrom = useCallback(async (orderId: string) => {
    const token = await auth.getAccessToken();
    return fetchOrderShipFromDisplay(orderId, token);
  }, [auth]);

  async function handlePreviewPackingPlan(orderId: string) {
    const token = await auth.getAccessToken();
    return previewOrderPackingPlan(orderId, token);
  }

  async function handleSavePackingPlan(orderId: string) {
    await runDrawerAction("packingSave", (token) => updateOrderPackingPlan(orderId, "save", token), "Recommended packing plan selected.");
  }

  async function handleClearPackingPlan(orderId: string) {
    await runDrawerAction("packingClear", (token) => updateOrderPackingPlan(orderId, "clear", token), "Selected packing plan cleared.");
  }

  async function handlePurchaseLabel(orderId: string, selectedRateObjectId: string) {
    const order = payload.orders.find((row) => String(row.id) === orderId);
    const labels = payload.labelsByOrderId.get(orderId) || [];
    const parcelCount = order ? parcelCountFromOrder(order, labels) : 1;
    const selectedRate = order
      ? shippoRates(order).find((rate) => rateObjectId(rate) === selectedRateObjectId) || null
      : null;
    const selectedRateDisplay = selectedRate ? rateLabel(selectedRate) : { carrier: "", service: "", cost: "" };
    const selectedRateCostCents = selectedRate ? rateCostCents(selectedRate) : null;
    const shippingBudgetCents = order && isOnlineStoreOrder(order)
      ? fieldCents(order, ["paid_shipping_amount_cents", "quoted_shipping_total_cents", "shipping_cents"]) ?? 0
      : null;
    setPurchaseIntent({
      orderId,
      rateObjectId: selectedRateObjectId,
      parcelCount,
      remainingCount: Math.max(1, parcelCount - purchasedPackageCount(labels)),
      carrier: selectedRateDisplay.carrier,
      service: selectedRateDisplay.service,
      cost: selectedRateDisplay.cost,
      costCents: selectedRateCostCents,
      customerShippingBudgetCents: shippingBudgetCents,
    });
  }

  async function confirmPurchaseLabel() {
    if (!purchaseIntent) return;
    const { orderId, rateObjectId, parcelCount } = purchaseIntent;
    await runDrawerAction(
      `purchase:${rateObjectId}`,
      (token) => (parcelCount > 1 ? purchaseOrderShippoAllLabels(orderId, rateObjectId, token) : purchaseOrderShippoLabel(orderId, rateObjectId, token)),
      parcelCount > 1 ? "Package labels purchased. Tracking is now on file." : "Label purchased. Tracking is now on file.",
    );
    setPurchaseIntent(null);
  }

  async function handleNotifyBuyer(orderId: string) {
    await runDrawerAction("notify", (token) => notifyBuyerShipping(orderId, token), "Buyer shipping notification sent.");
  }

  async function handleSaveExternalFulfillment(body: Parameters<typeof saveOrderExternalFulfillment>[0]) {
    await runDrawerAction(
      "externalFulfillment",
      (token) => saveOrderExternalFulfillment(body, token),
      "External carrier, tracking, and label saved.",
    );
  }

  async function confirmNotifyBuyer() {
    if (!notifyIntent) return;
    await handleNotifyBuyer(notifyIntent.orderId);
    setNotifyIntent(null);
  }

  async function confirmCancelOrder(reason: string) {
    if (!cancelIntent) return;
    const orderId = cancelIntent.orderId;
    setDrawerActionBusy("cancel");
    setDrawerActionStatus(null);
    try {
      const token = await auth.getAccessToken();
      const result = await cancelAndRefundOrder(orderId, reason, token);
      mergeActionResponse(result);
      await Promise.all([ordersQuery.refetch(), queryClient.invalidateQueries({ queryKey: ["admin-v2.5-summary"] })]);
      setDrawerActionStatus({
        tone: result.warning ? "error" : "success",
        message: result.warning || "Order cancelled. Customer payment refunded, inventory restored, and shipping label refunds requested.",
      });
      setCancelIntent(null);
    } catch (error) {
      await ordersQuery.refetch();
      setDrawerActionStatus({ tone: "error", message: error instanceof Error ? error.message : "Could not cancel the order." });
    } finally {
      setDrawerActionBusy(null);
    }
  }

  async function handleCheckCancellationStatus(orderId: string) {
    setDrawerActionBusy("refundStatus");
    setDrawerActionStatus(null);
    try {
      const token = await auth.getAccessToken();
      const result = await checkCancelledOrderRefundStatus(orderId, token);
      mergeActionResponse(result);
      await Promise.all([ordersQuery.refetch(), queryClient.invalidateQueries({ queryKey: ["admin-v2.5-summary"] })]);
      setDrawerActionStatus({
        tone: result.warning?.includes("manual review") ? "error" : "success",
        message: result.warning || "Square refund and Shippo label credit are complete.",
      });
    } catch (error) {
      await ordersQuery.refetch();
      setDrawerActionStatus({ tone: "error", message: error instanceof Error ? error.message : "Could not check refund status." });
    } finally {
      setDrawerActionBusy(null);
    }
  }

  async function handleSendRefundEmail(orderId: string) {
    const requestId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `email_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await runDrawerAction(
      "refundEmail",
      (token) => sendCancelledOrderRefundEmail(orderId, requestId, token),
      "Refund status email sent to the customer.",
    );
  }

  async function handleSendArrivalPaymentLink(orderId: string) {
    setDrawerActionBusy("arrivalLink");
    setDrawerActionStatus(null);
    try {
      const token = await auth.getAccessToken();
      const result = await sendManualOrderLink({ orderId, allowPayLaterLink: true }, token);
      await ordersQuery.refetch();
      setDrawerActionStatus({
        tone: "success",
        message: result.warning || "Payment link sent for arrival collection.",
      });
    } catch (error) {
      const message = error instanceof ApiError || error instanceof Error ? error.message : "Action failed.";
      setDrawerActionStatus({ tone: "error", message });
    } finally {
      setDrawerActionBusy(null);
    }
  }

  async function confirmProductShipped() {
    if (!shipIntent) return;
    const { orderId, mode } = shipIntent;
    setDrawerActionBusy("ship");
    setDrawerActionStatus(null);
    try {
      const token = await auth.getAccessToken();
      const result = mode === "handoff" ? await completeOrderHandoff(orderId, token) : await confirmOrderProductShipped(orderId, token);
      await ordersQuery.refetch();
      setDrawerActionStatus({
        tone: result.warning ? "error" : "success",
        message:
          result.warning ||
          (mode === "handoff"
            ? "Order completed. Revenue, paid status, handoff, and stock were updated."
            : "Order marked shipped and buyer notified."),
      });
      setShipIntent(null);
    } catch (error) {
      const message = error instanceof ApiError || error instanceof Error ? error.message : mode === "handoff" ? "Could not complete handoff." : "Could not confirm shipment.";
      setDrawerActionStatus({ tone: "error", message });
      setShipIntent(null);
    } finally {
      setDrawerActionBusy(null);
    }
  }

  const filteredOrders = useMemo(() => {
    const query = search.trim().toLowerCase();
    return payload.orders.filter((order) => {
      const labels = payload.labelsByOrderId.get(String(order.id)) || [];
      if (!passesTimeFilter(order, timeFilter)) return false;
      if (!passesStatusFilter(order, labels, statusFilter)) return false;
      if (!query) return true;
      const haystack = [order.order_ref, order.id, order.customer_name, order.customer_email, order.shippo_tracking_number, itemSummary(order)]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");
      return haystack.includes(query);
    });
  }, [payload.labelsByOrderId, payload.orders, search, statusFilter, timeFilter]);
  const orderPageCount = Math.max(1, Math.ceil(filteredOrders.length / 10));
  const effectiveOrderPage = Math.min(orderPage, orderPageCount - 1);
  const visibleOrders = filteredOrders.slice(effectiveOrderPage * 10, effectiveOrderPage * 10 + 10);
  const attentionOrders = useMemo(() => payload.orders.filter((order) => {
    const labels = payload.labelsByOrderId.get(String(order.id)) || [];
    return isAttentionOrder(order, labels);
  }), [payload.labelsByOrderId, payload.orders]);

  useEffect(() => {
    setOrderPage(0);
  }, [search, statusFilter, timeFilter]);

  const selectedOrder = selectedOrderId ? payload.orders.find((order) => String(order.id) === selectedOrderId) || null : null;
  const selectedLabels = selectedOrder ? payload.labelsByOrderId.get(String(selectedOrder.id)) || [] : [];

  const stats = useMemo(() => {
    let awaitingPayment = 0;
    let paidNotShipped = 0;
    let shipped = 0;
    let attention = 0;
    payload.orders.forEach((order) => {
      const labels = payload.labelsByOrderId.get(String(order.id)) || [];
      if (!isPaid(order) && !isCancelled(order)) awaitingPayment += 1;
      if (isPaid(order) && !isShipped(order) && !isCancelled(order)) paidNotShipped += 1;
      if (isShipped(order)) shipped += 1;
      if (isAttentionOrder(order, labels)) attention += 1;
    });
    return { awaitingPayment, paidNotShipped, shipped, attention };
  }, [payload.labelsByOrderId, payload.orders]);

  if (ordersQuery.isLoading) {
    return (
      <div className="-mt-3 space-y-4">
        <section className="py-4">
          <h1 className="text-3xl font-bold">Orders</h1>
          <p className="mt-2 text-sm text-sg-muted">Loading orders...</p>
        </section>
      </div>
    );
  }

  if (ordersQuery.error) {
    return (
      <section className="sg25-card p-6">
        <h1 className="text-3xl font-bold">Orders</h1>
        <p className="mt-3 rounded-[8px] bg-sg-danger-soft p-3 text-sm text-sg-danger">
          {ordersQuery.error instanceof Error ? ordersQuery.error.message : "Could not load orders."}
        </p>
      </section>
    );
  }

  return (
    <div className="-mt-3 space-y-4">
      <section>
        <div>
          <h1 className="text-4xl font-bold">Orders</h1>
          <p className="mt-1 text-[15px] text-sg-muted">Manage payment status, fulfillment, shipping, and buyer communication.</p>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard label="Total Orders" value={formatNumber(payload.orders.length)} description="All time" icon="cart" tone="neutral" />
        <KpiCard label="Awaiting Payment" value={formatNumber(stats.awaitingPayment)} description="Not yet paid" icon="clock" tone="amber" />
        <KpiCard label="Paid · Not Shipped" value={formatNumber(stats.paidNotShipped)} description="Paid orders still open" icon="package" tone="green" />
        <KpiCard label="Shipped" value={formatNumber(stats.shipped)} description="Handed off / in transit" icon="truck" tone="blue" />
        <KpiCard label="Needs Attention" value={formatNumber(stats.attention)} description="Address / label issues · view details" icon="alert" tone={stats.attention > 0 ? "red" : "neutral"} onClick={() => setAttentionOpen(true)} />
      </section>

      <section className="sg25-card overflow-hidden p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5">
            <Icon name="cart" className="h-3.5 w-3.5 shrink-0 text-sg-primary" />
            <div>
              <h2 className="text-sm font-bold">Orders</h2>
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Search orders</span>
            <input
              className="sg25-input h-[36px] rounded-full bg-sg-input-bg text-[12px] lg:min-w-[360px] xl:min-w-[480px]"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search order ID, customer, or email"
            />
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:flex lg:flex-nowrap">
            <SelectField value={timeFilter} options={timeOptions} onChange={setTimeFilter} ariaLabel="Order date filter" />
            <SelectField value={statusFilter} options={statusOptions} onChange={setStatusFilter} ariaLabel="Order status filter" />
            <button type="button" className="sg25-btn sg25-btn-ghost h-[36px] px-3 text-[12px]" disabled={ordersQuery.isFetching} onClick={() => void ordersQuery.refetch()}>
              <Icon name="refresh" className={`h-4 w-4 ${ordersQuery.isFetching ? "animate-spin" : ""}`} />
              {ordersQuery.isFetching ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="mt-4 w-full min-w-[1020px] table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-[128px]" />
              <col className="w-[205px]" />
              <col className="w-[118px]" />
              <col className="w-[132px]" />
              <col className="w-[132px]" />
              <col className="w-[146px]" />
              <col className="w-[82px]" />
              <col className="w-[146px]" />
              <col className="w-[104px]" />
            </colgroup>
            <thead className="text-[10px] font-bold uppercase tracking-normal text-sg-muted">
              <tr>
                <th className="border-b border-sg-border py-3 pl-2.5 pr-5">Order</th>
                <th className="border-b border-sg-border px-0 py-3 pr-5">Customer</th>
                <th className="border-b border-sg-border px-0 py-3 pr-5">Type</th>
                <th className="border-b border-sg-border px-0 py-3 pr-5">Payment</th>
                <th className="border-b border-sg-border px-0 py-3 pr-5">Shipping</th>
                <th className="border-b border-sg-border px-0 py-3 pr-5">Fulfillment</th>
                <th className="border-b border-sg-border px-0 py-3 pr-5 text-right">Total</th>
                <th className="border-b border-sg-border px-0 py-3 pr-5">Suggested Next</th>
                <th className="border-b border-sg-border px-0 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleOrders.map((order) => {
                const labels = payload.labelsByOrderId.get(String(order.id)) || [];
                const payment = paymentState(order);
                const fulfillment = fulfillmentState(order, labels);
                const typeLabel = orderTypeLabel(order);
                const typeDetail = paymentFlowLabel(order);
                return (
                  <tr
                    key={String(order.id)}
                    className="sg25-order-row cursor-pointer border-b border-sg-border"
                    onClick={() => setSelectedOrderId(String(order.id))}
                  >
                    <td className="max-w-[128px] py-4 pl-2.5 pr-5 align-middle">
                      <p className="break-words text-[13px] font-bold leading-tight">{shortenRef(order.order_ref || order.id)}</p>
                      <p className="mt-0.5 text-[11px] text-sg-muted">{formatOrderDate(order.created_at)}</p>
                    </td>
                    <td className="px-0 py-4 pr-5 align-middle">
                      <p className="text-[13px] font-medium">{order.customer_name || "-"}</p>
                      <p className="mt-1 max-w-[205px] truncate text-[11px] text-sg-muted">{order.customer_email || "-"}</p>
                    </td>
                    <td className="px-0 py-4 pr-5 align-middle">
                      <span className={`inline-flex ${statusChipRadiusClass(typeLabel)} border border-sg-border bg-sg-input-bg px-2.5 py-1 text-[11px] font-semibold text-sg-text`}>{typeLabel}</span>
                      {typeDetail ? (
                        <span className="mt-1.5 inline-flex max-w-[128px] whitespace-nowrap rounded-[8px] border border-sg-border bg-sg-input-bg px-1.5 py-1 text-[8.5px] font-semibold leading-tight text-sg-muted">
                          {typeDetail}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-0 py-4 pr-5 align-middle">
                      <span className={`inline-flex ${statusChipRadiusClass(payment.label)} px-2.5 py-1 text-[11px] font-semibold ${statusChipClass(payment.tone)}`}>{payment.label}</span>
                    </td>
                    <td className="max-w-[132px] px-0 py-4 pr-5 align-middle text-[13px] text-sg-muted">
                      <span className="block max-w-[112px] break-words leading-tight">{shippingSummary(order, labels)}</span>
                    </td>
                    <td className="px-0 py-4 pr-5 align-middle">
                      <span className={`inline-flex ${statusChipRadiusClass(fulfillment.label)} px-2.5 py-1 text-[11px] font-semibold ${statusChipClass(fulfillment.tone)}`}>{fulfillment.label}</span>
                    </td>
                    <td className="px-0 py-4 pr-5 text-right align-middle text-[13px] font-semibold">{formatUsdCents(order.total_cents)}</td>
                    <td className="px-0 py-4 pr-5 align-middle text-[13px] font-medium text-sg-muted">{nextAction(order, labels)}</td>
                    <td className="py-4 pl-2.5 pr-4 text-right align-middle">
                      <button
                        type="button"
                        className="sg25-btn sg25-btn-ghost h-[32px] px-4 text-[11px]"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedOrderId(String(order.id));
                        }}
                      >
                        <ViewIcon />
                        View
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!filteredOrders.length ? (
          <div className="px-4 py-10 text-center text-sm text-sg-muted">No orders match the current filters.</div>
        ) : null}
        {filteredOrders.length ? (
          <div className="flex items-center justify-end gap-3 px-4 pt-4">
            <p className="text-[11px] text-sg-muted">Page {effectiveOrderPage + 1} of {orderPageCount} · {formatNumber(filteredOrders.length)} orders</p>
            <div className="flex gap-2">
              <button type="button" className="sg25-btn sg25-btn-ghost h-8 w-8 p-0" aria-label="Previous orders page" disabled={effectiveOrderPage === 0} onClick={() => setOrderPage((page) => Math.max(0, page - 1))}><span aria-hidden="true">←</span></button>
              <button type="button" className="sg25-btn sg25-btn-ghost h-8 w-8 p-0" aria-label="Next orders page" disabled={effectiveOrderPage + 1 >= orderPageCount} onClick={() => setOrderPage((page) => Math.min(orderPageCount - 1, page + 1))}><span aria-hidden="true">→</span></button>
            </div>
          </div>
        ) : null}
      </section>

      {attentionOpen ? createPortal(
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-labelledby="attention-orders-title" onClick={() => setAttentionOpen(false)}>
          <section className="max-h-[80dvh] w-full max-w-2xl overflow-y-auto rounded-[14px] bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div><h2 id="attention-orders-title" className="text-xl font-bold">Orders needing attention</h2><p className="mt-1 text-sm text-sg-muted">Address, tracking, or label issues that need an admin review.</p></div>
              <button type="button" className="sg25-btn sg25-btn-ghost h-8 w-8 p-0" aria-label="Close attention details" onClick={() => setAttentionOpen(false)}><Icon name="x" className="h-4 w-4" /></button>
            </div>
            <div className="mt-5 space-y-2">
              {attentionOrders.map((order) => {
                const labels = payload.labelsByOrderId.get(String(order.id)) || [];
                return <button key={String(order.id)} type="button" className="flex w-full items-center justify-between gap-4 rounded-[10px] border border-sg-border p-3 text-left hover:bg-sg-input-bg" onClick={() => { setAttentionOpen(false); setSelectedOrderId(String(order.id)); }}><span><span className="block text-[13px] font-bold">{order.order_ref || order.id}</span><span className="mt-1 block text-[12px] text-sg-muted">{order.customer_name || order.customer_email || "Customer unavailable"}</span></span><span className="max-w-[220px] text-right text-[11px] font-semibold text-sg-danger">{attentionReason(order, labels)}</span></button>;
              })}
              {!attentionOrders.length ? <p className="rounded-[10px] bg-sg-success-soft p-4 text-sm text-sg-success">No orders currently need attention.</p> : null}
            </div>
          </section>
        </div>, document.body) : null}

      <MarketplaceOrdersSection
        orders={marketplaceOrdersQuery.data?.orders || []}
        variants={marketplaceInventoryQuery.data?.variants || []}
        error={marketplaceOrdersQuery.error instanceof Error ? marketplaceOrdersQuery.error.message : null}
        onRecord={handleRecordMarketplaceOrder}
        onTransition={handleMarketplaceTransition}
        onRetry={() => void marketplaceOrdersQuery.refetch()}
      />

      {selectedOrder ? (
        <OrderDrawer
          order={selectedOrder}
          labels={selectedLabels}
          onClose={() => {
            setSelectedOrderId(null);
          }}
          onSyncShippo={handleSyncShippo}
          onLoadShipFrom={handleLoadShipFrom}
          onPreviewPackingPlan={handlePreviewPackingPlan}
          onSavePackingPlan={handleSavePackingPlan}
          onClearPackingPlan={handleClearPackingPlan}
          onPurchaseLabel={handlePurchaseLabel}
          onRequestNotifyBuyer={(orderId) => setNotifyIntent({ orderId })}
          onSendArrivalPaymentLink={handleSendArrivalPaymentLink}
          onSaveExternalFulfillment={handleSaveExternalFulfillment}
          onRequestConfirmShipped={(intent) => setShipIntent(intent)}
          onRequestCancel={(intent) => setCancelIntent(intent)}
          onCheckCancellationStatus={handleCheckCancellationStatus}
          onSendRefundEmail={handleSendRefundEmail}
          actionBusy={drawerActionBusy}
          actionStatus={drawerActionStatus}
        />
      ) : null}
      {createdNoticeOrderId ? <OrderCreatedModal onClose={() => setCreatedNoticeOrderId(null)} /> : null}
      {purchaseIntent ? (
        <PurchaseLabelModal
          busy={drawerActionBusy === `purchase:${purchaseIntent.rateObjectId}`}
          parcelCount={purchaseIntent.parcelCount}
          remainingCount={purchaseIntent.remainingCount}
          carrier={purchaseIntent.carrier}
          service={purchaseIntent.service}
          cost={purchaseIntent.cost}
          costCents={purchaseIntent.costCents}
          customerShippingBudgetCents={purchaseIntent.customerShippingBudgetCents}
          onCancel={() => setPurchaseIntent(null)}
          onConfirm={() => void confirmPurchaseLabel()}
        />
      ) : null}
      {shipIntent ? (
        <ProductShippedModal
          busy={drawerActionBusy === "ship"}
          onCancel={() => setShipIntent(null)}
          onConfirm={() => void confirmProductShipped()}
          mode={shipIntent.mode}
          proofName={shipIntent.proofName}
          paymentProofName={shipIntent.paymentProofName}
        />
      ) : null}
      {notifyIntent ? (
        <ResendNotificationModal
          busy={drawerActionBusy === "notify"}
          onCancel={() => setNotifyIntent(null)}
          onConfirm={() => void confirmNotifyBuyer()}
        />
      ) : null}
      {cancelIntent ? (
        <CancelOrderModal
          intent={cancelIntent}
          busy={drawerActionBusy === "cancel"}
          onCancel={() => setCancelIntent(null)}
          onConfirm={(reason) => void confirmCancelOrder(reason)}
        />
      ) : null}
    </div>
  );
}
