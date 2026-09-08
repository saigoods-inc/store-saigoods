import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "../auth/AuthProvider";
import { CustomSelect } from "../components/ui/CustomSelect";
import {
  fetchInventoryDashboard,
  postInventoryAction,
  type IncomingInventoryBatch,
  type IncomingInventoryLine,
  type InventoryMovementRow,
  type InventoryVariantRow,
} from "../lib/api";
import { formatDateTime, formatNumber, formatShortDate } from "../lib/format";
import { Icon } from "../lib/icons";

type ChannelFilter = "all" | "case" | "box";
type HealthFilter = "all" | "attention" | "out" | "low" | "healthy";
type Health = { key: string; label: string; detail: string; className: string };
type Group = {
  productSlug: string;
  productName: string;
  size: string;
  boxesPerCase: number;
  caseLine?: InventoryVariantRow;
  boxLine?: InventoryVariantRow;
  availableBoxes: number | null;
  reservedBoxes: number;
  health: Health;
};

const inventoryProductOrder = new Map([
  ["nitrile-standard", 0],
  ["black-nitrile-general", 1],
  ["black-nitrile-heavy-duty", 2],
]);
const inventorySizeOrder = new Map(["S", "M", "L", "XL"].map((size, index) => [size, index]));

function compareInventorySizes(left: string, right: string) {
  const leftRank = inventorySizeOrder.get(left.toUpperCase()) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = inventorySizeOrder.get(right.toUpperCase()) ?? Number.MAX_SAFE_INTEGER;
  return leftRank - rightRank || left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}
type CountDraft = {
  group: Group;
  cases: string;
  boxes: string;
  reason: string;
  note: string;
};
type IncomingLineDraft = {
  key: string;
  id?: string;
  productSlug: string;
  size: string;
  expectedCases: string;
  expectedBoxes: string;
};
type IncomingDraft = {
  createdBatchId?: string;
  name: string;
  supplier: string;
  poNumber: string;
  etaDate: string;
  status: "planned" | "in_transit";
  notes: string;
  lines: IncomingLineDraft[];
};

const num = (value: unknown) =>
  Number.isFinite(Number(value)) ? Number(value) : 0;
const whole = (value: unknown) => Math.max(0, Math.floor(num(value)));
const integer = (value: unknown) => whole(value).toLocaleString();
const signedInteger = (value: unknown) =>
  Math.floor(num(value)).toLocaleString();
const productOf = (row: InventoryVariantRow | InventoryMovementRow) =>
  String(
    row.productSlug || ("product_slug" in row ? row.product_slug : "") || "",
  ).trim();
const channelOf = (row: InventoryVariantRow | InventoryMovementRow) =>
  String(row.channel || "")
    .trim()
    .toLowerCase();
const availableOf = (row?: InventoryVariantRow) =>
  row
    ? Math.max(
        0,
        row.availableFinite == null
          ? whole(row.onHand) - whole(row.reserved)
          : whole(row.availableFinite),
      )
    : 0;

function healthFor(
  available: number | null,
  boxesPerCase: number,
  tracked: boolean,
  active: boolean,
): Health {
  if (!active)
    return {
      key: "inactive",
      label: "Inactive",
      detail: "This stock line is inactive.",
      className: "bg-sg-input-bg text-sg-muted",
    };
  if (!tracked || available == null)
    return {
      key: "untracked",
      label: "Not tracked",
      detail: "Quantity tracking is disabled.",
      className: "bg-sg-input-bg text-sg-muted",
    };
  if (available <= 0)
    return {
      key: "out",
      label: "Out",
      detail: "No sellable stock remains.",
      className: "bg-sg-danger-soft text-sg-danger",
    };
  if (available <= boxesPerCase)
    return {
      key: "low",
      label: "Low",
      detail: "One carton worth or less remains.",
      className: "bg-amber-50 text-amber-700",
    };
  return {
    key: "healthy",
    label: "Healthy",
    detail: "Stock is above the low-stock level.",
    className: "bg-sg-success-soft text-sg-success",
  };
}

function Kpi({
  label,
  value,
  icon,
  tone = "",
}: {
  label: string;
  value: string;
  icon: Parameters<typeof Icon>[0]["name"];
  tone?: string;
}) {
  return (
    <section className="sg25-card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-sg-muted">{label}</p>
        <Icon name={icon} className={`h-4 w-4 ${tone}`} />
      </div>
      <p className={`mt-3 text-3xl font-bold ${tone}`}>{value}</p>
    </section>
  );
}

