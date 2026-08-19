import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "../auth/AuthProvider";
import { useAdminShellHeaderMeta } from "../components/layout/AdminShell";
import { fetchNexusSummary, type NexusSummaryRow } from "../lib/api";
import { formatDateTime, formatNumber, formatUsdCents, stateName } from "../lib/format";
import { Icon } from "../lib/icons";

function KpiCard({ label, value, description, icon }: { label: string; value: string; description: string; icon: "pin" | "cart" | "trend-up" }) {
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

function activityClass(orderCount: number, maxOrders: number) {
  if (orderCount <= 0) return "bg-sg-input-bg text-sg-muted";
  if (orderCount >= maxOrders * 0.25) return "bg-sg-green-soft text-sg-green";
  return "bg-sg-amber-soft text-sg-amber";
}

function activityLabel(orderCount: number, maxOrders: number) {
  if (orderCount <= 0) return "No activity";
  if (orderCount >= maxOrders * 0.25) return "Higher volume";
  return "Lower volume";
}

export function NexusPage() {
  const auth = useAuth();

  const nexusQuery = useQuery({
    queryKey: ["admin-v2.5-nexus-page"],
    queryFn: async () => fetchNexusSummary(await auth.getAccessToken()),
    enabled: Boolean(auth.session),
  });

  useAdminShellHeaderMeta(nexusQuery.data?.generated_at ? <span>Updated {formatDateTime(nexusQuery.data.generated_at)}</span> : null);

  const rows = useMemo(
    () =>
      [...(Array.isArray(nexusQuery.data?.summary) ? nexusQuery.data.summary : [])].sort(
        (a, b) => Number(b.total_revenue || 0) - Number(a.total_revenue || 0),
      ),
    [nexusQuery.data?.summary],
  );

  const totals = useMemo(
    () =>
      rows.reduce(
        (sum, row) => ({
          revenue: sum.revenue + Number(row.total_revenue || 0),
          orders: sum.orders + Number(row.total_orders || 0),
        }),
        { revenue: 0, orders: 0 },
      ),
    [rows],
  );

  const maxOrders = Math.max(1, ...rows.map((row) => Number(row.total_orders || 0)));
  const topState = rows[0];

  if (nexusQuery.isLoading) {
    return (
      <section className="py-4">
        <h1 className="text-3xl font-bold">Nexus by State</h1>
        <p className="mt-2 text-sm text-sg-muted">Loading nexus monitoring...</p>
      </section>
    );
  }

  if (nexusQuery.error) {
    return (
      <section className="sg25-card p-6">
        <h1 className="text-3xl font-bold">Nexus by State</h1>
        <p className="mt-3 rounded-[8px] bg-sg-danger-soft p-3 text-sm text-sg-danger">
          {nexusQuery.error instanceof Error ? nexusQuery.error.message : "Could not load nexus summary."}
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section>
        <h1 className="text-4xl font-bold">Nexus by State</h1>
        <p className="mt-1 text-[15px] text-sg-muted">Monitor paid revenue and order activity by customer destination state.</p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="States with Activity" value={formatNumber(rows.length)} description="Destinations with paid orders" icon="pin" />
        <KpiCard label="Total Revenue" value={formatUsdCents(totals.revenue)} description="Cumulative paid" icon="trend-up" />
        <KpiCard label="Total Orders" value={formatNumber(totals.orders)} description="Across all states" icon="cart" />
        <KpiCard label="Top State" value={topState?.state || "-"} description={topState ? `${formatUsdCents(topState.total_revenue)} paid` : "No data"} icon="pin" />
      </section>

      <section className="sg25-card overflow-hidden p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Icon name="pin" className="h-4 w-4 text-sg-primary" />
              <h2 className="text-lg font-bold">State Activity</h2>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="mt-4 w-full min-w-[720px] table-fixed border-collapse text-left">
              <colgroup>
                <col className="w-[240px]" />
                <col className="w-[150px]" />
                <col className="w-[110px]" />
                <col className="w-[180px]" />
              </colgroup>
              <thead className="text-[10px] font-bold uppercase tracking-normal text-sg-muted">
                <tr>
                  <th className="border-b border-sg-border py-3 pl-2.5 pr-5">State</th>
                  <th className="border-b border-sg-border px-0 py-3 pr-5 text-right">Revenue</th>
                  <th className="border-b border-sg-border px-0 py-3 pr-5 text-right">Orders</th>
                  <th className="border-b border-sg-border px-0 py-3">Activity</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row: NexusSummaryRow) => {
                  const orders = Number(row.total_orders || 0);
                  const revenueShare = totals.revenue > 0 ? Math.round((Number(row.total_revenue || 0) / totals.revenue) * 100) : 0;
                  return (
                    <tr key={row.state} className="sg25-order-row border-b border-sg-border">
                      <td className="py-4 pl-2.5 pr-5 align-middle">
                        <div className="flex items-center gap-3">
                          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-sg-primary text-[13px] font-bold text-white">{row.state}</span>
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-bold">{stateName(row.state)}</p>
                            <p className="mt-0.5 text-[11px] text-sg-muted">{row.state}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-0 py-4 pr-5 text-right align-middle text-[13px] font-semibold">{formatUsdCents(row.total_revenue)}</td>
                      <td className="px-0 py-4 pr-5 text-right align-middle text-[13px] font-semibold">{formatNumber(orders)}</td>
                      <td className="px-0 py-4 align-middle">
                        <div className="flex min-w-0 flex-col gap-1">
                          <span className={`w-fit rounded-full px-2.5 py-1 text-[11px] font-semibold ${activityClass(orders, maxOrders)}`}>
                            {activityLabel(orders, maxOrders)}
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="h-1.5 w-24 rounded-full bg-sg-border-soft">
                              <span className="block h-1.5 rounded-full bg-sg-primary" style={{ width: `${Math.max(2, revenueShare)}%` }} />
                            </span>
                            <span className="text-[11px] text-sg-muted">{revenueShare}%</span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!rows.length ? <div className="px-4 py-10 text-center text-sm text-sg-muted">No paid orders by state yet.</div> : null}
      </section>
    </div>
  );
}
