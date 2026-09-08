import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useAuth } from "../auth/AuthProvider";
import { CustomSelect } from "../components/ui/CustomSelect";
import {
  fetchPackagingConfig,
  fetchBundleCatalog,
  fetchPaymentHealth,
  fetchPaymentFeeConfig,
  fetchFreeDeliveryConfig,
  fetchShippingHealth,
  fetchWarehouseConfig,
  ApiError,
  savePackagingConfig,
  savePaymentFeeConfig,
  saveFreeDeliveryConfig,
  saveBundleCatalog,
  saveWarehouseConfig,
  type PackagingConfig,
  type BundleCatalog,
  type BundleCatalogBundle,
  type VolumePricingRule,
  type PaymentHealthResponse,
  type PaymentFeeConfig,
  type FreeDeliveryConfig,
  type ShippingHealthResponse,
  type WarehouseLocation,
} from "../lib/api";
import { Icon } from "../lib/icons";

type BundleStatus = "active" | "inactive";
type ShippingProvider = "shippo" | "ups" | "manual";
type LabelFormat = "PDF_4x6" | "PDF" | "PNG";
type AddressValidationMode = "shippo" | "local" | "off";
type StockDeductionPoint = "awaiting" | "payment" | "label" | "completion";
type DiscountMode = "manual" | "off";
type FlowToggleKey = "onlineCheckout" | "manualOrders" | "localDelivery" | "b2bShipping" | "pickup" | "walkIn";
type PendingFlowToggle = { key: FlowToggleKey; label: string; enabled: boolean };

type BundleRow = {
  key: string;
  id: string;
  productSlug: string;
  product: string;
  bundle: string;
  kind: "box" | "case";
  units: number;
  priceCents: number;
  cogsCents?: number;
  status: BundleStatus;
  added?: boolean;
  removed?: boolean;
  sourceBundle?: BundleCatalogBundle;
};

type WarehouseRow = WarehouseLocation & {
  added?: boolean;
};

type BundleDraft = {
  key?: string;
  id: string;
  productSlug: string;
  product: string;
  bundle: string;
  kind: "box" | "case";
  units: string;
  price: string;
  cogs: string;
  status: BundleStatus;
};

type WarehouseDraft = WarehouseRow;
type VolumePricingDraft = {
  productSlug: string;
  product: string;
  active: boolean;
  minCases: string;
  pricePerCase: string;
  allowDiscountStacking: boolean;
};

type WarehouseFieldErrors = Partial<Record<"name" | "address1" | "city" | "state" | "zip" | "country" | "email" | "phone" | "roles", string>>;
type WarehouseAddressSuggestion = Partial<Record<"line1" | "line2" | "city" | "state" | "postalCode" | "country", string>>;

const productOptions = [
  { slug: "nitrile-standard", name: "Nitrile Examination - Standard" },
  { slug: "black-nitrile-general", name: "Black Nitrile - General" },
  { slug: "black-nitrile-heavy-duty", name: "Black Nitrile - Heavy Duty" },
];
const products = productOptions.map((product) => product.name);

const initialBundles: BundleRow[] = [
  { key: "nitrile-standard:box_1", id: "box_1", productSlug: "nitrile-standard", product: products[0], bundle: "1 box", kind: "box", units: 1, priceCents: 899, status: "active" },
  { key: "nitrile-standard:case_1", id: "case_1", productSlug: "nitrile-standard", product: products[0], bundle: "1 carton", kind: "case", units: 1, priceCents: 5499, status: "active" },
  { key: "black-nitrile-general:box_1", id: "box_1", productSlug: "black-nitrile-general", product: products[1], bundle: "1 box", kind: "box", units: 1, priceCents: 899, status: "active" },
  { key: "black-nitrile-general:case_1", id: "case_1", productSlug: "black-nitrile-general", product: products[1], bundle: "1 carton", kind: "case", units: 1, priceCents: 5799, status: "active" },
  { key: "black-nitrile-heavy-duty:box_1", id: "box_1", productSlug: "black-nitrile-heavy-duty", product: products[2], bundle: "1 box", kind: "box", units: 1, priceCents: 1399, status: "active" },
  { key: "black-nitrile-heavy-duty:case_1", id: "case_1", productSlug: "black-nitrile-heavy-duty", product: products[2], bundle: "1 carton", kind: "case", units: 1, priceCents: 11599, status: "active" },
];

const initialWarehouses: WarehouseRow[] = [
  {
    key: "savannah",
    name: "Savannah warehouse",
    address1: "275 Eureka Street",
    address2: "",
    city: "Savannah",
    state: "TN",
    zip: "38372",
    country: "US",
    email: "sales@saigoods.com",
    phone: "5555555555",
    roles: ["Default ship-from", "Returns", "Inventory"],
    active: true,
  },
];

const shippingProviderOptions: Array<{ value: ShippingProvider; label: string }> = [
  { value: "shippo", label: "Shippo" },
  { value: "ups", label: "Direct UPS" },
  { value: "manual", label: "Manual rates" },
];

const labelFormatOptions: Array<{ value: LabelFormat; label: string }> = [
  { value: "PDF_4x6", label: "PDF_4x6" },
  { value: "PDF", label: "PDF" },
  { value: "PNG", label: "PNG" },
];

const addressValidationOptions: Array<{ value: AddressValidationMode; label: string }> = [
  { value: "shippo", label: "Shippo validation" },
  { value: "local", label: "Local format check" },
  { value: "off", label: "Off" },
];

const warehouseRoleOptions = ["Default ship-from", "Returns", "Inventory"];
const countryOptions = [{ value: "US", label: "United States (US)" }];
const usStateOptions = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
  ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["FL", "Florida"], ["GA", "Georgia"],
  ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"],
  ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"],
  ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"],
  ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
  ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"],
  ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"],
  ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
  ["DC", "District of Columbia"],
].map(([value, name]) => ({ value, label: `${name} (${value})` }));

const stockDeductionOptions: Array<{ value: StockDeductionPoint; label: string }> = [
  { value: "awaiting", label: "When payment link is sent and awaiting payment" },
  { value: "payment", label: "When payment is received" },
  { value: "label", label: "When label is purchased" },
  { value: "completion", label: "When order is completed" },
];

const discountModeOptions: Array<{ value: DiscountMode; label: string }> = [
  { value: "manual", label: "Manual discount review" },
  { value: "off", label: "Off" },
];

function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function centsFromPrice(value: string) {
  const normalized = value.replace(/[^0-9.]/g, "");
  return Math.round((Number(normalized) || 0) * 100);
}

function numberOnly(value: string) {
  return value.replace(/[^0-9.]/g, "");
}

function wholeNumberOnly(value: string) {
  return value.replace(/\D/g, "");
}

function bundleIdFromDraft(draft: BundleDraft) {
  const normalized = String(draft.id || draft.bundle || `${draft.kind}_${draft.units}`)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || `${draft.kind}_${draft.units || "1"}`;
}

function compareBundleHierarchy(a: BundleRow, b: BundleRow) {
  const aKind = a.kind === "case" ? 1 : 0;
  const bKind = b.kind === "case" ? 1 : 0;
  if (aKind !== bKind) return aKind - bKind;
  if (a.units !== b.units) return a.units - b.units;
  return a.bundle.localeCompare(b.bundle);
}

function bundleRowsFromCatalog(catalog?: BundleCatalog | null): BundleRow[] {
  if (!catalog?.products?.length) return initialBundles;
  return catalog.products.flatMap((product) =>
    (product.bundles || []).map((bundle) => ({
      key: `${product.slug}:${bundle.id}`,
      id: bundle.id,
      productSlug: product.slug,
      product: product.name,
      bundle: bundle.label,
      kind: bundle.kind,
      units: bundle.units,
      priceCents: bundle.priceCents,
      cogsCents: bundle.cogsCents,
      status: bundle.active === false ? "inactive" as const : "active" as const,
      sourceBundle: { ...bundle },
    })),
  );
}

function volumePricingFromCatalog(catalog?: BundleCatalog | null) {
  return Object.fromEntries(
    (catalog?.products || []).filter((product) => product.volumePricing).map((product) => [product.slug, { ...product.volumePricing! }]),
  ) as Record<string, VolumePricingRule>;
}

function catalogFromBundleRows(rows: BundleRow[], volumePricing: Record<string, VolumePricingRule> = {}): BundleCatalog {
  return {
    $schema: "sai-store-bundle-catalog-v1",
    products: productOptions.map((product) => ({
      slug: product.slug,
      name: product.name,
      ...(volumePricing[product.slug] ? { volumePricing: { ...volumePricing[product.slug] } } : {}),
      bundles: rows
        .filter((row) => row.productSlug === product.slug && !row.removed)
        .map((row) => ({
          ...(row.sourceBundle || {}),
          id: row.id,
          label: row.bundle,
          kind: row.kind,
          units: row.units,
          priceCents: row.priceCents,
          hardinPriceCents: row.priceCents,
          cogsCents: row.cogsCents,
          expectedProfitCents: Math.max(0, grossProfitCents(row)),
          builtInShippingTotalCents: 0,
          active: row.status === "active",
        })),
    })),
  };
}

function zipOnly(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 9);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

function rowCogsCents(row: BundleRow) {
  if (typeof row.cogsCents === "number") return row.cogsCents;
  return Math.round(row.priceCents * 0.58);
}

function grossProfitCents(row: BundleRow) {
  return row.priceCents - rowCogsCents(row);
}

function formatAddress(row: WarehouseRow | WarehouseDraft) {
  return [row.address1, row.address2, `${row.city}, ${row.state} ${row.zip}`].filter(Boolean).join(", ");
}

function SectionTitle({ icon, title, description, action }: { icon: Parameters<typeof Icon>[0]["name"]; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-sg-primary-soft text-sg-primary">
          <Icon name={icon} className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[21px] font-bold leading-6">{title}</h2>
          <p className="mt-1 text-[13px] leading-5 text-sg-muted">{description}</p>
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: "success" | "warning" | "danger" | "neutral" }) {
  const styles = {
    success: "bg-sg-success-soft text-sg-success",
    warning: "bg-sg-warning-soft text-sg-warning",
    danger: "bg-sg-danger-soft text-sg-danger",
    neutral: "bg-sg-input-bg text-sg-muted",
  };
  return <span className={`inline-flex whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-bold ${styles[tone]}`}>{children}</span>;
}

function SettingRow({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail?: string; tone?: "success" | "warning" | "danger" | "neutral" }) {
  return (
    <div className="flex flex-col gap-2 rounded-[8px] border border-sg-border bg-white px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-[13px] font-bold">{label}</p>
        {detail ? <p className="mt-0.5 text-[12px] leading-4 text-sg-muted">{detail}</p> : null}
      </div>
      <StatusPill tone={tone}>{value}</StatusPill>
    </div>
  );
}

function GuardedValue({ label, value, detail, onEdit }: { label: string; value: string; detail?: string; onEdit: () => void }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 rounded-[8px] border border-sg-border bg-white px-3 py-2">
      <div className="min-w-0">
        <p className="text-[12px] font-bold text-sg-muted">{label}</p>
        <p className="mt-0.5 truncate text-[13px] font-bold">{value}</p>
        {detail ? <p className="mt-0.5 text-[11px] font-semibold leading-4 text-sg-muted">{detail}</p> : null}
      </div>
      <button type="button" className="sg25-btn sg25-btn-ghost h-8 rounded-[8px] px-3 text-[11px]" onClick={onEdit}>
        Edit
      </button>
    </div>
  );
}

function ToggleSetting({ label, detail, enabled, onChange }: { label: string; detail: string; enabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      className="flex min-h-[74px] items-center justify-between gap-3 rounded-[8px] border border-sg-border bg-white px-3 py-3 text-left"
      onClick={() => onChange(!enabled)}
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-bold">{label}</span>
        <span className="mt-1 block text-[12px] leading-5 text-sg-muted">{detail}</span>
      </span>
      <span className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-[8px] px-3 text-[12px] font-bold ${enabled ? "bg-sg-success-soft text-sg-success" : "bg-sg-danger-soft text-sg-danger"}`}>
        {enabled ? "Enabled" : "Disabled"}
        <span className={`relative h-5 w-9 rounded-full ${enabled ? "bg-sg-success" : "bg-sg-danger"}`}>
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${enabled ? "right-0.5" : "left-0.5"}`} />
        </span>
      </span>
    </button>
  );
}

function Modal({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex h-[100dvh] items-center justify-center overflow-hidden bg-black/45 p-4">
      <div role="dialog" aria-modal="true" className={`max-h-[calc(100dvh-2rem)] w-full overflow-y-auto overscroll-contain ${wide ? "max-w-2xl" : "max-w-lg"} rounded-[10px] bg-white p-5 shadow-[0_28px_80px_rgba(31,27,24,0.28)] sm:p-6`}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function WarningHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex items-start gap-4">
      <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sg-danger-soft text-sg-danger">
        <Icon name="alert" className="h-5 w-5" />
      </span>
      <div>
        <p className="text-[12px] font-bold text-sg-danger">Sensitive change warning</p>
        <h3 className="mt-1 text-[28px] font-bold leading-8">{title}</h3>
        {description ? <p className="mt-3 text-[14px] leading-6 text-sg-muted">{description}</p> : null}
      </div>
    </div>
  );
}

function Field({ label, children, required = false, error }: { label: string; children: ReactNode; required?: boolean; error?: string }) {
  return (
    <label className="block min-w-0 space-y-2">
      <span className="text-[12px] font-bold text-sg-muted">{label}{required ? <span className="ml-1 text-sg-danger" aria-hidden="true">*</span> : null}</span>
      {children}
      {error ? <span className="block text-[12px] font-semibold text-sg-danger">{error}</span> : null}
    </label>
  );
}

function packagingNumberValue(value: unknown) {
  return value === undefined || value === null ? "" : String(value);
}

function packagingNumberFromInput(value: string) {
  return value === "" ? "" : Number(value);
}

function packagingDimensions(value?: { length?: number | string; width?: number | string; height?: number | string }) {
  return `${packagingNumberValue(value?.length) || "-"} x ${packagingNumberValue(value?.width) || "-"} x ${packagingNumberValue(value?.height) || "-"} in`;
}

