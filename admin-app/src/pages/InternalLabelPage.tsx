import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

interface InternalLabelPayload {
  orderRef?: string;
  customer?: string;
  shipTo?: string[];
  items?: Array<{
    name?: string;
    size?: string;
    quantity?: string;
  }>;
}

function safePayload(value: string | null): InternalLabelPayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as InternalLabelPayload;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function InternalLabelPage() {
  const [params] = useSearchParams();
  const [printAttempted, setPrintAttempted] = useState(false);
  const key = params.get("key") || "";
  const autoPrint = params.get("print") === "1";

  const payload = useMemo(() => {
    if (!key) return null;
    return safePayload(sessionStorage.getItem(`sai-internal-label:${key}`));
  }, [key]);

  useEffect(() => {
    if (!autoPrint || !payload) return;
    const timer = window.setTimeout(() => {
      window.focus();
      window.print();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [autoPrint, payload]);

  function printLabel() {
    setPrintAttempted(true);
    window.focus();
    window.print();
  }

  if (!payload) {
    return (
      <main className="min-h-screen bg-sg-bg px-4 py-10 text-sg-text">
        <section className="mx-auto max-w-md rounded-[8px] border border-sg-border bg-white p-5">
          <h1 className="text-xl font-bold">Label unavailable</h1>
          <p className="mt-2 text-sm leading-6 text-sg-muted">Go back to the order and open the SAI label again.</p>
        </section>
      </main>
    );
  }

  const items = payload.items?.length ? payload.items : [];
  const shipTo = payload.shipTo?.filter(Boolean) || [];

  return (
    <main className="min-h-screen bg-[#f4f0ed] px-4 py-6 text-[#282625] print:bg-white print:p-0">
      <section className="mx-auto min-h-[6in] w-full max-w-[4in] rounded-[8px] border border-[#ded6d1] bg-white p-5 print:m-0 print:border-[#222]">
        <div className="text-[16px] font-extrabold text-[#cf5749]">SAI Goods, Inc.</div>
        <h1 className="mt-2 text-[26px] font-extrabold leading-none">Pickup / Local Handoff</h1>

        <div className="mt-4 rounded-[8px] border border-[#ded6d1] p-3">
          <div className="text-[11px] font-extrabold uppercase text-[#706a66]">Order reference</div>
          <div className="mt-1 break-words text-[18px] font-extrabold">{payload.orderRef || "-"}</div>
        </div>

        <div className="mt-4 border-t border-[#e8dfda] pt-3.5">
          <div className="text-[11px] font-extrabold uppercase text-[#706a66]">Customer</div>
          <div className="mt-1 text-[14px] font-bold leading-snug">{payload.customer || "-"}</div>
        </div>

        <div className="mt-4 border-t border-[#e8dfda] pt-3.5">
          <div className="text-[11px] font-extrabold uppercase text-[#706a66]">Ship to</div>
          <div className="mt-2 text-[14px] leading-snug">
            {shipTo.length ? shipTo.map((line) => <div key={line}>{line}</div>) : <div>No address on file.</div>}
          </div>
        </div>

        <div className="mt-4 border-t border-[#e8dfda] pt-3.5">
          <div className="text-[11px] font-extrabold uppercase text-[#706a66]">Items</div>
          <table className="mt-2 w-full border-collapse text-left text-[13px]">
            <thead className="text-[10px] uppercase text-[#706a66]">
              <tr>
                <th className="pb-1.5">Product</th>
                <th className="pb-1.5">Size</th>
                <th className="pb-1.5">Qty</th>
              </tr>
            </thead>
            <tbody>
              {items.length ? (
                items.map((item, index) => (
                  <tr key={`${item.name || "item"}-${index}`}>
                    <td className="border-t border-[#ede6e1] py-2 pr-2 font-bold align-top">{item.name || "-"}</td>
                    <td className="border-t border-[#ede6e1] py-2 pr-2 font-bold align-top">{item.size || "-"}</td>
                    <td className="border-t border-[#ede6e1] py-2 font-bold align-top">{item.quantity || "-"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="border-t border-[#ede6e1] py-2 font-bold" colSpan={3}>No item detail available.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

      </section>

      <div className="mx-auto mt-4 flex w-full max-w-[4in] flex-col items-center gap-2 print:hidden">
        <button
          type="button"
          className="rounded-full bg-[#cf5749] px-5 py-2.5 text-sm font-extrabold text-white"
          onClick={printLabel}
        >
          Print label
        </button>
        {printAttempted ? (
          <p className="max-w-[22rem] text-center text-xs leading-5 text-[#706a66]">
            If the print dialog does not open in this browser tab, use the browser menu and choose Print.
          </p>
        ) : null}
      </div>
    </main>
  );
}
