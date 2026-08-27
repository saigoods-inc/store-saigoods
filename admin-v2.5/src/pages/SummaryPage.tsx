import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "../auth/AuthProvider";
import { useAdminShellHeaderMeta } from "../components/layout/AdminShell";
import { fetchNexusSummary, fetchSummary, type NexusSummaryRow, type StateRevenueRow, type SummaryPreset, type SummaryResponse } from "../lib/api";
import { formatBucketLabel, formatDateTime, formatNumber, formatShortDate, formatUsdCents, percentDelta, signedCurrencyLabel, stateName } from "../lib/format";
import { Icon } from "../lib/icons";

const presetOptions: Array<{ value: SummaryPreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "last7", label: "Last 7 Days" },
  { value: "last30", label: "Last 30 Days" },
  { value: "month", label: "This Month" },
  { value: "all", label: "All Time" },
];

const salesOverviewRangeOptions: Array<{ value: SummaryPreset; label: string }> = [
  { value: "last7", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "last30", label: "Last 30 Days" },
  { value: "all", label: "All Time" },
];

const productPerformanceRangeOptions: Array<{ value: SummaryPreset; label: string }> = [
  { value: "last7", label: "Week" },
  { value: "month", label: "Month" },
  { value: "last30", label: "Last 30 Days" },
  { value: "all", label: "All Time" },
];

const salesKpiDefinitions = [
  {
    slug: "nitrile-examination-standard",
    aliases: ["exam gloves", "nitrile exam", "nitrile examination standard", "nitrile examination - standard"],
    label: "Nitrile Exam",
    seriesClassName: "bg-sg-chart-1",
    dotClassName: "bg-sg-chart-1",
    textClassName: "text-sg-chart-1",
  },
  {
    slug: "black-nitrile-general",
    aliases: ["general", "black nitrile general"],
    label: "General",
    seriesClassName: "bg-[#8d8780]",
    dotClassName: "bg-[#8d8780]",
    textClassName: "text-[#6e6761]",
  },
  {
    slug: "black-nitrile-heavy-duty",
    aliases: ["heavy duty", "black nitrile heavy duty"],
    label: "Heavy Duty",
    seriesClassName: "bg-[#2f2d2b]",
    dotClassName: "bg-[#2f2d2b]",
    textClassName: "text-[#2f2d2b]",
  },
] as const;
const knownSalesProducts = [
  { value: "all", label: "All Product" },
  { value: "nitrile-examination-standard", label: "Nitrile Examination – Standard" },
  { value: "black-nitrile-general", label: "Black Nitrile – General" },
  { value: "black-nitrile-heavy-duty", label: "Black Nitrile – Heavy Duty" },
] as const;

