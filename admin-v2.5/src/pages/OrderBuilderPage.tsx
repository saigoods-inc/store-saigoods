import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "../auth/AuthProvider";
import { useAdminShellHeaderMeta } from "../components/layout/AdminShell";
import { CustomSelect } from "../components/ui/CustomSelect";
import {
  ApiError,
  createManualOrder,
  estimateManualOrder,
  fetchDiscountCodes,
  fetchInventoryDashboard,
  fetchManualOrderDraft,
  sendManualOrderLink,
  updateManualOrderDraft,
  verifyManualOrderAddress,
  type ManualOrderAddress,
  type ManualOrderCreateRequest,
  type ManualOrderItem,
  type ManualOrderInvoiceAttachment,
  type ManualOrderTaxExemptionCertificate,
  type ManualOrderTaxExemptionRequest,
  type ManualOrderQuoteResponse,
  type ManualOrderShippingRateOption,
} from "../lib/api";
import { formatDateTime, formatUsdCents } from "../lib/format";
import { Icon } from "../lib/icons";

type BuilderMode = "remote" | "walk-in";
type FulfillmentMethod = "carrier" | "local_delivery" | "pickup" | "b2b_shipping";
type BackendFulfillmentMethod = "carrier" | "local_delivery" | "pickup" | "b2b_shipping";
type PaymentMethod = "square_payment_link" | "pay_later" | "arrival_payment_link";
type DiscountMode = "none" | "code" | "percent_5" | "percent_10" | "percent_15" | "custom_percent" | "custom_amount";
type DiscountCategory = "none" | "code" | "percent" | "amount";
type ProductSlug = "nitrile-standard" | "black-nitrile-general" | "black-nitrile-heavy-duty";
type SizeCode = "S" | "M" | "L" | "XL";
type TaxExemptionType = ManualOrderTaxExemptionRequest["exemptionType"];

type TaxExemptionState = {
  requested: boolean;
  exemptionType: TaxExemptionType;
  jurisdiction: string;
  certificateNumber: string;
  effectiveDate: string;
  expirationDate: string;
  internalNote: string;
  documentReviewed: boolean;
};

type BundleOption = {
  id: string;
  label: string;
  kind: "box" | "case";
  units: number;
  priceCents: number;
};

function sortBundlesHierarchically(bundles: BundleOption[]) {
  return [...bundles].sort((a, b) => {
    const kindDifference = (a.kind === "box" ? 0 : 1) - (b.kind === "box" ? 0 : 1);
    if (kindDifference) return kindDifference;
    return a.units - b.units || a.label.localeCompare(b.label);
  });
}

type ProductOption = {
  slug: ProductSlug;
  name: string;
  description: string;
  colorClassName: string;
  sizes: SizeCode[];
  bundles: BundleOption[];
  defaultSize: SizeCode;
  volumePricing?: {
    active: boolean;
    minCases: number;
    pricePerCaseCents: number;
    allowDiscountStacking: boolean;
  };
};

type OrderItemRow = {
  id: string;
  productSlug: ProductSlug;
  size: SizeCode;
  unit: "case" | "box";
  bundleId: string;
  quantity: number;
  pricingMode: "catalog" | "negotiated";
  negotiatedUnitPrice: string;
  negotiationReason: string;
};

type AddressVerificationState = {
  status: "idle" | "verified" | "suggested" | "invalid";
  fingerprint: string;
  suggestion: ManualOrderAddress | null;
  message: string;
};

type InventoryAvailability = Record<ProductSlug, Record<SizeCode, { caseAvailable: number | null; boxAvailable: number | null; boxesPerCase: number; tracked: boolean }>>;
const DEFAULT_DISCOUNT_PERCENT = 7;
const CARRIER_RATE_AUTO_REFRESH_MS = 15 * 60 * 1000;
const MAX_B2B_INVOICE_BYTES = 4 * 1024 * 1024;
const MAX_TAX_EXEMPTION_CERTIFICATE_BYTES = 2 * 1024 * 1024;
const initialTaxExemption: TaxExemptionState = {
  requested: false,
  exemptionType: "organization_own_use",
  jurisdiction: "TN",
  certificateNumber: "",
  effectiveDate: "",
  expirationDate: "",
  internalNote: "",
  documentReviewed: false,
};
const taxExemptionTypeOptions: Array<{ value: TaxExemptionType; label: string }> = [
  { value: "organization_own_use", label: "Exempt organization · own use" },
  { value: "government", label: "Government organization" },
  { value: "resale", label: "Resale certificate · manual review" },
  { value: "other", label: "Other · manual review required" },
];
const usStateOptions = [
  { value: "AL", label: "AL" },
  { value: "AK", label: "AK" },
  { value: "AZ", label: "AZ" },
  { value: "AR", label: "AR" },
  { value: "CA", label: "CA" },
  { value: "CO", label: "CO" },
  { value: "CT", label: "CT" },
  { value: "DE", label: "DE" },
  { value: "FL", label: "FL" },
  { value: "GA", label: "GA" },
  { value: "HI", label: "HI" },
  { value: "ID", label: "ID" },
  { value: "IL", label: "IL" },
  { value: "IN", label: "IN" },
  { value: "IA", label: "IA" },
  { value: "KS", label: "KS" },
  { value: "KY", label: "KY" },
  { value: "LA", label: "LA" },
  { value: "ME", label: "ME" },
  { value: "MD", label: "MD" },
  { value: "MA", label: "MA" },
  { value: "MI", label: "MI" },
  { value: "MN", label: "MN" },
  { value: "MS", label: "MS" },
  { value: "MO", label: "MO" },
  { value: "MT", label: "MT" },
  { value: "NE", label: "NE" },
  { value: "NV", label: "NV" },
  { value: "NH", label: "NH" },
  { value: "NJ", label: "NJ" },
  { value: "NM", label: "NM" },
  { value: "NY", label: "NY" },
  { value: "NC", label: "NC" },
  { value: "ND", label: "ND" },
  { value: "OH", label: "OH" },
  { value: "OK", label: "OK" },
  { value: "OR", label: "OR" },
  { value: "PA", label: "PA" },
  { value: "RI", label: "RI" },
  { value: "SC", label: "SC" },
  { value: "SD", label: "SD" },
  { value: "TN", label: "TN" },
  { value: "TX", label: "TX" },
  { value: "UT", label: "UT" },
  { value: "VT", label: "VT" },
  { value: "VA", label: "VA" },
  { value: "WA", label: "WA" },
  { value: "WV", label: "WV" },
  { value: "WI", label: "WI" },
  { value: "WY", label: "WY" },
];

const fallbackProducts: ProductOption[] = [
  {
    slug: "nitrile-standard",
    name: "Nitrile Examination - Standard",
    description: "Blue exam glove catalog bundle",
    colorClassName: "bg-sg-chart-1",
    sizes: ["S", "M", "L"],
    defaultSize: "M",
    bundles: [
      { id: "box_1", label: "1 box", kind: "box", units: 1, priceCents: 899 },
      { id: "case_1", label: "1 carton", kind: "case", units: 1, priceCents: 5499 },
    ],
  },
  {
    slug: "black-nitrile-general",
    name: "Black Nitrile - General",
    description: "General-purpose black nitrile catalog bundle",
    colorClassName: "bg-[#8f8a84]",
    sizes: ["M", "L"],
    defaultSize: "M",
    bundles: [
      { id: "box_1", label: "1 box", kind: "box", units: 1, priceCents: 899 },
      { id: "case_1", label: "1 carton", kind: "case", units: 1, priceCents: 5799 },
    ],
  },
  {
    slug: "black-nitrile-heavy-duty",
    name: "Black Nitrile - Heavy Duty",
    description: "Heavy-duty black nitrile catalog bundle",
    colorClassName: "bg-[#2d2c2b]",
    sizes: ["L", "XL"],
    defaultSize: "L",
    bundles: [
      { id: "box_1", label: "1 box", kind: "box", units: 1, priceCents: 1399 },
      { id: "case_1", label: "1 carton", kind: "case", units: 1, priceCents: 11599 },
    ],
  },
];

const pickupAddress: ManualOrderAddress = {
  line1: "In-store / pickup (see staff notes)",
  line2: "",
  city: "Savannah",
  state: "TN",
  postalCode: "38372",
  country: "US",
};

const fulfillmentOptions: Array<{ value: FulfillmentMethod; label: string; icon: "truck" | "pin" | "package" | "cart" }> = [
  { value: "carrier", label: "Ship with carrier", icon: "truck" },
  { value: "local_delivery", label: "Local delivery", icon: "pin" },
  { value: "b2b_shipping", label: "B2B shipping", icon: "cart" },
];

const paymentOptions: Array<{ value: PaymentMethod; label: string; icon: "receipt" | "logout" | "arrow-up-right" }> = [
  { value: "square_payment_link", label: "Send payment link email", icon: "arrow-up-right" },
  { value: "pay_later", label: "Pay later (Cash or Cheque)", icon: "receipt" },
  { value: "arrival_payment_link", label: "Send link upon arrival", icon: "logout" },
];

const discountCategoryOptions: Array<{ value: DiscountCategory; label: string }> = [
  { value: "none", label: "No discount" },
  { value: "code", label: "Discount code" },
  { value: "percent", label: "Percentage" },
  { value: "amount", label: "Fixed amount" },
];

const quickPercentOptions: Array<{ value: Extract<DiscountMode, "percent_5" | "percent_10" | "percent_15" | "custom_percent">; label: string }> = [
  { value: "percent_5", label: "5%" },
  { value: "percent_10", label: "10%" },
  { value: "percent_15", label: "15%" },
  { value: "custom_percent", label: "Custom" },
];

function discountCategoryForMode(mode: DiscountMode): DiscountCategory {
  if (mode === "code") return "code";
  if (mode === "custom_amount") return "amount";
  if (mode === "percent_5" || mode === "percent_10" || mode === "percent_15" || mode === "custom_percent") return "percent";
  return "none";
}

function emptySizeMap(sizes: SizeCode[]) {
  return Object.fromEntries(sizes.map((size) => [size, 0])) as Record<string, number>;
}

function makeOrderItemRow(index: number, product = fallbackProducts[0], unit: "case" | "box" = "case"): OrderItemRow {
  const bundle = getUnitBundle(product, unit);
  return {
    id: `item-${Date.now()}-${index}`,
    productSlug: product.slug,
    size: product.defaultSize,
    unit,
    bundleId: bundle.id,
    quantity: 0,
    pricingMode: "catalog",
    negotiatedUnitPrice: "",
    negotiationReason: "",
  };
}

function priceOrderRows(rows: OrderItemRow[], products: ProductOption[], allowNegotiatedPricing = false) {
  const caseCounts = new Map<ProductSlug, number>();
  for (const row of rows) {
    const product = getProduct(products, row.productSlug);
    const bundle = getSelectedBundle(product, row);
    if (bundle.kind === "case") caseCounts.set(product.slug, (caseCounts.get(product.slug) || 0) + Math.max(0, Math.floor(row.quantity || 0)) * bundle.units);
  }
  const appliedProducts = new Set<ProductSlug>();
  const lineTotals = new Map<string, number>();
  let totalCents = 0;
  for (const row of rows) {
    const product = getProduct(products, row.productSlug);
    const bundle = getSelectedBundle(product, row);
    const quantity = Math.max(0, Math.floor(row.quantity || 0));
    const rule = product.volumePricing;
    const eligible = bundle.kind === "case" && rule?.active === true && (caseCounts.get(product.slug) || 0) >= rule.minCases && rule.pricePerCaseCents > 0;
    const catalogUnitPrice = eligible ? Math.min(bundle.priceCents, bundle.units * rule.pricePerCaseCents) : bundle.priceCents;
    const negotiatedUnitPrice = parseDollarsToCents(row.negotiatedUnitPrice);
    const unitPrice = allowNegotiatedPricing && row.pricingMode === "negotiated" && negotiatedUnitPrice > 0
      ? negotiatedUnitPrice
      : catalogUnitPrice;
    if (eligible && catalogUnitPrice < bundle.priceCents) appliedProducts.add(product.slug);
    const lineTotal = unitPrice * quantity;
    totalCents += lineTotal;
    lineTotals.set(row.id, lineTotal);
  }
  const negotiatedApplied = allowNegotiatedPricing && rows.some((row) => row.pricingMode === "negotiated" && Math.max(0, Math.floor(row.quantity || 0)) > 0);
  const blocksDiscount = negotiatedApplied || [...appliedProducts].some((slug) => getProduct(products, slug).volumePricing?.allowDiscountStacking !== true);
  return { totalCents, lineTotals, appliedProducts, blocksDiscount, negotiatedApplied };
}

function modeButtonClass(active: boolean) {
  return [
    "inline-flex h-9 items-center justify-center rounded-full px-4 text-[12px] font-semibold transition",
    active ? "bg-white text-sg-primary shadow-sm" : "text-sg-muted hover:bg-white/70 hover:text-sg-text",
  ].join(" ");
}

function priceModeButtonClass(active: boolean) {
  return [
    "inline-flex h-9 items-center justify-center rounded-full px-4 text-[12px] font-semibold transition",
    active ? "bg-[#f5f5f5] text-sg-primary" : "text-sg-muted hover:bg-[#f5f5f5] hover:text-sg-text",
  ].join(" ");
}

function optionButtonClass(active: boolean) {
  return [
    "min-w-0 rounded-[7px] border p-3 text-left transition",
    active ? "border-sg-primary bg-sg-primary-soft text-sg-primary" : "border-sg-border bg-white hover:bg-sg-input-bg",
  ].join(" ");
}

function todayYmd() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

async function readB2bInvoicePdf(file: File): Promise<ManualOrderInvoiceAttachment> {
  if (!/\.pdf$/i.test(file.name) || (file.type && file.type !== "application/pdf")) {
    throw new Error("Select a PDF invoice file.");
  }
  if (!file.size || file.size > MAX_B2B_INVOICE_BYTES) {
    throw new Error("The invoice PDF must be 4 MB or smaller.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("The selected invoice is not a valid PDF file.");
  }
  const contentBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      const separator = value.indexOf(",");
      if (separator < 0) reject(new Error("The invoice PDF could not be read."));
      else resolve(value.slice(separator + 1));
    };
    reader.onerror = () => reject(new Error("The invoice PDF could not be read."));
    reader.readAsDataURL(file);
  });
  return { filename: file.name, contentBase64, contentType: "application/pdf", sizeBytes: file.size };
}

