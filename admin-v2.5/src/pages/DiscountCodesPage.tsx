import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "../auth/AuthProvider";
import { useAdminShellHeaderMeta } from "../components/layout/AdminShell";
import { CustomSelect } from "../components/ui/CustomSelect";
import { createDiscountCode, fetchDiscountCodes, type DiscountCodeRow } from "../lib/api";
import { formatDateTime, formatNumber } from "../lib/format";
import { Icon } from "../lib/icons";

type StatusFilter = "all" | "unused" | "used";
type SortFilter = "newest" | "oldest" | "code_az" | "code_za";

const statusOptions: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All Status" },
  { value: "unused", label: "Unused" },
  { value: "used", label: "Used" },
];

const sortOptions: Array<{ value: SortFilter; label: string }> = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "code_az", label: "Code A-Z" },
  { value: "code_za", label: "Code Z-A" },
];

function KpiCard({ label, value, description, icon }: { label: string; value: string; description: string; icon: "tag" | "receipt" | "bar-chart" }) {
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

function statusChip(used: boolean) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${used ? "bg-sg-green-soft text-sg-green" : "bg-sg-amber-soft text-sg-amber"}`}>
      {used ? "Used" : "Unused"}
    </span>
  );
}

function codeDate(value: string | null | undefined) {
  return value ? formatDateTime(value) : "-";
}

function sortTime(value: string | null | undefined) {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

export function DiscountCodesPage() {
  const auth = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortFilter>("newest");
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"random" | "manual">("random");
  const [createCode, setCreateCode] = useState("");
  const [createPercent, setCreatePercent] = useState("7");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");

  const codesQuery = useQuery({
    queryKey: ["admin-v2.5-discount-codes"],
    queryFn: async () => fetchDiscountCodes(await auth.getAccessToken()),
    enabled: Boolean(auth.session),
  });

  useAdminShellHeaderMeta(codesQuery.data?.generated_at ? <span>Updated {formatDateTime(codesQuery.data.generated_at)}</span> : null);

  const codes = useMemo(() => (Array.isArray(codesQuery.data?.codes) ? codesQuery.data.codes : []), [codesQuery.data?.codes]);

  const filteredCodes = useMemo(() => {
    const query = search.trim().toUpperCase();
    return [...codes]
      .filter((row) => {
        const used = Boolean(row.is_used);
        if (status === "used" && !used) return false;
        if (status === "unused" && used) return false;
        if (!query) return true;
        return [row.code, row.used_by_order_id].some((value) => String(value || "").toUpperCase().includes(query));
      })
      .sort((a, b) => {
        const aCode = String(a.code || "");
        const bCode = String(b.code || "");
        if (sort === "oldest") return sortTime(a.created_at) - sortTime(b.created_at);
        if (sort === "code_az") return aCode.localeCompare(bCode);
        if (sort === "code_za") return bCode.localeCompare(aCode);
        return sortTime(b.created_at) - sortTime(a.created_at);
      });
  }, [codes, search, sort, status]);
  const pageCount = Math.max(1, Math.ceil(filteredCodes.length / 10));
  const effectivePage = Math.min(page, pageCount - 1);
  const visibleCodes = filteredCodes.slice(effectivePage * 10, effectivePage * 10 + 10);

  const usedCount = codes.filter((row) => row.is_used).length;
  const unusedCount = codes.length - usedCount;
  const usageRate = codes.length ? `${Math.round((usedCount / codes.length) * 100)}%` : "0%";

  async function copyCode(code: string | undefined) {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      window.setTimeout(() => {
        setCopiedCode((current) => (current === code ? null : current));
      }, 1800);
    } catch (error) {
      console.error(error);
    }
  }

  async function handleCreateCode() {
    const percentOff = Math.round(Number(createPercent));
    if (!Number.isFinite(percentOff) || percentOff < 1 || percentOff > 100) {
      setCreateError("Enter a percentage between 1 and 100.");
      return;
    }
    if (createMode === "manual" && !createCode.trim()) {
      setCreateError("Enter the code text.");
      return;
    }
    setCreateBusy(true);
    setCreateError("");
    try {
      const token = await auth.getAccessToken();
      await createDiscountCode({ mode: createMode, code: createCode, percentOff }, token);
      await codesQuery.refetch();
      setPage(0);
      setCreateOpen(false);
      setCreateCode("");
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Could not create discount code.");
    } finally {
      setCreateBusy(false);
    }
  }

  if (codesQuery.isLoading) {
    return (
      <section className="py-4">
        <h1 className="text-3xl font-bold">Discount Codes</h1>
        <p className="mt-2 text-sm text-sg-muted">Loading discount codes...</p>
      </section>
    );
  }

  if (codesQuery.error) {
    return (
      <section className="sg25-card p-6">
        <h1 className="text-3xl font-bold">Discount Codes</h1>
        <p className="mt-3 rounded-[8px] bg-sg-danger-soft p-3 text-sm text-sg-danger">
          {codesQuery.error instanceof Error ? codesQuery.error.message : "Could not load discount codes."}
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section>
        <h1 className="text-4xl font-bold">Discount Codes</h1>
        <p className="mt-1 text-[15px] text-sg-muted">Create and manage one-time discount codes for your campaigns.</p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Total Codes" value={formatNumber(codes.length)} description="All generated codes" icon="tag" />
        <KpiCard label="Unused Codes" value={formatNumber(unusedCount)} description="Available to redeem" icon="tag" />
        <KpiCard label="Used Codes" value={formatNumber(usedCount)} description="Already redeemed" icon="receipt" />
        <KpiCard label="Usage Rate" value={usageRate} description="Used of total" icon="bar-chart" />
      </section>

      <section className="sg25-card overflow-hidden p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Icon name="tag" className="h-4 w-4 text-sg-primary" />
            <h2 className="text-lg font-bold">Codes</h2>
          </div>
          <button type="button" className="sg25-btn sg25-btn-primary h-9 px-4 text-[12px]" onClick={() => { setCreateError(""); setCreateOpen(true); }}><span aria-hidden="true">+</span>Add code</button>
        </div>

        <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Search codes</span>
            <input className="sg25-input h-[36px] rounded-full bg-sg-input-bg" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="Search code or order ID" />
          </label>
          <div className="flex flex-wrap gap-2">
            <CustomSelect value={status} options={statusOptions} onChange={(value) => { setStatus(value); setPage(0); }} ariaLabel="Discount status filter" triggerClassName="h-[36px] min-w-[122px]" />
            <CustomSelect value={sort} options={sortOptions} onChange={(value) => { setSort(value); setPage(0); }} ariaLabel="Discount sort filter" triggerClassName="h-[36px] min-w-[122px]" />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="mt-4 w-full min-w-[760px] table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-[200px]" />
              <col className="w-[140px]" />
              <col className="w-[220px]" />
              <col className="w-[180px]" />
              <col className="w-[120px]" />
            </colgroup>
            <thead className="text-[10px] font-bold uppercase tracking-normal text-sg-muted">
              <tr>
                <th className="border-b border-sg-border py-3 pl-2.5 pr-5">Code</th>
                <th className="border-b border-sg-border px-0 py-3 pr-5">Status</th>
                <th className="border-b border-sg-border px-0 py-3 pr-5">Used At</th>
                <th className="border-b border-sg-border px-0 py-3 pr-5">Order ID</th>
                <th className="border-b border-sg-border px-0 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleCodes.map((row: DiscountCodeRow) => (
                <tr key={String(row.code)} className="sg25-order-row border-b border-sg-border">
                  <td className="py-4 pl-2.5 pr-5 align-middle">
                    <span className="block font-mono text-[13px] font-bold">{row.code || "-"}</span>
                    <span className="mt-1 block text-[10px] font-semibold text-sg-muted">{Number(row.percent_off) || 7}% off</span>
                  </td>
                  <td className="px-0 py-4 pr-5 align-middle">{statusChip(Boolean(row.is_used))}</td>
                  <td className="px-0 py-4 pr-5 align-middle text-[13px] text-sg-muted">{codeDate(row.used_at)}</td>
                  <td className="px-0 py-4 pr-5 align-middle font-mono text-[12px]">{row.used_by_order_id || "-"}</td>
                  <td className="py-4 pr-0 text-right align-middle">
                    <button type="button" className="sg25-btn sg25-btn-ghost h-[32px] px-3 text-[11px]" disabled={Boolean(row.is_used)} onClick={() => void copyCode(row.code)}>
                      {copiedCode === row.code ? "Copied" : "Copy"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!filteredCodes.length ? <div className="px-4 py-10 text-center text-sm text-sg-muted">No discount codes match the current filters.</div> : null}
        {filteredCodes.length ? <div className="flex items-center justify-end gap-3 px-4 pt-4"><p className="text-[11px] text-sg-muted">Page {effectivePage + 1} of {pageCount} · {formatNumber(filteredCodes.length)} codes</p><div className="flex gap-2"><button type="button" className="sg25-btn sg25-btn-ghost h-8 w-8 p-0" aria-label="Previous discount codes page" disabled={effectivePage === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>←</button><button type="button" className="sg25-btn sg25-btn-ghost h-8 w-8 p-0" aria-label="Next discount codes page" disabled={effectivePage + 1 >= pageCount} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}>→</button></div></div> : null}
      </section>

      {createOpen ? createPortal(<div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-labelledby="create-discount-title" onClick={() => !createBusy && setCreateOpen(false)}><section className="w-full max-w-lg rounded-[14px] bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-4"><div><h2 id="create-discount-title" className="text-xl font-bold">Add discount code</h2><p className="mt-1 text-sm text-sg-muted">Create a one-time code that checkout and manual orders can verify.</p></div><button type="button" className="sg25-btn sg25-btn-ghost h-8 w-8 p-0" aria-label="Close create code" disabled={createBusy} onClick={() => setCreateOpen(false)}><Icon name="x" className="h-4 w-4" /></button></div><div className="mt-5 grid grid-cols-2 gap-3"><button type="button" className={`rounded-[10px] border p-3 text-left ${createMode === "random" ? "border-sg-primary bg-sg-primary-soft" : "border-sg-border"}`} onClick={() => setCreateMode("random")}><span className="block text-[13px] font-bold">Random code</span><span className="mt-1 block text-[11px] text-sg-muted">Generate PROMO-XXXXX</span></button><button type="button" className={`rounded-[10px] border p-3 text-left ${createMode === "manual" ? "border-sg-primary bg-sg-primary-soft" : "border-sg-border"}`} onClick={() => setCreateMode("manual")}><span className="block text-[13px] font-bold">Enter text</span><span className="mt-1 block text-[11px] text-sg-muted">Use a campaign code</span></button></div>{createMode === "manual" ? <label className="mt-4 block"><span className="text-[12px] font-semibold text-sg-muted">Code text</span><input className="sg25-input mt-1 bg-sg-input-bg" value={createCode} onChange={(event) => setCreateCode(event.target.value)} placeholder="SUMMER-2026" /><span className="mt-1 block text-[10px] text-sg-muted">Use 3–32 letters, numbers, or hyphens.</span></label> : null}<label className="mt-4 block"><span className="text-[12px] font-semibold text-sg-muted">Percent off</span><div className="relative mt-1"><input className="sg25-input bg-sg-input-bg pr-10" type="number" min="1" max="100" value={createPercent} onChange={(event) => setCreatePercent(event.target.value)} /><span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-sg-muted">%</span></div></label>{createError ? <p className="mt-3 rounded-[8px] bg-sg-danger-soft p-3 text-[12px] text-sg-danger">{createError}</p> : null}<div className="mt-5 flex justify-end gap-2"><button type="button" className="sg25-btn sg25-btn-ghost" disabled={createBusy} onClick={() => setCreateOpen(false)}>Cancel</button><button type="button" className="sg25-btn sg25-btn-primary" disabled={createBusy} onClick={() => void handleCreateCode()}>{createBusy ? "Creating..." : "Create code"}</button></div></section></div>, document.body) : null}
    </div>
  );
}