function packagingTypeLabel(value?: string) {
  if (value === "factory_case") return "Factory case";
  if (value === "corrugated_carton") return "Shipping carton";
  return String(value || "Package").replaceAll("_", " ");
}

function packagingProductLabel(slug: string) {
  const labels: Record<string, string> = {
    "nitrile-standard": products[0],
    "black-nitrile-general": products[1],
    "black-nitrile-heavy-duty": products[2],
  };
  return labels[slug] || slug.split("-").map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function PackagingMetric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase text-sg-muted">{label}</p>
      <p className="mt-1 text-[13px] font-bold leading-5">{value}</p>
    </div>
  );
}

function PackagingNumberField({ label, value, onChange, suffix }: { label: string; value: unknown; onChange: (value: string) => void; suffix?: string }) {
  return (
    <Field label={label}>
      <div className="flex h-10 items-center rounded-[7px] border border-sg-border bg-white px-3">
        <input className="min-w-0 flex-1 bg-transparent text-[13px] font-bold outline-none" inputMode="decimal" value={packagingNumberValue(value)} onChange={(event) => onChange(event.target.value)} />
        {suffix ? <span className="ml-2 text-[11px] font-bold text-sg-muted">{suffix}</span> : null}
      </div>
    </Field>
  );
}

function CurrencyCentsField({
  label,
  cents,
  onCommit,
  optional = false,
}: {
  label: string;
  cents: number | null | undefined;
  onCommit: (cents: number | null) => void;
  optional?: boolean;
}) {
  const formatted = cents == null ? "" : (cents / 100).toFixed(2);
  const [draft, setDraft] = useState(formatted);

  useEffect(() => {
    setDraft(formatted);
  }, [formatted]);

  function commitDraft() {
    if (!draft.trim() && optional) {
      onCommit(null);
      setDraft("");
      return;
    }
    const nextCents = Math.max(0, Math.round((Number(draft) || 0) * 100));
    onCommit(nextCents);
    setDraft((nextCents / 100).toFixed(2));
  }

  return (
    <Field label={label}>
      <div className="flex h-10 items-center rounded-[7px] border border-sg-border bg-white px-3 focus-within:border-sg-primary focus-within:ring-2 focus-within:ring-sg-primary/10">
        <input
          className="min-w-0 flex-1 bg-transparent text-[13px] font-bold outline-none disabled:cursor-not-allowed"
          inputMode="decimal"
          value={draft}
          placeholder={optional ? "Use default" : "0.00"}
          onChange={(event) => {
            const next = event.target.value;
            if (/^\d*(?:\.\d{0,2})?$/.test(next)) setDraft(next);
          }}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span className="ml-2 text-[11px] font-bold text-sg-muted">USD</span>
      </div>
    </Field>
  );
}

function PostalCodeEditor({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const postalCodes = Array.from(new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean)));

  function addPostalCodes(raw: string) {
    const candidates = raw.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
    const invalid = candidates.filter((entry) => !/^\d{5}$/.test(entry));
    const valid = candidates.filter((entry) => /^\d{5}$/.test(entry));
    if (valid.length) onChange(Array.from(new Set([...postalCodes, ...valid])));
    setDraft("");
    setError(invalid.length ? `Use 5-digit ZIP codes only: ${invalid.join(", ")}` : "");
  }

  return (
    <div className="rounded-[8px] border border-sg-border bg-white p-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className="sg25-input h-10 min-w-0 flex-1"
          inputMode="numeric"
          value={draft}
          placeholder="Enter ZIP code"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            addPostalCodes(draft);
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            if (!/[\s,]/.test(pasted)) return;
            event.preventDefault();
            addPostalCodes(pasted);
          }}
        />
        <button type="button" className="sg25-btn sg25-btn-ghost h-10 shrink-0" onClick={() => addPostalCodes(draft)} disabled={!draft.trim()}>
          Add ZIP
        </button>
      </div>
      <div className="mt-3 flex min-h-9 flex-wrap gap-2">
        {postalCodes.length ? postalCodes.map((postalCode) => (
          <span key={postalCode} className="inline-flex h-8 items-center gap-2 rounded-full bg-sg-input-bg px-3 text-[12px] font-bold">
            {postalCode}
            <button type="button" className="text-[16px] leading-none text-sg-muted hover:text-sg-danger" aria-label={`Remove ZIP ${postalCode}`} onClick={() => onChange(postalCodes.filter((entry) => entry !== postalCode))}>×</button>
          </span>
        )) : <span className="text-[12px] text-sg-muted">No ZIP codes added yet.</span>}
      </div>
      <p className={`mt-2 text-[11px] leading-4 ${error ? "font-semibold text-sg-danger" : "text-sg-muted"}`}>
        {error || `${postalCodes.length} eligible ZIP ${postalCodes.length === 1 ? "code" : "codes"}. Paste a comma-separated list to add several at once.`}
      </p>
    </div>
  );
}

function clonePackagingConfig(config: PackagingConfig) {
  return JSON.parse(JSON.stringify(config)) as PackagingConfig;
}

function cloneFreeDeliveryConfig(config: FreeDeliveryConfig) {
  return JSON.parse(JSON.stringify(config)) as FreeDeliveryConfig;
}

function makePackagingCarton() {
  return {
    id: `carton_${Date.now()}`,
    label: "New shipping carton",
    compatibilityGroup: "nitrile_gloves",
    packageType: "corrugated_carton",
    packingMaterial: "Bubble wrap or kraft paper inside carton",
    packingInstructions: "Protect the retail box and fill empty space so it cannot move.",
    inner: { length: "", width: "", height: "" },
    outer: { length: "", width: "", height: "" },
    maxRetailBox: { length: "", width: "", height: "" },
    tareWeightLb: "",
    costCents: "",
    maxWeightLb: "",
    maxRetailBoxes: 1,
  };
}

function makeBundleDraft(row?: BundleRow): BundleDraft {
  return row
    ? {
        key: row.key,
        id: row.id,
        productSlug: row.productSlug,
        product: row.product,
        bundle: row.bundle,
        kind: row.kind,
        units: String(row.units),
        price: (row.priceCents / 100).toFixed(2),
        cogs: (rowCogsCents(row) / 100).toFixed(2),
        status: row.status,
      }
    : {
        id: "",
        productSlug: productOptions[0].slug,
        product: products[0],
        bundle: "",
        kind: "case",
        units: "1",
        price: "",
        cogs: "",
        status: "active",
      };
}

function makeWarehouseDraft(row?: WarehouseRow): WarehouseDraft {
  return row
    ? { ...row, roles: [...row.roles] }
    : {
        key: `warehouse-${Date.now()}`,
        name: "",
        address1: "",
        address2: "",
        city: "",
        state: "TN",
        zip: "",
        country: "US",
        email: "",
        phone: "",
        active: true,
        added: true,
        roles: [],
      };
}

function validateWarehouseDraft(draft: WarehouseDraft) {
  const errors: WarehouseFieldErrors = {};
  const requiredFields = ["name", "address1", "city", "state", "zip", "country", "email", "phone"] as const;
  for (const field of requiredFields) {
    if (!String(draft[field] || "").trim()) errors[field] = "Required.";
  }
  if (draft.state && !/^[A-Z]{2}$/.test(draft.state)) errors.state = "Enter a two-letter state code.";
  if (draft.zip && !/^\d{5}(?:-\d{4})?$/.test(draft.zip)) errors.zip = "Enter a valid 5-digit or ZIP+4 code.";
  if (draft.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email)) errors.email = "Enter a valid email address.";
  if (draft.phone && draft.phone.replace(/\D/g, "").length < 10) errors.phone = "Enter a valid carrier phone number.";
  if (!draft.roles.length) errors.roles = "Select at least one role.";
  return errors;
}