async function readTaxExemptionCertificate(file: File): Promise<ManualOrderTaxExemptionCertificate> {
  const extension = file.name.toLowerCase().split(".").pop() || "";
  const inferredType = extension === "pdf"
    ? "application/pdf"
    : extension === "png"
      ? "image/png"
      : extension === "jpg" || extension === "jpeg"
        ? "image/jpeg"
        : "";
  const contentType = (file.type || inferredType).toLowerCase();
  if (!["application/pdf", "image/png", "image/jpeg"].includes(contentType)) {
    throw new Error("Select a PDF, PNG, JPG, or JPEG exemption certificate.");
  }
  if (!file.size || file.size > MAX_TAX_EXEMPTION_CERTIFICATE_BYTES) {
    throw new Error("The exemption certificate must be 2 MB or smaller.");
  }
  const contentBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      const separator = value.indexOf(",");
      if (separator < 0) reject(new Error("The exemption certificate could not be read."));
      else resolve(value.slice(separator + 1));
    };
    reader.onerror = () => reject(new Error("The exemption certificate could not be read."));
    reader.readAsDataURL(file);
  });
  return {
    filename: file.name,
    contentBase64,
    contentType: contentType as ManualOrderTaxExemptionCertificate["contentType"],
    sizeBytes: file.size,
  };
}

