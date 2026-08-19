import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "../auth/AuthProvider";
import { useAdminShellHeaderMeta } from "../components/layout/AdminShell";
import { CustomSelect } from "../components/ui/CustomSelect";
import { fetchTaxSummary, type TaxSummaryRow } from "../lib/api";
import { formatDateTime, formatNumber, formatUsdCents } from "../lib/format";
import { Icon } from "../lib/icons";

function KpiCard({ label, value, description, icon }: { label: string; value: string; description: string; icon: "receipt" | "cart" | "bar-chart" }) {
  return (
    <article className="sg25-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[13px] font-semibold text-sg-muted">{label}</p>
          <p className="mt-3 text-2xl font-bold">{value}</p>
          <p className="mt-2 text-[13px] text-sg-muted">{description}</p>
        </div>
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-sg-primary-soft text-sg-primary">
          <Icon name={icon} className="h-5 w-5" />
        </span>
      </div>
    </article>
  );
}

function monthLabel(value: string | undefined) {
  if (!value) return "-";
  const date = new Date(`${value}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function SalesTaxPage() {
  const auth = useAuth();
  const [monthFilter, setMonthFilter] = useState("all");

  const taxQuery = useQuery({
    queryKey: ["admin-v2.5-sales-tax"],
    queryFn: async () => fetchTaxSummary(await auth.getAccessToken()),
    enabled: Boolean(auth.session),
  });

  useAdminShellHeaderMeta(taxQuery.data?.generated_at ? <span>Updated {formatDateTime(taxQuery.data.generated_at)}</span> : null);

  const rows = useMemo(() => (Array.isArray(taxQuery.data?.summary) ? taxQuery.data.summary : []), [taxQuery.data?.summary]);
  const months = useMemo(() => [...new Set(rows.map((row) => row.month).filter(Boolean) as string[])].sort().reverse(), [rows]);
  const filteredRows = useMemo(() => (monthFilter === "all" ? rows : rows.filter((row) => row.month === monthFilter)), [monthFilter, rows]);

  const totals = useMemo(
    () =>
      filteredRows.reduce(
        (sum, row) => ({
          taxableRevenue: sum.taxableRevenue + Number(row.taxable_revenue || 0),
          taxCollected: sum.taxCollected + Number(row.tax_collected || 0),
          orders: sum.orders + Number(row.total_orders || 0),
        }),
        { taxableRevenue: 0, taxCollected: 0, orders: 0 },
      ),
    [filteredRows],
  );

  const scope = monthFilter === "all" ? "All months · TN paid orders" : `${monthLabel(monthFilter)} · TN paid orders`;

  function exportCsv() {
    const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [
      ["Month", "State", "Taxable Revenue", "Tax Collected", "Orders"],
      ...filteredRows.map((row) => [monthLabel(row.month), row.state || "", (Number(row.taxable_revenue || 0) / 100).toFixed(2), (Number(row.tax_collected || 0) / 100).toFixed(2), Number(row.total_orders || 0)]),
    ].map((row) => row.map(cell).join(",")).join("\n");
    const blobUrl = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `sai-goods-sales-tax-${monthFilter === "all" ? "all-months" : monthFilter}.csv`;
    link.click();
    URL.revokeObjectURL(blobUrl);
  }

  if (taxQuery.isLoading) {
    return (
      <section className="py-4">
        <h1 className="text-3xl font-bold">Sales Tax (TN)</h1>
        <p className="mt-2 text-sm text-sg-muted">Loading sales tax...</p>
      </section>
    );
  }

  if (taxQuery.error) {
    return (
      <section className="sg25-card p-6">
        <h1 className="text-3xl font-bold">Sales Tax (TN)</h1>
        <p className="mt-3 rounded-[8px] bg-sg-danger-soft p-3 text-sm text-sg-danger">
          {taxQuery.error instanceof Error ? taxQuery.error.message : "Could not load sales tax."}
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section>
        <h1 className="text-4xl font-bold">Sales Tax (TN)</h1>
        <p className="mt-1 text-[15px] text-sg-muted">Review Tennessee taxable sales, collected tax, and monthly order totals.</p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Taxable Revenue" value={formatUsdCents(totals.taxableRevenue)} description={scope} icon="receipt" />
        <KpiCard label="Tax Collected" value={formatUsdCents(totals.taxCollected)} description={scope} icon="receipt" />
        <KpiCard label="Total Orders" value={formatNumber(totals.orders)} description={scope} icon="cart" />
        <KpiCard label="Months Reported" value={formatNumber(filteredRows.length)} description={monthFilter === "all" ? "With paid TN activity" : "Selected month"} icon="bar-chart" />
      </section>

      <section className="sg25-card overflow-hidden p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Icon name="receipt" className="h-4 w-4 text-sg-primary" />
              <h2 className="text-lg font-bold">Monthly Sales Tax</h2>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="sg25-btn sg25-btn-ghost h-[36px] px-3 text-[12px]" disabled={!filteredRows.length} onClick={exportCsv}>
                <span aria-hidden="true">↓</span>
                Export CSV
              </button>
              <CustomSelect
                value={monthFilter}
                options={[{ value: "all", label: "All Months" }, ...months.map((month) => ({ value: month, label: monthLabel(month) }))]}
                onChange={setMonthFilter}
                ariaLabel="Month filter"
                triggerClassName="h-[36px] min-w-[140px]"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="mt-4 w-full min-w-[680px] table-fixed border-collapse text-left">
              <colgroup>
                <col className="w-[190px]" />
                <col className="w-[100px]" />
                <col className="w-[160px]" />
                <col className="w-[160px]" />
                <col className="w-[90px]" />
              </colgroup>
              <thead className="text-[10px] font-bold uppercase tracking-normal text-sg-muted">
                <tr>
                  <th className="border-b border-sg-border py-3 pl-2.5 pr-5">Month</th>
                  <th className="border-b border-sg-border px-0 py-3 pr-5">State</th>
                  <th className="border-b border-sg-border px-0 py-3 pr-5 text-right">Taxable Revenue</th>
                  <th className="border-b border-sg-border px-0 py-3 pr-5 text-right">Tax Collected</th>
                  <th className="border-b border-sg-border px-0 py-3 text-right">Orders</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row: TaxSummaryRow) => (
                  <tr key={`${row.month}-${row.state}`} className="sg25-order-row border-b border-sg-border">
                    <td className="py-4 pl-2.5 pr-5 align-middle text-[13px] font-bold">{monthLabel(row.month)}</td>
                    <td className="px-0 py-4 pr-5 align-middle text-[13px]">{row.state || "-"}</td>
                    <td className="px-0 py-4 pr-5 text-right align-middle text-[13px] font-semibold">{formatUsdCents(row.taxable_revenue)}</td>
                    <td className="px-0 py-4 pr-5 text-right align-middle text-[13px] font-semibold">{formatUsdCents(row.tax_collected)}</td>
                    <td className="px-0 py-4 text-right align-middle text-[13px] font-semibold">{formatNumber(row.total_orders)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!filteredRows.length ? <div className="px-4 py-10 text-center text-sm text-sg-muted">No paid TN orders in this scope.</div> : null}
      </section>
    </div>
  );
}