export function AdvancedPage() {
  const auth = useAuth();
  const [bundles, setBundles] = useState(initialBundles);
  const [savedBundles, setSavedBundles] = useState(initialBundles);
  const [bundleLoading, setBundleLoading] = useState(false);
  const [bundleSaving, setBundleSaving] = useState(false);
  const [bundleStatus, setBundleStatus] = useState("");
  const [bundleError, setBundleError] = useState("");
  const [bundleSource, setBundleSource] = useState("");
  const [expandedProducts, setExpandedProducts] = useState<Record<string, boolean>>({});
  const [bundleDraft, setBundleDraft] = useState<BundleDraft | null>(null);
  const [volumePricing, setVolumePricing] = useState<Record<string, VolumePricingRule>>({});
  const [volumePricingDraft, setVolumePricingDraft] = useState<VolumePricingDraft | null>(null);
  const [removeBundle, setRemoveBundle] = useState<BundleRow | null>(null);
  const [removeConfirmText, setRemoveConfirmText] = useState("");
  const [warehouses, setWarehouses] = useState(initialWarehouses);
  const [savedWarehouses, setSavedWarehouses] = useState(initialWarehouses);
  const [warehouseDraft, setWarehouseDraft] = useState<WarehouseDraft | null>(null);
  const [warehouseLoading, setWarehouseLoading] = useState(false);
  const [warehouseSaving, setWarehouseSaving] = useState(false);
  const [warehouseStatus, setWarehouseStatus] = useState("");
  const [warehouseError, setWarehouseError] = useState("");
  const [warehouseDraftError, setWarehouseDraftError] = useState("");
  const [warehouseFieldErrors, setWarehouseFieldErrors] = useState<WarehouseFieldErrors>({});
  const [warehouseAddressSuggestion, setWarehouseAddressSuggestion] = useState<WarehouseAddressSuggestion | null>(null);
  const [shippingProvider, setShippingProvider] = useState<ShippingProvider>("shippo");
  const [labelFormat, setLabelFormat] = useState<LabelFormat>("PDF_4x6");
  const [addressValidationMode, setAddressValidationMode] = useState<AddressValidationMode>("shippo");
  const [stockDeductionPoint, setStockDeductionPoint] = useState<StockDeductionPoint>("payment");
  const [discountMode, setDiscountMode] = useState<DiscountMode>("manual");
  const [lowStockThreshold, setLowStockThreshold] = useState("25");
  const [shippingBuffer, setShippingBuffer] = useState("2.00");
  const [bufferDraft, setBufferDraft] = useState<string | null>(null);
  const [guardedEdit, setGuardedEdit] = useState<{ title: string; value: string } | null>(null);
  const [onlineCheckout, setOnlineCheckout] = useState(true);
  const [manualOrders, setManualOrders] = useState(true);
  const [localDelivery, setLocalDelivery] = useState(true);
  const [b2bShipping, setB2bShipping] = useState(true);
  const [pickup, setPickup] = useState(false);
  const [walkIn, setWalkIn] = useState(false);
  const [pendingFlowToggle, setPendingFlowToggle] = useState<PendingFlowToggle | null>(null);
  const [blockOversell, setBlockOversell] = useState(true);
  const [packagingConfig, setPackagingConfig] = useState<PackagingConfig | null>(null);
  const [savedPackagingConfig, setSavedPackagingConfig] = useState<PackagingConfig | null>(null);
  const [packagingEditing, setPackagingEditing] = useState(false);
  const [packagingUnlockOpen, setPackagingUnlockOpen] = useState(false);
  const [packagingUnlockText, setPackagingUnlockText] = useState("");
  const [packagingLoading, setPackagingLoading] = useState(false);
  const [packagingSaving, setPackagingSaving] = useState(false);
  const [packagingStatus, setPackagingStatus] = useState("");
  const [packagingError, setPackagingError] = useState("");
  const [packagingSource, setPackagingSource] = useState("");
  const [packagingMigrationRequired, setPackagingMigrationRequired] = useState(false);
  const [shippingHealth, setShippingHealth] = useState<ShippingHealthResponse | null>(null);
  const [shippingHealthLoading, setShippingHealthLoading] = useState(false);
  const [shippingHealthError, setShippingHealthError] = useState("");
  const [paymentHealth, setPaymentHealth] = useState<PaymentHealthResponse | null>(null);
  const [paymentHealthLoading, setPaymentHealthLoading] = useState(false);
  const [paymentHealthError, setPaymentHealthError] = useState("");
  const [paymentFeeConfig, setPaymentFeeConfig] = useState<PaymentFeeConfig | null>(null);
  const [paymentFeeSaving, setPaymentFeeSaving] = useState(false);
  const [paymentFeeStatus, setPaymentFeeStatus] = useState("");
  const [paymentFeeError, setPaymentFeeError] = useState("");
  const [freeDeliveryConfig, setFreeDeliveryConfig] = useState<FreeDeliveryConfig | null>(null);
  const [savedFreeDeliveryConfig, setSavedFreeDeliveryConfig] = useState<FreeDeliveryConfig | null>(null);
  const [freeDeliveryEditing, setFreeDeliveryEditing] = useState(false);
  const [freeDeliveryUnlockOpen, setFreeDeliveryUnlockOpen] = useState(false);
  const [freeDeliverySaving, setFreeDeliverySaving] = useState(false);
  const [freeDeliveryStatus, setFreeDeliveryStatus] = useState("");
  const [freeDeliveryError, setFreeDeliveryError] = useState("");

  const bundleGroups = useMemo(
    () =>
      productOptions.map((product) => ({
        productSlug: product.slug,
        product: product.name,
        rows: bundles
          .filter((bundle) => bundle.productSlug === product.slug && !bundle.removed)
          .sort(compareBundleHierarchy),
      })),
    [bundles],
  );

  const changedBundleCount = bundles.filter((bundle) => {
    const original = savedBundles.find((row) => row.key === bundle.key);
    return bundle.added || bundle.removed || !original || JSON.stringify(original) !== JSON.stringify({ ...bundle, added: undefined, removed: undefined });
  }).length;
  const changedWarehouseCount = warehouses.filter((warehouse) => {
    const original = savedWarehouses.find((row) => row.key === warehouse.key);
    return warehouse.added || !original || JSON.stringify(original) !== JSON.stringify({ ...warehouse, added: undefined });
  }).length;
  const proposedChangeCount = changedBundleCount + changedWarehouseCount;

  useEffect(() => {
    if (!auth.session) return;
    let active = true;
    async function loadBundles() {
      setBundleLoading(true);
      setBundleError("");
      try {
        const result = await fetchBundleCatalog(await auth.getAccessToken());
        const rows = bundleRowsFromCatalog(result.catalog);
        if (active) {
          setBundles(rows);
          setSavedBundles(rows);
          setVolumePricing(volumePricingFromCatalog(result.catalog));
          setBundleSource(result.source || "");
        }
      } catch (error) {
        if (active) setBundleError(error instanceof Error ? error.message : "Could not load bundle catalog.");
      } finally {
        if (active) setBundleLoading(false);
      }
    }
    void loadBundles();
    return () => { active = false; };
  }, [auth]);

  useEffect(() => {
    if (!auth.session) return;
    let active = true;
    async function loadPackagingProfiles() {
      setPackagingLoading(true);
      setPackagingError("");
      try {
        const result = await fetchPackagingConfig(await auth.getAccessToken());
        if (active) {
          setPackagingConfig(result.config || null);
          setSavedPackagingConfig(result.config ? clonePackagingConfig(result.config) : null);
          setPackagingSource(result.source || "");
          setPackagingMigrationRequired(result.migrationRequired === true);
        }
      } catch (error) {
        if (active) {
          setPackagingError(error instanceof Error ? error.message : "Could not load packaging profiles.");
        }
      } finally {
        if (active) {
          setPackagingLoading(false);
        }
      }
    }
    void loadPackagingProfiles();
    return () => {
      active = false;
    };
  }, [auth]);

  useEffect(() => {
    if (!auth.session) return;
    let active = true;
    async function loadWarehouses() {
      setWarehouseLoading(true);
      setWarehouseError("");
      try {
        const result = await fetchWarehouseConfig(await auth.getAccessToken());
        if (active && Array.isArray(result.locations) && result.locations.length) {
          setWarehouses(result.locations);
          setSavedWarehouses(result.locations);
        }
      } catch (error) {
        if (active) setWarehouseError(error instanceof Error ? error.message : "Could not load warehouse locations.");
      } finally {
        if (active) setWarehouseLoading(false);
      }
    }
    void loadWarehouses();
    return () => {
      active = false;
    };
  }, [auth]);

  async function loadShippingHealth() {
    setShippingHealthLoading(true);
    setShippingHealthError("");
    try {
      setShippingHealth(await fetchShippingHealth(await auth.getAccessToken()));
    } catch (error) {
      setShippingHealthError(error instanceof Error ? error.message : "Could not load shipping health.");
    } finally {
      setShippingHealthLoading(false);
    }
  }

  useEffect(() => {
    if (!auth.session) return;
    void loadShippingHealth();
  }, [auth]);

  async function loadPaymentHealth() {
    setPaymentHealthLoading(true);
    setPaymentHealthError("");
    try {
      setPaymentHealth(await fetchPaymentHealth(await auth.getAccessToken()));
    } catch (error) {
      setPaymentHealthError(error instanceof Error ? error.message : "Could not load payment health.");
    } finally {
      setPaymentHealthLoading(false);
    }
  }

  useEffect(() => {
    if (!auth.session) return;
    let active = true;
    async function load() {
      setPaymentHealthLoading(true);
      setPaymentHealthError("");
      try {
        const result = await fetchPaymentHealth(await auth.getAccessToken());
        if (active) setPaymentHealth(result);
      } catch (error) {
        if (active) setPaymentHealthError(error instanceof Error ? error.message : "Could not load payment health.");
      } finally {
        if (active) setPaymentHealthLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [auth]);

  useEffect(() => {
    if (!auth.session) return;
    let active = true;
    void (async () => {
      try {
        const result = await fetchPaymentFeeConfig(await auth.getAccessToken());
        if (active) setPaymentFeeConfig(result.config);
      } catch (error) {
        if (active) setPaymentFeeError(error instanceof Error ? error.message : "Could not load fee profiles.");
      }
    })();
    return () => { active = false; };
  }, [auth]);

  async function savePaymentFees() {
    if (!paymentFeeConfig) return;
    setPaymentFeeSaving(true); setPaymentFeeError(""); setPaymentFeeStatus("");
    try {
      const result = await savePaymentFeeConfig(paymentFeeConfig, await auth.getAccessToken());
      setPaymentFeeConfig(result.config);
      setPaymentFeeStatus("Saved. New orders snapshot this estimate; Square actuals override it after payment.");
    } catch (error) {
      setPaymentFeeError(error instanceof Error ? error.message : "Could not save fee profiles.");
    } finally { setPaymentFeeSaving(false); }
  }

  useEffect(() => {
    if (!auth.session) return;
    let active = true;
    void (async () => {
      try {
        const result = await fetchFreeDeliveryConfig(await auth.getAccessToken());
        if (active) {
          setFreeDeliveryConfig(result.config);
          setSavedFreeDeliveryConfig(cloneFreeDeliveryConfig(result.config));
        }
      } catch (error) {
        if (active) setFreeDeliveryError(error instanceof Error ? error.message : "Could not load free-delivery settings.");
      }
    })();
    return () => { active = false; };
  }, [auth]);

  async function saveFreeDeliveryArea() {
    if (!freeDeliveryConfig) return;
    setFreeDeliverySaving(true);
    setFreeDeliveryError("");
    setFreeDeliveryStatus("");
    try {
      const result = await saveFreeDeliveryConfig(freeDeliveryConfig, await auth.getAccessToken());
      setFreeDeliveryConfig(result.config);
      setSavedFreeDeliveryConfig(cloneFreeDeliveryConfig(result.config));
      setFreeDeliveryEditing(false);
      setFreeDeliveryStatus(result.config.active ? "Free delivery area is active for new quotes." : "Saved as inactive.");
    } catch (error) {
      setFreeDeliveryError(error instanceof Error ? error.message : "Could not save free-delivery settings.");
    } finally {
      setFreeDeliverySaving(false);
    }
  }

  function discardFreeDeliveryChanges() {
    if (savedFreeDeliveryConfig) setFreeDeliveryConfig(cloneFreeDeliveryConfig(savedFreeDeliveryConfig));
    setFreeDeliveryEditing(false);
    setFreeDeliveryStatus("");
    setFreeDeliveryError("");
  }

  function updatePackaging(mutator: (config: PackagingConfig) => void) {
    setPackagingStatus("");
    setPackagingError("");
    setPackagingConfig((current) => {
      if (!current) return current;
      const next = clonePackagingConfig(current);
      mutator(next);
      return next;
    });
  }

  async function savePackagingProfiles() {
    if (!packagingConfig) return;
    setPackagingSaving(true);
    setPackagingStatus("");
    setPackagingError("");
    try {
      const result = await savePackagingConfig(packagingConfig, await auth.getAccessToken());
      setPackagingConfig(result.config || packagingConfig);
      setSavedPackagingConfig(clonePackagingConfig(result.config || packagingConfig));
      setPackagingSource(result.source || "");
      setPackagingMigrationRequired(false);
      setPackagingStatus("Packaging profiles saved. New checkout quotes and packing plans will use these dimensions.");
      setPackagingEditing(false);
    } catch (error) {
      setPackagingError(error instanceof Error ? error.message : "Could not save packaging profiles.");
    } finally {
      setPackagingSaving(false);
    }
  }

  function cancelPackagingEdits() {
    if (savedPackagingConfig) setPackagingConfig(clonePackagingConfig(savedPackagingConfig));
    setPackagingEditing(false);
    setPackagingStatus("");
    setPackagingError("");
  }

  async function persistBundleRows(nextRows: BundleRow[], successMessage: string, nextVolumePricing = volumePricing) {
    setBundleSaving(true);
    setBundleError("");
    setBundleStatus("");
    try {
      const proposedCatalog = catalogFromBundleRows(nextRows, nextVolumePricing);
      const result = await saveBundleCatalog(proposedCatalog, await auth.getAccessToken());
      const savedCatalog = result.catalog || proposedCatalog;
      const saved = bundleRowsFromCatalog(savedCatalog);
      setBundles(saved);
      setSavedBundles(saved);
      setVolumePricing(volumePricingFromCatalog(savedCatalog));
      setBundleSource(result.source || "");
      setBundleStatus(successMessage);
      return true;
    } catch (error) {
      setBundleError(error instanceof Error ? error.message : "Could not save bundle catalog.");
      return false;
    } finally {
      setBundleSaving(false);
    }
  }

  function openVolumePricing(productSlug: string, product: string) {
    const existing = volumePricing[productSlug];
    const oneCase = bundles.find((row) => row.productSlug === productSlug && row.kind === "case" && row.units === 1 && row.status === "active");
    const fallbackCents = Math.max(1, Number(oneCase?.priceCents || 1) - 100);
    setVolumePricingDraft({
      productSlug,
      product,
      active: existing?.active === true,
      minCases: String(existing?.minCases || 3),
      pricePerCase: ((existing?.pricePerCaseCents || fallbackCents) / 100).toFixed(2),
      allowDiscountStacking: existing?.allowDiscountStacking === true,
    });
  }

  async function saveVolumePricing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!volumePricingDraft) return;
    const rule: VolumePricingRule = {
      active: volumePricingDraft.active,
      minCases: Math.max(2, Number(volumePricingDraft.minCases) || 2),
      pricePerCaseCents: centsFromPrice(volumePricingDraft.pricePerCase),
      allowDiscountStacking: volumePricingDraft.allowDiscountStacking,
    };
    const nextRules = { ...volumePricing, [volumePricingDraft.productSlug]: rule };
    if (await persistBundleRows(bundles, `${volumePricingDraft.product} volume pricing saved. New storefront and admin quotes now use this rule.`, nextRules)) {
      setVolumePricingDraft(null);
    }
  }

  async function saveBundleDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!bundleDraft) return;
    const product = productOptions.find((candidate) => candidate.slug === bundleDraft.productSlug) || productOptions[0];
    const id = bundleDraft.key ? bundleDraft.id : bundleIdFromDraft(bundleDraft);
    const next: BundleRow = {
      key: `${product.slug}:${id}`,
      id,
      productSlug: product.slug,
      product: product.name,
      bundle: bundleDraft.bundle || "New bundle",
      kind: bundleDraft.kind,
      units: Math.max(1, Number(bundleDraft.units) || 1),
      priceCents: centsFromPrice(bundleDraft.price),
      cogsCents: centsFromPrice(bundleDraft.cogs),
      status: bundleDraft.status,
      added: !bundleDraft.key,
      sourceBundle: bundles.find((row) => row.key === bundleDraft.key)?.sourceBundle,
    };
    const proposed = bundleDraft.key ? bundles.map((row) => (row.key === bundleDraft.key ? next : row)) : [...bundles, next];
    if (await persistBundleRows(proposed, `${next.bundle} saved. Storefront, checkout, and Order Builder now use this bundle.`)) {
      setExpandedProducts((current) => ({ ...current, [next.product]: true }));
      setBundleDraft(null);
    }
  }

  const healthRuntime = shippingHealth?.runtime;
  const healthCounts = shippingHealth?.last24Hours?.counts || {};
  const healthFailureCount = Number(healthCounts.failed || 0) + Number(healthCounts.no_rates || 0) + Number(healthCounts.partial || 0);
  const shippoReady = Boolean(
    healthRuntime?.shippoConfigured === true &&
      Number(healthRuntime?.carrierAccountCount || 0) > 0 &&
      healthRuntime?.warehouseConfigured &&
      healthRuntime?.databasePurchaseLockEnabled,
  );
  const shippoHealthValue = shippingHealthLoading
    ? "Checking"
    : shippingHealthError
      ? "Unavailable"
      : shippoReady
        ? healthFailureCount > 0
          ? "Needs review"
          : "Ready"
        : "Setup required";
  const shippoHealthTone = shippingHealthError || !shippoReady ? "danger" : healthFailureCount > 0 ? "warning" : "success";
  const paymentRuntime = paymentHealth?.runtime;
  const paymentUnavailable = Boolean(paymentHealthError);
  const squareEnvironmentValue = paymentHealthLoading
    ? "Checking"
    : paymentUnavailable
      ? "Unavailable"
      : paymentRuntime?.environment === "sandbox"
        ? "Sandbox"
        : paymentRuntime?.environment === "production"
          ? "Production"
          : "Not configured";
  const squareEnvironmentTone = paymentUnavailable || paymentRuntime?.environmentConfigured !== true ? "danger" : "success";
  const squareEnvironmentDetail = paymentHealthLoading
    ? "Reading the active server configuration."
    : paymentUnavailable
      ? "The payment health endpoint could not read the current server configuration."
      : paymentRuntime?.environment === "production"
        ? "Square production credentials are active on the server."
        : paymentRuntime?.environment === "sandbox"
          ? "Square sandbox credentials are active on the server."
          : "Square environment is missing or invalid on the server.";
  const shippoEnvironmentTone = healthRuntime?.tokenMode === "live"
    ? "success"
    : healthRuntime?.tokenMode === "missing"
      ? "danger"
      : "warning";
  const shippoEnvironmentDetail = healthRuntime?.tokenMode === "live"
    ? "The active server token purchases real postage."
    : healthRuntime?.tokenMode === "test"
      ? "The active server token creates test quotes and labels."
      : "No Shippo API token is configured on the server.";
  const checkoutReady = Boolean(paymentRuntime?.embeddedCheckoutReady || paymentRuntime?.paymentLinkReady);
  const checkoutHealthValue = paymentHealthLoading ? "Checking" : paymentUnavailable ? "Unavailable" : checkoutReady ? "Ready" : "Setup required";
  const checkoutHealthTone = paymentUnavailable || !checkoutReady ? "danger" : "success";
  const webhookHealthValue = paymentHealthLoading
    ? "Checking"
    : paymentUnavailable
      ? "Unavailable"
      : paymentRuntime?.webhookSignatureConfigured
        ? "Configured"
        : "Missing";
  const webhookHealthTone = paymentUnavailable || !paymentRuntime?.webhookSignatureConfigured ? "danger" : "success";
  const checkoutAddressHealthValue = shippingHealthLoading
    ? "Checking"
    : shippingHealthError
      ? "Unavailable"
      : healthRuntime?.checkoutAddressValidationReady
        ? "Active"
        : "Setup required";
  const checkoutAddressHealthTone = shippingHealthError || !healthRuntime?.checkoutAddressValidationReady ? "danger" : "success";
  const warehouseAddressHealthValue = shippingHealthLoading
    ? "Checking"
    : shippingHealthError
      ? "Unavailable"
      : healthRuntime?.warehouseAddressValidationReady
        ? "Active"
        : "Setup required";
  const warehouseAddressHealthTone = shippingHealthError || !healthRuntime?.warehouseAddressValidationReady ? "danger" : "success";
  const paymentLinkEmailHealthValue = paymentHealthLoading
    ? "Checking"
    : paymentUnavailable
      ? "Unavailable"
      : paymentRuntime?.paymentLinkEmailReady
        ? "Ready"
        : "Email setup required";
  const paymentLinkEmailHealthTone = paymentUnavailable || !paymentRuntime?.paymentLinkEmailReady ? "danger" : "success";

  async function saveWarehouseDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!warehouseDraft) return;
    const fieldErrors = validateWarehouseDraft(warehouseDraft);
    if (Object.keys(fieldErrors).length) {
      setWarehouseFieldErrors(fieldErrors);
      setWarehouseDraftError("Check the highlighted fields before saving this warehouse.");
      return;
    }
    const next: WarehouseRow = { ...warehouseDraft, roles: [...warehouseDraft.roles] };
    const proposed = warehouses.some((row) => row.key === next.key)
      ? warehouses.map((row) => (row.key === next.key ? next : row))
      : [...warehouses, next];
    setWarehouseSaving(true);
    setWarehouseStatus("");
    setWarehouseDraftError("");
    setWarehouseFieldErrors({});
    setWarehouseAddressSuggestion(null);
    try {
      const result = await saveWarehouseConfig(
        proposed.map(({ added: _added, ...location }) => location),
        await auth.getAccessToken(),
      );
      setWarehouses(result.locations);
      setSavedWarehouses(result.locations);
      setWarehouseSource(result.source || "");
      setWarehouseStatus("Warehouse saved. New quotes, Shippo shipments, labels, and ship-from displays now use this address.");
      setWarehouseDraft(null);
    } catch (error) {
      const payload = error instanceof ApiError ? error.payload : {};
      const apiFieldErrors = payload.fieldErrors && typeof payload.fieldErrors === "object"
        ? payload.fieldErrors as Record<string, string>
        : {};
      setWarehouseFieldErrors({
        address1: apiFieldErrors.line1,
        city: apiFieldErrors.city,
        state: apiFieldErrors.state,
        zip: apiFieldErrors.postalCode,
      });
      setWarehouseAddressSuggestion(
        payload.addressSuggestion && typeof payload.addressSuggestion === "object"
          ? payload.addressSuggestion as WarehouseAddressSuggestion
          : null,
      );
      setWarehouseDraftError(error instanceof Error ? error.message : "Could not save warehouse location.");
    } finally {
      setWarehouseSaving(false);
    }
  }

  function openWarehouseDraft(row?: WarehouseRow) {
    setWarehouseDraftError("");
    setWarehouseFieldErrors({});
    setWarehouseAddressSuggestion(null);
    setWarehouseDraft(makeWarehouseDraft(row));
  }

  function updateWarehouseDraft(patch: Partial<WarehouseDraft>) {
    setWarehouseDraft((current) => current ? { ...current, ...patch } : current);
    setWarehouseDraftError("");
    setWarehouseFieldErrors({});
    setWarehouseAddressSuggestion(null);
  }

  function requestFlowToggle(key: FlowToggleKey, label: string, enabled: boolean) {
    setPendingFlowToggle({ key, label, enabled });
  }

  function confirmFlowToggle() {
    if (!pendingFlowToggle) return;
    const setters: Record<FlowToggleKey, (enabled: boolean) => void> = {
      onlineCheckout: setOnlineCheckout,
      manualOrders: setManualOrders,
      localDelivery: setLocalDelivery,
      b2bShipping: setB2bShipping,
      pickup: setPickup,
      walkIn: setWalkIn,
    };
    setters[pendingFlowToggle.key](pendingFlowToggle.enabled);
    setPendingFlowToggle(null);
  }

  const bundleHasChanges = bundleDraft
    ? !bundleDraft.key ||
      JSON.stringify(makeBundleDraft(bundles.find((row) => row.key === bundleDraft.key))) !== JSON.stringify(bundleDraft)
    : false;

  const warehouseHasChanges = warehouseDraft
    ? !savedWarehouses.some((row) => row.key === warehouseDraft.key) ||
      JSON.stringify(makeWarehouseDraft(warehouses.find((row) => row.key === warehouseDraft.key))) !== JSON.stringify(warehouseDraft)
    : false;

  return (
    <div className="space-y-5">
      <header className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[12px] font-bold text-sg-primary">Sensitive operations</p>
          <h1 className="text-[42px] font-bold leading-none tracking-normal">Advanced Setting</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill>{products.length} products</StatusPill>
          <StatusPill>{bundles.filter((row) => !row.removed).length} bundles</StatusPill>
          <StatusPill>{warehouses.length} locations</StatusPill>
        </div>
      </header>

      <section className="grid min-w-0 gap-4 2xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
        <div className="min-w-0 space-y-4">
          <section className="sg25-card min-w-0 overflow-hidden p-4 md:p-5">
            <SectionTitle
              icon="receipt"
              title="Bundle Pricing"
              description="Manage the live bundle catalog shared by storefront, checkout, and the manual Order Builder."
              action={<button type="button" className="sg25-btn sg25-btn-ghost" disabled={bundleLoading || bundleSaving} onClick={() => setBundleDraft(makeBundleDraft())}>Add bundle</button>}
            />
            {bundleError ? <p className="mt-3 rounded-[8px] bg-sg-danger-soft px-3 py-2 text-[13px] font-bold text-sg-danger">{bundleError}</p> : null}
            {bundleStatus ? <p className="mt-3 rounded-[8px] bg-sg-success-soft px-3 py-2 text-[13px] font-bold text-sg-success">{bundleStatus}</p> : null}
            <div className="mt-4 space-y-2">
              {bundleGroups.map((group) => {
                const open = !!expandedProducts[group.product];
                return (
                  <section key={group.product} className="min-w-0 overflow-hidden rounded-[8px] border border-sg-border bg-white">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                      onClick={() => setExpandedProducts((current) => ({ ...current, [group.product]: !open }))}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <Icon name="chevron" className={`h-4 w-4 shrink-0 text-sg-muted transition ${open ? "rotate-180" : "-rotate-90"}`} />
                        <span className="truncate text-[15px] font-bold">{group.product}</span>
                      </span>
                      <span className="shrink-0 text-[13px] font-bold text-sg-muted">{group.rows.length} bundles</span>
                    </button>
                    {open ? (
                      <div className="min-w-0">
                        <div className="overflow-x-auto">
                        <table className="w-full min-w-[760px] text-left text-[13px]">
                          <thead className="text-[11px] uppercase text-sg-muted">
                            <tr>
                              {["Bundle", "Fulfills as", "Price", "COGS", "Profit", "Status", "Actions"].map((heading) => (
                                <th key={heading} className="border-t border-sg-border px-4 py-2 font-bold">{heading}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {group.rows.map((row, index) => {
                              const last = index === group.rows.length - 1;
                              const border = last ? "" : "border-b border-sg-border";
                              return (
                                <tr key={row.key}>
                                  <td className={`${border} px-4 py-3 font-bold`}>{row.bundle}</td>
                                  <td className={`${border} px-4 py-3 font-bold text-sg-muted`}>{row.units} {row.kind === "case" ? (row.units === 1 ? "carton" : "cartons") : (row.units === 1 ? "box" : "boxes")}</td>
                                  <td className={`${border} px-4 py-3 font-bold`}>{money(row.priceCents)}</td>
                                  <td className={`${border} px-4 py-3 font-bold text-sg-muted`}>{money(rowCogsCents(row))}</td>
                                  <td className={`${border} px-4 py-3 font-bold text-sg-success`}>{money(grossProfitCents(row))}</td>
                                  <td className={`${border} px-4 py-3`}><StatusPill tone={row.status === "active" ? "success" : "danger"}>{row.status === "active" ? "Active" : "Inactive"}</StatusPill></td>
                                  <td className={`${border} px-4 py-3`}>
                                    <div className="flex justify-end gap-2">
                                      <button type="button" className="sg25-btn sg25-btn-ghost h-9 w-9 justify-center rounded-[8px] px-0" aria-label={`Edit ${row.bundle}`} onClick={() => setBundleDraft(makeBundleDraft(row))}>
                                        <Icon name="edit" className="h-4 w-4" />
                                      </button>
                                      <button
                                        type="button"
                                        className="sg25-btn sg25-btn-ghost h-9 w-9 justify-center rounded-[8px] px-0 text-sg-danger"
                                        aria-label={`Remove ${row.bundle}`}
                                        title="Remove bundle"
                                        onClick={() => {
                                          setRemoveConfirmText("");
                                          setRemoveBundle(row);
                                        }}
                                      >
                                        <Icon name="trash" className="h-4 w-4" />
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        </div>
                        <div className="flex flex-col gap-3 border-t border-sg-border bg-sg-input-bg px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="text-[13px] font-bold">Automatic volume pricing</p>
                            {volumePricing[group.productSlug] ? (
                              <p className="mt-1 text-[11px] text-sg-muted">
                                {volumePricing[group.productSlug].active ? "Active" : "Disabled"} · {volumePricing[group.productSlug].minCases}+ cartons at {money(volumePricing[group.productSlug].pricePerCaseCents)} each · discounts {volumePricing[group.productSlug].allowDiscountStacking ? "can stack" : "do not stack"}
                              </p>
                            ) : <p className="mt-1 text-[11px] text-sg-muted">Not configured. Standard bundle prices apply.</p>}
                          </div>
                          <button type="button" className="sg25-btn sg25-btn-ghost shrink-0" disabled={bundleSaving} onClick={() => openVolumePricing(group.productSlug, group.product)}>
                            {volumePricing[group.productSlug] ? "Edit rule" : "Add rule"}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
            <p className="mt-3 text-[12px] font-semibold text-sg-muted">{bundleLoading ? "Loading the live bundle catalog..." : `Source: ${bundleSource || "bundled defaults"}. Changes save immediately after server-side packaging validation.`}</p>
          </section>

          <section className="sg25-card min-w-0 overflow-hidden p-4 md:p-5">
            <SectionTitle
              icon="package"
              title="Packaging Profiles"
              description="Review the physical dimensions and packing rules used for checkout quotes, Shippo parcels, and warehouse packing."
              action={
                <div className="flex flex-wrap gap-2">
                  {packagingEditing ? (
                    <>
                      <button type="button" className="sg25-btn sg25-btn-ghost" disabled={packagingSaving} onClick={cancelPackagingEdits}>Discard edits</button>
                      <button type="button" className="sg25-btn sg25-btn-primary" disabled={!packagingConfig || packagingSaving} onClick={() => void savePackagingProfiles()}>
                        {packagingSaving ? "Saving" : "Save profiles"}
                      </button>
                    </>
                  ) : (
                    <button type="button" className="sg25-btn sg25-btn-ghost" disabled={!packagingConfig || packagingLoading} onClick={() => { setPackagingUnlockText(""); setPackagingUnlockOpen(true); }}>
                      <Icon name="lock" className="h-4 w-4" />
                      Unlock editing
                    </button>
                  )}
                </div>
              }
            />
            {packagingMigrationRequired ? <p className="mt-3 rounded-[8px] bg-sg-warning-soft px-3 py-2 text-[13px] font-bold text-sg-warning">Install sql/patch-runtime-packaging-settings.sql, then save these profiles to make them durable.</p> : null}
            {packagingSource ? <p className="mt-2 text-[11px] font-semibold text-sg-muted">Active source: {packagingSource === "supabase" ? "Supabase" : "bundled defaults"}</p> : null}
            {packagingError ? <p className="mt-3 rounded-[8px] bg-sg-danger-soft px-3 py-2 text-[13px] font-bold text-sg-danger">{packagingError}</p> : null}
            {packagingStatus ? <p className="mt-3 rounded-[8px] bg-sg-success-soft px-3 py-2 text-[13px] font-bold text-sg-success">{packagingStatus}</p> : null}
            {packagingLoading ? <p className="mt-4 rounded-[8px] border border-sg-border bg-sg-input-bg px-3 py-3 text-[13px] text-sg-muted">Loading packaging profiles...</p> : null}
            {!packagingLoading && packagingConfig ? (
              <>
                <div className="mt-5 space-y-3 select-text" style={{ userSelect: "text" }}>
                  <section>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                      <div>
                        <h3 className="text-[17px] font-bold">Packing materials and cartons</h3>
                        <p className="mt-1 text-[12px] leading-5 text-sg-muted">Choose the smallest approved outer package that fits the order. Factory cases ship unopened.</p>
                      </div>
                      {packagingEditing ? (
                        <button type="button" className="sg25-btn sg25-btn-ghost" onClick={() => updatePackaging((config) => { config.shippingCartons = [...(config.shippingCartons || []), makePackagingCarton()]; })}>
                          Add carton
                        </button>
                      ) : null}
                    </div>
                    <div className="mt-4 space-y-2">
                      {[
                        { type: "corrugated_carton", title: "Loose-box shipping cartons", detail: "For orders that do not fill a sealed 10-box factory case." },
                        { type: "factory_case", title: "Factory cases", detail: "Original manufacturer cartons shipped as received after inspection." },
                      ].map((group) => {
                        const cartons = (packagingConfig.shippingCartons || []).map((carton, index) => ({ carton, index })).filter(({ carton }) => carton.packageType === group.type);
                        if (!cartons.length) return null;
                        return (
                          <details key={group.type} className="group rounded-[8px] border border-sg-border bg-white">
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 [&::-webkit-details-marker]:hidden">
                              <div>
                                <p className="text-[14px] font-bold">{group.title}</p>
                                <p className="mt-0.5 text-[11px] text-sg-muted">{group.detail}</p>
                              </div>
                              <span className="flex shrink-0 items-center gap-2">
                                <StatusPill>{cartons.length} profiles</StatusPill>
                                <Icon name="chevron" className="h-4 w-4 text-sg-muted transition-transform group-open:rotate-180" />
                              </span>
                            </summary>
                            <div className="grid gap-3 border-t border-sg-border p-3 xl:grid-cols-2">
                              {cartons.map(({ carton, index }) => (
                                <article key={carton.id || index} className="rounded-[8px] border border-sg-border bg-white p-4">
                                  {packagingEditing ? (
                                    <div className="space-y-4">
                                      <div className="flex items-start gap-3">
                                        <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[1.3fr_0.7fr]">
                                          <Field label="Profile name"><input className="sg25-input" value={carton.label || ""} onChange={(event) => updatePackaging((config) => { config.shippingCartons![index].label = event.target.value; })} /></Field>
                                          <Field label="Package type"><input className="sg25-input" value={carton.packageType || ""} onChange={(event) => updatePackaging((config) => { config.shippingCartons![index].packageType = event.target.value; })} /></Field>
                                        </div>
                                        <button type="button" className="sg25-btn sg25-btn-ghost h-10 w-10 justify-center px-0 text-sg-danger" aria-label={`Remove ${carton.label || "carton"}`} disabled={(packagingConfig.shippingCartons || []).length <= 1} onClick={() => updatePackaging((config) => { config.shippingCartons = (config.shippingCartons || []).filter((_, cartonIndex) => cartonIndex !== index); })}>
                                          <Icon name="trash" className="h-4 w-4" />
                                        </button>
                                      </div>
                                      <div className="rounded-[8px] bg-sg-input-bg p-3">
                                        <p className="text-[12px] font-bold">Outer package dimensions</p>
                                        <div className="mt-3 grid gap-3 sm:grid-cols-3">
                                          {(["length", "width", "height"] as const).map((field) => <PackagingNumberField key={field} label={field[0].toUpperCase() + field.slice(1)} suffix="in" value={carton.outer?.[field]} onChange={(value) => updatePackaging((config) => { config.shippingCartons![index].outer![field] = packagingNumberFromInput(value); })} />)}
                                        </div>
                                      </div>
                                      <div className="rounded-[8px] bg-sg-input-bg p-3">
                                        <p className="text-[12px] font-bold">Fit and operating limits</p>
                                        <div className="mt-3 grid gap-3 sm:grid-cols-3">
                                          {(["length", "width", "height"] as const).map((field) => <PackagingNumberField key={field} label={`Max box ${field[0].toUpperCase()}`} suffix="in" value={carton.maxRetailBox?.[field]} onChange={(value) => updatePackaging((config) => { config.shippingCartons![index].maxRetailBox![field] = packagingNumberFromInput(value); })} />)}
                                          <PackagingNumberField label="Box capacity" value={carton.maxRetailBoxes} onChange={(value) => updatePackaging((config) => { config.shippingCartons![index].maxRetailBoxes = packagingNumberFromInput(value); })} />
                                          <PackagingNumberField label="Max weight" suffix="lb" value={carton.maxWeightLb} onChange={(value) => updatePackaging((config) => { config.shippingCartons![index].maxWeightLb = packagingNumberFromInput(value); })} />
                                          <PackagingNumberField label="Empty carton" suffix="lb" value={carton.tareWeightLb} onChange={(value) => updatePackaging((config) => { config.shippingCartons![index].tareWeightLb = packagingNumberFromInput(value); })} />
                                          <PackagingNumberField label="Material cost" suffix="cents" value={carton.costCents} onChange={(value) => updatePackaging((config) => { config.shippingCartons![index].costCents = packagingNumberFromInput(value); })} />
                                        </div>
                                      </div>
                                    </div>
                                  ) : (
                                    <>
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                          <h4 className="text-[14px] font-bold leading-5">{carton.label || carton.id}</h4>
                                          <p className="mt-1 text-[11px] font-semibold text-sg-muted">{packagingTypeLabel(carton.packageType)}</p>
                                        </div>
                                        <StatusPill>{packagingNumberValue(carton.maxRetailBoxes) || "-"} {Number(carton.maxRetailBoxes) === 1 ? "box" : "boxes"}</StatusPill>
                                      </div>
                                      <div className="mt-4 grid gap-3 border-y border-sg-border py-3 sm:grid-cols-2 lg:grid-cols-4">
                                        <PackagingMetric label="Outer size" value={packagingDimensions(carton.outer)} />
                                        <PackagingMetric label="Maximum weight" value={`${packagingNumberValue(carton.maxWeightLb) || "-"} lb`} />
                                        <PackagingMetric label="Empty weight" value={`${packagingNumberValue(carton.tareWeightLb) || "-"} lb`} />
                                        <PackagingMetric label="Material cost" value={Number(carton.costCents) ? money(Number(carton.costCents)) : "$0.00"} />
                                      </div>
                                    </>
                                  )}
                                </article>
                              ))}
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  </section>

                  <details className="group rounded-[8px] border border-sg-border bg-white">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 [&::-webkit-details-marker]:hidden">
                      <div>
                        <h3 className="text-[17px] font-bold">Product package dimensions</h3>
                        <p className="mt-0.5 text-[12px] leading-4 text-sg-muted">Retail-box measurements determine carton fit. Factory-case measurements determine the parcel sent to the carrier.</p>
                      </div>
                      <Icon name="chevron" className="h-4 w-4 shrink-0 text-sg-muted transition-transform group-open:rotate-180" />
                    </summary>
                    <div className="space-y-3 border-t border-sg-border p-3">
                      {Object.entries(packagingConfig.products || {}).map(([slug, product]) => {
                        const sizeRows = Object.entries(product.sizes || {});
                        const sameAcrossSizes = sizeRows.length > 0 && sizeRows.every(([, profile]) => JSON.stringify(profile) === JSON.stringify(sizeRows[0][1]));
                        const sharedProfile = sizeRows[0]?.[1];
                        return (
                          <article key={slug} className="rounded-[8px] border border-sg-border bg-white p-4">
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                              <div><h4 className="text-[15px] font-bold">{packagingProductLabel(slug)}</h4><p className="mt-1 text-[11px] font-semibold text-sg-muted">{product.boxesPerFactoryCase || 10} boxes per factory case</p></div>
                              <StatusPill tone={product.factoryCaseShipAsIs ? "success" : "warning"}>{product.factoryCaseShipAsIs ? "Case ships unopened" : "Repack case"}</StatusPill>
                            </div>
                            {packagingEditing ? (
                              <div className="mt-4 space-y-3">
                                {sizeRows.map(([size, profile]) => (
                                  <div key={size} className="rounded-[8px] bg-sg-input-bg p-3">
                                    <p className="text-[13px] font-bold">{size}</p>
                                    <div className="mt-3 grid gap-4 lg:grid-cols-2">
                                      {(["retailUnit", "factoryCase"] as const).map((kind) => (
                                        <div key={kind}>
                                          <p className="text-[11px] font-bold uppercase text-sg-muted">{kind === "retailUnit" ? "Retail box" : "Factory case"}</p>
                                          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                                            {(["length", "width", "height", "weightLb"] as const).map((field) => (
                                              <PackagingNumberField key={field} label={field === "weightLb" ? "Weight" : field[0].toUpperCase()} suffix={field === "weightLb" ? "lb" : "in"} value={profile[kind]?.[field]} onChange={(value) => updatePackaging((config) => { config.products![slug].sizes![size][kind]![field] = packagingNumberFromInput(value); })} />
                                            ))}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : sameAcrossSizes && sharedProfile ? (
                              <div className="mt-4 grid gap-4 rounded-[8px] bg-sg-input-bg p-3 sm:grid-cols-2">
                                <div><p className="text-[11px] font-bold uppercase text-sg-muted">Retail box · all sizes</p><p className="mt-2 text-[13px] font-bold">{packagingDimensions(sharedProfile.retailUnit)}</p><p className="mt-1 text-[12px] text-sg-muted">{packagingNumberValue(sharedProfile.retailUnit?.weightLb) || "-"} lb each</p></div>
                                <div><p className="text-[11px] font-bold uppercase text-sg-muted">Factory case · all sizes</p><p className="mt-2 text-[13px] font-bold">{packagingDimensions(sharedProfile.factoryCase)}</p><p className="mt-1 text-[12px] text-sg-muted">{packagingNumberValue(sharedProfile.factoryCase?.weightLb) || "-"} lb each</p></div>
                              </div>
                            ) : (
                              <div className="mt-4 divide-y divide-sg-border rounded-[8px] bg-sg-input-bg px-3">
                                {sizeRows.map(([size, profile]) => <div key={size} className="grid gap-2 py-3 sm:grid-cols-[100px_1fr_1fr]"><p className="text-[12px] font-bold">{size}</p><p className="text-[12px]"><span className="text-sg-muted">Retail:</span> {packagingDimensions(profile.retailUnit)} · {packagingNumberValue(profile.retailUnit?.weightLb)} lb</p><p className="text-[12px]"><span className="text-sg-muted">Case:</span> {packagingDimensions(profile.factoryCase)} · {packagingNumberValue(profile.factoryCase?.weightLb)} lb</p></div>)}
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  </details>

                </div>
              </>
            ) : null}
          </section>

          <section className="sg25-card p-4 md:p-5">
            <SectionTitle icon="pin" title="Warehouse Locations" description="Manage ship-from, return, and operational location records." />
            {warehouseError ? <div className="mt-4 rounded-[8px] bg-sg-danger-soft px-4 py-3 text-[13px] font-semibold text-sg-danger">{warehouseError}</div> : null}
            {warehouseStatus ? <div className="mt-4 rounded-[8px] bg-sg-success-soft px-4 py-3 text-[13px] font-semibold text-sg-success">{warehouseStatus}</div> : null}
            <div className="mt-5 overflow-hidden rounded-[8px] border border-sg-border bg-white">
              <div className="flex flex-col gap-3 border-b border-sg-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[14px] font-bold">Locations</p>
                  <p className="mt-1 text-[12px] text-sg-muted">Use one record per warehouse. Roles can support shipping, returns, and inventory later.</p>
                </div>
                <button type="button" className="sg25-btn sg25-btn-ghost" disabled={warehouseLoading || warehouseSaving} onClick={() => openWarehouseDraft()}>Add location</button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-[13px]">
                  <thead className="text-[11px] uppercase text-sg-muted">
                    <tr>
                      {["Location", "Roles", "Carrier contact", "Status", "Actions"].map((heading) => (
                        <th key={heading} className="border-b border-sg-border px-4 py-2 font-bold last:text-right">{heading}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {warehouses.map((row, index) => {
                      const border = index === warehouses.length - 1 ? "" : "border-b border-sg-border";
                      return (
                        <tr key={row.key}>
                          <td className={`${border} px-4 py-3`}>
                            <p className="font-bold">{row.name}</p>
                            <p className="mt-1 text-[12px] leading-5 text-sg-muted">{formatAddress(row)}</p>
                          </td>
                          <td className={`${border} px-4 py-3`}>
                            <div className="flex flex-wrap gap-1.5">
                              {row.roles.map((role) => <span key={role} className="rounded-full bg-sg-input-bg px-2.5 py-1 text-[11px] font-bold text-sg-muted">{role}</span>)}
                            </div>
                          </td>
                          <td className={`${border} px-4 py-3`}>
                            <p className="font-semibold">{row.email}</p>
                            <p className="mt-1 text-[12px] text-sg-muted">{row.phone}</p>
                          </td>
                          <td className={`${border} px-4 py-3`}><StatusPill tone={row.active ? "success" : "danger"}>{row.active ? "Active" : "Inactive"}</StatusPill></td>
                          <td className={`${border} px-4 py-3 text-right`}>
                            <button type="button" className="sg25-btn sg25-btn-ghost inline-flex h-9 w-9 justify-center rounded-[8px] px-0" aria-label={`Edit ${row.name}`} onClick={() => openWarehouseDraft(row)}>
                              <Icon name="edit" className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {warehouseLoading || changedWarehouseCount ? (
                <p className="px-4 py-3 text-[12px] font-semibold text-sg-muted">
                  {warehouseLoading ? "Loading authoritative warehouse..." : `${changedWarehouseCount} proposed warehouse change${changedWarehouseCount === 1 ? "" : "s"}.`}
                </p>
              ) : null}
            </div>
          </section>

          <section className="sg25-card p-4 md:p-5">
            <SectionTitle icon="pin" title="Address Validation" description="Control how customer and warehouse addresses are checked before quotes and labels." />
            <div className="mt-5 grid gap-3">
              <Field label="Validation method">
                <CustomSelect value={addressValidationMode} options={addressValidationOptions} onChange={setAddressValidationMode} ariaLabel="Address validation method" className="w-full" triggerClassName="h-11 w-full rounded-[7px] bg-white px-4 pr-3 text-[13px]" panelClassName="left-0 right-auto w-full" />
              </Field>
              <div className="grid gap-2 md:grid-cols-2">
                <SettingRow label="Checkout address check" value={checkoutAddressHealthValue} tone={checkoutAddressHealthTone} detail="Shippo validates customer addresses before quoting and again before payment." />
                <SettingRow label="Warehouse address check" value={warehouseAddressHealthValue} tone={warehouseAddressHealthTone} detail="Shippo validates every warehouse address before the authoritative record is saved." />
              </div>
              {shippingHealthError ? (
                <div className="flex flex-col gap-2 rounded-[8px] border border-sg-danger/30 bg-sg-danger-soft px-3 py-3 text-[12px] text-sg-danger sm:flex-row sm:items-center sm:justify-between" role="alert">
                  <span>{shippingHealthError}</span>
                  <button type="button" className="sg25-btn sg25-btn-ghost h-8 shrink-0 px-3" onClick={() => void loadShippingHealth()} disabled={shippingHealthLoading}>
                    {shippingHealthLoading ? "Retrying" : "Retry"}
                  </button>
                </div>
              ) : null}
            </div>
          </section>

          <section className="sg25-card p-4 md:p-5">
            <SectionTitle icon="cart" title="Order Flow Toggles" description="Stage which admin and customer order paths should be available." />
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <ToggleSetting label="Online checkout" detail="Customer-facing checkout remains available." enabled={onlineCheckout} onChange={(enabled) => requestFlowToggle("onlineCheckout", "Online checkout", enabled)} />
              <ToggleSetting label="Manual order builder" detail="Admins can create remote call-in orders." enabled={manualOrders} onChange={(enabled) => requestFlowToggle("manualOrders", "Manual order builder", enabled)} />
              <ToggleSetting label="Local delivery" detail="Admins can create local delivery handoff orders." enabled={localDelivery} onChange={(enabled) => requestFlowToggle("localDelivery", "Local delivery", enabled)} />
              <ToggleSetting label="B2B shipping" detail="Custom freight and large-route order option." enabled={b2bShipping} onChange={(enabled) => requestFlowToggle("b2bShipping", "B2B shipping", enabled)} />
              <ToggleSetting label="Pickup fulfillment" detail="Kept off until storefront pickup is ready." enabled={pickup} onChange={(enabled) => requestFlowToggle("pickup", "Pickup fulfillment", enabled)} />
              <ToggleSetting label="Walk-in sale" detail="Kept off until storefront workflows are ready." enabled={walkIn} onChange={(enabled) => requestFlowToggle("walkIn", "Walk-in sale", enabled)} />
            </div>
          </section>

          <section className="sg25-card p-4 md:p-5">
            <SectionTitle icon="tag" title="Discount Rules" description="Stage discount-code behavior and manual review defaults for checkout pricing." />
            <div className="mt-5 grid gap-3">
              <Field label="Discount review mode">
                <CustomSelect value={discountMode} options={discountModeOptions} onChange={setDiscountMode} ariaLabel="Discount review mode" className="w-full" triggerClassName="h-11 w-full rounded-[7px] bg-white px-4 pr-3 text-[13px]" panelClassName="left-0 right-auto w-full" />
              </Field>
              <SettingRow label="Discount code audit" value="Required" tone="success" detail="Every future backend discount change should be logged with actor, time, and previous value." />
              <SettingRow label="Stacking behavior" value="One code per order" detail="Prevents multiple customer-facing discounts from compounding unexpectedly." />
            </div>
          </section>

          <section className="sg25-card p-4 md:p-5">
            <SectionTitle icon="package" title="Inventory Safety Settings" description="Control oversell protection, stock warnings, and when inventory is reserved." />
            <div className="mt-5 grid gap-3">
              <Field label="Stock deduction timing">
                <CustomSelect value={stockDeductionPoint} options={stockDeductionOptions} onChange={setStockDeductionPoint} ariaLabel="Stock deduction timing" className="w-full" triggerClassName="h-11 w-full rounded-[7px] bg-white px-4 pr-3 text-[13px]" panelClassName="left-0 right-auto w-full" />
              </Field>
              <div className="grid gap-3 md:grid-cols-2">
                <ToggleSetting label="Block oversell" detail="Prevent checkout and manual orders from exceeding available stock." enabled={blockOversell} onChange={setBlockOversell} />
                <div className="flex min-h-[74px] flex-col gap-3 rounded-[8px] border border-sg-border bg-white px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-[13px] font-bold">Low-stock warning threshold</p>
                    <p className="mt-1 text-[12px] leading-5 text-sg-muted">Flag product variants when available units fall below this number.</p>
                  </div>
                  <input className="sg25-input h-9 w-full sm:w-[132px]" value={lowStockThreshold} inputMode="numeric" onChange={(event) => setLowStockThreshold(wholeNumberOnly(event.target.value))} />
                </div>
              </div>
              <SettingRow label="Inventory movement audit" value="Required" tone="success" detail="Every backend stock adjustment should produce a readable audit event." />
            </div>
          </section>
        </div>

        <aside className="min-w-0 space-y-4">
          <section className="sg25-card p-4 md:p-5">
            <SectionTitle icon="truck" title="Shipping Controls" description="Set provider behavior, buffer, and label defaults." />
            <div className="mt-5 space-y-3">
              <Field label="Rate provider">
                <CustomSelect value={shippingProvider} options={shippingProviderOptions} onChange={setShippingProvider} ariaLabel="Rate provider" className="w-full" triggerClassName="h-11 w-full rounded-[7px] bg-white px-4 pr-3 text-[13px]" panelClassName="left-0 right-auto w-full" />
              </Field>
              <GuardedValue label="Shipping buffer" value={`$${shippingBuffer}`} detail="Added to quoted carrier rates." onEdit={() => setBufferDraft(shippingBuffer)} />
              <Field label="Label format">
                <CustomSelect value={labelFormat} options={labelFormatOptions} onChange={setLabelFormat} ariaLabel="Label format" className="w-full" triggerClassName="h-11 w-full rounded-[7px] bg-white px-4 pr-3 text-[13px]" panelClassName="left-0 right-auto w-full" />
              </Field>
              <div className="rounded-[8px] border border-sg-border px-3 py-3 text-[13px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold">Shippo environment</span>
                  <StatusPill tone={shippoEnvironmentTone}>
                    {healthRuntime?.tokenMode === "live" ? "Live" : healthRuntime?.tokenMode === "missing" ? "Missing" : "Test"}
                  </StatusPill>
                </div>
                <p className="mt-0.5 text-[12px] leading-4 text-sg-muted">{shippoEnvironmentDetail}</p>
              </div>
              <SettingRow
                label="Shippo provider health"
                value={shippoHealthValue}
                tone={shippoHealthTone}
                detail={
                  shippingHealthError ||
                  shippingHealth?.warning ||
                  `${healthRuntime?.carrierAccountCount || 0} carrier account · warehouse ${healthRuntime?.warehouseConfigured ? "ready" : "missing"} · purchase lock ${healthRuntime?.databasePurchaseLockEnabled ? "on" : "off"}`
                }
              />
              <SettingRow
                label="Shipping activity (24 hours)"
                value={shippingHealth?.telemetryAvailable ? `${shippingHealth.last24Hours?.total || 0} checks` : "No history"}
                tone={healthFailureCount > 0 ? "warning" : shippingHealth?.telemetryAvailable ? "success" : "neutral"}
                detail={`${Number(healthCounts.success || 0)} successful · ${Number(healthCounts.no_rates || 0)} no-rate · ${Number(healthCounts.failed || 0)} failed · ${Number(healthCounts.partial || 0)} partial`}
              />
            </div>
            {freeDeliveryConfig ? (
              <div className="mt-5 rounded-[9px] border border-sg-border bg-sg-canvas/60 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-[13px] font-bold">Free Delivery Area</p>
                    <p className="mt-1 text-[11px] leading-5 text-sg-muted">Eligible orders become free local delivery. Shippo rating and carrier-label purchase are bypassed.</p>
                  </div>
                  {freeDeliveryEditing ? (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <button type="button" className="sg25-btn sg25-btn-ghost h-9 px-4" onClick={discardFreeDeliveryChanges} disabled={freeDeliverySaving}>Discard</button>
                      <button type="button" className="sg25-btn sg25-btn-primary h-9 px-4" onClick={() => void saveFreeDeliveryArea()} disabled={freeDeliverySaving}>
                        {freeDeliverySaving ? "Saving" : "Save area"}
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="sg25-btn sg25-btn-ghost h-9 shrink-0 px-4" onClick={() => setFreeDeliveryUnlockOpen(true)}>
                      <Icon name="lock" className="h-4 w-4" /> Unlock editing
                    </button>
                  )}
                </div>
                {!freeDeliveryEditing ? (
                  <div className="mt-4 space-y-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="rounded-[9px] border border-sg-border bg-white p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-sg-muted">Current status</p>
                            <p className="mt-2 text-[16px] font-bold">Free local delivery</p>
                            <p className="mt-1 text-[12px] leading-5 text-sg-muted">
                              {freeDeliveryConfig.active
                                ? "Qualifying orders bypass Shippo and enter the local-delivery workflow."
                                : "The rule is saved but is not being offered to customers."}
                            </p>
                          </div>
                          <StatusPill tone={freeDeliveryConfig.active ? "success" : "neutral"}>{freeDeliveryConfig.active ? "Active" : "Inactive"}</StatusPill>
                        </div>
                      </div>
                      <div className="rounded-[9px] border border-sg-border bg-white p-4">
                        <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-sg-muted">Delivery area</p>
                        <p className="mt-2 text-[16px] font-bold">
                          {usStateOptions.find((option) => option.value === freeDeliveryConfig.state)?.label || freeDeliveryConfig.state || "Not configured"}
                        </p>
                        <p className="mt-1 text-[12px] leading-5 text-sg-muted">
                          {freeDeliveryConfig.postalCodes.length === 1
                            ? "1 eligible ZIP code"
                            : `${freeDeliveryConfig.postalCodes.length} eligible ZIP codes`}
                        </p>
                      </div>
                    </div>

                    <div className="rounded-[9px] border border-sg-border bg-white p-4">
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                          <p className="text-[13px] font-bold">Minimum order total</p>
                          <p className="mt-1 text-[11px] leading-4 text-sg-muted">The complete post-discount merchandise subtotal must reach this amount.</p>
                        </div>
                        <p className="text-[17px] font-bold">{money(freeDeliveryConfig.minimumSubtotalCents)}</p>
                      </div>
                    </div>

                    <div className="rounded-[9px] border border-sg-border bg-white p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[13px] font-bold">Eligible ZIP codes</p>
                        <span className="text-[11px] font-semibold text-sg-muted">{freeDeliveryConfig.postalCodes.length} total</span>
                      </div>
                      {freeDeliveryConfig.postalCodes.length ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {freeDeliveryConfig.postalCodes.map((postalCode) => (
                            <span key={postalCode} className="inline-flex rounded-full border border-sg-border bg-sg-canvas px-3 py-1.5 text-[12px] font-bold">{postalCode}</span>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-3 rounded-[8px] bg-sg-canvas px-3 py-3 text-[12px] text-sg-muted">No ZIP codes have been added.</p>
                      )}
                    </div>

                    <div className="flex items-start gap-3 rounded-[8px] border border-sg-border bg-sg-canvas/70 px-3 py-3 text-[11px] leading-5 text-sg-muted">
                      <Icon name="lock" className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>This is a read-only summary. Unlock editing to change the delivery area, order minimum, or ZIP codes.</span>
                    </div>
                  </div>
                ) : (
                  <fieldset disabled={freeDeliverySaving} className="mt-4 space-y-3">
                  <ToggleSetting label="Free local delivery" detail="Applies when the ZIP qualifies and the complete post-discount order reaches the configured minimum." enabled={freeDeliveryConfig.active} onChange={(active) => setFreeDeliveryConfig((current) => current ? { ...current, active } : current)} />
                  <div className="grid gap-3 sm:grid-cols-[110px_minmax(0,1fr)]">
                    <Field label="State">
                      <CustomSelect
                        value={freeDeliveryConfig.state || "TN"}
                        options={usStateOptions}
                        onChange={(state) => setFreeDeliveryConfig((current) => current ? { ...current, state } : current)}
                        ariaLabel="Eligible free-delivery state"
                        className="w-full"
                        triggerClassName="h-11 w-full rounded-[7px] bg-white px-3 text-[13px]"
                        panelClassName="left-0 right-auto max-h-72 w-[240px] overflow-y-auto"
                      />
                    </Field>
                    <CurrencyCentsField
                      label="Minimum order subtotal"
                      cents={freeDeliveryConfig.minimumSubtotalCents}
                      onCommit={(minimumSubtotalCents) => setFreeDeliveryConfig((current) => current ? { ...current, minimumSubtotalCents: minimumSubtotalCents || 0, productMinimumsCents: {} } : current)}
                    />
                  </div>
                  <div>
                    <p className="text-[11px] font-bold text-sg-muted">Eligible ZIP codes</p>
                    <div className="mt-2">
                      <PostalCodeEditor value={freeDeliveryConfig.postalCodes} onChange={(postalCodes) => setFreeDeliveryConfig((current) => current ? { ...current, postalCodes } : current)} />
                    </div>
                  </div>
                  </fieldset>
                )}
                {freeDeliveryStatus ? <p className="mt-3 text-[11px] font-bold text-sg-success">{freeDeliveryStatus}</p> : null}
                {freeDeliveryError ? <p className="mt-3 text-[11px] font-bold text-sg-danger">{freeDeliveryError}</p> : null}
              </div>
            ) : freeDeliveryError ? <p className="mt-4 text-[11px] font-bold text-sg-danger">{freeDeliveryError}</p> : null}
          </section>

          <section className="sg25-card p-4 md:p-5">
            <SectionTitle icon="receipt" title="Payment Provider Health" description="Track Square readiness for checkout links, card payments, and webhooks." />
            <div className="mt-5 grid gap-2">
              <SettingRow label="Square environment" value={squareEnvironmentValue} tone={squareEnvironmentTone} detail={squareEnvironmentDetail} />
              <SettingRow label="Checkout payment readiness" value={checkoutHealthValue} tone={checkoutHealthTone} detail="Checks the server configuration used by embedded checkout and payment links; it does not submit a payment." />
              <SettingRow label="Webhook signature" value={webhookHealthValue} tone={webhookHealthTone} detail="Checks that the webhook secret matching the active Square environment is configured." />
              {paymentHealthError ? (
                <div className="flex flex-col gap-2 rounded-[8px] border border-sg-danger/30 bg-sg-danger-soft px-3 py-3 text-[12px] text-sg-danger sm:flex-row sm:items-center sm:justify-between" role="alert">
                  <span>{paymentHealthError}</span>
                  <button type="button" className="sg25-btn sg25-btn-ghost h-8 shrink-0 px-3" onClick={() => void loadPaymentHealth()} disabled={paymentHealthLoading}>
                    {paymentHealthLoading ? "Retrying" : "Retry"}
                  </button>
                </div>
              ) : null}
            </div>
            {paymentFeeConfig ? (
              <div className="mt-5 rounded-[9px] border border-sg-border bg-sg-canvas/60 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div><p className="text-[13px] font-bold">Payment fee profiles</p><p className="mt-1 text-[11px] text-sg-muted">Estimates only; Square’s settled fee becomes authoritative.</p></div>
                  <button type="button" className="sg25-btn sg25-btn-primary h-9 px-4" onClick={() => void savePaymentFees()} disabled={paymentFeeSaving}>{paymentFeeSaving ? "Saving" : "Save fee profiles"}</button>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {(["online", "cardPresent"] as const).map((key) => {
                    const profile = paymentFeeConfig.profiles[key];
                    return <div key={key} className="rounded-[8px] border border-sg-border bg-white p-3"><p className="text-[12px] font-bold">{profile.label}</p><div className="mt-3 grid grid-cols-2 gap-2"><PackagingNumberField label="Percent" value={(profile.percentBps / 100).toFixed(2)} suffix="%" onChange={(value) => setPaymentFeeConfig((current) => current ? { ...current, profiles: { ...current.profiles, [key]: { ...current.profiles[key], percentBps: Math.max(0, Math.round((Number(value) || 0) * 100)) } } } : current)} /><PackagingNumberField label="Fixed fee" value={(profile.fixedCents / 100).toFixed(2)} suffix="USD" onChange={(value) => setPaymentFeeConfig((current) => current ? { ...current, profiles: { ...current.profiles, [key]: { ...current.profiles[key], fixedCents: Math.max(0, Math.round((Number(value) || 0) * 100)) } } } : current)} /></div></div>;
                  })}
                </div>
                {paymentFeeStatus ? <p className="mt-3 text-[11px] font-bold text-sg-success">{paymentFeeStatus}</p> : null}
                {paymentFeeError ? <p className="mt-3 text-[11px] font-bold text-sg-danger">{paymentFeeError}</p> : null}
              </div>
            ) : null}
          </section>

          <section className="sg25-card p-4 md:p-5">
            <SectionTitle icon="clock" title="Email Settings" description="Stage sender, notification, receipt, and payment-link email controls." />
            <div className="mt-5 space-y-3">
              <GuardedValue label="Receipt sender" value="sales@saigoods.com" onEdit={() => setGuardedEdit({ title: "Edit receipt sender", value: "sales@saigoods.com" })} />
              <GuardedValue label="Operations notification recipient" value="sales@saigoods.com" onEdit={() => setGuardedEdit({ title: "Edit operations recipient", value: "sales@saigoods.com" })} />
              <GuardedValue label="Reply-to address" value="sales@saigoods.com" onEdit={() => setGuardedEdit({ title: "Edit reply-to address", value: "sales@saigoods.com" })} />
              <SettingRow label="Payment link email" value={paymentLinkEmailHealthValue} tone={paymentLinkEmailHealthTone} detail="Supports initial send, resending the saved link, and local-delivery arrival links through Resend." />
              <SettingRow label="Receipt email template" value="Active" tone="success" detail="Used for customer order receipts after confirmed payment." />
              {paymentHealthError ? (
                <div className="flex flex-col gap-2 rounded-[8px] border border-sg-danger/30 bg-sg-danger-soft px-3 py-3 text-[12px] text-sg-danger sm:flex-row sm:items-center sm:justify-between" role="alert">
                  <span>{paymentHealthError}</span>
                  <button type="button" className="sg25-btn sg25-btn-ghost h-8 shrink-0 px-3" onClick={() => void loadPaymentHealth()} disabled={paymentHealthLoading}>
                    {paymentHealthLoading ? "Retrying" : "Retry"}
                  </button>
                </div>
              ) : null}
            </div>
          </section>

          <section className="sg25-card p-4 md:p-5">
            <SectionTitle icon="settings" title="Tax & Finance" description="Control defaults used by quotes, reporting, and receipts." />
            <div className="mt-5 space-y-3">
              <GuardedValue label="Sales tax state" value="TN" onEdit={() => setGuardedEdit({ title: "Edit sales tax state", value: "TN" })} />
              <GuardedValue label="Default tax rate" value="9.75%" onEdit={() => setGuardedEdit({ title: "Edit default tax rate", value: "9.75%" })} />
              <SettingRow label="Tax applies to shipping" value="Needs policy review" tone="warning" detail="Keep explicit because this affects checkout totals and receipts." />
              <SettingRow label="Revenue report source" value="Paid orders only" tone="success" detail="Dashboard should continue to count only confirmed payments." />
            </div>
          </section>

          <section className="sg25-card border-sg-danger/30 p-4 md:p-5">
            <SectionTitle icon="alert" title="Danger Zone" description="Actions here will require explicit backend safeguards before activation." />
            <div className="mt-5 grid gap-2">
              {["Recalculate all open quotes", "Rotate payment webhook secret", "Disable checkout"].map((label) => (
                <button key={label} type="button" className="sg25-btn sg25-btn-ghost justify-between rounded-[8px] px-4 text-sg-danger" disabled>
                  {label}
                  <Icon name="arrow-up-right" className="h-4 w-4" />
                </button>
              ))}
            </div>
          </section>
        </aside>
      </section>

      <section className="flex flex-col gap-3 rounded-[10px] border border-sg-border bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[14px] font-bold">Advanced settings review</p>
          <p className="mt-1 text-[13px] leading-5 text-sg-muted">
            Bundle pricing and packaging profiles save immediately after server validation. Other staged controls still require review before activation. {proposedChangeCount ? `${proposedChangeCount} proposed change${proposedChangeCount === 1 ? " is" : "s are"} pending review.` : "No staged business-setting changes."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="sg25-btn sg25-btn-ghost" disabled>Discard changes</button>
          <button type="button" className="sg25-btn sg25-btn-primary" disabled>Save advanced settings</button>
        </div>
      </section>

      {pendingFlowToggle ? (
        <Modal>
          <WarningHeader
            title={`${pendingFlowToggle.enabled ? "Enable" : "Disable"} ${pendingFlowToggle.label}?`}
            description="This changes which customer or admin order path is available. Review the new state before confirming."
          />
          <div className="mt-5 rounded-[8px] border border-sg-warning bg-sg-warning-soft p-4 text-[13px] text-sg-warning">
            <p className="font-bold">Requested state: {pendingFlowToggle.enabled ? "Enabled" : "Disabled"}</p>
            <p className="mt-1 leading-5">The toggle will not change until you confirm.</p>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="sg25-btn sg25-btn-ghost" onClick={() => setPendingFlowToggle(null)}>Cancel</button>
            <button type="button" className="sg25-btn sg25-btn-primary" autoFocus onClick={confirmFlowToggle}>Confirm change</button>
          </div>
        </Modal>
      ) : null}

      {volumePricingDraft ? (
        <Modal wide>
          <form onSubmit={saveVolumePricing}>
            <WarningHeader title="Automatic volume pricing" description="This rule changes new storefront, checkout, and manual-order quotes. Existing orders keep their saved price snapshot." />
            <div className="mt-5 rounded-[8px] border border-sg-border bg-sg-input-bg p-4">
              <p className="text-[14px] font-bold">{volumePricingDraft.product}</p>
              <p className="mt-1 text-[12px] leading-5 text-sg-muted">All factory-carton bundles and sizes for this product count toward the threshold. Retail-box bundles keep their normal price.</p>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <Field label="Minimum cartons">
                <input className="sg25-input" inputMode="numeric" value={volumePricingDraft.minCases} onChange={(event) => setVolumePricingDraft({ ...volumePricingDraft, minCases: wholeNumberOnly(event.target.value) })} />
              </Field>
              <Field label="Promotional price per carton">
                <div className="flex h-11 items-center rounded-[7px] border border-sg-border bg-white px-3">
                  <span className="text-sg-muted">$</span>
                  <input className="min-w-0 flex-1 bg-transparent px-2 text-[14px] font-bold outline-none" inputMode="decimal" value={volumePricingDraft.pricePerCase} onChange={(event) => setVolumePricingDraft({ ...volumePricingDraft, pricePerCase: numberOnly(event.target.value) })} />
                </div>
              </Field>
              <Field label="Availability">
                <button type="button" className={`flex h-11 w-full items-center justify-between rounded-[7px] px-4 text-[13px] font-bold ${volumePricingDraft.active ? "bg-sg-success-soft text-sg-success" : "bg-sg-danger-soft text-sg-danger"}`} onClick={() => setVolumePricingDraft({ ...volumePricingDraft, active: !volumePricingDraft.active })}>
                  {volumePricingDraft.active ? "Enabled" : "Disabled"}
                  <span className={`relative h-5 w-9 rounded-full ${volumePricingDraft.active ? "bg-sg-success" : "bg-sg-danger"}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white ${volumePricingDraft.active ? "right-0.5" : "left-0.5"}`} /></span>
                </button>
              </Field>
              <Field label="Combine with other discounts">
                <button type="button" className={`flex h-11 w-full items-center justify-between rounded-[7px] px-4 text-[13px] font-bold ${volumePricingDraft.allowDiscountStacking ? "bg-sg-success-soft text-sg-success" : "bg-sg-input-bg text-sg-muted"}`} onClick={() => setVolumePricingDraft({ ...volumePricingDraft, allowDiscountStacking: !volumePricingDraft.allowDiscountStacking })}>
                  {volumePricingDraft.allowDiscountStacking ? "Allowed" : "Not allowed"}
                  <span className={`relative h-5 w-9 rounded-full ${volumePricingDraft.allowDiscountStacking ? "bg-sg-success" : "bg-sg-muted"}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white ${volumePricingDraft.allowDiscountStacking ? "right-0.5" : "left-0.5"}`} /></span>
                </button>
              </Field>
            </div>
            <p className="mt-4 rounded-[8px] bg-sg-warning-soft px-3 py-2 text-[12px] leading-5 text-sg-warning">The promotional price must be lower than the active 1-carton price. If another pricing tier is already cheaper, the customer keeps the lower price.</p>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="sg25-btn sg25-btn-ghost" onClick={() => setVolumePricingDraft(null)}>Cancel</button>
              <button type="submit" className="sg25-btn sg25-btn-primary" disabled={bundleSaving || Number(volumePricingDraft.minCases) < 2 || !centsFromPrice(volumePricingDraft.pricePerCase)}>{bundleSaving ? "Saving" : "Save volume rule"}</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {bundleDraft ? (
        <Modal wide>
          <form onSubmit={saveBundleDraft}>
            <WarningHeader title={bundleDraft.key ? "Edit bundle settings" : "Add bundle"} />
            <div className="mt-5 rounded-[8px] border border-sg-border bg-sg-input-bg p-4 text-[13px]">
              <div className="grid gap-2 sm:grid-cols-[150px_1fr]">
                <span className="font-bold text-sg-muted">Product</span><span className="font-bold">{bundleDraft.product}</span>
                <span className="font-bold text-sg-muted">Bundle</span><span className="font-bold">{bundleDraft.bundle || "New bundle"}</span>
                <span className="font-bold text-sg-muted">Physical allocation</span><span className="font-bold">{bundleDraft.units || "1"} {bundleDraft.kind === "case" ? "carton(s)" : "box(es)"}</span>
                <span className="font-bold text-sg-muted">Proposed price</span><span className="font-bold">${bundleDraft.price || "0.00"}</span>
                <span className="font-bold text-sg-muted">COGS</span><span className="font-bold">${bundleDraft.cogs || "0.00"}</span>
                <span className="font-bold text-sg-muted">Gross profit</span><span className="font-bold text-sg-success">${((centsFromPrice(bundleDraft.price) - centsFromPrice(bundleDraft.cogs)) / 100).toFixed(2)}</span>
              </div>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <Field label="Product">
                <CustomSelect value={bundleDraft.productSlug} options={productOptions.map((product) => ({ value: product.slug, label: product.name }))} onChange={(productSlug) => { const product = productOptions.find((candidate) => candidate.slug === productSlug) || productOptions[0]; setBundleDraft({ ...bundleDraft, productSlug, product: product.name }); }} ariaLabel="Product" className="w-full" triggerClassName="h-11 w-full rounded-[7px] bg-white px-4 pr-3 text-[13px]" panelClassName="left-0 right-auto w-full" />
              </Field>
              <Field label="Bundle name">
                <input className="sg25-input" value={bundleDraft.bundle} onChange={(event) => setBundleDraft({ ...bundleDraft, bundle: event.target.value })} />
              </Field>
              <Field label="Proposed price">
                <div className="flex h-11 items-center rounded-[7px] border border-sg-border bg-white px-3">
                  <span className="text-sg-muted">$</span>
                  <input className="min-w-0 flex-1 bg-transparent px-2 text-[14px] font-bold outline-none" value={bundleDraft.price} inputMode="decimal" onChange={(event) => setBundleDraft({ ...bundleDraft, price: numberOnly(event.target.value) })} />
                </div>
              </Field>
              <Field label="COGS">
                <div className="flex h-11 items-center rounded-[7px] border border-sg-border bg-white px-3">
                  <span className="text-sg-muted">$</span>
                  <input className="min-w-0 flex-1 bg-transparent px-2 text-[14px] font-bold outline-none" value={bundleDraft.cogs} inputMode="decimal" onChange={(event) => setBundleDraft({ ...bundleDraft, cogs: numberOnly(event.target.value) })} />
                </div>
              </Field>
              <Field label="Fulfillment unit">
                <CustomSelect value={bundleDraft.kind} options={[{ value: "box", label: "Retail box" }, { value: "case", label: "Factory carton" }]} onChange={(kind) => setBundleDraft({ ...bundleDraft, kind: kind as "box" | "case" })} ariaLabel="Bundle fulfillment unit" className="w-full" triggerClassName="h-11 w-full rounded-[7px] bg-white px-4 pr-3 text-[13px]" panelClassName="left-0 right-auto w-full" />
              </Field>
              <Field label="Units included">
                <input className="sg25-input" value={bundleDraft.units} inputMode="numeric" onChange={(event) => setBundleDraft({ ...bundleDraft, units: wholeNumberOnly(event.target.value) })} />
              </Field>
              <Field label="Availability">
                <button type="button" className={`flex h-11 w-full items-center justify-between rounded-[7px] px-4 text-[13px] font-bold ${bundleDraft.status === "active" ? "bg-sg-success-soft text-sg-success" : "bg-sg-danger-soft text-sg-danger"}`} onClick={() => setBundleDraft({ ...bundleDraft, status: bundleDraft.status === "active" ? "inactive" : "active" })}>
                  {bundleDraft.status === "active" ? "Active" : "Inactive"}
                  <span className={`relative h-5 w-9 rounded-full ${bundleDraft.status === "active" ? "bg-sg-success" : "bg-sg-danger"}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white ${bundleDraft.status === "active" ? "right-0.5" : "left-0.5"}`} /></span>
                </button>
              </Field>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="sg25-btn sg25-btn-ghost" onClick={() => setBundleDraft(null)}>Cancel</button>
              <button type="submit" className="sg25-btn sg25-btn-primary" disabled={!bundleHasChanges || bundleSaving || !bundleDraft.bundle.trim() || !centsFromPrice(bundleDraft.price) || !Number(bundleDraft.units)}>{bundleSaving ? "Saving" : "Save live bundle"}</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {removeBundle ? (
        <Modal>
          <WarningHeader title="Dangerous bundle removal" description="Removing a customer-facing bundle can affect checkout options, quote history, reports, receipts, packing records, and future backend product mappings." />
          <div className="mt-5 rounded-[8px] border border-sg-danger bg-sg-danger-soft p-4 text-[13px] text-sg-danger">
            <p className="font-bold">Heavy warning</p>
            <p className="mt-1 leading-5">Only continue if this bundle should no longer be available after backend safeguards are connected. Existing orders may still need this bundle for receipts, packing, refunds, and audit history.</p>
          </div>
          <div className="mt-5 rounded-[8px] border border-sg-border bg-sg-input-bg p-4 text-[13px]">
            <p className="font-bold">{removeBundle.product}</p>
            <p className="mt-1 text-sg-muted">{removeBundle.bundle} · {money(removeBundle.priceCents)}</p>
            <p className="mt-1 text-sg-muted">COGS {money(rowCogsCents(removeBundle))} · Gross profit {money(grossProfitCents(removeBundle))}</p>
          </div>
          <Field label='Type "REMOVE" to stage this removal'>
            <input className="sg25-input mt-3" value={removeConfirmText} onChange={(event) => setRemoveConfirmText(event.target.value)} />
          </Field>
          {removeConfirmText && removeConfirmText !== "REMOVE" ? (
            <p className="mt-3 rounded-[8px] bg-sg-warning-soft px-3 py-2 text-[13px] font-bold text-sg-warning">Type REMOVE exactly before confirming.</p>
          ) : null}
          <p className="mt-3 rounded-[8px] bg-sg-warning-soft px-3 py-2 text-[13px] font-bold text-sg-warning">This removes the option from future storefront and admin orders. Existing paid orders keep their saved receipt and packing data.</p>
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="sg25-btn sg25-btn-ghost" onClick={() => {
              setRemoveBundle(null);
              setRemoveConfirmText("");
            }}>Cancel</button>
            <button
              type="button"
              className="sg25-btn sg25-btn-primary"
              disabled={removeConfirmText !== "REMOVE" || bundleSaving}
              onClick={() => {
                const proposed = bundles.filter((row) => row.key !== removeBundle.key);
                void persistBundleRows(proposed, `${removeBundle.bundle} removed from future orders.`).then((saved) => {
                  if (!saved) return;
                  setRemoveBundle(null);
                  setRemoveConfirmText("");
                });
              }}
            >
              {bundleSaving ? "Removing" : "Confirm removal"}
            </button>
          </div>
        </Modal>
      ) : null}

      {freeDeliveryUnlockOpen ? (
        <Modal>
          <WarningHeader title="Unlock free-delivery settings" description="These rules decide which customer orders bypass Shippo and become no-charge local deliveries." />
          <div className="mt-5 rounded-[8px] border border-sg-warning bg-sg-warning-soft p-4 text-[13px] text-sg-warning">
            <p className="font-bold">Review the delivery area carefully</p>
            <p className="mt-1 leading-5">An incorrect state, ZIP, or minimum can unintentionally offer free delivery. Changes do not take effect until you select Save area.</p>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="sg25-btn sg25-btn-ghost" onClick={() => setFreeDeliveryUnlockOpen(false)}>Cancel</button>
            <button
              type="button"
              className="sg25-btn sg25-btn-primary"
              onClick={() => {
                setFreeDeliveryEditing(true);
                setFreeDeliveryUnlockOpen(false);
                setFreeDeliveryStatus("");
                setFreeDeliveryError("");
              }}
            >
              Unlock editing
            </button>
          </div>
        </Modal>
      ) : null}

      {packagingUnlockOpen ? (
        <Modal>
          <WarningHeader title="Unlock packaging edits" description="Packaging dimensions directly affect customer shipping estimates, parcel selection, label prices, and warehouse instructions." />
          <div className="mt-5 rounded-[8px] border border-sg-warning bg-sg-warning-soft p-4 text-[13px] text-sg-warning">
            <p className="font-bold">Verify physical measurements first</p>
            <p className="mt-1 leading-5">Only edit these profiles using measured outer dimensions and packed weights. Saving incorrect values can undercharge shipping or produce invalid labels.</p>
          </div>
          <Field label='Type "EDIT" to unlock'>
            <input className="sg25-input mt-3" autoFocus value={packagingUnlockText} onChange={(event) => setPackagingUnlockText(event.target.value.toUpperCase())} />
          </Field>
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="sg25-btn sg25-btn-ghost" onClick={() => { setPackagingUnlockOpen(false); setPackagingUnlockText(""); }}>Cancel</button>
            <button type="button" className="sg25-btn sg25-btn-primary" disabled={packagingUnlockText !== "EDIT"} onClick={() => { setPackagingEditing(true); setPackagingUnlockOpen(false); setPackagingUnlockText(""); }}>
              Unlock editing
            </button>
          </div>
        </Modal>
      ) : null}

      {warehouseDraft ? (
        <Modal wide>
          <form onSubmit={saveWarehouseDraft} noValidate>
            <WarningHeader title={warehouseDraft.added ? "Add warehouse location" : "Edit warehouse location"} description="Warehouse changes affect shipping labels, returns, and future inventory routing." />
            {warehouseDraftError ? <div role="alert" className="mt-4 rounded-[8px] border border-sg-danger bg-sg-danger-soft px-4 py-3 text-[13px] font-semibold text-sg-danger">{warehouseDraftError}</div> : null}
            {warehouseAddressSuggestion ? (
              <div className="mt-3 flex flex-col gap-3 rounded-[8px] border border-sg-warning bg-sg-warning-soft px-4 py-3 text-[13px] sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-bold text-sg-warning">Shippo verified this address</p>
                  <p className="mt-1 leading-5 text-sg-text">
                    {[warehouseAddressSuggestion.line1, warehouseAddressSuggestion.line2, warehouseAddressSuggestion.city, warehouseAddressSuggestion.state, warehouseAddressSuggestion.postalCode, warehouseAddressSuggestion.country].filter(Boolean).join(", ")}
                  </p>
                </div>
                <button
                  type="button"
                  className="sg25-btn sg25-btn-ghost shrink-0"
                  onClick={() => updateWarehouseDraft({
                    address1: warehouseAddressSuggestion.line1 || warehouseDraft.address1,
                    address2: warehouseAddressSuggestion.line2 ?? warehouseDraft.address2,
                    city: warehouseAddressSuggestion.city || warehouseDraft.city,
                    state: warehouseAddressSuggestion.state || warehouseDraft.state,
                    zip: warehouseAddressSuggestion.postalCode || warehouseDraft.zip,
                    country: warehouseAddressSuggestion.country || warehouseDraft.country,
                  })}
                >
                  Use verified address
                </button>
              </div>
            ) : null}
            <div className="mt-5 grid gap-3">
              <Field label="Warehouse name" required error={warehouseFieldErrors.name}><input className="sg25-input" required value={warehouseDraft.name} onChange={(event) => updateWarehouseDraft({ name: event.target.value })} /></Field>
              <div className="rounded-[8px] border border-sg-border bg-sg-input-bg p-4">
                <p className="text-[13px] font-bold text-sg-muted">Ship-from / return address</p>
                <div className="mt-3 grid gap-3">
                  <Field label="Address line 1" required error={warehouseFieldErrors.address1}><input className="sg25-input" required value={warehouseDraft.address1} onChange={(event) => updateWarehouseDraft({ address1: event.target.value })} /></Field>
                  <Field label="Address line 2"><input className="sg25-input" value={warehouseDraft.address2} placeholder="Suite, unit, optional" onChange={(event) => updateWarehouseDraft({ address2: event.target.value })} /></Field>
                  <div className="grid gap-3 sm:grid-cols-[1fr_0.65fr_0.8fr]">
                    <Field label="City" required error={warehouseFieldErrors.city}><input className="sg25-input" required value={warehouseDraft.city} onChange={(event) => updateWarehouseDraft({ city: event.target.value })} /></Field>
                    <Field label="State" required error={warehouseFieldErrors.state}><input className="sg25-input" required value={warehouseDraft.state} maxLength={2} onChange={(event) => updateWarehouseDraft({ state: event.target.value.toUpperCase() })} /></Field>
                    <Field label="ZIP" required error={warehouseFieldErrors.zip}><input className="sg25-input" required value={warehouseDraft.zip} inputMode="numeric" onChange={(event) => updateWarehouseDraft({ zip: zipOnly(event.target.value) })} /></Field>
                  </div>
                  <Field label="Country" required error={warehouseFieldErrors.country}>
                    <CustomSelect value={warehouseDraft.country || "US"} options={countryOptions} ariaLabel="Country" className="w-full" triggerClassName="h-11 w-full rounded-[7px] border border-sg-border bg-white px-3 text-[13px] font-semibold" onChange={(country) => updateWarehouseDraft({ country })} />
                  </Field>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Notification email" required error={warehouseFieldErrors.email}><input className="sg25-input" required type="email" value={warehouseDraft.email} onChange={(event) => updateWarehouseDraft({ email: event.target.value })} /></Field>
                <Field label="Carrier phone" required error={warehouseFieldErrors.phone}><input className="sg25-input" required value={warehouseDraft.phone} inputMode="tel" onChange={(event) => updateWarehouseDraft({ phone: wholeNumberOnly(event.target.value).slice(0, 15) })} /></Field>
              </div>
              <fieldset className="rounded-[8px] border border-sg-border p-3">
                <legend className="px-1 text-[12px] font-bold text-sg-muted">Roles<span className="ml-1 text-sg-danger" aria-hidden="true">*</span></legend>
                <div className="grid gap-2 sm:grid-cols-3">
                  {warehouseRoleOptions.map((role) => (
                    <label key={role} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-[7px] bg-sg-input-bg px-3 text-[12px] font-semibold">
                      <input type="checkbox" className="h-4 w-4 accent-sg-primary" checked={warehouseDraft.roles.includes(role)} onChange={(event) => updateWarehouseDraft({ roles: event.target.checked ? [...warehouseDraft.roles, role] : warehouseDraft.roles.filter((value) => value !== role) })} />
                      <span>{role}</span>
                    </label>
                  ))}
                </div>
                {warehouseFieldErrors.roles ? <p className="mt-2 text-[12px] font-semibold text-sg-danger">{warehouseFieldErrors.roles}</p> : null}
              </fieldset>
              <button type="button" className={`flex h-12 items-center justify-between rounded-[8px] px-4 text-[13px] font-bold ${warehouseDraft.active ? "bg-sg-success-soft text-sg-success" : "bg-sg-danger-soft text-sg-danger"}`} onClick={() => updateWarehouseDraft({ active: !warehouseDraft.active })}>
                {warehouseDraft.active ? "Active" : "Inactive"}
                <span className={`relative h-5 w-9 rounded-full ${warehouseDraft.active ? "bg-sg-success" : "bg-sg-danger"}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white ${warehouseDraft.active ? "right-0.5" : "left-0.5"}`} /></span>
              </button>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="sg25-btn sg25-btn-ghost" disabled={warehouseSaving} onClick={() => { setWarehouseDraft(null); setWarehouseDraftError(""); setWarehouseFieldErrors({}); setWarehouseAddressSuggestion(null); }}>Cancel</button>
              <button type="submit" className="sg25-btn sg25-btn-primary" disabled={!warehouseHasChanges || warehouseSaving}>{warehouseSaving ? "Saving..." : "Save warehouse"}</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {bufferDraft !== null ? (
        <Modal>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setShippingBuffer((Number(bufferDraft) || 0).toFixed(2));
              setBufferDraft(null);
            }}
          >
            <WarningHeader title="Edit shipping buffer" description="This amount is added to quoted shipping rates before checkout or manual order totals are shown." />
            <div className="mt-5 rounded-[8px] border border-sg-border bg-sg-input-bg p-4 text-[13px]">
              <div className="grid gap-2 sm:grid-cols-[150px_1fr]">
                <span className="font-bold text-sg-muted">Current buffer</span><span className="font-bold">${shippingBuffer}</span>
                <span className="font-bold text-sg-muted">New buffer</span><span className="font-bold">${bufferDraft || "0.00"}</span>
              </div>
            </div>
            <Field label="New buffer">
              <div className="mt-3 flex h-11 items-center rounded-[7px] border border-sg-border bg-white px-3">
                <span className="text-sg-muted">$</span>
                <input className="min-w-0 flex-1 bg-transparent px-2 text-[14px] font-bold outline-none" value={bufferDraft} inputMode="decimal" onChange={(event) => setBufferDraft(numberOnly(event.target.value))} />
              </div>
            </Field>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="sg25-btn sg25-btn-ghost" onClick={() => setBufferDraft(null)}>Cancel</button>
              <button type="submit" className="sg25-btn sg25-btn-primary" disabled={Number(bufferDraft) === Number(shippingBuffer)}>Confirm buffer change</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {guardedEdit ? (
        <Modal>
          <WarningHeader title={guardedEdit.title} description="This control is intentionally staged behind a confirmation flow because it can affect checkout, reporting, or customer messages." />
          <div className="mt-5 rounded-[8px] border border-sg-border bg-sg-input-bg p-4 text-[13px]">
            <p className="font-bold text-sg-muted">Current value</p>
            <p className="mt-1 font-bold">{guardedEdit.value}</p>
          </div>
          <p className="mt-4 rounded-[8px] bg-sg-warning-soft px-3 py-2 text-[13px] font-bold text-sg-warning">Frontend-only placeholder. Backend save and audit validation will be connected later.</p>
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="sg25-btn sg25-btn-ghost" onClick={() => setGuardedEdit(null)}>Close</button>
            <button type="button" className="sg25-btn sg25-btn-primary" disabled>Confirm change</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