function parseDollarsToCents(value: string) {
  const n = Number(value.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0;
}

function getProduct(products: ProductOption[], productSlug: ProductSlug) {
  return products.find((product) => product.slug === productSlug) || products[0];
}

function getUnitBundle(product: ProductOption, unit: "case" | "box") {
  return product.bundles.find((bundle) => bundle.kind === unit) || product.bundles[0];
}

function getSelectedBundle(product: ProductOption, row: Pick<OrderItemRow, "bundleId" | "unit">) {
  return product.bundles.find((bundle) => bundle.id === row.bundleId) || getUnitBundle(product, row.unit);
}

function addressFingerprint(address: ManualOrderAddress) {
  return [address.line1, address.line2, address.city, address.state, address.postalCode, address.country]
    .map((value) => String(value || "").trim().toUpperCase())
    .join("|");
}

function formatAddress(address: ManualOrderAddress) {
  return [address.line1, address.line2, `${address.city}, ${address.state} ${address.postalCode}`]
    .filter((line) => String(line || "").trim())
    .join("\n");
}

function formatRateLabel(rate: ManualOrderShippingRateOption) {
  const service = rate.serviceLabel || rate.serviceCode || "Carrier rate";
  const price = rate.totalAmountFormatted || rate.amountFormatted || formatUsdCents(rate.totalAmountCents || rate.amountCents || 0);
  return `${service} - ${price}`;
}

function formatRateBreakdown(rate: ManualOrderShippingRateOption) {
  if (rate.freeShippingApplied) {
    return `${rate.provider || "Carrier"} · ${rate.carrierTotalAmountFormatted || formatUsdCents(rate.carrierTotalAmountCents || 0)} carrier cost · customer shipping free`;
  }
  const surchargeCents = Math.max(0, Math.round(Number(rate.residentialSurchargeCents) || 0));
  const bufferCents = Math.max(0, Math.round(Number(rate.bufferCents) || 0));
  if (!surchargeCents && !bufferCents) return rate.provider || "Carrier";
  const base = rate.amountFormatted || formatUsdCents(rate.amountCents || 0);
  const parts = [`${base} rate`];
  if (bufferCents) parts.push(`${rate.bufferFormatted || formatUsdCents(bufferCents)} buffer`);
  if (surchargeCents) parts.push(`${rate.residentialSurchargeFormatted || formatUsdCents(surchargeCents)} residential`);
  return `${rate.provider || "Carrier"} · ${parts.join(" + ")}`;
}

function formatDeliveryEstimate(rate: ManualOrderShippingRateOption) {
  const days = Math.max(0, Math.round(Number(rate.estimatedDays) || 0));
  if (!days) return "";
  return `Estimated delivery: ${days} business day${days === 1 ? "" : "s"}`;
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function visibleQuoteWarnings(quote: ManualOrderQuoteResponse | null) {
  return (quote?.warnings || []).filter((warning) => !/no carrier or shippo in this quote/i.test(warning));
}

function rateAmountCents(rate: ManualOrderShippingRateOption | null | undefined) {
  if (!rate) return 0;
  return Math.max(0, Math.round(Number(rate.totalAmountCents ?? rate.amountCents) || 0));
}

function shippingRateOptionsFromError(error: unknown) {
  if (!(error instanceof ApiError)) return null;
  const rates = error.payload.shippingRateOptions;
  return Array.isArray(rates) ? (rates as ManualOrderShippingRateOption[]) : null;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  required = false,
  error,
  compact = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: string;
  required?: boolean;
  error?: string;
  compact?: boolean;
}) {
  return (
    <label className="block min-w-0">
      <span className="text-[12px] font-semibold text-sg-muted">
        {label}
        {required ? <span className="ml-0.5 text-sg-danger">*</span> : null}
      </span>
      <input
        className={`sg25-input ${compact ? "mt-1" : "mt-2"} h-10 rounded-[7px] bg-sg-input-bg px-2.5 ${
          error ? "border-sg-danger bg-sg-danger-soft/40" : ""
        }`}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        aria-invalid={Boolean(error)}
      />
      {error ? <p className="mt-1 text-[11px] font-semibold text-sg-danger">{error}</p> : null}
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="text-[12px] font-semibold text-sg-muted">{label}</span>
      <textarea
        className="sg25-input mt-2 min-h-[84px] resize-y rounded-[7px] bg-sg-input-bg px-2.5 py-2"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function StateField({
  value,
  onChange,
  error,
  required = true,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
}) {
  return (
    <label className="block min-w-0">
      <span className="text-[12px] font-semibold text-sg-muted">
        State{required ? <span className="ml-0.5 text-sg-danger">*</span> : null}
      </span>
      <CustomSelect
        value={value}
        options={usStateOptions}
        onChange={onChange}
        ariaLabel="State"
        className="mt-2 w-full"
        triggerClassName={`h-10 rounded-[7px] bg-sg-input-bg px-2.5 text-[13px] ${error ? "border-sg-danger bg-sg-danger-soft/40" : ""}`}
        panelClassName="left-0 right-auto max-h-72 overflow-y-auto"
      />
      {error ? <p className="mt-1 text-[11px] font-semibold text-sg-danger">{error}</p> : null}
    </label>
  );
}

function Stepper({
  value,
  onChange,
  ariaLabel,
  max,
  fill = false,
  size = "sm",
  className = "",
}: {
  value: number;
  onChange: (nextValue: number) => void;
  ariaLabel: string;
  max?: number;
  fill?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const canDecrease = value > 0;
  const canIncrease = max == null || value < max;
  const heightClassName = size === "md" ? "h-11" : "h-8";
  const buttonSizeClassName = size === "md" ? "h-8 w-8" : "h-6 w-6";
  const layoutClassName = fill
    ? size === "md"
      ? "w-full grid-cols-[40px_minmax(0,1fr)_40px]"
      : "w-full grid-cols-[32px_minmax(0,1fr)_32px]"
    : "w-fit grid-cols-[32px_48px_32px]";
  return (
    <div className={`grid ${heightClassName} ${layoutClassName} items-center rounded-[10px] border border-sg-border bg-sg-input-bg/60 px-1 ${className}`}>
      <button
        type="button"
        className={`m-auto flex ${buttonSizeClassName} items-center justify-center rounded-full border border-sg-border bg-white pb-px text-base font-semibold leading-none text-sg-muted shadow-sm outline-none transition enabled:hover:border-sg-primary/40 enabled:hover:text-sg-primary focus-visible:ring-2 focus-visible:ring-sg-primary/20 disabled:cursor-not-allowed disabled:opacity-35`}
        onClick={() => onChange(Math.max(0, value - 1))}
        disabled={!canDecrease}
        aria-label={`Decrease ${ariaLabel}`}
      >
        −
      </button>
      <output aria-live="polite" className="flex h-full w-full items-center justify-center pb-px text-[14px] font-bold leading-none text-sg-text">{value}</output>
      <button
        type="button"
        className={`m-auto flex ${buttonSizeClassName} items-center justify-center rounded-full border border-sg-border bg-white pb-px text-base font-semibold leading-none text-sg-muted shadow-sm outline-none transition enabled:hover:border-sg-primary/40 enabled:hover:text-sg-primary focus-visible:ring-2 focus-visible:ring-sg-primary/20 disabled:cursor-not-allowed disabled:opacity-35`}
        onClick={() => onChange(value + 1)}
        disabled={!canIncrease}
        aria-label={`Increase ${ariaLabel}`}
      >
        +
      </button>
    </div>
  );
}

function SummaryLine({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-4 ${strong ? "text-sg-text" : "text-sg-muted"}`}>
      <span>{label}</span>
      <span className={strong ? "text-lg font-bold" : "font-semibold text-sg-text"}>{value}</span>
    </div>
  );
}

function quoteValue(quote: ManualOrderQuoteResponse | null, key: keyof ManualOrderQuoteResponse, fallbackCents: number) {
  const value = quote?.[key];
  return typeof value === "string" && value ? value : formatUsdCents(fallbackCents);
}

function paymentOptionsForFulfillment(method: FulfillmentMethod) {
  if (method === "carrier") return paymentOptions.filter((option) => option.value === "square_payment_link");
  if (method === "b2b_shipping") return paymentOptions.filter((option) => option.value !== "arrival_payment_link");
  if (method === "local_delivery") return paymentOptions;
  return paymentOptions.filter((option) => option.value === "pay_later");
}

function sizeLabel(size: SizeCode) {
  if (size === "S") return "Small";
  if (size === "M") return "Medium";
  if (size === "L") return "Large";
  return "X Large";
}

function normalizeAdminDiscountCode(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

function recordValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function rowsFromDraftItems(rawItems: unknown, products: ProductOption[]) {
  if (!Array.isArray(rawItems)) return [];
  const rows: OrderItemRow[] = [];
  rawItems.forEach((rawItem, itemIndex) => {
    const item = recordValue(rawItem);
    const product = products.find((entry) => entry.slug === String(item.slug || ""));
    if (!product) return;
    const bundleLines = Array.isArray(item.bundleLines) ? item.bundleLines : [];
    const pricing = recordValue(item.b2bPricing);
    if (bundleLines.length === 1 && item.clientLineId) {
      const rawBundle = recordValue(bundleLines[0]);
      const bundle = product.bundles.find((entry) => entry.id === String(rawBundle.id || ""));
      if (bundle) {
        const allocations = recordValue(bundle.kind === "case" ? item.quantities : item.boxQuantities);
        const size = product.sizes.find((entry) => Number(allocations[entry]) > 0) || product.defaultSize;
        rows.push({
          id: String(item.clientLineId),
          productSlug: product.slug,
          size,
          unit: bundle.kind,
          bundleId: bundle.id,
          quantity: Math.max(1, Math.floor(Number(rawBundle.qty) || 1)),
          pricingMode: pricing.mode === "negotiated" ? "negotiated" : "catalog",
          negotiatedUnitPrice: pricing.mode === "negotiated" ? (Math.max(0, Number(pricing.unitPriceCents) || 0) / 100).toFixed(2) : "",
          negotiationReason: pricing.mode === "negotiated" ? String(pricing.reason || "") : "",
        });
        return;
      }
    }
    (["case", "box"] as const).forEach((unit) => {
      const allocations = recordValue(unit === "case" ? item.quantities : item.boxQuantities);
      const bundle = getUnitBundle(product, unit);
      product.sizes.forEach((size) => {
        const allocated = Math.max(0, Math.floor(Number(allocations[size]) || 0));
        if (!allocated) return;
        rows.push({
          id: `edit-${itemIndex}-${unit}-${size}`,
          productSlug: product.slug,
          size,
          unit,
          bundleId: bundle.id,
          quantity: Math.max(1, Math.ceil(allocated / Math.max(1, bundle.units))),
          pricingMode: "catalog",
          negotiatedUnitPrice: "",
          negotiationReason: "",
        });
      });
    });
  });
  return rows;
}

function emptyInventoryAvailability(products: ProductOption[]) {
  return Object.fromEntries(
    products.map((product) => [
      product.slug,
      Object.fromEntries(product.sizes.map((size) => [size, { caseAvailable: null, boxAvailable: null, boxesPerCase: 10, tracked: false }])),
    ]),
  ) as InventoryAvailability;
}

export function OrderBuilderPage() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const editOrderId = String((location.state as { editOrderId?: unknown } | null)?.editOrderId || "").trim();
  const [editOrderRef, setEditOrderRef] = useState("");
  const [editDraftLoaded, setEditDraftLoaded] = useState(!editOrderId);
  const [editOriginalDiscountCode, setEditOriginalDiscountCode] = useState("");
  const [mode, setMode] = useState<BuilderMode>("remote");
  const [fulfillmentMethod, setFulfillmentMethod] = useState<FulfillmentMethod>("carrier");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("square_payment_link");
  const [discountMode, setDiscountMode] = useState<DiscountMode>("none");
  const [discountCode, setDiscountCode] = useState("");
  const [discountCodeCheck, setDiscountCodeCheck] = useState<{
    code: string;
    status: "valid" | "invalid";
    message: string;
    percent?: number;
  } | null>(null);
  const [customDiscountValue, setCustomDiscountValue] = useState("");
  const [customB2bShipping, setCustomB2bShipping] = useState("");
  const [b2bInvoiceFile, setB2bInvoiceFile] = useState<File | null>(null);
  const [b2bInvoiceDragActive, setB2bInvoiceDragActive] = useState(false);
  const [selectedRateId, setSelectedRateId] = useState("");
  const [selectedRateSnapshot, setSelectedRateSnapshot] = useState<ManualOrderShippingRateOption | null>(null);
  const [products, setProducts] = useState<ProductOption[]>(fallbackProducts);
  const [itemRows, setItemRows] = useState<OrderItemRow[]>([]);
  const [customer, setCustomer] = useState({ name: "", email: "", phone: "" });
  const [taxExemption, setTaxExemption] = useState<TaxExemptionState>(initialTaxExemption);
  const [taxExemptionCertificateFile, setTaxExemptionCertificateFile] = useState<File | null>(null);
  const [taxExemptionCertificateReference, setTaxExemptionCertificateReference] = useState("");
  const [taxExemptionDragActive, setTaxExemptionDragActive] = useState(false);
  const [taxReviewWarning, setTaxReviewWarning] = useState<string[] | null>(null);
  const [address, setAddress] = useState<ManualOrderAddress>({
    line1: "",
    line2: "",
    city: "",
    state: "TN",
    postalCode: "",
    country: "US",
  });
  const [addressVerification, setAddressVerification] = useState<AddressVerificationState>({
    status: "idle",
    fingerprint: "",
    suggestion: null,
    message: "",
  });
  const [deliveryNote, setDeliveryNote] = useState("");
  const [pickupNote, setPickupNote] = useState("");
  const [staffNote, setStaffNote] = useState("");
  const [shipmentDate, setShipmentDate] = useState(todayYmd);
  const [quote, setQuote] = useState<ManualOrderQuoteResponse | null>(null);
  const [quoteReceivedAt, setQuoteReceivedAt] = useState<number | null>(null);
  const [quoteDirty, setQuoteDirty] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ tone: "muted" | "success" | "danger" | "warning"; message: string } | null>(null);
  const [busy, setBusy] = useState<"verify-address" | "estimate" | "send" | null>(null);
  const [isCarrierRatesRefreshing, setIsCarrierRatesRefreshing] = useState(false);
  const [inventoryAvailability, setInventoryAvailability] = useState<InventoryAvailability>(() => emptyInventoryAvailability(fallbackProducts));
  const [summaryCanStick, setSummaryCanStick] = useState(true);
  const [updatedAt] = useState(() => new Date().toISOString());
  const summaryRef = useRef<HTMLElement | null>(null);
  const carrierRatesRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollToRatesRef = useRef(false);
  const editDraftLoadingRef = useRef(false);
  const b2bInvoiceInputRef = useRef<HTMLInputElement | null>(null);
  const taxExemptionInputRef = useRef<HTMLInputElement | null>(null);

  useAdminShellHeaderMeta(<span>Updated {formatDateTime(updatedAt)}</span>);

  useEffect(() => {
    let alive = true;
    async function loadCatalog() {
      try {
        const response = await fetch("/api/products", { cache: "no-store" });
        if (!response.ok) return;
        const store = await response.json() as { products?: Array<Record<string, unknown>> };
        const next = (store.products || []).map((raw) => {
          const fallback = fallbackProducts.find((product) => product.slug === raw.slug);
          if (!fallback) return null;
          const bundles = (Array.isArray(raw.bundles) ? raw.bundles : []).map((bundle) => {
            const value = bundle as Record<string, unknown>;
            return {
              id: String(value.id || ""),
              label: String(value.label || ""),
              kind: value.kind === "box" ? "box" as const : "case" as const,
              units: Math.max(1, Math.floor(Number(value.units) || 1)),
              priceCents: Math.max(1, Math.floor(Number(value.priceCents) || 1)),
            };
          }).filter((bundle) => bundle.id && bundle.label);
          return {
            ...fallback,
            name: String(raw.name || fallback.name),
            sizes: (Array.isArray(raw.supportedSizes) ? raw.supportedSizes : fallback.sizes) as SizeCode[],
            bundles: sortBundlesHierarchically(bundles.length ? bundles : fallback.bundles),
            ...(raw.volumePricing && typeof raw.volumePricing === "object" ? { volumePricing: raw.volumePricing as ProductOption["volumePricing"] } : {}),
          };
        }).filter(Boolean) as ProductOption[];
        if (alive && next.length) setProducts(next);
      } catch {
        // Bundled catalog remains available when the live catalog request is unavailable.
      }
    }
    void loadCatalog();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!editOrderId || editDraftLoaded || editDraftLoadingRef.current) return;
    editDraftLoadingRef.current = true;
    async function loadDraftForEditing() {
      try {
        const token = await auth.getAccessToken();
        const response = await fetchManualOrderDraft(editOrderId, token);
        if (!response.order) return;
        const order = response.order;
        const shippingAddress = recordValue(order.shipping_address);
        const fulfillment = String(order.fulfillment_method || "carrier") as FulfillmentMethod;
        const snapshot = recordValue(order.quoted_address_snapshot_json);
        const quoteSnapshot = recordValue(order.checkout_quote_snapshot_json);
        const existingTaxExemption = recordValue(quoteSnapshot.taxExemption);
        const manualDiscount = recordValue(snapshot.manualDiscount);
        const discountType = String(manualDiscount.type || "none").toLowerCase();
        const discountValue = Number(manualDiscount.value ?? manualDiscount.percent ?? manualDiscount.amountCents) || 0;
        const existingCode = String(order.discount_code_used || "").trim();

        setEditOrderRef(String(order.order_ref || editOrderId));
        setEditOriginalDiscountCode(normalizeAdminDiscountCode(existingCode));
        setMode("remote");
        setCustomer({
          name: String(order.customer_name || ""),
          email: String(order.customer_email || ""),
          phone: String(order.customer_phone || ""),
        });
        if (existingTaxExemption.status === "approved") {
          setTaxExemption({
            requested: true,
            exemptionType: (["organization_own_use", "government", "resale", "other"].includes(String(existingTaxExemption.exemptionType))
              ? String(existingTaxExemption.exemptionType)
              : "organization_own_use") as TaxExemptionType,
            jurisdiction: String(existingTaxExemption.jurisdiction || shippingAddress.state || "TN"),
            certificateNumber: String(existingTaxExemption.certificateNumber || ""),
            effectiveDate: String(existingTaxExemption.effectiveDate || ""),
            expirationDate: String(existingTaxExemption.expirationDate || ""),
            internalNote: String(existingTaxExemption.internalNote || ""),
            documentReviewed: true,
          });
          setTaxExemptionCertificateReference(String(response.taxExemptionCertificateReference || ""));
          setTaxExemptionCertificateFile(null);
        }
        setAddress({
          line1: String(shippingAddress.line1 || shippingAddress.address1 || ""),
          line2: String(shippingAddress.line2 || shippingAddress.address2 || ""),
          city: String(shippingAddress.city || ""),
          state: String(shippingAddress.state || "TN"),
          postalCode: String(shippingAddress.postalCode || shippingAddress.zip || ""),
          country: String(shippingAddress.country || "US"),
        });
        setItemRows(rowsFromDraftItems(order.items, products));
        setFulfillmentMethod(["carrier", "local_delivery", "pickup", "b2b_shipping"].includes(fulfillment) ? fulfillment : "carrier");
        setPaymentMethod("square_payment_link");
        setShipmentDate(String(order.shippo_shipment_date || todayYmd()));
        if (fulfillment === "b2b_shipping") {
          setCustomB2bShipping((Math.max(0, Number(order.shipping_cents) || 0) / 100).toFixed(2));
        }
        if (existingCode && discountType === "percent") {
          const percent = Math.max(0, Math.round(discountValue));
          setDiscountMode("code");
          setDiscountCode(existingCode);
          setDiscountCodeCheck({ code: normalizeAdminDiscountCode(existingCode), status: "valid", message: "Existing order discount", percent });
        } else if (discountType === "percent" && discountValue > 0) {
          const percent = Math.round(discountValue);
          setDiscountMode(percent === 5 ? "percent_5" : percent === 10 ? "percent_10" : percent === 15 ? "percent_15" : "custom_percent");
          if (![5, 10, 15].includes(percent)) setCustomDiscountValue(String(percent));
        } else if (discountType === "amount" && discountValue > 0) {
          setDiscountMode("custom_amount");
          setCustomDiscountValue((discountValue / 100).toFixed(2));
        }
        setQuote(null);
        setQuoteDirty(true);
        setQuoteReceivedAt(null);
        setSelectedRateId("");
        setSelectedRateSnapshot(null);
        setAddressVerification({ status: "idle", fingerprint: "", suggestion: null, message: "Verify the address to get current shipping rates." });
        setStatus({ tone: "warning", message: `Editing expired order ${String(order.order_ref || editOrderId)}. Review it and get current totals before sending a new link.` });
        setEditDraftLoaded(true);
      } catch (error) {
        setStatus({ tone: "danger", message: error instanceof Error ? error.message : "Could not load this expired order." });
      } finally {
        editDraftLoadingRef.current = false;
      }
    }
    void loadDraftForEditing();
  }, [auth, editDraftLoaded, editOrderId, products]);

  useEffect(() => {
    let alive = true;
    async function loadInventoryAvailability() {
      try {
        const token = await auth.getAccessToken();
        const data = await fetchInventoryDashboard(token);
        if (!alive) return;
        const next = emptyInventoryAvailability(products);
        for (const raw of data.variants || []) {
          const slug = String(raw.productSlug || "") as ProductSlug;
          const size = String(raw.size || "") as SizeCode;
          const channel = String(raw.channel || "");
          if (!next[slug]?.[size] || (channel !== "case" && channel !== "box")) continue;
          const tracked = raw.track === true && raw.active !== false;
          const finite = Number.isFinite(raw.availableFinite) ? Math.max(0, Math.floor(Number(raw.availableFinite))) : null;
          next[slug][size] = {
            ...next[slug][size],
            tracked: next[slug][size].tracked || tracked,
            boxesPerCase: Math.max(1, Math.floor(Number(raw.boxesPerCase) || next[slug][size].boxesPerCase || 10)),
            ...(channel === "case" ? { caseAvailable: tracked ? finite : null } : { boxAvailable: tracked ? finite : null }),
          };
        }
        setInventoryAvailability(next);
      } catch {
        if (alive) setInventoryAvailability(emptyInventoryAvailability(products));
      }
    }
    void loadInventoryAvailability();
    return () => {
      alive = false;
    };
  }, [auth, products]);

  useEffect(() => {
    const summary = summaryRef.current;
    if (!summary) return;

    const updateStickyEligibility = () => {
      const desktop = window.matchMedia("(min-width: 1024px)").matches;
      const availableHeight = window.innerHeight - 88 - 24;
      const canStick = !desktop || summary.getBoundingClientRect().height <= availableHeight;
      setSummaryCanStick((current) => (current === canStick ? current : canStick));
    };

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateStickyEligibility);
    observer?.observe(summary);
    window.addEventListener("resize", updateStickyEligibility);
    updateStickyEligibility();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateStickyEligibility);
    };
  }, []);

  const selectedItems = useMemo<ManualOrderItem[]>(() => {
    if (fulfillmentMethod === "b2b_shipping") {
      return itemRows.flatMap((row) => {
        const quantity = Math.max(0, Math.floor(row.quantity || 0));
        if (!quantity) return [];
        const product = getProduct(products, row.productSlug);
        const bundle = getSelectedBundle(product, row);
        const quantities = emptySizeMap(product.sizes);
        const boxQuantities = emptySizeMap(product.sizes);
        const allocation = bundle.kind === "case" ? quantities : boxQuantities;
        allocation[row.size] = quantity * bundle.units;
        return [{
          slug: product.slug,
          clientLineId: row.id,
          bundleLines: [{ id: bundle.id, qty: quantity }],
          quantities,
          boxQuantities,
          ...(row.pricingMode === "negotiated" ? {
            b2bNegotiatedUnitPriceCents: parseDollarsToCents(row.negotiatedUnitPrice),
            b2bNegotiationReason: row.negotiationReason.trim(),
          } : {}),
        }];
      });
    }
    const grouped = new Map<ProductSlug, ManualOrderItem>();
    for (const row of itemRows) {
      const quantity = Math.max(0, Math.floor(row.quantity || 0));
      if (!quantity) continue;
      const product = getProduct(products, row.productSlug);
      const bundle = getSelectedBundle(product, row);
      const current = grouped.get(product.slug) || {
        slug: product.slug,
        bundleLines: [],
        quantities: emptySizeMap(product.sizes),
        boxQuantities: emptySizeMap(product.sizes),
      };
      const existingBundle = current.bundleLines?.find((line) => line.id === bundle.id);
      if (existingBundle) existingBundle.qty += quantity;
      else current.bundleLines?.push({ id: bundle.id, qty: quantity });
      const allocation = bundle.kind === "case" ? current.quantities : current.boxQuantities;
      if (allocation) allocation[row.size] = Math.max(0, Math.floor(allocation[row.size] || 0)) + quantity * bundle.units;
      grouped.set(product.slug, current);
    }
    return [...grouped.values()];
  }, [fulfillmentMethod, itemRows, products]);

  const summaryProductLines = useMemo(() => {
    const pricedRows = priceOrderRows(itemRows, products, fulfillmentMethod === "b2b_shipping");
    const grouped = new Map<string, { key: string; name: string; detail: string; totalCents: number; cases: number; boxes: number; size: SizeCode }>();
    for (const row of itemRows) {
      const quantity = Math.max(0, Math.floor(row.quantity || 0));
      if (!quantity) continue;
      const product = getProduct(products, row.productSlug);
      const bundle = getSelectedBundle(product, row);
      const key = `${product.slug}-${row.size}`;
      const current = grouped.get(key) || { key, name: product.name, detail: "", totalCents: 0, cases: 0, boxes: 0, size: row.size };
      current[bundle.kind === "case" ? "cases" : "boxes"] += quantity * bundle.units;
      current.totalCents += pricedRows.lineTotals.get(row.id) || 0;
      grouped.set(key, current);
    }
    return [...grouped.values()].map((line) => ({
      key: line.key,
      name: line.name,
      detail: [
        sizeLabel(line.size),
        [
          line.cases ? `${line.cases} carton${line.cases === 1 ? "" : "s"}` : "",
          line.boxes ? `${line.boxes} box${line.boxes === 1 ? "" : "es"}` : "",
        ].filter(Boolean).join(" + "),
      ].join(" · "),
      total: formatUsdCents(line.totalCents),
    }));
  }, [fulfillmentMethod, itemRows, products]);

  const taxExemptionCertificateSelected = Boolean(taxExemptionCertificateFile || taxExemptionCertificateReference);
  const taxExemptionReady = Boolean(
    taxExemption.requested &&
    taxExemption.documentReviewed &&
    taxExemptionCertificateSelected &&
    taxExemption.jurisdiction === address.state.trim().toUpperCase(),
  );

  const previewTotals = useMemo(() => {
    const pricedRows = priceOrderRows(itemRows, products, fulfillmentMethod === "b2b_shipping");
    const subtotalCents = pricedRows.totalCents;
    const discountCents =
      discountMode === "percent_5"
        ? Math.round(subtotalCents * 0.05)
        : discountMode === "percent_10"
          ? Math.round(subtotalCents * 0.1)
          : discountMode === "percent_15"
            ? Math.round(subtotalCents * 0.15)
            : discountMode === "custom_percent"
              ? Math.round(subtotalCents * Math.min(100, Math.max(0, Number(customDiscountValue) || 0)) / 100)
              : discountMode === "custom_amount"
                ? Math.min(subtotalCents, parseDollarsToCents(customDiscountValue))
                : discountMode === "code" && discountCodeCheck?.status === "valid"
                  ? Math.round(subtotalCents * ((discountCodeCheck.percent ?? DEFAULT_DISCOUNT_PERCENT) / 100))
                  : 0;
    const allowedDiscountCents = pricedRows.blocksDiscount ? 0 : discountCents;
    const discountedSubtotalCents = Math.max(0, subtotalCents - allowedDiscountCents);
    const shippingCents =
      fulfillmentMethod === "b2b_shipping"
        ? parseDollarsToCents(customB2bShipping)
        : fulfillmentMethod === "carrier"
          ? quote?.freeDelivery?.applied
            ? 0
            : quoteDirty
            ? 0
            : rateAmountCents(selectedRateSnapshot)
          : 0;
    const taxableTaxCents = address.state.trim().toUpperCase() === "TN"
      ? Math.round((discountedSubtotalCents + shippingCents) * 0.0975)
      : 0;
    const taxCents = taxExemptionReady ? 0 : taxableTaxCents;
    const unitCount = itemRows.reduce((sum, row) => sum + Math.max(0, Math.floor(row.quantity || 0)), 0);
    return {
      itemCount: selectedItems.length,
      unitCount,
      originalSubtotalCents: subtotalCents,
      discountCents: allowedDiscountCents,
      volumePricingApplied: pricedRows.appliedProducts.size > 0,
      volumePricingBlocksDiscount: pricedRows.blocksDiscount,
      negotiatedPricingApplied: pricedRows.negotiatedApplied,
      subtotalCents: discountedSubtotalCents,
      shippingCents,
      taxCents,
      taxExcludedCents: taxExemptionReady ? taxableTaxCents : 0,
      totalCents: discountedSubtotalCents + shippingCents + taxCents,
    };
  }, [address.state, customB2bShipping, customDiscountValue, discountCodeCheck, discountMode, fulfillmentMethod, itemRows, products, quote, quoteDirty, selectedItems.length, selectedRateSnapshot, taxExemptionReady]);

  const selectedRate = useMemo(() => {
    const rates = quote?.shippingRateOptions || [];
    return rates.find((rate) => String(rate.id || "") === selectedRateId) || selectedRateSnapshot;
  }, [quote, selectedRateId, selectedRateSnapshot]);

  useEffect(() => {
    const options = paymentOptionsForFulfillment(fulfillmentMethod);
    if (!options.length) return;
    if (!options.some((option) => option.value === paymentMethod)) {
      setPaymentMethod(options[0].value);
    }
  }, [fulfillmentMethod, paymentMethod]);

  useEffect(() => {
    if (fulfillmentMethod !== "b2b_shipping" || paymentMethod !== "square_payment_link") {
      setB2bInvoiceFile(null);
      setB2bInvoiceDragActive(false);
    }
  }, [fulfillmentMethod, paymentMethod]);

  function selectB2bInvoice(file: File | null) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) || (file.type && file.type !== "application/pdf")) {
      setB2bInvoiceFile(null);
      setStatus({ tone: "danger", message: "Select a PDF invoice file." });
      return;
    }
    if (!file.size || file.size > MAX_B2B_INVOICE_BYTES) {
      setB2bInvoiceFile(null);
      setStatus({ tone: "danger", message: "The invoice PDF must be 4 MB or smaller." });
      return;
    }
    setB2bInvoiceFile(file);
    setStatus(null);
  }

  function markDirty() {
    setQuoteDirty(true);
    setQuote(null);
    setQuoteReceivedAt(null);
    setSelectedRateId("");
    setSelectedRateSnapshot(null);
    setStatus(null);
    setFieldErrors({});
  }

  function invalidateTaxExemptionReview() {
    setTaxExemption((current) => current.requested && current.documentReviewed
      ? { ...current, documentReviewed: false }
      : current);
  }

  function updateTaxExemption(patch: Partial<TaxExemptionState>) {
    setTaxExemption((current) => ({ ...current, ...patch }));
    markDirty();
  }

  function selectTaxExemptionCertificate(file: File | null) {
    if (!file) {
      setTaxExemptionCertificateFile(null);
      setTaxExemptionCertificateReference("");
      setTaxExemption((current) => ({ ...current, documentReviewed: false }));
      markDirty();
      return;
    }
    const extension = file.name.toLowerCase().split(".").pop() || "";
    if (!["pdf", "png", "jpg", "jpeg"].includes(extension)) {
      setStatus({ tone: "danger", message: "Select a PDF, PNG, JPG, or JPEG exemption certificate." });
      return;
    }
    if (!file.size || file.size > MAX_TAX_EXEMPTION_CERTIFICATE_BYTES) {
      setStatus({ tone: "danger", message: "The exemption certificate must be 2 MB or smaller." });
      return;
    }
    setTaxExemptionCertificateFile(file);
    setTaxExemptionCertificateReference("");
    setTaxExemption((current) => ({ ...current, documentReviewed: false }));
    setStatus(null);
    markDirty();
  }

  function updateCustomer(key: keyof typeof customer, value: string) {
    setCustomer((current) => ({ ...current, [key]: value }));
    invalidateTaxExemptionReview();
    markDirty();
  }

  function updateAddress(key: keyof ManualOrderAddress, value: string) {
    setAddress((current) => ({ ...current, [key]: key === "state" || key === "country" ? value.toUpperCase() : value }));
    if (key === "state") {
      setTaxExemption((current) => ({ ...current, jurisdiction: value.toUpperCase(), documentReviewed: false }));
    } else {
      invalidateTaxExemptionReview();
    }
    setAddressVerification({ status: "idle", fingerprint: "", suggestion: null, message: "Address changed. Verify it before getting carrier rates." });
    markDirty();
  }

  function patchItemRow(itemId: string, patch: Partial<OrderItemRow>) {
    setItemRows((current) => current.map((row) => {
      if (row.id !== itemId) return row;
      const next = { ...row, ...patch };
      const product = getProduct(products, next.productSlug);
      if (!product.sizes.includes(next.size)) next.size = product.defaultSize;
      if (!product.bundles.some((bundle) => bundle.id === next.bundleId)) {
        const fallback = product.bundles[0];
        next.bundleId = fallback.id;
        next.unit = fallback.kind;
      }
      return next;
    }));
    markDirty();
  }

  function addItemRow() {
    setItemRows((current) => [...current, { ...makeOrderItemRow(current.length, products[0], "box"), quantity: 1 }]);
    markDirty();
  }

  function removeItemRow(itemId: string) {
    setItemRows((current) => current.filter((row) => row.id !== itemId));
    markDirty();
  }

  function sellableBoxesForRow(row: OrderItemRow) {
    const inventory = inventoryAvailability[row.productSlug]?.[row.size];
    if (!inventory?.tracked) return null;
    return (inventory.boxAvailable ?? 0) + (inventory.caseAvailable ?? 0) * Math.max(1, inventory.boxesPerCase || 10);
  }

  function maxQuantityForRow(row: OrderItemRow) {
    const inventory = inventoryAvailability[row.productSlug]?.[row.size];
    const sellableBoxes = sellableBoxesForRow(row);
    if (!inventory?.tracked || sellableBoxes == null) return undefined;
    const boxesPerCase = Math.max(1, inventory.boxesPerCase || 10);
    const otherDemand = itemRows.reduce((sum, item) => {
      if (item.id === row.id || item.productSlug !== row.productSlug || item.size !== row.size) return sum;
      const product = getProduct(products, item.productSlug);
      const bundle = getSelectedBundle(product, item);
      const boxesPerBundle = bundle.kind === "case" ? bundle.units * boxesPerCase : bundle.units;
      return sum + Math.max(0, Math.floor(item.quantity || 0)) * boxesPerBundle;
    }, 0);
    const remainingBoxes = Math.max(0, sellableBoxes - otherDemand);
    const product = getProduct(products, row.productSlug);
    const bundle = getSelectedBundle(product, row);
    const boxesPerBundle = bundle.kind === "case" ? bundle.units * boxesPerCase : bundle.units;
    return Math.floor(remainingBoxes / Math.max(1, boxesPerBundle));
  }

  function backendFulfillment(): BackendFulfillmentMethod {
    if (fulfillmentMethod === "pickup") return "pickup";
    if (fulfillmentMethod === "carrier") return quote?.freeDelivery?.applied && !quoteDirty ? "local_delivery" : "carrier";
    if (fulfillmentMethod === "b2b_shipping") return "b2b_shipping";
    return "local_delivery";
  }

  function buildAddress() {
    if (fulfillmentMethod === "pickup") return pickupAddress;
    return {
      ...address,
      state: address.state.trim().toUpperCase(),
      country: "US",
    };
  }

  function manualDiscountPayload() {
    if (discountMode === "code" && discountCodeCheck?.status === "valid") {
      return {
        manualDiscountType: "none" as const,
        manualDiscountValue: 0,
        discountCode: discountCodeCheck.code,
      };
    }
    if (discountMode === "percent_5") return { manualDiscountType: "percent" as const, manualDiscountValue: 5 };
    if (discountMode === "percent_10") return { manualDiscountType: "percent" as const, manualDiscountValue: 10 };
    if (discountMode === "percent_15") return { manualDiscountType: "percent" as const, manualDiscountValue: 15 };
    if (discountMode === "custom_percent") {
      return { manualDiscountType: "percent" as const, manualDiscountValue: Math.round(Number(customDiscountValue)) };
    }
    if (discountMode === "custom_amount") {
      return { manualDiscountType: "amount" as const, manualDiscountValue: parseDollarsToCents(customDiscountValue) };
    }
    return { manualDiscountType: "none" as const, manualDiscountValue: 0 };
  }

  function taxExemptionReviewIssues() {
    const issues: string[] = [];
    const shippingState = address.state.trim().toUpperCase();
    if (!customer.name.trim()) issues.push("Enter the customer name.");
    if (!customer.email.trim() || !customer.email.includes("@")) issues.push("Enter a valid customer email.");
    if (!shippingState) issues.push("Select the shipping state.");
    if (!taxExemption.exemptionType) issues.push("Select the exemption type.");
    if (!taxExemption.jurisdiction) {
      issues.push("Select the certificate jurisdiction.");
    } else if (shippingState && taxExemption.jurisdiction !== shippingState) {
      issues.push("Make the certificate jurisdiction match the shipping state.");
    }
    if (!taxExemptionCertificateSelected) issues.push("Upload the buyer's exemption certificate.");
    if (taxExemption.exemptionType === "other" && taxExemption.internalNote.trim().length < 10) {
      issues.push("Add a manual-review note explaining the exemption.");
    }
    if (taxExemption.effectiveDate && taxExemption.expirationDate && taxExemption.expirationDate < taxExemption.effectiveDate) {
      issues.push("Correct the certificate dates; expiration cannot be before the effective date.");
    }
    return issues;
  }

  function handleTaxExemptionReview(checked: boolean) {
    if (!checked) {
      updateTaxExemption({ documentReviewed: false });
      return;
    }
    const issues = taxExemptionReviewIssues();
    if (issues.length) {
      setTaxReviewWarning(issues);
      setFieldErrors((current) => ({ ...current, taxExemption: issues[0] }));
      return;
    }
    setTaxReviewWarning(null);
    updateTaxExemption({ documentReviewed: true });
  }

  function validateRemoteOrder(forCreate = false) {
    const errors: Record<string, string> = {};
    if (mode !== "remote") errors.mode = "Switch to Remote order to use this flow.";
    if (!customer.name.trim()) errors.customerName = "Customer name is required.";
    if (!customer.email.trim() || !customer.email.includes("@")) errors.customerEmail = "A valid email is required.";
    if (customer.phone.trim() && normalizePhone(customer.phone).length < 10) errors.customerPhone = "Enter at least 10 digits.";
    if (!selectedItems.length) errors.products = "Add at least one item with a quantity.";
    itemRows.forEach((row, index) => {
      const quantity = Math.max(0, Math.floor(row.quantity || 0));
      if (!quantity) return;
      const max = maxQuantityForRow(row);
      if (max != null && quantity > max) {
        errors[`item-${row.id}`] = `Item ${index + 1} exceeds the shared stock available for this product and size.`;
      }
      if (fulfillmentMethod === "b2b_shipping" && row.pricingMode === "negotiated") {
        const negotiatedCents = parseDollarsToCents(row.negotiatedUnitPrice);
        if (negotiatedCents < 1 || negotiatedCents > 10_000_000) {
          errors[`item-${row.id}`] = `Item ${index + 1} needs a negotiated unit price between $0.01 and $100,000.00.`;
        } else if (row.negotiationReason.trim().length < 3) {
          errors[`item-${row.id}`] = `Item ${index + 1} needs a short negotiation reason.`;
        }
      }
    });

    if (discountMode === "code") {
      const normalized = normalizeAdminDiscountCode(discountCode);
      if (!normalized) {
        errors.discount = "Enter the discount code.";
      } else if (discountCodeCheck?.status !== "valid" || discountCodeCheck.code !== normalized) {
        errors.discount = "Verify this discount code before calculating totals.";
      }
    }
    if (discountMode === "custom_percent") {
      const percent = Math.round(Number(customDiscountValue));
      if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
        errors.discount = "Enter a custom percentage from 1 to 100.";
      }
    }
    if (discountMode === "custom_amount" && parseDollarsToCents(customDiscountValue) < 1) {
      errors.discount = "Enter a custom dollar amount greater than $0.00.";
    }
    if (discountMode !== "none" && previewTotals.volumePricingBlocksDiscount) {
      errors.discount = previewTotals.negotiatedPricingApplied
        ? "Negotiated B2B prices cannot be combined with another discount."
        : "This automatic volume price cannot be combined with another discount.";
    }

    if (fulfillmentMethod === "carrier" || fulfillmentMethod === "b2b_shipping") {
      if (!address.line1.trim()) errors.addressLine1 = "Street address is required.";
      if (!address.city.trim()) errors.addressCity = "City is required.";
      if (!address.state.trim()) errors.addressState = "State is required.";
      if (address.postalCode.replace(/\D/g, "").length < 5) errors.addressZip = "ZIP is required.";
    }
    if (fulfillmentMethod === "carrier" && forCreate && !quote?.freeDelivery?.applied && addressVerification.fingerprint !== addressFingerprint(buildAddress())) {
      errors.addressVerification = "Verify the current address before getting carrier rates.";
    } else if (fulfillmentMethod === "carrier" && forCreate && !quote?.freeDelivery?.applied && addressVerification.status !== "verified") {
      errors.addressVerification = "Use the suggested address or verify the current address before getting carrier rates.";
    }
    if (fulfillmentMethod === "carrier" && forCreate && !quote?.freeDelivery?.applied && !selectedRateId) {
      errors.carrierRate = "Select a carrier rate before creating the order.";
    }
    if (fulfillmentMethod === "b2b_shipping") {
      const freightCents = parseDollarsToCents(customB2bShipping);
      if (freightCents < 1 || freightCents > 10_000_000) {
        errors.b2b = "Enter a B2B freight charge between $0.01 and $100,000.00.";
      }
    }
    if (forCreate && !paymentOptionsForFulfillment(fulfillmentMethod).some((option) => option.value === paymentMethod)) {
      errors.payment = "Select a payment method available for this fulfillment method.";
    }
    if (taxExemption.requested) {
      if (!taxExemption.exemptionType) errors.taxExemption = "Select the exemption type.";
      else if (!taxExemption.jurisdiction) errors.taxExemption = "Select the certificate jurisdiction.";
      else if (taxExemption.jurisdiction !== address.state.trim().toUpperCase()) errors.taxExemption = "The certificate jurisdiction must match the current shipping state.";
      else if (!taxExemptionCertificateSelected) errors.taxExemption = "Upload the buyer's exemption certificate before removing tax.";
      else if (!taxExemption.documentReviewed) errors.taxExemption = "Confirm that an administrator reviewed the certificate before removing tax.";
      else if (taxExemption.exemptionType === "other" && taxExemption.internalNote.trim().length < 10) errors.taxExemption = "Add a manual-review note describing this exemption.";
      else if (taxExemption.effectiveDate && taxExemption.expirationDate && taxExemption.expirationDate < taxExemption.effectiveDate) errors.taxExemption = "The certificate expiration date cannot be before its effective date.";
    }

    setFieldErrors(errors);
    const first = Object.values(errors)[0] || "";
    if (first) setStatus({ tone: "danger", message: first });
    return first;
  }

  function taxExemptionPayload(): ManualOrderTaxExemptionRequest | undefined {
    if (!taxExemption.requested) return undefined;
    return {
      requested: true,
      exemptionType: taxExemption.exemptionType,
      jurisdiction: taxExemption.jurisdiction,
      certificateNumber: taxExemption.certificateNumber.trim(),
      effectiveDate: taxExemption.effectiveDate || null,
      expirationDate: taxExemption.expirationDate || null,
      internalNote: taxExemption.internalNote.trim(),
      documentReviewed: taxExemption.documentReviewed,
      certificateSelected: taxExemptionCertificateSelected,
    };
  }

  function buildEstimateRequest(includeSelectedRate = true) {
    const base = {
      name: customer.name.trim(),
      email: customer.email.trim(),
      phone: normalizePhone(customer.phone),
      address: buildAddress(),
      items: selectedItems,
      fulfillmentMethod: backendFulfillment(),
      ...(fulfillmentMethod === "b2b_shipping"
        ? { manualB2bShippingCents: parseDollarsToCents(customB2bShipping) }
        : {}),
      localDeliveryNote: fulfillmentMethod === "local_delivery" || quote?.freeDelivery?.applied ? deliveryNote.trim() : "",
      ...manualDiscountPayload(),
      ...(taxExemption.requested ? { taxExemption: taxExemptionPayload() } : {}),
      ...(includeSelectedRate && quote?.quoteToken ? { quoteToken: quote.quoteToken } : {}),
    };
    if (includeSelectedRate && selectedRate) {
      return {
        ...base,
        selectedShippingRateObjectId: selectedRate.id,
        selectedShippingServiceCode: selectedRate.serviceCode,
        selectedShippingServiceLabel: selectedRate.serviceLabel,
        selectedShippingProvider: selectedRate.provider,
        selectedShippingAmountCents: selectedRate.amountCents,
        selectedShippingParcelCount: selectedRate.parcelCount,
        selectedShippingResidentialSurchargeCents: selectedRate.residentialSurchargeCents,
      };
    }
    return base;
  }

  async function handleVerifyDiscountCode() {
    const normalized = normalizeAdminDiscountCode(discountCode);
    setDiscountCodeCheck(null);
    if (!/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(normalized)) {
      const message = "Enter a valid discount code.";
      setDiscountCodeCheck({ code: normalized, status: "invalid", message });
      setFieldErrors((current) => ({ ...current, discount: message }));
      return;
    }
    try {
      const token = await auth.getAccessToken();
      const data = await fetchDiscountCodes(token);
      const found = (data.codes || []).find((row) => normalizeAdminDiscountCode(row.code || "") === normalized);
      const message = !found
        ? "That discount code is not valid."
        : found.is_used
          ? "This discount code has already been used."
          : `Discount code verified: ${Number(found?.percent_off || DEFAULT_DISCOUNT_PERCENT)}% off.`;
      const status = found && !found.is_used ? "valid" : "invalid";
      setDiscountCodeCheck({ code: normalized, status, message, percent: status === "valid" ? Number(found?.percent_off || DEFAULT_DISCOUNT_PERCENT) : undefined });
      setFieldErrors((current) => {
        const next = { ...current };
        if (status === "valid") delete next.discount;
        else next.discount = message;
        return next;
      });
      setStatus({ tone: status === "valid" ? "success" : "danger", message });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not verify discount code.";
      setDiscountCodeCheck({ code: normalized, status: "invalid", message });
      setStatus({ tone: "danger", message });
    }
  }

  async function handleVerifyAddress() {
    const nextErrors: Record<string, string> = {};
    if (!address.line1.trim()) nextErrors.addressLine1 = "Street address is required.";
    if (!address.city.trim()) nextErrors.addressCity = "City is required.";
    if (!address.state.trim()) nextErrors.addressState = "State is required.";
    if (address.postalCode.replace(/\D/g, "").length < 5) nextErrors.addressZip = "ZIP is required.";
    if (Object.keys(nextErrors).length) {
      setFieldErrors((current) => ({ ...current, ...nextErrors }));
      setAddressVerification({ status: "invalid", fingerprint: "", suggestion: null, message: "Complete the address before verifying it." });
      setStatus({ tone: "danger", message: "Complete the address before verifying it." });
      return;
    }

    setBusy("verify-address");
    setStatus(null);
    setFieldErrors((current) => {
      const next = { ...current };
      delete next.addressLine1;
      delete next.addressCity;
      delete next.addressState;
      delete next.addressZip;
      delete next.addressVerification;
      return next;
    });
    try {
      const token = await auth.getAccessToken();
      const result = await verifyManualOrderAddress(buildAddress(), token);
      const suggestion = result.addressSuggestion || null;
      if (suggestion) {
        setAddressVerification({
          status: "suggested",
          fingerprint: addressFingerprint(buildAddress()),
          suggestion,
          message: result.message || "A deliverable address correction is available.",
        });
        setStatus(null);
        return;
      }
      if (!result.verified) {
        const message = result.message || "This address could not be verified.";
        setAddressVerification({ status: "invalid", fingerprint: addressFingerprint(buildAddress()), suggestion: null, message });
        setFieldErrors((current) => ({ ...current, ...(result.fieldErrors || {}) }));
        setStatus({ tone: "danger", message });
        return;
      }
      const verifiedAddress = result.normalizedAddress || buildAddress();
      if (addressFingerprint(verifiedAddress) !== addressFingerprint(buildAddress())) invalidateTaxExemptionReview();
      setAddress(verifiedAddress);
      setAddressVerification({
        status: "verified",
        fingerprint: addressFingerprint(verifiedAddress),
        suggestion: null,
        message: "Address verified. You can now get carrier rates.",
      });
      setStatus({ tone: "success", message: "Address verified. You can now get carrier rates." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not verify the address.";
      const payload = error instanceof ApiError ? error.payload : {};
      const suggestion = payload.addressSuggestion as ManualOrderAddress | undefined;
      if (suggestion) {
        setAddressVerification({ status: "suggested", fingerprint: addressFingerprint(buildAddress()), suggestion, message });
        setStatus(null);
      } else {
        setAddressVerification({ status: "invalid", fingerprint: addressFingerprint(buildAddress()), suggestion: null, message });
        setStatus({ tone: "danger", message });
      }
    } finally {
      setBusy(null);
    }
  }

  function useSuggestedAddress() {
    const suggestion = addressVerification.suggestion;
    if (!suggestion) return;
    if (addressFingerprint(suggestion) !== addressFingerprint(buildAddress())) invalidateTaxExemptionReview();
    setAddress(suggestion);
    setAddressVerification({
      status: "verified",
      fingerprint: addressFingerprint(suggestion),
      suggestion: null,
      message: "Suggested address accepted. You can now get carrier rates.",
    });
    setQuote(null);
    setSelectedRateId("");
    setSelectedRateSnapshot(null);
    setQuoteDirty(true);
    setStatus({ tone: "success", message: "Suggested address accepted. You can now get carrier rates." });
    setFieldErrors((current) => {
      const next = { ...current };
      delete next.addressVerification;
      return next;
    });
  }

  async function handleEstimate(options: { refreshCarrierRates?: boolean; quiet?: boolean; scrollToRates?: boolean } = {}) {
    const validation = validateRemoteOrder(false);
    if (validation) return null;
    shouldScrollToRatesRef.current = options.scrollToRates === true;
    setBusy("estimate");
    if (options.refreshCarrierRates) setIsCarrierRatesRefreshing(true);
    if (!options.quiet) setStatus(null);
    try {
      const token = await auth.getAccessToken();
      const estimateRequest = buildEstimateRequest(!options.refreshCarrierRates);
      const nextQuote = await estimateManualOrder(estimateRequest, token);
      const nextCarrierRates = (nextQuote.shippingRateOptions || []).filter((rate) => String(rate.provider || "").toLowerCase() !== "local");
      if (!nextCarrierRates.length) {
        shouldScrollToRatesRef.current = false;
      }
      setQuote(nextQuote);
      setQuoteReceivedAt(Date.now());
      setQuoteDirty(false);
      if (options.refreshCarrierRates) {
        setSelectedRateId("");
        setSelectedRateSnapshot(null);
      }
      if (options.refreshCarrierRates) {
        setStatus(null);
      } else if (fulfillmentMethod === "carrier" && !selectedRateId && nextCarrierRates.length) {
        setStatus(null);
      } else if (nextQuote.freeDelivery?.applied) {
        setStatus({ tone: "success", message: "This address qualifies for free local delivery. Shippo was not contacted." });
      } else if (nextQuote.userFacingError) {
        setStatus({ tone: "danger", message: nextQuote.userFacingError });
      } else {
        setStatus({
          tone: "success",
          message: fulfillmentMethod === "carrier"
            ? "Carrier rates are ready. Select the service to use."
            : "Totals checked. This order is ready to create.",
        });
      }
      return nextQuote;
    } catch (error) {
      const freshRates = shippingRateOptionsFromError(error);
      if (freshRates?.length && fulfillmentMethod === "carrier") {
        setQuote((current) => ({
          ...(current || {}),
          shippingRateOptions: freshRates,
          userFacingError: "",
        }));
        setQuoteReceivedAt(Date.now());
        setQuoteDirty(false);
        setSelectedRateId("");
        setSelectedRateSnapshot(null);
        setStatus(null);
        return null;
      }
      setStatus({ tone: "danger", message: error instanceof Error ? error.message : "Could not calculate totals." });
      shouldScrollToRatesRef.current = false;
      return null;
    } finally {
      if (options.refreshCarrierRates) setIsCarrierRatesRefreshing(false);
      setBusy(null);
    }
  }

  useEffect(() => {
    if (fulfillmentMethod !== "carrier" || mode !== "remote" || busy || quoteDirty || !quoteReceivedAt) return;
    const carrierRates = (quote?.shippingRateOptions || []).filter((rate) => String(rate.provider || "").toLowerCase() !== "local");
    if (!carrierRates.length || quote?.freeDelivery?.applied) return;

    const remainingMs = Math.max(0, CARRIER_RATE_AUTO_REFRESH_MS - (Date.now() - quoteReceivedAt));
    const timer = window.setTimeout(() => {
      void handleEstimate({ refreshCarrierRates: true, quiet: true });
    }, remainingMs);

    return () => window.clearTimeout(timer);
  }, [busy, fulfillmentMethod, mode, quote, quoteDirty, quoteReceivedAt]);

  async function handleCreateAndSend() {
    const validation = validateRemoteOrder(true);
    if (validation) return;
    let invoiceAttachment: ManualOrderInvoiceAttachment | undefined;
    let taxExemptionCertificate: ManualOrderTaxExemptionCertificate | undefined;
    if (taxExemption.requested && taxExemptionCertificateFile) {
      try {
        taxExemptionCertificate = await readTaxExemptionCertificate(taxExemptionCertificateFile);
      } catch (error) {
        setStatus({ tone: "danger", message: error instanceof Error ? error.message : "The exemption certificate could not be read." });
        return;
      }
    }
    if (fulfillmentMethod === "b2b_shipping" && paymentMethod === "square_payment_link" && b2bInvoiceFile) {
      try {
        invoiceAttachment = await readB2bInvoicePdf(b2bInvoiceFile);
      } catch (error) {
        setStatus({ tone: "danger", message: error instanceof Error ? error.message : "The invoice PDF could not be read." });
        return;
      }
    }
    setBusy("send");
    setStatus({ tone: "muted", message: editOrderId ? "Saving order changes..." : "Creating draft order..." });
    try {
      const token = await auth.getAccessToken();
      const paymentFlow = paymentMethod === "square_payment_link" ? "square_payment_link" : "pay_later";
      const request: ManualOrderCreateRequest = {
        ...buildEstimateRequest(),
        paymentFlow,
        manualPaymentMethod: paymentMethod === "arrival_payment_link" ? "arrival_payment_link" : null,
        shipmentDate: shipmentDate || null,
        ...(taxExemptionCertificate ? { taxExemptionCertificate } : {}),
        ...(taxExemption.requested && !taxExemptionCertificate && taxExemptionCertificateReference ? { taxExemptionCertificateReference } : {}),
        ...(editOrderId && editOriginalDiscountCode && discountMode === "code" &&
        discountCodeCheck?.status === "valid" && discountCodeCheck.code === editOriginalDiscountCode
          ? { preserveExistingDiscountCode: true }
          : {}),
      };
      const created = editOrderId
        ? await updateManualOrderDraft({ ...request, orderId: editOrderId }, token)
        : await createManualOrder(request, token);
      const orderId = String(created.orderId || "").trim();
      if (!orderId) {
        throw new Error("The order may have been created, but no order ID was returned. Check Orders before retrying.");
      }

      if (paymentFlow === "pay_later") {
        setQuoteDirty(false);
        setStatus({
          tone: "success",
          message:
            paymentMethod === "arrival_payment_link"
              ? `Arrival-link order created for ${created.orderRef || orderId}.`
              : `Pay-later order created for ${created.orderRef || orderId}.`,
        });
        navigate("/orders", { state: { openOrderId: orderId, orderCreated: !editOrderId } });
        return;
      }

      setStatus({ tone: "muted", message: editOrderId ? "Changes saved. Creating a new Square payment link..." : "Draft created. Creating Square payment link..." });
      const selectedRatePayload = buildEstimateRequest();
      const sent = await sendManualOrderLink({
        ...selectedRatePayload,
        orderId,
        shipmentDate: shipmentDate || null,
        ...(invoiceAttachment ? { invoiceAttachment } : {}),
      }, token);
      setQuoteDirty(false);
      setStatus({
        tone: sent.warning ? "warning" : "success",
        message:
          sent.warning ||
          `Payment link ${sent.emailed ? "emailed" : "created"}${sent.emailed && invoiceAttachment ? " with invoice attached" : ""} for ${created.orderRef || orderId}.`,
      });
      if (sent.checkoutUrl) {
        setQuote((current) => ({ ...(current || {}), totalFormatted: created.totalFormatted || current?.totalFormatted }));
      }
      navigate("/orders", { state: { openOrderId: orderId, orderCreated: !editOrderId } });
    } catch (error) {
      const freshRates = shippingRateOptionsFromError(error);
      if (freshRates && fulfillmentMethod === "carrier") {
        setQuote((current) => ({
          ...(current || {}),
          shippingRateOptions: freshRates,
        }));
        setQuoteDirty(false);
        setQuoteReceivedAt(Date.now());
        setSelectedRateId("");
        setSelectedRateSnapshot(null);
      }
      setStatus({ tone: "danger", message: error instanceof Error ? error.message : "Could not create the order." });
    } finally {
      setBusy(null);
    }
  }

  const statusClass =
    status?.tone === "success"
      ? "bg-sg-success-soft text-sg-success"
      : status?.tone === "danger"
        ? "bg-sg-danger-soft text-sg-danger"
        : status?.tone === "warning"
          ? "bg-sg-amber-soft text-sg-amber"
          : "bg-sg-input-bg text-sg-muted";
  const actionsDisabled = busy !== null || mode !== "remote" || !editDraftLoaded;
  const automaticFreeLocalDelivery = fulfillmentMethod === "carrier" && quote?.freeDelivery?.applied === true;
  const availablePaymentOptions = paymentOptionsForFulfillment(fulfillmentMethod);
  const displayQuote = quoteDirty || (fulfillmentMethod === "carrier" && Boolean(selectedRateId)) ? null : quote;
  const summaryWarnings = visibleQuoteWarnings(quote);
  const visibleCarrierRates = (quote?.shippingRateOptions || []).filter((rate) => String(rate.provider || "").toLowerCase() !== "local");
  const hasVisibleCarrierRates = fulfillmentMethod === "carrier" && visibleCarrierRates.length > 0;
  const carrierQuoteUnavailable = fulfillmentMethod === "carrier" && !automaticFreeLocalDelivery && Boolean(quote?.userFacingError);
  const carrierRateRequired = fulfillmentMethod === "carrier" && !automaticFreeLocalDelivery && !selectedRateId;
  const showAddressFields = fulfillmentMethod !== "pickup";
  const addressRequired = fulfillmentMethod === "carrier" || fulfillmentMethod === "b2b_shipping";
  const addressVerifiedCurrent =
    fulfillmentMethod !== "carrier" ||
    automaticFreeLocalDelivery ||
    (addressVerification.status === "verified" && addressVerification.fingerprint === addressFingerprint(buildAddress()));
  const createReadinessMessage = !selectedItems.length
    ? "Select at least one product before creating the order."
    : fulfillmentMethod === "carrier" && !addressVerifiedCurrent
      ? "Verify the current address before getting carrier rates."
    : carrierQuoteUnavailable
      ? "Refresh carrier rates before creating the order."
    : carrierRateRequired
      ? "Select a carrier rate before creating the order."
        : quoteDirty
          ? fulfillmentMethod === "carrier"
            ? "Get current carrier rates before creating the order."
            : "Check totals before creating the order."
        : "";
  const createDisabled = actionsDisabled || Boolean(createReadinessMessage);
  const displayedRowPricing = priceOrderRows(itemRows, products, fulfillmentMethod === "b2b_shipping");
  const catalogRowPricing = priceOrderRows(itemRows, products, false);

  useEffect(() => {
    if (!hasVisibleCarrierRates || !shouldScrollToRatesRef.current) return;
    shouldScrollToRatesRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      carrierRatesRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [hasVisibleCarrierRates, quoteReceivedAt]);

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-4xl font-bold">{editOrderId ? "Edit expired order" : "Order Builder"}</h1>
          <p className="mt-1 text-[15px] text-sg-muted">
            {editOrderId
              ? `Update ${editOrderRef || editOrderId}, recalculate shipping, and send a fresh payment link.`
              : "Build call-in orders with backend pricing, discounts, fulfillment, and payment handoff."}
          </p>
        </div>
        <div className="flex rounded-full border border-sg-border bg-sg-input-bg p-1">
          <button type="button" className={modeButtonClass(mode === "remote")} onClick={() => setMode("remote")}>
            Remote order
          </button>
        </div>
      </section>

      {mode === "walk-in" ? (
        <section className="sg25-card p-5">
          <h2 className="text-lg font-bold">Walk-in Sale</h2>
          <p className="mt-2 text-[13px] leading-5 text-sg-muted">
            Walk-in checkout is paused for this pass. The production flow is still available while remote order integration is completed in v2.5.
          </p>
          <a className="sg25-btn sg25-btn-ghost mt-4" href="/admin-v2.5/order-builder">
            Open current Walk-in Sale
          </a>
        </section>
      ) : null}

      <section className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-4">
          <section className="sg25-card order-1 p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <Icon name="tag" className="h-4 w-4 text-sg-primary" />
              <h2 className="text-lg font-bold">Customer</h2>
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              <Field label="Customer name" value={customer.name} onChange={(value) => updateCustomer("name", value)} placeholder="Buyer name" required error={fieldErrors.customerName} />
              <Field label="Email" value={customer.email} onChange={(value) => updateCustomer("email", value)} placeholder="customer@email.com" type="email" required error={fieldErrors.customerEmail} />
              <Field label="Phone" value={customer.phone} onChange={(value) => updateCustomer("phone", value)} placeholder="Optional" error={fieldErrors.customerPhone} />
            </div>
            <div className="mt-5 border-t border-sg-border pt-4">
              <label className={`flex cursor-pointer items-start gap-3 rounded-[10px] border p-3 transition ${taxExemption.requested ? "border-sg-primary bg-sg-primary-soft/45" : "border-sg-border bg-white hover:border-sg-primary/40"}`}>
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-sg-primary"
                  checked={taxExemption.requested}
                  aria-expanded={taxExemption.requested}
                  onChange={(event) => {
                    if (event.target.checked) {
                      updateTaxExemption({ requested: true, jurisdiction: address.state.trim().toUpperCase() || taxExemption.jurisdiction });
                      return;
                    }
                    setTaxExemption({ ...initialTaxExemption, jurisdiction: address.state.trim().toUpperCase() || "TN" });
                    setTaxExemptionCertificateFile(null);
                    setTaxExemptionCertificateReference("");
                    setTaxReviewWarning(null);
                    markDirty();
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] font-bold text-sg-text">Apply tax exemption</span>
                    {taxExemption.requested ? (
                      <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${taxExemptionReady ? "bg-sg-success-soft text-sg-success" : "bg-white text-sg-muted"}`}>
                        {taxExemptionReady ? "Reviewed" : "Needs review"}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-sg-muted">Optional · use only when the buyer supplied a qualifying certificate.</span>
                </span>
              </label>

            {taxExemption.requested ? (
              <div className="mt-3 space-y-4 rounded-[10px] border border-sg-border bg-sg-input-bg/45 p-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block min-w-0">
                    <span className="text-[12px] font-semibold text-sg-muted">Exemption type<span className="ml-0.5 text-sg-danger">*</span></span>
                    <CustomSelect
                      value={taxExemption.exemptionType}
                      options={taxExemptionTypeOptions}
                      onChange={(value) => updateTaxExemption({ exemptionType: value as TaxExemptionType, documentReviewed: false })}
                      ariaLabel="Tax exemption type"
                      className="mt-2 w-full"
                      triggerClassName="h-10 rounded-[7px] bg-white px-2.5 text-[13px]"
                      panelClassName="left-0 right-auto"
                    />
                  </label>
                  <label className="block min-w-0">
                    <span className="text-[12px] font-semibold text-sg-muted">Certificate jurisdiction<span className="ml-0.5 text-sg-danger">*</span></span>
                    <CustomSelect
                      value={taxExemption.jurisdiction}
                      options={usStateOptions}
                      onChange={(value) => updateTaxExemption({ jurisdiction: value, documentReviewed: false })}
                      ariaLabel="Certificate jurisdiction"
                      className="mt-2 w-full"
                      triggerClassName="h-10 rounded-[7px] bg-white px-2.5 text-[13px]"
                      panelClassName="left-0 right-auto max-h-72 overflow-y-auto"
                    />
                  </label>
                  <Field label="Certificate number" value={taxExemption.certificateNumber} onChange={(value) => updateTaxExemption({ certificateNumber: value, documentReviewed: false })} placeholder="Optional reference number" />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Effective date" value={taxExemption.effectiveDate} onChange={(value) => updateTaxExemption({ effectiveDate: value, documentReviewed: false })} placeholder="" type="date" />
                    <Field label="Expiration date" value={taxExemption.expirationDate} onChange={(value) => updateTaxExemption({ expirationDate: value, documentReviewed: false })} placeholder="" type="date" />
                  </div>
                </div>
                <TextAreaField
                  label={taxExemption.exemptionType === "other" ? "Manual-review note (required)" : "Internal exemption note"}
                  value={taxExemption.internalNote}
                  onChange={(value) => updateTaxExemption({ internalNote: value, documentReviewed: false })}
                  placeholder="Why this certificate applies to this order"
                />

                <div>
                  <p className="text-[12px] font-semibold text-sg-muted">Certificate document<span className="ml-0.5 text-sg-danger">*</span></p>
                  <p className="mt-0.5 text-[10px] text-sg-muted">PDF, PNG, or JPEG · maximum 2 MB · stored privately</p>
                </div>
                <input
                  ref={taxExemptionInputRef}
                  type="file"
                  accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg"
                  className="sr-only"
                  onChange={(event) => {
                    selectTaxExemptionCertificate(event.target.files?.[0] || null);
                    event.currentTarget.value = "";
                  }}
                />
                {taxExemptionCertificateFile || taxExemptionCertificateReference ? (
                  <div className="flex flex-col gap-2 rounded-[9px] border border-sg-success/30 bg-sg-success-soft px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate text-[12px] font-bold text-sg-text">{taxExemptionCertificateFile?.name || "Saved private certificate"}</p>
                      <p className="mt-0.5 text-[11px] text-sg-muted">{taxExemptionCertificateFile ? `${(taxExemptionCertificateFile.size / 1024).toFixed(0)} KB · Ready for private upload` : "Stored privately with this order"}</p>
                    </div>
                    <button type="button" className="sg25-btn sg25-btn-secondary shrink-0" onClick={() => selectTaxExemptionCertificate(null)}>
                      <Icon name="x" className="h-4 w-4" /> Remove
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={`flex w-full flex-col items-center justify-center rounded-[9px] border border-dashed px-4 py-6 text-center transition ${taxExemptionDragActive ? "border-sg-primary bg-sg-primary-soft" : "border-sg-border bg-white hover:border-sg-primary/50 hover:bg-sg-primary-soft/30"}`}
                    onClick={() => taxExemptionInputRef.current?.click()}
                    onDragEnter={(event) => { event.preventDefault(); setTaxExemptionDragActive(true); }}
                    onDragOver={(event) => { event.preventDefault(); setTaxExemptionDragActive(true); }}
                    onDragLeave={(event) => { event.preventDefault(); setTaxExemptionDragActive(false); }}
                    onDrop={(event) => {
                      event.preventDefault();
                      setTaxExemptionDragActive(false);
                      selectTaxExemptionCertificate(event.dataTransfer.files?.[0] || null);
                    }}
                  >
                    <span className="text-[12px] font-bold text-sg-text">Drop the exemption certificate here</span>
                    <span className="mt-1 text-[11px] text-sg-muted">or click to choose a file</span>
                  </button>
                )}

                <label className="flex cursor-pointer items-start gap-3 rounded-[9px] border border-sg-border bg-white p-3">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-sg-primary"
                    checked={taxExemption.documentReviewed}
                    onChange={(event) => handleTaxExemptionReview(event.target.checked)}
                  />
                  <span className="text-[12px] font-semibold leading-5 text-sg-text">I reviewed the certificate and confirm it applies to this customer, shipping jurisdiction, products, and transaction.</span>
                </label>
                {fieldErrors.taxExemption ? <p className="text-[12px] font-semibold text-sg-danger">{fieldErrors.taxExemption}</p> : null}
              </div>
            ) : null}
            </div>
          </section>

          <section className="sg25-card order-3 overflow-hidden p-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3 px-4 pt-4 sm:px-5 sm:pt-5">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-sg-primary-soft text-sg-primary">
                  <Icon name="package" className="h-4 w-4" />
                </span>
                <div>
                  <h2 className="text-lg font-bold">Products</h2>
                  <p className="mt-0.5 text-[11px] text-sg-muted">Build the order one product line at a time.</p>
                </div>
              </div>
              <div className="flex items-center gap-2 px-4 pt-4 sm:px-5 sm:pt-5">
                <span className="rounded-full bg-sg-input-bg px-3 py-1 text-[12px] font-semibold text-sg-muted">{previewTotals.unitCount} units</span>
                <button type="button" className="sg25-btn sg25-btn-ghost h-9 px-3 text-[12px]" onClick={addItemRow}>
                  <span aria-hidden="true" className="text-base leading-none">+</span>
                  Add item
                </button>
              </div>
            </div>
            {fieldErrors.products ? <p className="mx-4 mt-3 text-[12px] font-semibold text-sg-danger sm:mx-5">{fieldErrors.products}</p> : null}
            <div className="mt-5 space-y-3 bg-sg-input-bg/35 p-4 sm:p-5">
              {itemRows.map((row, index) => {
                const product = getProduct(products, row.productSlug);
                const bundle = getSelectedBundle(product, row);
                const inventory = inventoryAvailability[row.productSlug]?.[row.size];
                const maxQuantity = maxQuantityForRow(row);
                const sellableBoxes = sellableBoxesForRow(row);
                const rowError = fieldErrors[`item-${row.id}`];
                return (
                  <article key={row.id} className={`relative rounded-[12px] border bg-white p-4 pl-5 shadow-[0_8px_24px_rgba(58,43,35,0.04)] ${rowError ? "border-sg-danger" : "border-sg-border"}`}>
                    <span className={`absolute bottom-2 left-2 top-2 w-0.5 overflow-hidden rounded-full ${rowError ? "bg-sg-danger" : product.colorClassName}`} />
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-sg-primary-soft text-[11px] font-bold text-sg-primary">{index + 1}</span>
                        <p className="text-[12px] font-bold text-sg-text">Product line</p>
                      </div>
                      <button
                        type="button"
                        className="flex h-8 w-8 items-center justify-center rounded-full text-sg-danger outline-none transition hover:bg-sg-danger-soft focus-visible:ring-2 focus-visible:ring-sg-danger/20"
                        onClick={() => removeItemRow(row.id)}
                        aria-label={`Remove item ${index + 1}`}
                        title="Remove product line"
                      >
                        <Icon name="trash" className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1.6fr)_minmax(130px,.8fr)_minmax(140px,.8fr)_170px]">
                      <label className="block min-w-0">
                        <span className="text-[11px] font-bold uppercase text-sg-muted">Product</span>
                        <CustomSelect
                          value={row.productSlug}
                          options={products.map((item) => ({ value: item.slug, label: item.name }))}
                          onChange={(value) => patchItemRow(row.id, { productSlug: value as ProductSlug })}
                          ariaLabel={`Item ${index + 1} product`}
                          triggerClassName="mt-1 h-11 w-full justify-between rounded-[10px] bg-sg-input-bg/60 px-3.5 text-[12px] font-semibold leading-5 hover:border-sg-primary/40 hover:bg-white"
                          panelClassName="left-0 right-auto rounded-[10px]"
                        />
                      </label>
                      <label className="block min-w-0">
                        <span className="text-[11px] font-bold uppercase text-sg-muted">Size</span>
                        <CustomSelect
                          value={row.size}
                          options={product.sizes.map((size) => ({ value: size, label: sizeLabel(size) }))}
                          onChange={(value) => patchItemRow(row.id, { size: value as SizeCode })}
                          ariaLabel={`Item ${index + 1} size`}
                          triggerClassName="mt-1 h-11 w-full justify-between rounded-[10px] bg-sg-input-bg/60 px-3.5 text-[12px] font-semibold leading-5 hover:border-sg-primary/40 hover:bg-white"
                          panelClassName="left-0 right-auto rounded-[10px]"
                        />
                      </label>
                      <label className="block min-w-0">
                        <span className="text-[11px] font-bold uppercase text-sg-muted">Unit</span>
                        <CustomSelect
                          value={bundle.id}
                          options={sortBundlesHierarchically(product.bundles).map((option) => ({ value: option.id, label: `${option.label} - ${formatUsdCents(option.priceCents)}` }))}
                          onChange={(value) => {
                            const nextBundle = product.bundles.find((option) => option.id === value) || product.bundles[0];
                            patchItemRow(row.id, { bundleId: nextBundle.id, unit: nextBundle.kind });
                          }}
                          ariaLabel={`Item ${index + 1} unit`}
                          triggerClassName="mt-1 h-11 w-full justify-between rounded-[10px] bg-sg-input-bg/60 px-3.5 text-[12px] font-semibold leading-5 hover:border-sg-primary/40 hover:bg-white"
                          panelClassName="left-0 right-auto rounded-[10px]"
                        />
                      </label>
                      <div className="min-w-0">
                        <span className="text-[11px] font-bold uppercase text-sg-muted">Quantity</span>
                        <Stepper
                          value={row.quantity}
                          max={maxQuantity}
                          onChange={(quantity) => patchItemRow(row.id, { quantity })}
                          ariaLabel={`Item ${index + 1} quantity`}
                          fill
                          size="md"
                          className="mt-1 h-11 w-full"
                        />
                      </div>
                    </div>
                    {fulfillmentMethod === "b2b_shipping" ? (
                      <div className="mt-3 rounded-[10px] border border-sg-border bg-sg-input-bg/45 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="text-[11px] font-bold uppercase text-sg-muted">B2B product price</p>
                            <p className="mt-0.5 text-[11px] text-sg-muted">Automatic catalog price: {formatUsdCents(Math.round((catalogRowPricing.lineTotals.get(row.id) || 0) / Math.max(1, row.quantity)))}/unit</p>
                          </div>
                          <div className="flex rounded-full bg-white p-1" role="group" aria-label={`Item ${index + 1} price type`}>
                            {(["catalog", "negotiated"] as const).map((pricingMode) => (
                              <button
                                key={pricingMode}
                                type="button"
                                aria-pressed={row.pricingMode === pricingMode}
                                className={priceModeButtonClass(row.pricingMode === pricingMode)}
                                onClick={() => patchItemRow(row.id, { pricingMode })}
                              >
                                {pricingMode === "catalog" ? "Catalog price" : "Negotiated price"}
                              </button>
                            ))}
                          </div>
                        </div>
                        {row.pricingMode === "negotiated" ? (
                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            <Field
                              label="Negotiated unit price"
                              value={row.negotiatedUnitPrice}
                              onChange={(value) => patchItemRow(row.id, { negotiatedUnitPrice: value })}
                              placeholder="e.g. 69.00"
                              compact
                            />
                            <Field
                              label="Reason / agreement note"
                              value={row.negotiationReason}
                              onChange={(value) => patchItemRow(row.id, { negotiationReason: value })}
                              placeholder="e.g. Contract price approved"
                              compact
                            />
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-sg-border pt-3 text-[11px]">
                      <span className={sellableBoxes === 0 ? "font-semibold text-sg-danger" : "text-sg-muted"}>
                        {sellableBoxes == null
                          ? "Inventory not capped"
                          : `${formatInteger(sellableBoxes)} sellable boxes · ${formatInteger(inventory?.caseAvailable ?? 0)} cartons + ${formatInteger(inventory?.boxAvailable ?? 0)} loose`}
                      </span>
                      <span className="rounded-full bg-sg-input-bg px-3 py-1 font-bold text-sg-text">Line total {formatUsdCents(displayedRowPricing.lineTotals.get(row.id) || 0)}</span>
                    </div>
                    {rowError ? <p className="mt-2 text-[11px] font-semibold text-sg-danger">{rowError}</p> : null}
                  </article>
                );
              })}
              <button type="button" className="sg25-btn sg25-btn-ghost w-full border-dashed" onClick={addItemRow}>
                <span aria-hidden="true" className="text-base leading-none">+</span>
                {itemRows.length ? "Add another item" : "Add item"}
              </button>
            </div>
          </section>

          <section className="sg25-card order-4 p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <Icon name="tag" className="h-4 w-4 text-sg-primary" />
              <div>
                <h2 className="text-lg font-bold">Discount</h2>
                <p className="mt-0.5 text-[12px] text-sg-muted">Choose a discount type, then enter only the details it needs.</p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-1 rounded-[9px] bg-sg-input-bg p-1 sm:grid-cols-4" role="group" aria-label="Discount type">
              {discountCategoryOptions.map((option) => {
                const selected = discountCategoryForMode(discountMode) === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={selected}
                    className={`min-h-10 rounded-[7px] px-3 text-[12px] font-bold transition ${selected ? "bg-white text-sg-primary shadow-sm" : "text-sg-muted hover:bg-white/70 hover:text-sg-text"}`}
                    onClick={() => {
                      setDiscountMode(option.value === "percent" ? "percent_5" : option.value === "amount" ? "custom_amount" : option.value);
                      markDirty();
                    }}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            {discountCategoryForMode(discountMode) === "percent" ? (
              <div className="mt-4 rounded-[9px] border border-sg-border bg-sg-input-bg/60 p-3.5">
                <p className="text-[12px] font-bold text-sg-text">Percentage off</p>
                <div className="mt-2 grid grid-cols-4 gap-2" role="group" aria-label="Percentage discount">
                  {quickPercentOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={discountMode === option.value}
                      className={`min-h-9 rounded-full border px-3 text-[12px] font-bold transition ${discountMode === option.value ? "border-sg-primary bg-sg-primary-soft text-sg-primary" : "border-sg-border bg-white text-sg-text hover:bg-sg-input-bg"}`}
                      onClick={() => {
                        setDiscountMode(option.value);
                        markDirty();
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {discountMode === "custom_percent" ? (
                  <div className="mt-3 max-w-xs">
                    <Field
                      label="Custom percentage"
                      value={customDiscountValue}
                      onChange={(value) => {
                        setCustomDiscountValue(value);
                        markDirty();
                      }}
                      placeholder="i.e. 12"
                      error={fieldErrors.discount}
                      compact
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            {discountMode === "code" ? (
              <div className="mt-4 w-full rounded-[9px] border border-sg-border bg-sg-input-bg/60 p-3.5">
                <label className="block min-w-0">
                  <span className="text-[12px] font-bold text-sg-text">Discount code</span>
                  <div className="relative mt-1.5">
                    <input
                      className={`sg25-input bg-white py-2 pl-2.5 pr-[112px] ${fieldErrors.discount ? "border-sg-danger" : ""}`}
                      value={discountCode}
                      onChange={(event) => {
                        setDiscountCode(event.target.value);
                        setDiscountCodeCheck(null);
                        markDirty();
                      }}
                      placeholder="SUMMER-2026"
                    />
                    <button type="button" className="sg25-btn sg25-btn-ghost absolute right-1.5 top-1/2 h-8 -translate-y-1/2 px-3 text-[12px]" onClick={() => void handleVerifyDiscountCode()}>
                      Verify code
                    </button>
                  </div>
                </label>
                <div className="mt-2">
                  {fieldErrors.discount ? <p className="mb-1 text-[11px] font-semibold text-sg-danger">{fieldErrors.discount}</p> : null}
                  {discountCodeCheck ? (
                    <span className={`text-[12px] font-semibold ${discountCodeCheck.status === "valid" ? "text-sg-success" : "text-sg-danger"}`}>
                      {discountCodeCheck.message}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
            {discountMode === "custom_amount" ? (
              <div className="mt-4 w-full rounded-[9px] border border-sg-border bg-sg-input-bg/60 p-3.5">
                <Field
                  label="Fixed amount off"
                  value={customDiscountValue}
                  onChange={(value) => {
                    setCustomDiscountValue(value);
                    markDirty();
                  }}
                  placeholder="25.00"
                  error={fieldErrors.discount}
                  compact
                />
              </div>
            ) : null}
            {fieldErrors.discount && discountMode !== "code" && discountMode !== "custom_amount" && discountMode !== "custom_percent" ? (
              <p className="mt-3 text-[12px] font-semibold text-sg-danger">{fieldErrors.discount}</p>
            ) : null}
          </section>

          <section className="sg25-card order-2 p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <Icon name="truck" className="h-4 w-4 text-sg-primary" />
              <h2 className="text-lg font-bold">Fulfillment</h2>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {fulfillmentOptions.map((option) => {
                const selected = fulfillmentMethod === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`${optionButtonClass(selected)} flex min-h-14 min-w-0 items-center gap-3`}
                    onClick={() => {
                      setFulfillmentMethod(option.value);
                      setSelectedRateId("");
                      setSelectedRateSnapshot(null);
                      markDirty();
                    }}
                  >
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${selected ? "bg-sg-primary text-white" : "bg-sg-primary-soft text-sg-primary"}`}>
                      <Icon name={option.icon} className="h-4 w-4" />
                    </span>
                    <span className="block min-w-0 text-[13px] font-bold leading-tight">{option.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              <Field label="Planned ship date" value={shipmentDate} onChange={setShipmentDate} placeholder="2026-08-09" type="date" />
              {fulfillmentMethod === "b2b_shipping" ? <Field label="B2B shipping cost" value={customB2bShipping} onChange={(value) => { setCustomB2bShipping(value); markDirty(); }} placeholder="250.00" error={fieldErrors.b2b} /> : null}
            </div>
            {fulfillmentMethod === "b2b_shipping" ? (
              <p className="mt-3 rounded-[8px] bg-sg-input-bg px-3 py-2 text-[12px] leading-5 text-sg-muted">
                This freight charge is included in the customer total. After payment, add the external carrier, tracking, and label in Orders.
              </p>
            ) : null}
            {showAddressFields ? (
              <div className="mt-5 grid gap-x-4 gap-y-2 md:grid-cols-2">
                <Field label="Address line 1" value={address.line1} onChange={(value) => updateAddress("line1", value)} placeholder="Street address" required={addressRequired} error={addressRequired ? fieldErrors.addressLine1 : undefined} />
                <Field label="Address line 2" value={address.line2 || ""} onChange={(value) => updateAddress("line2", value)} placeholder="Suite, unit, optional" />
                <Field label="City" value={address.city} onChange={(value) => updateAddress("city", value)} placeholder="City" required={addressRequired} error={addressRequired ? fieldErrors.addressCity : undefined} />
                <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                  <StateField value={address.state} onChange={(value) => updateAddress("state", value)} required={addressRequired} error={addressRequired ? fieldErrors.addressState : undefined} />
                  <Field label="ZIP" value={address.postalCode} onChange={(value) => updateAddress("postalCode", value)} placeholder="38372" required={addressRequired} error={addressRequired ? fieldErrors.addressZip : undefined} />
                </div>
              </div>
            ) : fulfillmentMethod === "pickup" ? (
              <p className="mt-5 rounded-[10px] bg-sg-input-bg p-3 text-[12px] leading-5 text-sg-muted">
                Pickup uses the stored Savannah pickup address for tax and order records.
              </p>
            ) : null}
            <div className="mt-4">
              {fulfillmentMethod === "local_delivery" ? (
                <TextAreaField
                  label="Delivery note"
                  value={deliveryNote}
                  onChange={(value) => {
                    setDeliveryNote(value);
                    markDirty();
                  }}
                  placeholder="Gate code, dock, route note"
                />
              ) : fulfillmentMethod === "pickup" ? (
                <TextAreaField
                  label="Pickup note"
                  value={pickupNote}
                  onChange={(value) => {
                    setPickupNote(value);
                    markDirty();
                  }}
                  placeholder="Pickup contact or timing"
                />
              ) : (
                <TextAreaField
                  label="Note"
                  value={staffNote}
                  onChange={(value) => {
                    setStaffNote(value);
                    markDirty();
                  }}
                  placeholder="Internal fulfillment note"
                />
              )}
            </div>
            {fulfillmentMethod === "carrier" ? (
              <div className="mt-4 space-y-3">
                <button
                  type="button"
                  className="sg25-btn sg25-btn-ghost w-full sm:w-auto"
                  disabled={busy !== null}
                  onClick={() => void handleVerifyAddress()}
                >
                  <Icon name="check" className="h-4 w-4" />
                  {busy === "verify-address" ? "Verifying address..." : addressVerifiedCurrent ? "Address verified" : "Verify address"}
                </button>
                {fieldErrors.addressVerification ? <p className="text-[11px] font-semibold text-sg-danger">{fieldErrors.addressVerification}</p> : null}
                {addressVerification.status === "verified" && addressVerifiedCurrent ? (
                  <div className="flex items-start gap-2 rounded-[9px] bg-sg-success-soft px-3 py-2.5 text-[12px] text-sg-success">
                    <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{addressVerification.message}</span>
                  </div>
                ) : null}
                {addressVerification.status === "suggested" && addressVerification.suggestion ? (
                  <div className="rounded-[10px] border border-sg-amber bg-sg-amber-soft/50 p-3">
                    <div className="flex items-start gap-2">
                      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0 text-sg-amber" />
                      <div className="min-w-0">
                        <p className="text-[12px] font-bold text-sg-text">Suggested deliverable address</p>
                        <p className="mt-1 text-[11px] leading-5 text-sg-muted">{addressVerification.message}</p>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <div className="rounded-[8px] bg-white/70 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-sg-muted">Entered</p>
                        <p className="mt-1 whitespace-pre-line text-[12px] leading-5 text-sg-text">{formatAddress(buildAddress())}</p>
                      </div>
                      <div className="rounded-[8px] border border-sg-amber/40 bg-white p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-sg-amber">Suggested</p>
                        <p className="mt-1 whitespace-pre-line text-[12px] leading-5 text-sg-text">{formatAddress(addressVerification.suggestion)}</p>
                      </div>
                    </div>
                    <button type="button" className="sg25-btn sg25-btn-primary mt-3 w-full sm:w-auto" onClick={useSuggestedAddress}>
                      <Icon name="check" className="h-4 w-4" />
                      Use suggested address
                    </button>
                  </div>
                ) : null}
                {addressVerification.status === "invalid" ? (
                  <div className="rounded-[9px] bg-sg-danger-soft px-3 py-2.5 text-[12px] text-sg-danger">{addressVerification.message}</div>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="sg25-card order-5 p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <Icon name="receipt" className="h-4 w-4 text-sg-primary" />
              <h2 className="text-lg font-bold">Payment</h2>
            </div>
            {availablePaymentOptions.length ? (
              <div className={`mt-4 grid gap-3 ${availablePaymentOptions.length === 1 ? "sm:grid-cols-1" : "sm:grid-cols-2 xl:grid-cols-3"}`}>
                {availablePaymentOptions.map((option) => {
                  const selected = paymentMethod === option.value;
                  return (
                    <button key={option.value} type="button" className={`${optionButtonClass(selected)} flex min-w-0 items-center gap-3`} onClick={() => { setPaymentMethod(option.value); markDirty(); }}>
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${selected ? "bg-sg-primary text-white" : "bg-sg-primary-soft text-sg-primary"}`}>
                        <Icon name={option.icon} className="h-4 w-4" />
                      </span>
                      <span className="block min-w-0 text-[13px] font-bold leading-tight">{option.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mt-4 rounded-[10px] border border-sg-border bg-sg-input-bg p-3 text-[12px] leading-5 text-sg-muted">
                Select a payment option for this order.
              </div>
            )}
            {fieldErrors.payment ? <p className="mt-3 text-[12px] font-semibold text-sg-danger">{fieldErrors.payment}</p> : null}
            {fulfillmentMethod === "b2b_shipping" && paymentMethod === "square_payment_link" ? (
              <div className="mt-4 rounded-[10px] border border-sg-border bg-sg-input-bg/50 p-3">
                <div className="flex items-start gap-2">
                  <Icon name="receipt" className="mt-0.5 h-4 w-4 shrink-0 text-sg-primary" />
                  <div>
                    <p className="text-[12px] font-bold text-sg-text">Customer invoice PDF <span className="font-medium text-sg-muted">(optional)</span></p>
                    <p className="mt-1 text-[11px] leading-5 text-sg-muted">Attached only to this B2B payment-link email. PDF, up to 4 MB. The file is not stored with the order.</p>
                  </div>
                </div>
                <input
                  ref={b2bInvoiceInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  className="sr-only"
                  onChange={(event) => {
                    selectB2bInvoice(event.target.files?.[0] || null);
                    event.currentTarget.value = "";
                  }}
                />
                {b2bInvoiceFile ? (
                  <div className="mt-3 flex flex-col gap-2 rounded-[8px] border border-sg-success/30 bg-sg-success-soft px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate text-[12px] font-bold text-sg-text">{b2bInvoiceFile.name}</p>
                      <p className="mt-0.5 text-[11px] text-sg-muted">{(b2bInvoiceFile.size / 1024).toFixed(0)} KB · Ready to attach</p>
                    </div>
                    <button type="button" className="sg25-btn sg25-btn-secondary shrink-0" onClick={() => setB2bInvoiceFile(null)}>
                      <Icon name="x" className="h-4 w-4" /> Remove
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={`mt-3 flex w-full flex-col items-center justify-center rounded-[8px] border border-dashed px-4 py-5 text-center transition ${b2bInvoiceDragActive ? "border-sg-primary bg-sg-primary-soft" : "border-sg-border bg-white hover:border-sg-primary/50 hover:bg-sg-primary-soft/30"}`}
                    onClick={() => b2bInvoiceInputRef.current?.click()}
                    onDragEnter={(event) => { event.preventDefault(); setB2bInvoiceDragActive(true); }}
                    onDragOver={(event) => { event.preventDefault(); setB2bInvoiceDragActive(true); }}
                    onDragLeave={(event) => { event.preventDefault(); setB2bInvoiceDragActive(false); }}
                    onDrop={(event) => {
                      event.preventDefault();
                      setB2bInvoiceDragActive(false);
                      selectB2bInvoice(event.dataTransfer.files?.[0] || null);
                    }}
                  >
                    <span className="text-[12px] font-bold text-sg-text">Drop invoice PDF here</span>
                    <span className="mt-1 text-[11px] text-sg-muted">or click to choose a file</span>
                  </button>
                )}
              </div>
            ) : null}
          </section>
        </div>

        <aside
          ref={summaryRef}
          data-sticky-enabled={summaryCanStick ? "true" : "false"}
          className={`sg25-card self-start p-4 sm:p-5 ${summaryCanStick ? "lg:sticky lg:top-[88px]" : "lg:static"}`}
        >
          <div className="flex items-center gap-2">
            <Icon name="receipt" className="h-4 w-4 text-sg-primary" />
            <h2 className="text-lg font-bold">Order Summary</h2>
          </div>
          <div className="mt-5 space-y-3 border-y border-sg-border py-4 text-[13px]">
            {summaryProductLines.length ? (
              <div className="space-y-2 border-b border-sg-border pb-3">
                {summaryProductLines.map((line) => (
                  <div key={line.key} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-words font-semibold text-sg-text">{line.name}</p>
                      <p className="mt-0.5 text-[11px] text-sg-muted">{line.detail}</p>
                    </div>
                    <span className="shrink-0 font-semibold">{line.total}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="border-b border-sg-border pb-3 text-[12px] text-sg-muted">No products selected.</p>
            )}
            <SummaryLine label="Subtotal" value={formatUsdCents(previewTotals.originalSubtotalCents)} />
            {(displayQuote?.volumePricingApplied || previewTotals.volumePricingApplied) ? (
              <SummaryLine label="Volume pricing" value="Applied automatically" />
            ) : null}
            {(displayQuote?.merchandiseDiscountCents || previewTotals.discountCents) > 0 ? (
              <SummaryLine
                label="Discount"
                value={`-${displayQuote?.merchandiseDiscountFormatted || formatUsdCents(previewTotals.discountCents)}`}
              />
            ) : null}
            {discountMode === "code" && discountCodeCheck?.status === "valid" ? (
              <SummaryLine label="Discount code" value={`${discountCodeCheck.code} · ${discountCodeCheck.percent ?? DEFAULT_DISCOUNT_PERCENT}%`} />
            ) : null}
            <SummaryLine label="Shipping" value={quoteValue(displayQuote, "shippingFormatted", previewTotals.shippingCents)} />
            <SummaryLine label="Estimated tax" value={quoteValue(displayQuote, "taxFormatted", previewTotals.taxCents)} />
            {taxExemptionReady ? (
              <SummaryLine label="Tax excluded" value={formatUsdCents(displayQuote?.taxExemption?.taxExcludedCents ?? previewTotals.taxExcludedCents)} />
            ) : null}
            <SummaryLine label="Total" value={quoteValue(displayQuote, "totalFormatted", previewTotals.totalCents)} strong />
          </div>
          {taxExemptionReady ? (
            <div className="mt-3 flex items-start gap-2 rounded-[10px] bg-sg-success-soft p-3 text-[12px] leading-5 text-sg-success">
              <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" />
              <span><strong>Tax-exempt order.</strong> The certificate and approval evidence will be saved privately with the order.</span>
            </div>
          ) : null}
          {quote?.freeDelivery?.applied ? (
            <div className="mt-3 rounded-[10px] bg-sg-success-soft p-3 text-[12px] leading-5 text-sg-success">
              {quote.freeDelivery.message || "Free local delivery applies. SAI Goods will deliver this order without a carrier label."}
            </div>
          ) : quote?.freeDelivery?.reason === "minimum_not_met" && quote.freeDelivery.message ? (
            <div className="mt-3 rounded-[10px] bg-sg-amber-soft p-3 text-[12px] leading-5 text-sg-amber">{quote.freeDelivery.message}</div>
          ) : null}
          {fulfillmentMethod === "carrier" && quote?.freeShipping?.message ? (
            <div className={`mt-3 rounded-[10px] p-3 text-[12px] leading-5 ${quote.freeShipping.eligible ? "bg-sg-success-soft text-sg-success" : "bg-sg-amber-soft text-sg-amber"}`}>
              {quote.freeShipping.message}
            </div>
          ) : null}
          {quoteDirty && quote ? <p className="mt-3 text-[12px] text-sg-amber">Inputs changed after the last quote. Recalculate before sending.</p> : null}
          {summaryWarnings.length ? (
            <div className="mt-3 rounded-[10px] bg-sg-amber-soft p-3 text-[12px] leading-5 text-sg-amber">
              {summaryWarnings.slice(0, 2).join(" ")}
            </div>
          ) : null}
          {quote?.userFacingError && !hasVisibleCarrierRates ? <div className="mt-3 rounded-[10px] bg-sg-danger-soft p-3 text-[12px] leading-5 text-sg-danger">{quote.userFacingError}</div> : null}
          {status && !(quote?.userFacingError && !hasVisibleCarrierRates && status.message === quote.userFacingError) ? <div className={`mt-3 rounded-[10px] p-3 text-[12px] leading-5 ${statusClass}`}>{status.message}</div> : null}
          {hasVisibleCarrierRates ? (
            <div ref={carrierRatesRef} className="mt-5 scroll-mt-24 rounded-[10px] border border-sg-border p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[12px] font-bold text-sg-muted">Carrier rates</p>
                  {quote?.userFacingError ? (
                    <p className="mt-0.5 text-[10px] font-semibold text-sg-danger">Previous rates unavailable · refresh required</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {fieldErrors.carrierRate ? <p className="text-[11px] font-semibold text-sg-danger">{fieldErrors.carrierRate}</p> : null}
                  <button
                    type="button"
                    className="sg25-btn sg25-btn-ghost h-8 px-3 text-[11px]"
                    disabled={actionsDisabled}
                    onClick={() => void handleEstimate({ refreshCarrierRates: true })}
                  >
                    <Icon name="refresh" className="h-3.5 w-3.5" />
                    {isCarrierRatesRefreshing ? "Refreshing" : "Refresh"}
                  </button>
                </div>
              </div>
              <div className="mt-3 grid gap-2">
                {visibleCarrierRates.map((rate) => {
                  const id = String(rate.id || "");
                  const isSelected = selectedRateId === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={optionButtonClass(isSelected)}
                      disabled={actionsDisabled || carrierQuoteUnavailable}
                      onClick={() => {
                        const nextSelected = isSelected ? "" : id;
                        setSelectedRateId(nextSelected);
                        setSelectedRateSnapshot(nextSelected ? rate : null);
                        setFieldErrors((current) => {
                          const next = { ...current };
                          delete next.carrierRate;
                          return next;
                        });
                        setStatus(nextSelected
                          ? { tone: "success", message: `${rate.serviceLabel || "Carrier rate"} selected. Create and send the link when ready.` }
                          : null);
                      }}
                    >
                      <span className="flex items-start justify-between gap-2">
                        <span className="block min-w-0 text-[13px] font-bold">{formatRateLabel(rate)}</span>
                        {isSelected ? (
                          <span className="shrink-0 rounded-full bg-sg-primary-soft px-2 py-0.5 text-[10px] font-semibold text-sg-primary">
                            Selected
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1 block text-[11px] text-sg-muted">
                        {formatRateBreakdown(rate)}
                        {rate.parcelCount ? ` · ${rate.parcelCount} parcels` : ""}
                      </span>
                      {formatDeliveryEstimate(rate) ? (
                        <span className="mt-1 block text-[11px] font-medium text-sg-muted">{formatDeliveryEstimate(rate)}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className="mt-5 space-y-3">
            {fulfillmentMethod !== "carrier" || !hasVisibleCarrierRates ? (
              <button type="button" className="sg25-btn sg25-btn-ghost w-full" disabled={actionsDisabled} onClick={() => void handleEstimate({ scrollToRates: fulfillmentMethod === "carrier" })}>
                <Icon name="receipt" className="h-4 w-4" />
                {busy === "estimate"
                  ? fulfillmentMethod === "carrier"
                    ? "Getting rates..."
                    : "Checking totals..."
                  : fulfillmentMethod === "carrier"
                    ? automaticFreeLocalDelivery && quote && !quoteDirty
                      ? "Free local delivery confirmed"
                      : "Check delivery options"
                    : quote && !quoteDirty
                      ? "Totals checked"
                      : "Check totals"}
              </button>
            ) : null}
            {createReadinessMessage ? <p className="text-center text-[11px] font-medium text-sg-muted">{createReadinessMessage}</p> : null}
            <button type="button" className="sg25-btn sg25-btn-primary w-full" disabled={createDisabled} onClick={() => void handleCreateAndSend()}>
              {busy === "send"
                ? editOrderId ? "Saving and sending..." : "Creating..."
                : paymentMethod === "square_payment_link"
                  ? editOrderId ? "Save changes and send new link" : "Create and send link"
                  : paymentMethod === "arrival_payment_link"
                    ? "Create arrival-link order"
                    : "Create pay-later order"}
              <Icon name="arrow-up-right" className="h-4 w-4" />
            </button>
          </div>
        </aside>
      </section>
      {taxReviewWarning ? createPortal(
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tax-review-warning-title"
          onClick={() => setTaxReviewWarning(null)}
        >
          <section className="w-full max-w-md rounded-[14px] bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sg-amber-soft text-sg-amber">
                <Icon name="alert" className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2 id="tax-review-warning-title" className="text-lg font-bold">Complete the exemption details</h2>
                <p className="mt-1 text-[12px] leading-5 text-sg-muted">The certificate cannot be marked reviewed until these required items are complete:</p>
              </div>
            </div>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-[12px] leading-5 text-sg-text">
              {taxReviewWarning.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
            <div className="mt-5 flex justify-end">
              <button type="button" className="sg25-btn sg25-btn-primary" onClick={() => setTaxReviewWarning(null)}>Review fields</button>
            </div>
          </section>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