function statusLabel(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "Paid";
  const labels: Record<string, string> = {
    ready_to_ship: "Ready to ship",
    shipped: "Shipped",
    label_pending: "Pending label",
    pending_label: "Pending label",
    label_purchased: "Label purchased",
    partial_label_purchase: "Partial label purchase",
    paid: "Paid",
    cancelled: "Cancelled",
    refunded: "Refunded",
  };
  const normalized = raw.toLowerCase();
  if (labels[normalized]) return labels[normalized];
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

const nexusThresholdsByState: Record<string, { revenueCents?: number; orderCount?: number; label: string; localOnly?: boolean; noStateSalesTax?: boolean }> = {
  AL: { revenueCents: 250_000_00, label: "$250k AL retail sales threshold" },
  AK: { revenueCents: 100_000_00, label: "$100k AK local remote seller threshold", localOnly: true },
  AZ: { revenueCents: 100_000_00, label: "$100k AZ gross sales threshold" },
  AR: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 AR taxable sales threshold" },
  CA: { revenueCents: 500_000_00, label: "$500k CA sales threshold" },
  CO: { revenueCents: 100_000_00, label: "$100k CO retail sales threshold" },
  CT: { revenueCents: 100_000_00, orderCount: 200, label: "$100k and 200 CT retail sales watch" },
  DC: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 DC retail sales threshold" },
  DE: { label: "DE has no state sales tax", noStateSalesTax: true },
  FL: { revenueCents: 100_000_00, label: "$100k FL remote sales threshold" },
  GA: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 GA retail sales threshold" },
  HI: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 HI gross sales threshold" },
  IA: { revenueCents: 100_000_00, label: "$100k IA gross sales threshold" },
  ID: { revenueCents: 100_000_00, label: "$100k ID gross sales threshold" },
  IL: { revenueCents: 100_000_00, label: "$100k IL retail sales threshold" },
  IN: { revenueCents: 100_000_00, label: "$100k IN gross sales threshold" },
  KS: { revenueCents: 100_000_00, label: "$100k KS gross sales threshold" },
  KY: { revenueCents: 100_000_00, label: "$100k KY gross sales threshold" },
  LA: { revenueCents: 100_000_00, label: "$100k LA gross sales threshold" },
  MA: { revenueCents: 100_000_00, label: "$100k MA gross sales threshold" },
  MD: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 MD gross sales threshold" },
  ME: { revenueCents: 100_000_00, label: "$100k ME gross sales threshold" },
  MI: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 MI gross sales threshold" },
  MN: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 MN retail sales threshold" },
  MO: { revenueCents: 100_000_00, label: "$100k MO taxable sales threshold" },
  MS: { revenueCents: 250_000_00, label: "Over $250k MS gross sales threshold" },
  MT: { label: "MT has no state sales tax", noStateSalesTax: true },
  NC: { revenueCents: 100_000_00, label: "$100k NC gross sales threshold" },
  ND: { revenueCents: 100_000_00, label: "$100k ND taxable sales threshold" },
  NE: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 NE retail sales threshold" },
  NH: { label: "NH has no state sales tax", noStateSalesTax: true },
  NJ: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 NJ gross sales threshold" },
  NM: { revenueCents: 100_000_00, label: "$100k NM taxable sales threshold" },
  NV: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 NV retail sales threshold" },
  NY: { revenueCents: 500_000_00, orderCount: 101, label: "$500k and more than 100 NY sales watch" },
  OH: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 OH retail sales threshold" },
  OK: { revenueCents: 100_000_00, label: "$100k OK taxable sales threshold" },
  OR: { label: "OR has no state sales tax", noStateSalesTax: true },
  PA: { revenueCents: 100_000_00, label: "$100k PA gross sales threshold" },
  PR: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 PR gross sales threshold" },
  RI: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 RI gross sales threshold" },
  SC: { revenueCents: 100_000_00, label: "$100k SC gross sales threshold" },
  SD: { revenueCents: 100_000_00, label: "$100k SD gross revenue threshold" },
  TN: { revenueCents: 100_000_00, label: "$100k TN remote sales threshold" },
  TX: { revenueCents: 500_000_00, label: "$500k TX gross revenue threshold" },
  UT: { revenueCents: 100_000_00, label: "$100k UT gross sales threshold" },
  VA: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 VA retail sales threshold" },
  VT: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 VT gross sales threshold" },
  WA: { revenueCents: 100_000_00, label: "$100k WA gross income threshold" },
  WI: { revenueCents: 100_000_00, label: "$100k WI gross sales threshold" },
  WV: { revenueCents: 100_000_00, orderCount: 200, label: "$100k or 200 WV gross sales threshold" },
  WY: { revenueCents: 100_000_00, label: "$100k WY gross sales threshold" },
};
const NEXUS_WARNING_RATIO = 0.8;
const normalizeSalesProductName = (value?: string | null) =>
  String(value || "")
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function SelectField<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
  triggerClassName = "",
  panelClassName = "",
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  triggerClassName?: string;
  panelClassName?: string;
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
    <div ref={rootRef} className={`relative min-w-0 shrink-0 ${className}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`sg25-pill-field flex min-w-0 items-center justify-between gap-2.5 text-left ${triggerClassName}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="truncate">{selectedOption?.label || ""}</span>
        <Icon
          name="chevron"
          className={`h-3 w-3 shrink-0 text-sg-muted transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div
          role="listbox"
          className={`absolute right-0 top-[calc(100%+6px)] z-30 w-max min-w-full max-w-[calc(100vw-2rem)] rounded-[7px] border border-sg-border bg-white px-1.5 py-1.5 shadow-[0_18px_40px_rgba(31,27,24,0.14)] ${panelClassName}`}
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                className={`flex w-full items-center justify-between gap-3 rounded-[5px] px-3.5 py-2 text-left text-[11.5px] transition sm:text-[12px] ${
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

function SummaryKpi({
  label,
  value,
  subtext,
  icon,
  danger = false,
  success = false,
  compact = false,
  iconToneClassName = "bg-sg-primary-soft text-sg-primary",
}: {
  label: string;
  value: string;
  subtext: string;
  icon: ReactNode;
  danger?: boolean;
  success?: boolean;
  compact?: boolean;
  iconToneClassName?: string;
}) {
  return (
    <article className="sg25-card h-full overflow-hidden p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2.5 sm:gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[0.74rem] font-medium leading-[1.16] text-sg-muted sm:text-[0.8rem]">{label}</p>
          <p
            className={`mt-3 font-extrabold leading-none ${
              compact ? "text-[1.44rem] sm:text-[1.58rem]" : "text-[1.56rem] sm:text-[1.72rem] xl:text-[1.82rem]"
            } ${danger ? "text-sg-danger" : success ? "text-sg-success" : "text-sg-text"}`}
          >
            {value}
          </p>
          <p className="mt-2 text-[11px] leading-[1.15] text-sg-muted sm:text-[12px]">{subtext}</p>
        </div>
        <div
          className={`flex shrink-0 items-center justify-center rounded-full ${iconToneClassName} ${
            compact ? "h-9 w-9 sm:h-10 sm:w-10" : "h-10 w-10 sm:h-11 sm:w-11"
          }`}
        >
          {icon}
        </div>
      </div>
    </article>
  );
}

function MiniAlertGrid({
  summary,
  nexusRows,
}: {
  summary: SummaryResponse;
  nexusRows: NexusSummaryRow[];
}) {
  const alerts = summary.alerts || {};
  const nexusWatchRows = nexusRows
    .map((row) => {
      const threshold = nexusThresholdsByState[row.state];
      if (!threshold || threshold.noStateSalesTax) return null;

      const revenue = Number(row.total_revenue || 0);
      const orders = Number(row.total_orders || 0);
      const revenueRatio = threshold.revenueCents ? revenue / threshold.revenueCents : 0;
      const orderRatio = threshold.orderCount ? orders / threshold.orderCount : 0;
      const status = revenueRatio >= 1 || orderRatio >= 1 ? "Exceeded" : revenueRatio >= NEXUS_WARNING_RATIO || orderRatio >= NEXUS_WARNING_RATIO ? "Close" : null;

      if (!status) return null;

      const basis = threshold.orderCount && orderRatio >= revenueRatio
        ? `${formatNumber(orders)} / ${formatNumber(threshold.orderCount)} orders`
        : `${formatUsdCents(revenue)} / ${formatUsdCents(threshold.revenueCents || 0)}`;
      const scope = threshold.localOnly ? " local" : "";
      return `${status}: ${row.state}${scope} ${basis}`;
    })
    .filter(Boolean) as string[];
  const items = [
    {
      title: "Paid, Not Fulfilled",
      count: alerts.paidNotFulfilled?.count || 0,
      rows: alerts.paidNotFulfilled?.rows?.slice(0, 6).map((row) => {
        const orderRef = row.orderRef || "Order pending";
        return row.customer ? `${orderRef} - ${row.customer}` : orderRef;
      }) || [],
      tone: "border-sg-warning bg-sg-warning-soft/80",
      countTone: "bg-sg-warning text-white",
    },
    {
      title: "Missing Shipping Cost",
      count: alerts.missingShippingCost?.count || 0,
      rows: alerts.missingShippingCost?.rows?.slice(0, 3).map((row) => row.orderRef || "Order needs review") || [],
      tone: "border-sg-danger bg-sg-danger-soft/75",
      countTone: "bg-sg-danger text-white",
    },
    {
      title: "Pending Shipping Cost",
      count: alerts.pendingShippingCost?.count || 0,
      rows: alerts.pendingShippingCost?.rows?.slice(0, 3).map((row) => row.orderRef || "Carrier cost pending") || [],
      tone: "border-sg-danger bg-sg-danger-soft/75",
      countTone: "bg-sg-danger text-white",
    },
    {
      title: "High Shipping Cost",
      count: alerts.unusuallyHighShipping?.count || 0,
      rows: alerts.unusuallyHighShipping?.rows?.slice(0, 3).map((row) => `${row.orderRef || "Order"} · ${formatUsdCents(row.shippingExpenseCents || 0)}`) || [],
      tone: "border-sg-warning bg-sg-warning-soft/70",
      countTone: "bg-sg-warning text-white",
    },
    {
      title: "Financial Review",
      count: (alerts.feeCalculationIssues?.count || 0) + (alerts.marketplaceFinancialsIncomplete?.count || 0),
      rows: [
        ...(alerts.feeCalculationIssues?.rows?.slice(0, 2).map((row) => row.orderRef || "Order fee review") || []),
        ...(alerts.marketplaceFinancialsIncomplete?.rows?.slice(0, 2).map((row) => [row.marketplace, row.externalOrderId].filter(Boolean).join(" · ") || "Marketplace order") || []),
      ],
      tone: "border-sg-info bg-sg-info-soft/75",
      countTone: "bg-sg-info text-white",
    },
    {
      title: "Out of Stock",
      count: alerts.inventoryOutOfStock?.count || 0,
      rows:
        alerts.inventoryOutOfStock?.rows?.slice(0, 2).map((row) => [row.slug, row.size].filter(Boolean).join(" / ")) || [],
      tone: "border-sg-danger bg-sg-danger-soft/75",
      countTone: "bg-sg-danger text-white",
    },
    {
      title: "Low Stock",
      count: alerts.lowInventory?.count || 0,
      rows: alerts.lowInventory?.rows?.slice(0, 2).map((row) => [row.slug, row.size].filter(Boolean).join(" / ")) || [],
      tone: "border-sg-warning bg-sg-warning-soft/70",
      countTone: "bg-sg-warning text-white",
    },
    {
      title: "Incoming On Hold",
      count: alerts.incomingBatchesOnHold?.count || 0,
      rows: alerts.incomingBatchesOnHold?.rows?.slice(0, 2).map((row) => row.batch_name || "Incoming batch") || [],
      tone: "border-sg-info bg-sg-info-soft/75",
      countTone: "bg-sg-info text-white",
    },
    {
      title: "Nexus Watch",
      count: nexusWatchRows.length,
      rows: nexusWatchRows.slice(0, 3),
      tone: "border-sg-warning bg-sg-warning-soft/70",
      countTone: nexusWatchRows.some((row) => row.startsWith("Exceeded")) ? "bg-sg-danger text-white" : "bg-sg-warning text-white",
    },
  ].filter((item) => item.count > 0 && item.rows.length > 0);

  return (
    <section className="sg25-card flex h-full flex-col p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <Icon name="alert" className="h-5 w-5 text-sg-primary" />
        <h2 className="text-[1rem] font-bold sm:text-[1.08rem]">Alerts &amp; Watchouts</h2>
      </div>
      <p className="mt-2 text-[11px] leading-[1.15] text-sg-muted sm:text-[12px]">Current operational issues across orders.</p>
      <div className="mt-5 min-h-0 overflow-y-auto pr-1">
        <div className="grid gap-3 md:grid-cols-2">
        {items.length ? (
          items.map((item) => (
            <article key={item.title} className={`h-full rounded-[10px] border p-4 sm:p-5 ${item.tone}`}>
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-[11.5px] font-extrabold uppercase tracking-[0.04em] sm:text-[12.5px]">{item.title}</h3>
                <span className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-[11.5px] font-bold ${item.countTone}`}>
                  {item.count}
                </span>
              </div>
              <div className="mt-3 space-y-1.5 text-[11.5px] leading-[1.22] text-sg-text sm:text-[12.5px]">
                {item.rows.map((row) => <p key={row}>{row}</p>)}
              </div>
            </article>
          ))
        ) : (
          <div className="rounded-[10px] border border-dashed border-sg-border px-5 py-8 text-center text-[12px] text-sg-muted md:col-span-2">
            No active alerts or watchouts.
          </div>
        )}
        </div>
      </div>
    </section>
  );
}

function SalesOverview({
  summary,
  preset,
  onPresetChange,
  product,
  onProductChange,
}: {
  summary: SummaryResponse;
  preset: SummaryPreset;
  onPresetChange: (value: SummaryPreset) => void;
  product: string;
  onProductChange: (value: string) => void;
}) {
  const buckets = summary.breakdown?.salesOverviewSeries?.buckets || [];
  const products = summary.breakdown?.salesOverviewSeries?.products || [];
  const productOptions = useMemo(() => {
    const baseOptions = knownSalesProducts.map((entry) => ({ ...entry }));
    const knownValues = new Set<string>(baseOptions.map((entry) => entry.value));
    const knownLabels = new Set([
      ...baseOptions.map((entry) => normalizeSalesProductName(entry.label)),
      ...salesKpiDefinitions.flatMap((entry) => [normalizeSalesProductName(entry.label), ...entry.aliases.map(normalizeSalesProductName)]),
    ]);
    const dynamicOptions = products
      .filter((entry) => {
        const slug = String(entry.slug || "");
        const label = normalizeSalesProductName(entry.label || entry.name || entry.slug);
        return slug && !knownValues.has(slug) && !knownLabels.has(label);
      })
      .map((entry) => ({
        value: String(entry.slug || "all"),
        label: entry.label || entry.name || entry.slug || "Product",
      }));
    return [...baseOptions, ...dynamicOptions];
  }, [products]);

  const displayed = buckets.slice(-7);
  const displayedCount = Math.max(displayed.length, 1);
  const getProductRevenue = (bucket: (typeof buckets)[number], slug: string) => {
    const definition = salesKpiDefinitions.find((entry) => entry.slug === slug);
    const matchesProduct = (entry: (typeof bucket.products)[number]) => {
      if (entry.slug === slug) return true;
      if (!definition) return false;
      const normalizedValues = [entry.slug, entry.label, entry.name].map(normalizeSalesProductName);
      return normalizedValues.some((value) => value && definition.aliases.map(normalizeSalesProductName).includes(value));
    };
    return Number(bucket.products.find(matchesProduct)?.revenueCents || 0);
  };
  const getBucketProductSegments = (bucket: (typeof buckets)[number]) =>
    salesKpiDefinitions.map((definition) => ({
      slug: definition.slug,
      label: definition.label,
      className: definition.seriesClassName,
      value: getProductRevenue(bucket, definition.slug),
    }));
  const maxValue = Math.max(
    1,
    ...displayed.map((bucket) => {
      if (product === "all") return getBucketProductSegments(bucket).reduce((sum, segment) => sum + segment.value, 0);
      return getProductRevenue(bucket, product);
    }),
  );

  const selectedTotalRevenue = displayed.reduce((sum, bucket) => {
    if (product === "all") return sum + getBucketProductSegments(bucket).reduce((bucketSum, segment) => bucketSum + segment.value, 0);
    return sum + getProductRevenue(bucket, product);
  }, 0);
  const salesKpis = salesKpiDefinitions.map((definition) => ({
    ...definition,
    revenueCents: displayed.reduce((sum, bucket) => sum + getProductRevenue(bucket, definition.slug), 0),
  }));

  const selectedTrend = displayed.map((bucket) => {
    if (product === "all") return getBucketProductSegments(bucket).reduce((sum, segment) => sum + segment.value, 0);
    return getProductRevenue(bucket, product);
  });
  const latestTrend = selectedTrend[selectedTrend.length - 1];
  const previousTrend = selectedTrend[selectedTrend.length - 2];
  const deltaPercent = percentDelta(latestTrend, previousTrend);
  const deltaCents = Number(latestTrend || 0) - Number(previousTrend || 0);
  const deltaTone =
    deltaCents > 0
      ? { className: "bg-sg-success-soft text-sg-success", icon: "trend-up" as const }
      : deltaCents < 0
        ? { className: "bg-sg-danger-soft text-sg-danger", icon: "trend-down" as const }
        : { className: "bg-sg-input-bg text-sg-muted", icon: "trend-up" as const };
  const axisLabels = [maxValue, Math.round(maxValue / 2), 0];
  const tooltipData = displayed.map((bucket) => ({
    label: formatBucketLabel(bucket.bucketStart, summary.dateRange?.bucketMode),
    segments:
      product === "all"
        ? getBucketProductSegments(bucket)
        : [
            {
              label: productOptions.find((option) => option.value === product)?.label || "Selected product",
              className: salesKpiDefinitions.find((definition) => definition.slug === product)?.seriesClassName || "bg-sg-chart-1",
              value: getProductRevenue(bucket, product),
            },
          ],
  }));
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  const activeTooltipIndex = pinnedIndex ?? hoveredIndex;
  const chartRegionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setHoveredIndex(null);
    setPinnedIndex(null);
  }, [preset, product]);

  useEffect(() => {
    if (pinnedIndex == null) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (chartRegionRef.current?.contains(event.target as Node)) return;
      setPinnedIndex(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPinnedIndex(null);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [pinnedIndex]);

  return (
    <section className="sg25-card flex h-full flex-col p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 shrink-0">
          <div className="flex min-w-0 items-center gap-2">
            <Icon name="bar-chart" className="h-5 w-5 shrink-0 text-sg-primary" />
            <h2 className="whitespace-nowrap text-[0.98rem] font-bold sm:text-[1.04rem]">Sales Overview</h2>
          </div>
        </div>
        <div className="flex w-full flex-col gap-2.5 sm:flex-row sm:justify-end sm:gap-3 lg:ml-auto lg:w-auto">
          <SelectField
            value={product}
            options={productOptions}
            onChange={onProductChange}
            ariaLabel="Sales Overview product filter"
            className="w-full sm:w-auto"
            triggerClassName="h-[32px] px-3 pr-2.5 text-[10.5px] sm:!w-auto sm:h-[34px] sm:text-[11px]"
            panelClassName="max-h-[240px] overflow-y-auto"
          />
          <SelectField
            value={preset}
            options={salesOverviewRangeOptions}
            onChange={onPresetChange}
            ariaLabel="Sales Overview range filter"
            className="w-full sm:w-auto"
            triggerClassName="h-[32px] px-3 pr-2.5 text-[10.5px] sm:!w-auto sm:h-[34px] sm:text-[11px]"
          />
        </div>
      </div>

      <div className="mt-5">
        <p className="text-[11px] font-medium text-sg-muted sm:text-[12px]">Merchandise revenue</p>
        <div className="mt-2 flex flex-wrap items-center gap-2.5">
          <p className="text-[1.56rem] font-extrabold leading-none sm:text-[1.72rem] xl:text-[1.82rem]">{formatUsdCents(selectedTotalRevenue)}</p>
          {deltaPercent != null ? (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-semibold sm:text-[12px] ${deltaTone.className}`}
            >
              <Icon name={deltaTone.icon} className="h-4 w-4" />
              {deltaPercent}%
            </span>
          ) : null}
        </div>
        {deltaPercent != null ? (
          <p className="mt-2 text-[11px] leading-[1.15] text-sg-muted sm:text-[12px]">
            {signedCurrencyLabel(deltaCents)} vs previous interval
          </p>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {salesKpis.map((kpi) => (
          <article key={kpi.slug} className="min-w-0 rounded-[10px] border border-sg-border bg-white px-3.5 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${kpi.dotClassName}`} />
              <p className="truncate text-[11px] font-semibold leading-none text-sg-muted sm:text-[11.5px]">{kpi.label}</p>
            </div>
            <p className={`mt-2 text-[1rem] font-bold leading-none ${kpi.textClassName}`}>{formatUsdCents(kpi.revenueCents)}</p>
          </article>
        ))}
      </div>

      <div ref={chartRegionRef} className="relative mt-6 flex-1">
        <div className="mt-14 grid grid-cols-[44px_minmax(0,1fr)] grid-rows-[232px_auto] gap-x-3 sm:mt-[72px] sm:grid-rows-[262px_auto]">
          <div className="flex h-[232px] flex-col justify-between pt-0.5 text-right text-[10px] leading-none text-sg-muted sm:h-[262px] sm:text-[11px]">
            {axisLabels.map((label, index) => (
              <span key={`${label}-${index}`}>{formatUsdCents(label)}</span>
            ))}
          </div>
          <div className="relative h-[232px] sm:h-[262px]">
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
              {axisLabels.map((label, index) => (
                <span key={`gridline-${label}-${index}`} className="block h-px w-full bg-sg-border" />
              ))}
            </div>
            <div
              className="relative z-10 grid h-full items-end gap-3 sm:gap-4"
              style={{ gridTemplateColumns: `repeat(${displayedCount}, minmax(0, 1fr))` }}
            >
              {displayed.map((bucket, index) => {
                const segments =
                  product === "all"
                    ? getBucketProductSegments(bucket)
                    : [
                        {
                          className: salesKpiDefinitions.find((definition) => definition.slug === product)?.seriesClassName || "bg-sg-chart-1",
                          value: getProductRevenue(bucket, product),
                        },
                      ];
                const total = segments.reduce((sum, segment) => sum + segment.value, 0);
                const tooltip = tooltipData[index];
                const tooltipVisible = activeTooltipIndex === index && Boolean(tooltip);

                return (
                  <button
                    key={bucket.bucketStart}
                    type="button"
                    className="group relative flex h-full w-full flex-col items-center justify-end gap-4 text-left"
                    aria-pressed={pinnedIndex === index}
                    onMouseEnter={() => setHoveredIndex(index)}
                    onMouseLeave={() => setHoveredIndex((current) => (current === index ? null : current))}
                    onFocus={() => setHoveredIndex(index)}
                    onBlur={() => setHoveredIndex((current) => (current === index ? null : current))}
                    onClick={() => setPinnedIndex((current) => (current === index ? null : index))}
                  >
                    {tooltipVisible && tooltip ? (
                      <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-3 w-[214px] max-w-[calc(100vw-3rem)] -translate-x-1/2 rounded-[7px] border border-sg-border bg-white px-4 py-3 shadow-[0_18px_40px_rgba(31,27,24,0.14)] before:absolute before:left-1/2 before:top-full before:h-4 before:w-4 before:-translate-x-1/2 before:-translate-y-1/2 before:rotate-45 before:border-b before:border-r before:border-sg-border before:bg-white">
                        <p className="text-[1rem] font-bold sm:text-[1.05rem]">{tooltip.label}</p>
                        <div className="mt-3 space-y-2 text-[12px] text-sg-muted sm:text-[13px]">
                          {tooltip.segments.map((segment, segmentIndex) => (
                            <div key={segment.label} className="flex items-center justify-between gap-3">
                              <span className="flex items-center gap-2">
                                <span className={`h-3 w-3 rounded-full ${segment.className || salesKpiDefinitions[segmentIndex % salesKpiDefinitions.length].dotClassName}`} />
                                {segment.label}
                              </span>
                              <strong className="text-sg-text">{formatUsdCents(segment.value)}</strong>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div className="relative flex h-full w-full items-end bg-transparent">
                      <div
                        className="flex w-full flex-col justify-end overflow-hidden rounded-[4px]"
                        style={{ height: `${Math.max((total / maxValue) * 100, total > 0 ? 2 : 0)}%` }}
                      >
                        {segments
                          .slice()
                          .reverse()
                          .map((segment, reverseIndex) => (
                            <div
                              key={`${bucket.bucketStart}-${reverseIndex}`}
                              style={{ height: `${total > 0 ? (segment.value / total) * 100 : 0}%` }}
                              className={`w-full ${segment.className} transition-opacity first:rounded-t-[4px] last:rounded-b-[4px] group-hover:opacity-90`}
                            />
                          ))}
                        {total <= 0 ? <div className="h-2 rounded-[4px] bg-sg-border-soft" /> : null}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="col-start-2 mt-3 grid gap-3 border-t border-sg-border pt-2 sm:gap-4" style={{ gridTemplateColumns: `repeat(${displayedCount}, minmax(0, 1fr))` }}>
            {displayed.map((bucket) => (
              <span key={`label-${bucket.bucketStart}`} className="text-center text-[10.5px] text-sg-muted sm:text-[11.5px]">
                {formatBucketLabel(bucket.bucketStart, summary.dateRange?.bucketMode)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-3 border-t border-sg-border pt-4 text-[11px] leading-[1.15] text-sg-muted sm:text-[12px]">
        {(product === "all"
          ? salesKpiDefinitions.map((entry) => ({
              label: entry.label,
              className: entry.dotClassName,
            }))
          : [
              {
                label:
                  salesKpiDefinitions.find((definition) => definition.slug === product)?.label ||
                  productOptions.find((option) => option.value === product)?.label ||
                  "Selected product",
                className: salesKpiDefinitions.find((definition) => definition.slug === product)?.dotClassName || "bg-sg-chart-1",
              },
            ]
        ).map((entry) => (
          <span key={entry.label} className="flex items-center gap-2">
            <span className={`h-3 w-3 rounded-full ${entry.className}`} />
            {entry.label}
          </span>
        ))}
      </div>
    </section>
  );
}

function ProductPerformance({
  summary,
  preset,
  onPresetChange,
}: {
  summary: SummaryResponse;
  preset: SummaryPreset;
  onPresetChange: (value: SummaryPreset) => void;
}) {
  const ranking = summary.breakdown?.productRanking || [];
  const top = ranking.slice(0, 4);
  const maxRevenue = Math.max(1, ...top.map((row) => Number(row.revenueCents || 0)));
  const totalTracked = ranking.reduce((sum, row) => sum + Number(row.revenueCents || 0), 0);
  const formatExportDate = (value: string | null | undefined) => {
    if (!value) return "";
    const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
  };
  const dateRangeLabel =
    summary.dateRange?.start && summary.dateRange?.end
      ? `${formatExportDate(summary.dateRange.start)} - ${formatExportDate(summary.dateRange.end)}`
      : productPerformanceRangeOptions.find((option) => option.value === preset)?.label || preset;
  const filenameDateRange =
    summary.dateRange?.start && summary.dateRange?.end
      ? `${summary.dateRange.start.slice(0, 10)}-to-${summary.dateRange.end.slice(0, 10)}`
      : preset;
  const exportRows = ranking.map((row, index) => ({
    rank: index + 1,
    product: row.name || row.slug || "-",
    slug: row.slug || "",
    orders: Number(row.orderCount || 0),
    units: Number(row.quantityUnits || 0),
    revenue: Number(row.revenueCents || 0) / 100,
  }));
  const handleExport = () => {
    const escapeCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
    const header = ["Rank", "Product", "Slug", "Orders", "Units", "Revenue"];
    const lines = [
      ["Product Performance", dateRangeLabel].map(escapeCell).join(","),
      [],
      header.map(escapeCell).join(","),
      ...exportRows.map((row) => [row.rank, row.product, row.slug, row.orders, row.units, row.revenue.toFixed(2)].map(escapeCell).join(",")),
      ["", "Total tracked", "", "", "", (totalTracked / 100).toFixed(2)].map(escapeCell).join(","),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `product-performance-${filenameDateRange}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="sg25-card flex h-full flex-col p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 shrink-0">
          <div className="flex items-center gap-2">
            <Icon name="trend-up" className="h-5 w-5 text-sg-primary" />
            <h2 className="whitespace-nowrap text-[0.98rem] font-bold sm:text-[1.04rem]">Product Performance</h2>
          </div>
        </div>
        <div className="w-full sm:ml-auto sm:w-auto">
          <SelectField
            value={preset}
            options={productPerformanceRangeOptions}
            onChange={onPresetChange}
            ariaLabel="Product Performance range filter"
            triggerClassName="h-[32px] px-3 pr-2.5 text-[10.5px] sm:!w-auto sm:h-[34px] sm:text-[11px]"
          />
        </div>
      </div>

      <div className="mt-5 flex-1 space-y-5">
        {top.length ? (
          top.map((product, index) => {
            const barPercent = Math.max(8, Math.round((Number(product.revenueCents || 0) / maxRevenue) * 100));
            return (
              <div key={`${product.slug}-${index}`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 gap-4">
                    <span className="w-4 shrink-0 text-[12px] text-sg-muted sm:text-[13px]">{index + 1}</span>
                    <div className="min-w-0">
                      <p className="text-[0.96rem] font-semibold leading-[1.2] sm:text-[1rem]">{product.name || product.slug || "-"}</p>
                      <p className="mt-1 text-[11.5px] leading-[1.2] text-sg-muted sm:text-[12.5px]">
                        {Number(product.orderCount || 0) > 0
                          ? `${product.orderCount} ${Number(product.orderCount) === 1 ? "order" : "orders"}`
                          : `${Number(product.quantityUnits || 0)} units`}
                      </p>
                    </div>
                  </div>
                  <p className="shrink-0 text-[1rem] font-bold leading-none sm:text-[1.12rem]">{formatUsdCents(product.revenueCents)}</p>
                </div>
                <div className="mt-3 h-2.5 rounded-full bg-sg-border-soft">
                  <div className="h-2.5 rounded-full bg-sg-primary" style={{ width: `${barPercent}%` }} />
                </div>
              </div>
            );
          })
        ) : (
          <div className="rounded-[10px] border border-dashed border-sg-border px-5 py-10 text-center text-sg-muted">No product sales in this range.</div>
        )}
      </div>

      <div className="mt-auto border-t border-sg-border pt-4 text-[12px] sm:text-[13px]">
        <div className="flex items-center justify-between">
          <span className="text-sg-muted">Total tracked</span>
          <strong>{formatUsdCents(totalTracked)}</strong>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-sg-muted">Products with sales</span>
          <strong>{ranking.length}</strong>
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" className="sg25-btn sg25-btn-ghost h-[34px] px-3 text-[11px]" onClick={handleExport} disabled={!ranking.length}>
            <Icon name="arrow-up-right" className="h-4 w-4" />
            Export
          </button>
        </div>
      </div>
    </section>
  );
}

function RecentOrders({ summary }: { summary: SummaryResponse }) {
  const rows = summary.breakdown?.recentFinancialActivity?.slice(0, 6) || [];

  return (
    <section className="sg25-card h-full min-w-0 overflow-hidden p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon name="cart" className="h-5 w-5 text-sg-primary" />
          <h2 className="text-[0.98rem] font-bold sm:text-[1.04rem]">Recent Orders</h2>
        </div>
        <a href="/admin-v2.5/orders" className="sg25-btn sg25-btn-ghost shrink-0">
          View all
          <Icon name="arrow-up-right" className="h-4 w-4" />
        </a>
      </div>
      <div
        aria-label="Recent orders table"
        className="mt-5 max-w-full overflow-x-auto overscroll-x-contain"
        tabIndex={0}
      >
        <table className="w-[980px] min-w-[980px] table-fixed border-collapse text-left">
          <colgroup>
            <col className="w-[220px]" />
            <col className="w-[230px]" />
            <col className="w-[170px]" />
            <col className="w-[150px]" />
            <col className="w-[110px]" />
            <col className="w-[100px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-sg-border text-[10px] uppercase tracking-[0.08em] text-sg-muted">
              <th className="pb-3 pr-6 font-semibold">Order</th>
              <th className="pb-3 pr-6 font-semibold">Customer</th>
              <th className="pb-3 pr-6 font-semibold">Status</th>
              <th className="pb-3 pr-6 font-semibold">Items</th>
              <th className="pb-3 pr-6 font-semibold">Total</th>
              <th className="pb-3 font-semibold">Date</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.orderRef}-${row.paidAt}`} className="border-b border-sg-border text-[12px] last:border-b-0 sm:text-[13px]">
                <td className="py-3.5 pr-6 align-middle">
                  <span className="block whitespace-nowrap font-mono">{row.orderRef || "-"}</span>
                  {row.channel ? <span className="mt-1 inline-flex rounded-full bg-sg-input-bg px-2 py-0.5 text-[9px] font-semibold uppercase text-sg-muted">{row.channel}</span> : null}
                </td>
                <td className="py-3.5 pr-6">{row.customer || "-"}</td>
                <td className="py-3.5 pr-6">
                  <span className="inline-flex whitespace-nowrap rounded-full bg-sg-info-soft px-2.5 py-1 text-[11px] font-semibold text-sg-info sm:text-[12px]">
                    {statusLabel(row.orderStatus)}
                  </span>
                </td>
                <td className="py-3.5 pr-6 text-sg-muted">{row.quantityPreview || "-"}</td>
                <td className="py-3.5 pr-6 font-semibold">{formatUsdCents(row.revenueCents)}</td>
                <td className="py-3.5 text-sg-muted">{formatShortDate(row.paidAt?.slice(0, 10))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function InventoryHealth({ summary }: { summary: SummaryResponse }) {
  const alerts = summary.alerts || {};
  const tiles = [
    {
      label: "Out of Stock",
      value: alerts.inventoryOutOfStock?.count || 0,
      tone: "bg-sg-danger-soft text-sg-danger",
    },
    {
      label: "Low Stock",
      value: alerts.lowInventory?.count || 0,
      tone: "bg-sg-warning-soft text-sg-warning",
    },
    {
      label: "Incoming Hold",
      value: alerts.incomingBatchesOnHold?.count || 0,
      tone: "bg-sg-info-soft text-sg-info",
    },
  ];

  return (
    <section className="sg25-card flex h-full flex-col p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <Icon name="package" className="h-5 w-5 text-sg-primary" />
        <h2 className="text-[1rem] font-bold sm:text-[1.08rem]">Inventory Health</h2>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        {tiles.map((tile) => (
          <div key={tile.label} className={`flex min-h-[112px] flex-col items-center justify-center gap-0.5 rounded-[10px] px-4 py-4 text-center ${tile.tone}`}>
            <p className="text-[1.45rem] font-extrabold leading-none sm:text-[1.58rem]">{tile.value}</p>
            <p className="text-[11.5px] font-semibold leading-[1.12] sm:text-[12.5px]">{tile.label}</p>
          </div>
        ))}
      </div>
      <div className="mt-auto pt-4">
        <a href="/admin-v2.5/inventory" className="sg25-btn sg25-btn-primary w-full">
          Review inventory
        </a>
      </div>
    </section>
  );
}

function StateRevenueRanking({
  rows,
  totalStates,
  totalOrders,
  totalRevenueCents,
}: {
  rows: StateRevenueRow[];
  totalStates: number;
  totalOrders: number;
  totalRevenueCents: number;
}) {
  const top = rows.slice(0, 5);

  return (
    <section className="sg25-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sg-primary-soft text-sg-primary">
              <Icon name="pin" className="h-[18px] w-[18px]" />
            </div>
            <div>
              <h2 className="text-[0.98rem] font-bold sm:text-[1.04rem]">State Revenue Ranking</h2>
              <p className="mt-1 text-[11px] leading-[1.15] text-sg-muted sm:text-[12px]">Website shipping states ranked for the selected date range.</p>
            </div>
          </div>
        </div>
        <a href="/admin-v2.5/nexus" className="sg25-btn sg25-btn-ghost ml-auto shrink-0 self-start">
          View nexus
          <Icon name="arrow-up-right" className="h-4 w-4" />
        </a>
      </div>

      <div className="mt-7 hidden grid-cols-[minmax(290px,1.6fr)_88px_120px_160px_118px] gap-4 px-4 text-[10px] font-semibold uppercase tracking-normal text-sg-muted xl:grid">
        <span>State</span>
        <span>Orders</span>
        <span>Revenue</span>
        <span>Share</span>
        <span>Avg. Order</span>
      </div>

      <div className="mt-4 space-y-3">
        {!top.length ? (
          <div className="rounded-[10px] border border-dashed border-sg-border px-4 py-6 text-center text-[12px] text-sg-muted">
            No website orders with a recognized shipping state match these filters.
          </div>
        ) : null}
        {top.map((row, index) => {
          const revenue = Number(row.total_revenue || 0);
          const orders = Number(row.total_orders || 0);
          const share = totalRevenueCents > 0 ? Math.round((revenue / totalRevenueCents) * 100) : 0;
          const shareBarWidth = share > 0 ? Math.min(Math.max(share, 14), 100) : 0;
          const avgOrder = orders > 0 ? Math.round(revenue / orders) : 0;
          const isTop = index === 0;

          return (
            <article
              key={row.state}
              className={`rounded-[10px] border px-4 py-[14px] xl:px-3.5 ${
                isTop ? "border-sg-primary/35 bg-sg-primary-soft/35" : "border-sg-border bg-white"
              }`}
            >
              <div className="xl:hidden md:flex md:items-center md:gap-4">
                <div className="flex min-w-0 items-center gap-3 md:w-[170px] md:shrink-0 lg:w-[210px]">
                  <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-sg-primary-soft text-[12px] font-bold text-sg-primary">
                    {index + 1}
                  </span>
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[14px] font-bold ${
                      isTop ? "bg-sg-primary text-white" : "bg-sg-input-bg text-sg-text"
                    }`}
                  >
                    {row.state}
                  </span>
                  <span className="min-w-0">
                    <strong className="block truncate text-[0.95rem] leading-[1.2] sm:text-[1rem]">{stateName(row.state)}</strong>
                    <span className="mt-0.5 block text-[12px] text-sg-muted">{row.state}</span>
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 md:mt-0 md:flex md:min-w-0 md:flex-1 md:items-start md:justify-between md:gap-3 lg:gap-5">
                  <div className="md:shrink-0">
                    <p className="text-[10px] font-semibold uppercase tracking-normal text-sg-muted">Orders</p>
                    <p className="mt-1 text-[0.95rem] font-semibold leading-none sm:text-[1rem]">{orders}</p>
                  </div>
                  <div className="md:shrink-0">
                    <p className="text-[10px] font-semibold uppercase tracking-normal text-sg-muted">Revenue</p>
                    <p className="mt-1 text-[0.95rem] font-semibold leading-none sm:text-[1rem]">{formatUsdCents(revenue)}</p>
                  </div>
                  <div className="col-span-2 md:w-[130px] md:shrink-0 lg:w-[180px]">
                    <p className="text-[10px] font-semibold uppercase tracking-normal text-sg-muted">Share</p>
                    <div className="mt-1 flex flex-col-reverse items-start gap-1">
                      <div className="sg25-progress w-full overflow-hidden">
                        <div className="h-2 rounded-full bg-sg-primary" style={{ width: `${shareBarWidth}%` }} />
                      </div>
                      <span className="shrink-0 text-[12px] leading-none text-sg-muted">{share}%</span>
                    </div>
                  </div>
                  <div className="md:shrink-0 md:text-right">
                    <p className="text-[10px] font-semibold uppercase tracking-normal text-sg-muted">Avg. Order</p>
                    <p className="mt-1 text-[0.95rem] font-semibold leading-none sm:text-[1rem]">{formatUsdCents(avgOrder)}</p>
                  </div>
                </div>
              </div>

              <div className="hidden xl:grid xl:grid-cols-[minmax(290px,1.6fr)_88px_120px_160px_118px] xl:items-center xl:gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-sg-primary-soft text-[12px] font-bold text-sg-primary">
                    {index + 1}
                  </span>
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[14px] font-bold ${
                      isTop ? "bg-sg-primary text-white" : "bg-sg-input-bg text-sg-text"
                    }`}
                  >
                    {row.state}
                  </span>
                  <span className="min-w-0">
                    <strong className="block truncate text-[0.93rem] leading-[1.16] sm:text-[0.98rem]">{stateName(row.state)}</strong>
                    <span className="block text-[11px] leading-[1.1] text-sg-muted">{row.state}</span>
                  </span>
                </div>
                <div>
                  <p className="text-[0.95rem] font-semibold leading-none sm:text-[1rem]">{orders}</p>
                </div>
                <div>
                  <p className="text-[0.95rem] font-semibold leading-none sm:text-[1rem]">{formatUsdCents(revenue)}</p>
                </div>
                <div className="flex min-w-0 flex-col-reverse items-start gap-1">
                  <div className="sg25-progress w-full overflow-hidden">
                    <div className="h-2 rounded-full bg-sg-primary" style={{ width: `${shareBarWidth}%` }} />
                  </div>
                  <span className="shrink-0 text-[12px] leading-none text-sg-muted">{share}%</span>
                </div>
                <div>
                  <p className="text-[0.95rem] font-semibold leading-none sm:text-[1rem]">{formatUsdCents(avgOrder)}</p>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-sg-border pt-4 text-[12px] sm:text-[13px]">
        <span className="text-sg-muted">
          {formatNumber(totalStates)} states · {formatNumber(totalOrders)} website orders{totalStates > 5 ? " · top 5 shown" : ""}
        </span>
        <strong className="text-sg-primary">{formatUsdCents(totalRevenueCents)} total revenue</strong>
      </div>
    </section>
  );
}

function NexusPreview({ rows }: { rows: NexusSummaryRow[] }) {
  const top = rows.slice(0, 5);

  return (
    <section className="sg25-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Icon name="pin" className="h-5 w-5 text-sg-primary" />
            <h2 className="text-[0.98rem] font-bold sm:text-[1.04rem]">Nexus by State</h2>
          </div>
        </div>
        <a href="/admin-v2.5/nexus" className="sg25-btn sg25-btn-ghost ml-auto shrink-0 self-start">
          Full report
          <Icon name="arrow-up-right" className="h-4 w-4" />
        </a>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-3">
        {top.map((row, index) => {
          const active = index < Math.min(3, top.length);
          return (
            <article
              key={row.state}
              className={`min-w-0 rounded-[10px] border px-5 py-5 ${
                active ? "border-sg-primary/35 bg-sg-primary-soft/35" : "border-sg-border bg-white"
              }`}
            >
              <p className={`text-[1.46rem] font-extrabold leading-none ${active ? "text-sg-primary" : "text-sg-text"}`}>{row.state}</p>
              <p className="mt-1.5 text-[0.98rem] font-semibold leading-[1.08]">{stateName(row.state)}</p>
              <p className={`mt-3 text-[1.2rem] font-bold leading-none ${active ? "text-sg-primary" : "text-sg-text"}`}>{formatUsdCents(row.total_revenue)}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function SummaryPage() {
  const auth = useAuth();
  const [preset, setPreset] = useState<SummaryPreset>("all");
  const [salesPreset, setSalesPreset] = useState<SummaryPreset>("all");
  const [productPreset, setProductPreset] = useState<SummaryPreset>("all");
  const [salesProduct, setSalesProduct] = useState<string>("all");
  const [channel, setChannel] = useState<"all" | "website" | "amazon" | "walmart">("all");

  const summaryQuery = useQuery({
    queryKey: ["admin-v2.5-summary", preset, channel],
    queryFn: async () => fetchSummary(preset, await auth.getAccessToken(), channel),
    enabled: Boolean(auth.session),
    placeholderData: (previousData) => previousData,
  });

  const salesSummaryQuery = useQuery({
    queryKey: ["admin-v2.5-summary", salesPreset, channel],
    queryFn: async () => fetchSummary(salesPreset, await auth.getAccessToken(), channel),
    enabled: Boolean(auth.session),
    placeholderData: (previousData) => previousData,
  });

  const productSummaryQuery = useQuery({
    queryKey: ["admin-v2.5-summary", productPreset, channel],
    queryFn: async () => fetchSummary(productPreset, await auth.getAccessToken(), channel),
    enabled: Boolean(auth.session),
    placeholderData: (previousData) => previousData,
  });

  const nexusQuery = useQuery({
    queryKey: ["admin-v2.5-nexus"],
    queryFn: async () => fetchNexusSummary(await auth.getAccessToken()),
    enabled: Boolean(auth.session),
  });

  const nexusRows = useMemo(
    () =>
      [...(nexusQuery.data?.summary || [])].sort(
        (left, right) => Number(right.total_revenue || 0) - Number(left.total_revenue || 0),
      ),
    [nexusQuery.data?.summary],
  );

  const loading = !summaryQuery.data || !salesSummaryQuery.data || !productSummaryQuery.data || !nexusQuery.data;
  const error =
    (!summaryQuery.data && summaryQuery.error) ||
    (!salesSummaryQuery.data && salesSummaryQuery.error) ||
    (!productSummaryQuery.data && productSummaryQuery.error) ||
    (!nexusQuery.data && nexusQuery.error);
  const updatedAt = summaryQuery.data?.generatedAt || nexusQuery.data?.generated_at || null;

  useAdminShellHeaderMeta(updatedAt ? <span>Updated {formatDateTime(updatedAt)}</span> : null);

  if (error) {
    return (
      <section className="sg25-card border-sg-danger/30 bg-sg-danger-soft p-6 text-sg-danger">
        <h1 className="text-[1.5rem] font-extrabold sm:text-[1.72rem]">Dashboard</h1>
        <p className="mt-3 text-[12px] leading-[1.15] text-sg-muted sm:text-[13px]">
          {error instanceof Error ? error.message : "Could not load the dashboard."}
        </p>
        <button
          type="button"
          className="sg25-btn sg25-btn-primary mt-4"
          onClick={() => {
            void Promise.all([
              summaryQuery.refetch(),
              salesSummaryQuery.refetch(),
              productSummaryQuery.refetch(),
              nexusQuery.refetch(),
            ]);
          }}
        >
          <Icon name="refresh" className="h-4 w-4" />
          Retry
        </button>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="py-4">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="mt-2 text-sm text-sg-muted">Loading summary...</p>
      </section>
    );
  }

  if (!summaryQuery.data || !salesSummaryQuery.data || !productSummaryQuery.data || !nexusQuery.data) {
    return null;
  }

  const summary = summaryQuery.data;
  const kpis = summary.kpis || {};
  const stateRevenue = summary.breakdown?.stateRevenue;
  const currentProfitStatus = kpis.currentProfitStatus || "actual";
  const currentProfitStatusLabel = currentProfitStatus === "pending" ? "Pending" : currentProfitStatus === "estimated" ? "Estimated" : "Actual";
  const currentProfitSubtext = currentProfitStatus === "pending"
    ? `${formatNumber(kpis.currentProfitPendingOrders || 0)} order${Number(kpis.currentProfitPendingOrders || 0) === 1 ? "" : "s"} missing required cost information · Merchandise revenue minus product costs, payment fees, and shipping expense.`
    : `${currentProfitStatusLabel} · Merchandise revenue minus product costs, payment fees, and shipping expense.`;
  const shippingVarianceCents = Number(kpis.totalShippingVarianceCents || 0);
  const squareFeeOrders = Number(kpis.squareFeeOrders || 0);
  const actualSquareFeeOrders = Number(kpis.actualSquareFeeOrders || 0);
  const estimatedSquareFeeOrders = Number(kpis.estimatedSquareFeeOrders || 0);

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[1.5rem] font-extrabold tracking-[-0.02em] sm:text-[1.72rem]">Dashboard</h1>
          <p className="mt-1 max-w-3xl text-[12px] leading-[1.15] text-sg-muted sm:text-[13px]">
            Sales, inventory, and fulfillment overview across every sales channel.
          </p>
        </div>
        <div className="ml-auto grid w-full shrink-0 grid-cols-2 gap-2 sm:w-auto">
          <SelectField
            value={channel}
            options={[{ value: "all", label: "All channels" }, { value: "website", label: "Website" }, { value: "amazon", label: "Amazon" }, { value: "walmart", label: "Walmart" }]}
            onChange={setChannel}
            ariaLabel="Dashboard sales channel filter"
            triggerClassName="h-[39px] px-4 pr-3 text-[11.5px] sm:!w-auto sm:text-[12px]"
          />
          <SelectField
            value={preset}
            options={presetOptions}
            onChange={setPreset}
            ariaLabel="Dashboard summary range filter"
            triggerClassName="h-[39px] px-4 pr-3 text-[11.5px] sm:!w-auto sm:text-[12px]"
          />
        </div>
      </section>

      <section aria-labelledby="business-snapshot-title">
        <div className="mb-3">
          <h2 id="business-snapshot-title" className="text-[0.95rem] font-bold">Business snapshot</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryKpi
          label="Total Revenue"
          value={formatUsdCents(kpis.totalRevenueCents)}
          subtext="Sales revenue · tax excluded"
          icon={<Icon name="trend-up" className="h-5 w-5" />}
          iconToneClassName="bg-sg-success-soft text-sg-success"
        />
        <SummaryKpi
          label="Current Profit"
          value={currentProfitStatus === "pending" ? "Pending" : formatUsdCents(kpis.currentProfitCents)}
          subtext={currentProfitSubtext}
          icon={<span className="text-2xl">$</span>}
          iconToneClassName="bg-sg-success-soft text-sg-success"
        />
        <SummaryKpi
          label="Total Orders"
          value={formatNumber(kpis.totalOrders)}
          subtext={channel === "all" ? `${formatNumber(kpis.websiteOrders)} website · ${formatNumber(kpis.marketplaceOrders)} marketplace` : "Orders in selected channel"}
          icon={<Icon name="cart" className="h-5 w-5" />}
          iconToneClassName="bg-sg-info-soft text-sg-info"
        />
        <SummaryKpi
          label="Average Order Value"
          value={formatUsdCents(kpis.averageOrderValueCents)}
          subtext="Per paid order"
          icon={<Icon name="bar-chart" className="h-5 w-5" />}
          iconToneClassName="bg-sg-info-soft text-sg-info"
        />
        </div>
      </section>

      <section aria-labelledby="operations-overview-title">
        <div className="mb-3">
          <h2 id="operations-overview-title" className="text-[0.95rem] font-bold">Operations overview</h2>
        </div>
        <div className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(420px,1fr)]">
          <div className="min-w-0">
            <MiniAlertGrid summary={summary} nexusRows={nexusRows} />
          </div>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <SummaryKpi
            label="Square Processing Fees"
            value={formatUsdCents(kpis.totalSquareProcessingFeesCents)}
            subtext={`${formatUsdCents(kpis.actualSquareProcessingFeesCents)} actual · ${formatUsdCents(kpis.estimatedSquareProcessingFeesCents)} estimated`}
            icon={<Icon name="receipt" className="h-5 w-5" />}
            iconToneClassName="bg-sg-danger-soft text-sg-danger"
            compact
          />
          <SummaryKpi
            label="Average Square Fee"
            value={formatUsdCents(kpis.averageSquareProcessingFeeCents)}
            subtext={squareFeeOrders > 0
              ? `${formatNumber(squareFeeOrders)} paid Square order${squareFeeOrders === 1 ? "" : "s"} · ${formatNumber(actualSquareFeeOrders)} actual · ${formatNumber(estimatedSquareFeeOrders)} estimated`
              : "No paid Square orders in this range"}
            icon={<span className="text-2xl">$</span>}
            iconToneClassName="bg-sg-warning-soft text-sg-warning"
            compact
          />
          <SummaryKpi
            label="Shipping Expense"
            value={formatUsdCents(kpis.totalShippingExpenseCents)}
            subtext="Known label cost in range"
            icon={<Icon name="truck" className="h-5 w-5" />}
            iconToneClassName="bg-sg-warning-soft text-sg-warning"
            compact
          />
          <SummaryKpi
            label="Profit from Shipping"
            value={signedCurrencyLabel(shippingVarianceCents)}
            subtext="Charged minus label cost"
            icon={<Icon name={shippingVarianceCents >= 0 ? "trend-up" : "trend-down"} className="h-5 w-5" />}
            danger={shippingVarianceCents < 0}
            success={shippingVarianceCents > 0}
            iconToneClassName={shippingVarianceCents >= 0 ? "bg-sg-success-soft text-sg-success" : "bg-sg-danger-soft text-sg-danger"}
            compact
          />
          <SummaryKpi
            label="Avg. Shipping Cost"
            value={formatUsdCents(kpis.averageShippingPerOrderCents)}
            subtext="Per order with known label cost"
            icon={<span className="text-2xl">$</span>}
            iconToneClassName="bg-sg-info-soft text-sg-info"
            compact
          />
          <SummaryKpi
            label="Stock List-Price Potential"
            value={formatUsdCents(kpis.inventorySellThroughRevenueCents)}
            subtext={`${formatNumber(kpis.inventorySellThroughCaseUnits)} cases, ${formatNumber(kpis.inventorySellThroughBoxUnits)} boxes on hand · current list prices`}
            icon={<Icon name="package" className="h-5 w-5" />}
            iconToneClassName="bg-sg-success-soft text-sg-success"
            compact
          />
          </div>
        </div>
      </section>

      <div className="grid items-stretch gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <SalesOverview
            summary={salesSummaryQuery.data}
            preset={salesPreset}
            onPresetChange={setSalesPreset}
            product={salesProduct}
            onProductChange={setSalesProduct}
          />
        </div>
        <div className="lg:col-span-2">
          <ProductPerformance summary={productSummaryQuery.data} preset={productPreset} onPresetChange={setProductPreset} />
        </div>
      </div>

      <div className="grid items-stretch gap-4 lg:grid-cols-5">
        <div className="flex min-w-0 lg:col-span-3">
          <RecentOrders summary={summary} />
        </div>
        <div className="flex min-w-0 lg:col-span-2">
          <InventoryHealth summary={summary} />
        </div>
      </div>

      <StateRevenueRanking
        rows={stateRevenue?.rows || []}
        totalStates={Number(stateRevenue?.totalStates || 0)}
        totalOrders={Number(stateRevenue?.totalOrders || 0)}
        totalRevenueCents={Number(stateRevenue?.totalRevenueCents || 0)}
      />
      <NexusPreview rows={nexusRows} />
    </div>
  );
}