function Modal({
  title,
  close,
  children,
  wide,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", escape);
    };
  }, [close]);
  return createPortal(
    <div className="fixed inset-0 z-[100] flex h-[100dvh] items-center justify-center overflow-hidden bg-black/45 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[calc(100dvh-2rem)] w-full overflow-y-auto rounded-[10px] bg-white p-5 shadow-[0_28px_80px_rgba(31,27,24,0.28)] sm:p-6 ${wide ? "max-w-3xl" : "max-w-lg"}`}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-2xl font-bold">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            className="sg25-btn sg25-btn-ghost h-9 w-9 p-0"
            onClick={close}
          >
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>
        {children}
      </section>
    </div>,
    document.body,
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-2 block text-[12px] font-bold text-sg-muted">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1.5 block text-[11px] leading-4 text-sg-muted">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function StockChannel({
  label,
  line,
  show,
}: {
  label: string;
  line?: InventoryVariantRow;
  show: boolean;
}) {
  if (!show) return null;
  return (
    <div className="min-w-0 rounded-[8px] border border-sg-border bg-sg-input-bg/55 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-bold uppercase tracking-wide text-sg-muted">
          {label}
        </p>
        <p className="text-[18px] font-bold tabular-nums">
          {integer(line?.onHand)}
        </p>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-sg-muted">
        <span>
          Reserved{" "}
          <strong className="ml-1 text-sg-text">
            {integer(line?.reserved)}
          </strong>
        </span>
        <span className="text-right">
          Available{" "}
          <strong className="ml-1 text-sg-text">
            {integer(availableOf(line))}
          </strong>
        </span>
      </div>
    </div>
  );
}

export function InventoryPage() {
  const auth = useAuth();
  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [countDraft, setCountDraft] = useState<CountDraft | null>(null);
  const [countReview, setCountReview] = useState(false);
  const [countSaving, setCountSaving] = useState(false);
  const [countError, setCountError] = useState("");
  const [incomingDraft, setIncomingDraft] = useState<IncomingDraft | null>(
    null,
  );
  const [incomingReview, setIncomingReview] = useState(false);
  const [incomingSaving, setIncomingSaving] = useState(false);
  const [incomingError, setIncomingError] = useState("");
  const [movementPage, setMovementPage] = useState(0);

  const inventory = useQuery({
    queryKey: ["inventory-dashboard"],
    queryFn: async () => fetchInventoryDashboard(await auth.getAccessToken()),
  });
  const variants = inventory.data?.variants || [];
  const movements = inventory.data?.movements || [];
  const movementPageCount = Math.max(1, Math.ceil(movements.length / 10));
  const effectiveMovementPage = Math.min(movementPage, movementPageCount - 1);
  const visibleMovements = movements.slice(effectiveMovementPage * 10, effectiveMovementPage * 10 + 10);
  const incomingRows = inventory.data?.incomingInventory?.rows || [];
  const activeIncomingRows = useMemo(
    () =>
      incomingRows.filter((row) =>
        ["planned", "in_transit", "arrived", "on_hold"].includes(
          String(row.batch?.status || ""),
        ),
      ),
    [incomingRows],
  );
  const incomingSummary = inventory.data?.incomingInventory?.summary || {};

  const groups = useMemo<Group[]>(() => {
    const map = new Map<
      string,
      Omit<Group, "availableBoxes" | "reservedBoxes" | "health">
    >();
    for (const row of variants) {
      const slug = productOf(row),
        size = String(row.size || "").trim();
      if (!slug || !size) continue;
      const key = `${slug}\t${size}`;
      const current = map.get(key) || {
        productSlug: slug,
        productName: String(row.productName || slug),
        size,
        boxesPerCase: Math.max(1, whole(row.boxesPerCase) || 1),
      };
      if (channelOf(row) === "case") current.caseLine = row;
      if (channelOf(row) === "box") current.boxLine = row;
      map.set(key, current);
    }
    return [...map.values()]
      .map((row) => {
        const stockLines = [row.caseLine, row.boxLine].filter(
          (line): line is InventoryVariantRow => Boolean(line),
        );
        const tracked = stockLines.some((line) => Boolean(line.track));
        const active = stockLines.some((line) => line.active !== false);
        const availableBoxes = tracked
          ? availableOf(row.caseLine) * row.boxesPerCase +
            availableOf(row.boxLine)
          : null;
        const reservedBoxes =
          whole(row.caseLine?.reserved) * row.boxesPerCase +
          whole(row.boxLine?.reserved);
        return {
          ...row,
          availableBoxes,
          reservedBoxes,
          health: healthFor(availableBoxes, row.boxesPerCase, tracked, active),
        };
      })
      .sort(
        (a, b) =>
          (inventoryProductOrder.get(a.productSlug) ?? Number.MAX_SAFE_INTEGER) -
            (inventoryProductOrder.get(b.productSlug) ?? Number.MAX_SAFE_INTEGER) ||
          a.productName.localeCompare(b.productName) ||
          compareInventorySizes(a.size, b.size),
      );
  }, [variants]);

  const filtered = useMemo(
    () =>
      groups.filter((group) => {
        const needle = query.trim().toLowerCase();
        if (
          needle &&
          ![group.productName, group.productSlug, group.size].some((item) =>
            item.toLowerCase().includes(needle),
          )
        )
          return false;
        if (healthFilter === "attention")
          return ["out", "low"].includes(group.health.key);
        return healthFilter === "all" || healthFilter === group.health.key;
      }),
    [groups, healthFilter, query],
  );

  const products = useMemo(() => {
    const map = new Map<string, Group[]>();
    for (const group of filtered)
      map.set(group.productSlug, [
        ...(map.get(group.productSlug) || []),
        group,
      ]);
    return [...map.entries()];
  }, [filtered]);
  const productOptions = useMemo(
    () =>
      [
        ...new Map(groups.map((g) => [g.productSlug, g.productName])).entries(),
      ].map(([value, label]) => ({ value, label })),
    [groups],
  );
  const sizeOptions = (slug: string) =>
    groups
      .filter((group) => group.productSlug === slug)
      .sort((a, b) => compareInventorySizes(a.size, b.size))
      .map((group) => ({ value: group.size, label: group.size }));
  const counts = useMemo(
    () =>
      groups.reduce(
        (result, group) => {
          if (group.health.key === "out") result.out++;
          if (group.health.key === "low") result.low++;
          return result;
        },
        { out: 0, low: 0 },
      ),
    [groups],
  );

  const openCount = (group: Group) => {
    setCountDraft({
      group,
      cases: String(whole(group.caseLine?.onHand)),
      boxes: String(whole(group.boxLine?.onHand)),
      reason: "Physical stock count",
      note: "",
    });
    setCountReview(false);
    setCountError("");
  };
  const saveCount = async () => {
    if (!countDraft || countSaving) return;
    setCountSaving(true);
    setCountError("");
    try {
      await postInventoryAction(
        {
          action: "stock_patch",
          patches: [
            {
              productSlug: countDraft.group.productSlug,
              size: countDraft.group.size,
              channel: "case",
              setOnHand: whole(countDraft.cases),
              track: true,
            },
            {
              productSlug: countDraft.group.productSlug,
              size: countDraft.group.size,
              channel: "box",
              setOnHand: whole(countDraft.boxes),
              track: true,
            },
          ],
          reason: countDraft.reason.trim(),
          source: "physical_stock_override",
          overrideNote: countDraft.note.trim() || null,
        },
        await auth.getAccessToken(),
      );
      await inventory.refetch();
      setCountDraft(null);
    } catch (error) {
      setCountError(
        error instanceof Error
          ? error.message
          : "Could not update current stock.",
      );
    } finally {
      setCountSaving(false);
    }
  };

  const blankIncoming = (): IncomingDraft => {
    const productSlug = productOptions[0]?.value || "";
    return {
      name: "",
      supplier: "",
      poNumber: "",
      etaDate: "",
      status: "planned",
      notes: "",
      lines: [
        {
          key: crypto.randomUUID(),
          productSlug,
          size: sizeOptions(productSlug)[0]?.value || "",
          expectedCases: "0",
          expectedBoxes: "0",
        },
      ],
    };
  };
  const updateLine = (key: string, patch: Partial<IncomingLineDraft>) => {
    setIncomingDraft((current) =>
      current
        ? {
            ...current,
            lines: current.lines.map((line) =>
              line.key === key ? { ...line, ...patch } : line,
            ),
          }
        : current,
    );
    setIncomingReview(false);
    setIncomingError("");
  };
  const incomingValidation = useMemo(() => {
    if (!incomingDraft) return "";
    if (!incomingDraft.name.trim()) return "Enter a shipment or batch name.";
    const seen = new Set<string>();
    for (const line of incomingDraft.lines) {
      if (!line.productSlug || !line.size)
        return "Choose a product and size for every line.";
      if (whole(line.expectedCases) + whole(line.expectedBoxes) < 1)
        return "Every line needs at least one expected carton or box.";
      const key = `${line.productSlug}\t${line.size}`;
      if (seen.has(key)) return "Combine duplicate product and size lines.";
      seen.add(key);
    }
    return "";
  }, [incomingDraft]);

  const saveIncoming = async () => {
    if (!incomingDraft || incomingSaving || incomingValidation) return;
    setIncomingSaving(true);
    setIncomingError("");
    let working = incomingDraft;
    try {
      const token = await auth.getAccessToken();
      let batchId = working.createdBatchId;
      if (!batchId) {
        const response = await postInventoryAction<{
          batch?: IncomingInventoryBatch;
        }>(
          {
            action: "incoming_batch_create",
            batch: {
              batch_name: working.name.trim(),
              supplier: working.supplier.trim() || null,
              po_number: working.poNumber.trim() || null,
              eta_date: working.etaDate || null,
              status: working.status,
              notes: working.notes.trim() || null,
            },
          },
          token,
        );
        batchId = String(response.batch?.id || "");
        if (!batchId)
          throw new Error(
            "The incoming shipment was created without an ID. Refresh before retrying.",
          );
        working = { ...working, createdBatchId: batchId };
        setIncomingDraft(working);
      }
      const nextLines = [...working.lines];
      for (let index = 0; index < nextLines.length; index++) {
        const line = nextLines[index];
        if (line.id) continue;
        const response = await postInventoryAction<{
          line?: IncomingInventoryLine;
        }>(
          {
            action: "incoming_batch_line_create",
            batch_id: batchId,
            line: {
              product_slug: line.productSlug,
              size: line.size,
              expected_cases: whole(line.expectedCases),
              expected_boxes: whole(line.expectedBoxes),
            },
          },
          token,
        );
        const id = String(response.line?.id || "");
        if (!id)
          throw new Error(
            "An inventory line was not saved. Retry to continue without duplicating saved lines.",
          );
        nextLines[index] = { ...line, id };
        working = { ...working, lines: nextLines };
        setIncomingDraft(working);
      }
      await inventory.refetch();
      setIncomingDraft(null);
    } catch (error) {
      setIncomingDraft(working);
      setIncomingError(
        error instanceof Error
          ? error.message
          : "Could not save incoming stock. Retry to continue.",
      );
    } finally {
      setIncomingSaving(false);
    }
  };

  if (inventory.isLoading)
    return (
      <section className="py-4">
        <h1 className="text-3xl font-bold">Inventory</h1>
        <p className="mt-2 text-sm text-sg-muted">Loading inventory...</p>
      </section>
    );
  if (inventory.isError)
    return (
      <section className="sg25-card border-sg-danger/30 bg-sg-danger-soft p-6 text-sg-danger">
        <h1 className="text-2xl font-bold">Inventory unavailable</h1>
        <p className="mt-2 text-sm">
          {inventory.error instanceof Error
            ? inventory.error.message
            : "Could not load inventory."}
        </p>
        <button
          type="button"
          className="sg25-btn sg25-btn-primary mt-4"
          onClick={() => void inventory.refetch()}
        >
          Retry
        </button>
      </section>
    );

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-4xl font-bold">Inventory</h1>
          <p className="mt-1 text-[15px] text-sg-muted">
            Monitor stock health, record physical counts, and manage expected
            inventory.
          </p>
        </div>
        <button
          type="button"
          className="sg25-btn sg25-btn-ghost"
          onClick={() => void inventory.refetch()}
        >
          <Icon name="refresh" className="h-4 w-4" />
          Refresh
        </button>
      </section>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi
          label="Sellable boxes"
          value={integer(
            groups.reduce((sum, group) => sum + (group.availableBoxes || 0), 0),
          )}
          icon="check"
        />
        <Kpi
          label="Reserved boxes"
          value={integer(
            groups.reduce((sum, group) => sum + group.reservedBoxes, 0),
          )}
          icon="lock"
        />
        <Kpi
          label="Incoming cartons"
          value={integer(incomingSummary.incomingCases)}
          icon="truck"
        />
        <Kpi
          label="Low stock"
          value={integer(counts.low)}
          icon="alert"
          tone="text-amber-700"
        />
        <Kpi
          label="Out of stock"
          value={integer(counts.out)}
          icon="alert"
          tone="text-sg-danger"
        />
      </section>

      <section className="sg25-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Stock Lines</h2>
            <p className="mt-1 text-[13px] text-sg-muted">
              Grouped by product and size. Cartons and loose boxes share one
              stock-health result.
            </p>
          </div>
          <div className="flex w-full flex-wrap gap-2 lg:w-auto">
            <input
              className="sg25-input min-w-0 flex-1 lg:w-60 lg:flex-none"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search product or size"
            />
            <CustomSelect
              value={healthFilter}
              options={[
                { value: "all", label: "All health" },
                { value: "attention", label: "Needs attention" },
                { value: "out", label: "Out of stock" },
                { value: "low", label: "Low stock" },
                { value: "healthy", label: "Healthy" },
              ]}
              onChange={setHealthFilter}
              ariaLabel="Stock health filter"
              triggerClassName="h-[42px] min-w-[148px]"
            />
            <CustomSelect
              value={channel}
              options={[
                { value: "all", label: "Cartons & boxes" },
                { value: "case", label: "Cartons" },
                { value: "box", label: "Boxes" },
              ]}
              onChange={setChannel}
              ariaLabel="Stock channel filter"
              triggerClassName="h-[42px] min-w-[138px]"
            />
          </div>
        </div>
        <div className="mt-4 space-y-3">
          {products.map(([slug, rows]) => {
            const attention = rows.filter((g) =>
              ["out", "low"].includes(g.health.key),
            ).length;
            const expanded = !collapsed[slug];
            return (
              <section
                key={slug}
                className="overflow-hidden rounded-[9px] border border-sg-border"
              >
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 bg-sg-input-bg/45 px-4 py-3 text-left"
                  onClick={() =>
                    setCollapsed((current) => ({
                      ...current,
                      [slug]: expanded,
                    }))
                  }
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-bold">
                      {rows[0]?.productName || slug}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-sg-muted">
                      {rows.length} size{rows.length === 1 ? "" : "s"} · {slug}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    {attention ? (
                      <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-700">
                        {attention} need attention
                      </span>
                    ) : (
                      <span className="rounded-full bg-sg-success-soft px-2.5 py-1 text-[11px] font-bold text-sg-success">
                        Healthy
                      </span>
                    )}
                    <Icon
                      name="chevron"
                      className={`h-4 w-4 text-sg-muted transition ${expanded ? "rotate-180" : ""}`}
                    />
                  </span>
                </button>
                {expanded ? (
                  <div className="divide-y divide-sg-border">
                    {rows.map((group) => (
                      <div
                        key={group.size}
                        className="grid gap-3 p-4 lg:grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_170px_112px] lg:items-center"
                      >
                        <div className="flex items-center justify-between lg:block">
                          <span className="text-[11px] font-bold uppercase text-sg-muted">
                            Size
                          </span>
                          <strong className="ml-2 text-[18px] lg:ml-0 lg:mt-1 lg:block">
                            {group.size}
                          </strong>
                        </div>
                        <StockChannel
                          label="Cartons"
                          line={group.caseLine}
                          show={channel !== "box"}
                        />
                        <StockChannel
                          label="Loose boxes"
                          line={group.boxLine}
                          show={channel !== "case"}
                        />
                        <div>
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${group.health.className}`}
                          >
                            {group.health.label}
                          </span>
                          <p className="mt-1.5 text-[12px] font-semibold">
                            {group.availableBoxes == null
                              ? "Not tracked"
                              : `${integer(group.availableBoxes)} sellable boxes`}
                          </p>
                          <p className="mt-0.5 text-[10px] leading-4 text-sg-muted">
                            {group.health.detail}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="sg25-btn sg25-btn-ghost w-full whitespace-nowrap justify-center lg:w-auto"
                          onClick={() => openCount(group)}
                        >
                          <Icon name="edit" className="h-3.5 w-3.5" />
                          Update count
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
          {!products.length ? (
            <div className="rounded-[8px] border border-dashed border-sg-border px-4 py-8 text-center text-[13px] text-sg-muted">
              No stock matches these filters.
            </div>
          ) : null}
        </div>
      </section>

      <section className="sg25-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Incoming Stock</h2>
            <p className="mt-1 text-[13px] text-sg-muted">
              Expected shipments stay separate from on-hand stock until they are
              received.
            </p>
          </div>
          <button
            type="button"
            className="sg25-btn sg25-btn-primary"
            onClick={() => {
              setIncomingDraft(blankIncoming());
              setIncomingReview(false);
              setIncomingError("");
            }}
          >
            <Icon name="truck" className="h-4 w-4" />
            Add incoming shipment
          </button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {activeIncomingRows.map((row, index) => {
            const batch = row.batch || {},
              lines = row.lines || [];
            const cases = lines.reduce(
                (sum, line) => sum + whole(line.expected_cases),
                0,
              ),
              boxes = lines.reduce(
                (sum, line) => sum + whole(line.expected_boxes),
                0,
              );
            return (
              <article
                key={batch.id || index}
                className="rounded-[8px] border border-sg-border p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-[14px] font-bold">
                      {batch.batch_name || "Incoming shipment"}
                    </h3>
                    <p className="mt-1 text-[11px] text-sg-muted">
                      {batch.supplier ||
                        batch.po_number ||
                        "Supplier not recorded"}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-bold capitalize text-amber-700">
                    {String(batch.status || "planned").replaceAll("_", " ")}
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 border-t border-sg-border pt-3 text-[11px]">
                  <span>
                    <span className="block text-sg-muted">Expected</span>
                    <strong className="mt-1 block">
                      {cases} cases · {boxes} boxes
                    </strong>
                  </span>
                  <span>
                    <span className="block text-sg-muted">Lines</span>
                    <strong className="mt-1 block">{lines.length}</strong>
                  </span>
                  <span>
                    <span className="block text-sg-muted">ETA</span>
                    <strong className="mt-1 block">
                      {formatShortDate(batch.eta_date)}
                    </strong>
                  </span>
                </div>
              </article>
            );
          })}
          {!activeIncomingRows.length ? (
            <div className="rounded-[8px] border border-dashed border-sg-border p-6 text-[13px] text-sg-muted md:col-span-2 xl:col-span-3">
              No incoming shipments are being tracked. Add one when a purchase
              order is confirmed.
            </div>
          ) : null}
        </div>
      </section>

      <section className="sg25-card p-4">
        <h2 className="text-lg font-bold">Recent Movements</h2>
        <p className="mt-1 text-[13px] text-sg-muted">
          Audit trail for recounts, reservations, receipts, and fulfillment
          changes.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-sg-border text-xs uppercase text-sg-muted">
              <tr>
                <th className="px-3 py-3">When</th>
                <th className="px-3 py-3">Product</th>
                <th className="px-3 py-3">Size</th>
                <th className="px-3 py-3">Channel</th>
                <th className="px-3 py-3 text-right">On-hand change</th>
                <th className="px-3 py-3 text-right">Reserved change</th>
                <th className="px-3 py-3">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-sg-border">
              {visibleMovements.map((row, index) => (
                <tr key={`${row.id || index}`}>
                  <td className="whitespace-nowrap px-3 py-3">
                    {formatDateTime(row.createdAt || row.created_at)}
                  </td>
                  <td className="px-3 py-3 font-medium">
                    {productOf(row) || "-"}
                  </td>
                  <td className="px-3 py-3">{row.size || "-"}</td>
                  <td className="px-3 py-3 capitalize">{row.channel || "-"}</td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {signedInteger(row.deltaOnHand ?? row.delta_on_hand)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {signedInteger(row.deltaReserved ?? row.delta_reserved)}
                  </td>
                  <td className="px-3 py-3">{row.reason || "-"}</td>
                </tr>
              ))}
              {!movements.length ? (
                <tr>
                  <td
                    className="px-3 py-6 text-center text-sg-muted"
                    colSpan={7}
                  >
                    No recent inventory movement.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {movements.length ? (
          <div className="mt-4 flex items-center justify-end gap-3">
            <p className="text-[11px] text-sg-muted">Page {effectiveMovementPage + 1} of {movementPageCount} · {formatNumber(movements.length)} movements</p>
            <div className="flex gap-2">
              <button type="button" className="sg25-btn sg25-btn-ghost h-8 w-8 p-0" aria-label="Previous movement page" disabled={effectiveMovementPage === 0} onClick={() => setMovementPage((page) => Math.max(0, page - 1))}>←</button>
              <button type="button" className="sg25-btn sg25-btn-ghost h-8 w-8 p-0" aria-label="Next movement page" disabled={effectiveMovementPage + 1 >= movementPageCount} onClick={() => setMovementPage((page) => Math.min(movementPageCount - 1, page + 1))}>→</button>
            </div>
          </div>
        ) : null}
      </section>

      {countDraft ? (
        <Modal
          title={
            countReview ? "Confirm physical count" : "Update current stock"
          }
          close={() => !countSaving && setCountDraft(null)}
        >
          <p className="mt-2 text-[13px] text-sg-muted">
            {countDraft.group.productName} · Size {countDraft.group.size}
          </p>
          {!countReview ? (
            <div className="mt-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Cartons on hand">
                  <input
                    type="number"
                    min="0"
                    className="sg25-input w-full"
                    value={countDraft.cases}
                    onChange={(event) =>
                      setCountDraft({
                        ...countDraft,
                        cases: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Loose boxes on hand">
                  <input
                    type="number"
                    min="0"
                    className="sg25-input w-full"
                    value={countDraft.boxes}
                    onChange={(event) =>
                      setCountDraft({
                        ...countDraft,
                        boxes: event.target.value,
                      })
                    }
                  />
                </Field>
              </div>
              <Field label="Reason">
                <input
                  className="sg25-input w-full"
                  value={countDraft.reason}
                  onChange={(event) =>
                    setCountDraft({ ...countDraft, reason: event.target.value })
                  }
                />
              </Field>
              <Field
                label="Count note (optional)"
                hint="For example: shelf count, damaged stock removed, or count sheet reference."
              >
                <textarea
                  className="sg25-input min-h-20 w-full resize-y py-3"
                  value={countDraft.note}
                  onChange={(event) =>
                    setCountDraft({ ...countDraft, note: event.target.value })
                  }
                />
              </Field>
              <div className="rounded-[8px] bg-sg-input-bg p-3 text-[12px] text-sg-muted">
                This changes current on-hand stock only. It does not receive or
                alter incoming shipments.
              </div>
            </div>
          ) : (
            <div className="mt-5 grid grid-cols-2 gap-3">
              <div className="rounded-[8px] border border-sg-border p-3">
                <p className="text-[11px] text-sg-muted">Cartons</p>
                <p className="mt-1 text-lg font-bold">
                  {integer(countDraft.group.caseLine?.onHand)} →{" "}
                  {integer(countDraft.cases)}
                </p>
              </div>
              <div className="rounded-[8px] border border-sg-border p-3">
                <p className="text-[11px] text-sg-muted">Loose boxes</p>
                <p className="mt-1 text-lg font-bold">
                  {integer(countDraft.group.boxLine?.onHand)} →{" "}
                  {integer(countDraft.boxes)}
                </p>
              </div>
            </div>
          )}
          {countError ? (
            <div
              role="alert"
              className="mt-4 rounded-[8px] bg-sg-danger-soft p-3 text-[12px] font-semibold text-sg-danger"
            >
              {countError}
            </div>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              className="sg25-btn sg25-btn-ghost"
              disabled={countSaving}
              onClick={() =>
                countReview ? setCountReview(false) : setCountDraft(null)
              }
            >
              {countReview ? "Back" : "Cancel"}
            </button>
            <button
              type="button"
              className="sg25-btn sg25-btn-primary"
              disabled={countSaving || !countDraft.reason.trim()}
              onClick={() =>
                countReview ? void saveCount() : setCountReview(true)
              }
            >
              {countSaving
                ? "Saving..."
                : countReview
                  ? "Confirm count"
                  : "Review change"}
            </button>
          </div>
        </Modal>
      ) : null}

      {incomingDraft ? (
        <Modal
          wide
          title={
            incomingReview
              ? "Confirm incoming shipment"
              : "Add incoming shipment"
          }
          close={() => !incomingSaving && setIncomingDraft(null)}
        >
          {!incomingReview ? (
            <div className="mt-5 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Shipment / batch name">
                  <input
                    className="sg25-input w-full"
                    value={incomingDraft.name}
                    onChange={(e) =>
                      setIncomingDraft({
                        ...incomingDraft,
                        name: e.target.value,
                      })
                    }
                    placeholder="PO 1042 · September restock"
                  />
                </Field>
                <Field label="Supplier">
                  <input
                    className="sg25-input w-full"
                    value={incomingDraft.supplier}
                    onChange={(e) =>
                      setIncomingDraft({
                        ...incomingDraft,
                        supplier: e.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Purchase order (optional)">
                  <input
                    className="sg25-input w-full"
                    value={incomingDraft.poNumber}
                    onChange={(e) =>
                      setIncomingDraft({
                        ...incomingDraft,
                        poNumber: e.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Expected arrival">
                  <input
                    type="date"
                    className="sg25-input w-full"
                    value={incomingDraft.etaDate}
                    onChange={(e) =>
                      setIncomingDraft({
                        ...incomingDraft,
                        etaDate: e.target.value,
                      })
                    }
                  />
                </Field>
              </div>
              <Field label="Shipment status">
                <CustomSelect
                  value={incomingDraft.status}
                  options={[
                    { value: "planned", label: "Planned" },
                    { value: "in_transit", label: "In transit" },
                  ]}
                  onChange={(status) =>
                    setIncomingDraft({ ...incomingDraft, status })
                  }
                  ariaLabel="Incoming shipment status"
                  className="w-full"
                  triggerClassName="h-[42px] w-full rounded-[7px] bg-white px-4 text-[13px]"
                  panelClassName="left-0 right-auto w-full"
                />
              </Field>
              <div className="border-t border-sg-border pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-[14px] font-bold">
                      Expected inventory
                    </h3>
                    <p className="mt-1 text-[11px] text-sg-muted">
                      Add each product and size included in this shipment.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="sg25-btn sg25-btn-ghost"
                    onClick={() => {
                      const slug = productOptions[0]?.value || "";
                      setIncomingDraft({
                        ...incomingDraft,
                        lines: [
                          ...incomingDraft.lines,
                          {
                            key: crypto.randomUUID(),
                            productSlug: slug,
                            size: sizeOptions(slug)[0]?.value || "",
                            expectedCases: "0",
                            expectedBoxes: "0",
                          },
                        ],
                      });
                    }}
                  >
                    Add line
                  </button>
                </div>
                <div className="mt-3 space-y-3">
                  {incomingDraft.lines.map((line) => (
                    <div
                      key={line.key}
                      className="grid gap-2 rounded-[8px] border border-sg-border p-3 sm:grid-cols-[minmax(0,1.4fr)_90px_90px_90px_40px] sm:items-end"
                    >
                      <Field label="Product">
                        <CustomSelect
                          value={line.productSlug}
                          options={productOptions}
                          onChange={(productSlug) =>
                            updateLine(line.key, {
                              productSlug,
                              size: sizeOptions(productSlug)[0]?.value || "",
                            })
                          }
                          ariaLabel="Incoming product"
                          className="w-full"
                          triggerClassName="h-[42px] w-full rounded-[7px] bg-white px-3 text-[12px]"
                          panelClassName="left-0 right-auto w-full"
                        />
                      </Field>
                      <Field label="Size">
                        <CustomSelect
                          value={line.size}
                          options={sizeOptions(line.productSlug)}
                          onChange={(size) => updateLine(line.key, { size })}
                          ariaLabel="Incoming size"
                          className="w-full"
                          triggerClassName="h-[42px] w-full rounded-[7px] bg-white px-3 text-[12px]"
                          panelClassName="left-0 right-auto w-full"
                        />
                      </Field>
                      <Field label="Cartons">
                        <input
                          type="number"
                          min="0"
                          className="sg25-input w-full"
                          value={line.expectedCases}
                          onChange={(e) =>
                            updateLine(line.key, {
                              expectedCases: e.target.value,
                            })
                          }
                        />
                      </Field>
                      <Field label="Boxes">
                        <input
                          type="number"
                          min="0"
                          className="sg25-input w-full"
                          value={line.expectedBoxes}
                          onChange={(e) =>
                            updateLine(line.key, {
                              expectedBoxes: e.target.value,
                            })
                          }
                        />
                      </Field>
                      <button
                        type="button"
                        aria-label="Remove line"
                        className="sg25-btn sg25-btn-ghost h-[42px] w-[42px] p-0"
                        disabled={
                          incomingDraft.lines.length === 1 || Boolean(line.id)
                        }
                        onClick={() =>
                          setIncomingDraft({
                            ...incomingDraft,
                            lines: incomingDraft.lines.filter(
                              (item) => item.key !== line.key,
                            ),
                          })
                        }
                      >
                        <Icon name="trash" className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <Field label="Notes (optional)">
                <textarea
                  className="sg25-input min-h-20 w-full resize-y py-3"
                  value={incomingDraft.notes}
                  onChange={(e) =>
                    setIncomingDraft({
                      ...incomingDraft,
                      notes: e.target.value,
                    })
                  }
                />
              </Field>
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              <div className="rounded-[8px] bg-sg-input-bg p-4">
                <p className="font-bold">{incomingDraft.name}</p>
                <p className="mt-1 text-[12px] text-sg-muted">
                  {incomingDraft.supplier || "Supplier not recorded"} ·{" "}
                  {incomingDraft.etaDate
                    ? `ETA ${formatShortDate(incomingDraft.etaDate)}`
                    : "No ETA"}
                </p>
              </div>
              {incomingDraft.lines.map((line) => (
                <div
                  key={line.key}
                  className="flex items-center justify-between gap-3 rounded-[8px] border border-sg-border px-3 py-2 text-[12px]"
                >
                  <span>
                    <strong>
                      {productOptions.find(
                        (option) => option.value === line.productSlug,
                      )?.label || line.productSlug}
                    </strong>{" "}
                    · Size {line.size}
                  </span>
                  <span className="shrink-0 font-semibold">
                    {whole(line.expectedCases)} cartons ·{" "}
                    {whole(line.expectedBoxes)} boxes
                  </span>
                </div>
              ))}
              <div className="rounded-[8px] bg-amber-50 p-3 text-[12px] leading-5 text-amber-800">
                This records expected inventory only. On-hand stock will not
                change until receiving is completed.
              </div>
            </div>
          )}
          {incomingError || (!incomingReview && incomingValidation) ? (
            <div
              role="alert"
              className="mt-4 rounded-[8px] bg-sg-danger-soft p-3 text-[12px] font-semibold text-sg-danger"
            >
              {incomingError || incomingValidation}
            </div>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              className="sg25-btn sg25-btn-ghost"
              disabled={incomingSaving}
              onClick={() =>
                incomingReview
                  ? setIncomingReview(false)
                  : setIncomingDraft(null)
              }
            >
              {incomingReview ? "Back" : "Cancel"}
            </button>
            <button
              type="button"
              className="sg25-btn sg25-btn-primary"
              disabled={incomingSaving || Boolean(incomingValidation)}
              onClick={() =>
                incomingReview ? void saveIncoming() : setIncomingReview(true)
              }
            >
              {incomingSaving
                ? "Saving..."
                : incomingReview
                  ? "Confirm shipment"
                  : "Review shipment"}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
