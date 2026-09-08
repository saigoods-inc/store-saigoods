import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { NavLink } from "react-router-dom";

import { Icon } from "../../lib/icons";

const navItems = [
  { to: "/summary", label: "Summary", icon: "dashboard" as const },
  { to: "/orders", label: "Orders", icon: "cart" as const },
  { to: "/order-builder", label: "Order Builder", icon: "clipboard" as const },
  { to: "/inventory", label: "Inventory", icon: "package" as const },
  { to: "/discount-codes", label: "Discount Codes", icon: "tag" as const },
  { to: "/tax", label: "Sales Tax (TN)", icon: "receipt" as const },
  { to: "/nexus", label: "Nexus by State", icon: "pin" as const },
  { to: "/advanced", label: "Advanced", icon: "settings" as const },
];

const ShellHeaderMetaContext = createContext<((meta: ReactNode | null) => void) | null>(null);
const SIDEBAR_WIDTH_KEY = "sg25-sidebar-width";
const SIDEBAR_COLLAPSED_KEY = "sg25-sidebar-collapsed";
const SIDEBAR_MIN_WIDTH = 224;
const SIDEBAR_MAX_WIDTH = 360;
const SIDEBAR_DEFAULT_WIDTH = 248;
const SIDEBAR_COLLAPSED_WIDTH = 88;

function SaiGoodsLogo() {
  return (
    <svg width="39" height="39" viewBox="0 0 39 39" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M0 6.27452C0 2.8092 2.8092 0 6.27453 0H12.6945L6.34724 6.34724L0 12.6945V6.27452Z" fill="#BF5841" />
      <path d="M0 6.27452C0 2.8092 2.8092 0 6.27453 0H12.6945L6.34724 6.34724L0 12.6945V6.27452Z" fill="white" fillOpacity="0.25" />
      <path d="M12.6953 12.6945L12.6953 0L19.1623 6.34724L25.6293 12.6945L12.6953 12.6945Z" fill="#BF5841" />
      <path d="M25.6289 25.6285L25.6289 38.323L19.1619 31.9757L12.6949 25.6285L25.6289 25.6285Z" fill="#BF5841" />
      <path d="M38.3242 32.0484C38.3242 35.5138 35.515 38.323 32.0497 38.323L25.6297 38.323L31.977 31.9757L38.3242 25.6285L38.3242 32.0484Z" fill="#BF5841" />
      <path d="M38.3242 32.0484C38.3242 35.5138 35.515 38.323 32.0497 38.323L25.6297 38.323L31.977 31.9757L38.3242 25.6285L38.3242 32.0484Z" fill="white" fillOpacity="0.25" />
      <path d="M12.6953 12.6945L12.6953 25.6285L6.34807 19.1615L0.000825882 12.6945L12.6953 12.6945Z" fill="#BF5841" />
      <path d="M12.6953 12.6945L12.6953 25.6285L6.34807 19.1615L0.000825882 12.6945L12.6953 12.6945Z" fill="white" fillOpacity="0.25" />
      <path d="M25.6289 25.6285L25.6289 12.6945L31.9761 19.1615L38.3234 25.6285L25.6289 25.6285Z" fill="#BF5841" />
      <path d="M25.6289 25.6285L25.6289 12.6945L31.9761 19.1615L38.3234 25.6285L25.6289 25.6285Z" fill="white" fillOpacity="0.25" />
      <path d="M12.6953 0H32.0493C35.5146 0 38.3238 2.8092 38.3238 6.27453V12.6945H25.5096L12.6953 0Z" fill="#BF5841" />
      <path d="M25.6289 38.323L6.27494 38.323C2.80962 38.323 0.000412233 35.5138 0.000412536 32.0484L0.000413097 25.6285L12.8147 25.6285L25.6289 38.323Z" fill="#BF5841" />
      <path d="M19.1875 6.32364L25.5936 12.7297L19.1581 12.7591L12.7227 12.7885L19.1875 6.32364Z" fill="#CF8270" />
      <path d="M19.1289 32.0323L12.7229 25.6263L19.1583 25.5969L25.5937 25.5675L19.1289 32.0323Z" fill="#CF8270" />
      <path d="M19.1465 28.527L16.2298 25.6103L19.1599 25.5969L22.0899 25.5835L19.1465 28.527Z" fill="#BF5841" />
      <path d="M19.1719 9.845L22.0886 12.7617L19.1585 12.7751L16.2284 12.7884L19.1719 9.845Z" fill="#BF5841" />
      <circle cx="19.163" cy="19.1615" r="3.95206" fill="#BF5841" />
    </svg>
  );
}

export function useAdminShellHeaderMeta(meta: ReactNode | null) {
  const setMeta = useContext(ShellHeaderMetaContext);

  useEffect(() => {
    if (!setMeta) return;
    setMeta(meta);
    return () => setMeta(null);
  }, [meta, setMeta]);
}

export function AdminShell({
  children,
  email,
  onSignOut,
}: {
  children: ReactNode;
  email: string;
  onSignOut: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [headerMeta, setHeaderMeta] = useState<ReactNode | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const emailHandle = useMemo(() => {
    const localPart = String(email || "").split("@")[0]?.trim();
    return localPart || "there";
  }, [email]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const media = window.matchMedia("(min-width: 768px)");
    const handleChange = () => setIsDesktop(media.matches);
    handleChange();
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const storedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    const storedCollapsed = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);

    if (Number.isFinite(storedWidth) && storedWidth >= SIDEBAR_MIN_WIDTH && storedWidth <= SIDEBAR_MAX_WIDTH) {
      setSidebarWidth(storedWidth);
    }

    if (storedCollapsed === "true") {
      setSidebarCollapsed(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (event: MouseEvent) => {
      if (!resizeStateRef.current) return;

      const nextWidth = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, resizeStateRef.current.startWidth + event.clientX - resizeStateRef.current.startX),
      );
      setSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      resizeStateRef.current = null;
      setIsResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing]);

  const effectiveSidebarCollapsed = isDesktop && sidebarCollapsed;
  const desktopSidebarWidth = effectiveSidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth;
  const sidebarVars = {
    "--sg25-sidebar-width": `${desktopSidebarWidth}px`,
  } as CSSProperties;

  const handleResizeStart = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (effectiveSidebarCollapsed || typeof window === "undefined" || window.innerWidth < 768) return;
    resizeStateRef.current = { startX: event.clientX, startWidth: sidebarWidth };
    setIsResizing(true);
  };

  return (
    <ShellHeaderMetaContext.Provider value={setHeaderMeta}>
      <div className="min-h-screen overflow-x-clip bg-sg-bg text-sg-text">
        <div className="flex min-h-screen" style={sidebarVars}>
          <div
            className={`fixed inset-0 z-40 bg-[#1f1b18]/35 transition md:hidden ${open ? "block" : "hidden"}`}
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />

          <aside
            style={sidebarVars}
            className={`fixed inset-y-0 left-0 z-50 flex h-screen w-[248px] max-w-[88vw] flex-col overflow-hidden border-r border-sg-border bg-white transition duration-200 md:w-[var(--sg25-sidebar-width)] md:min-w-[var(--sg25-sidebar-width)] md:max-w-[var(--sg25-sidebar-width)] md:overflow-visible ${
              open ? "translate-x-0" : "-translate-x-full md:translate-x-0"
            }`}
          >
            <div
              className={`flex items-center border-b border-sg-border ${
                effectiveSidebarCollapsed ? "justify-center px-3 py-[18px]" : "gap-3 px-5 py-5"
              } shrink-0`}
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-[10px]">
                <SaiGoodsLogo />
              </div>
              {!effectiveSidebarCollapsed ? (
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-bold">SAI Goods, Inc.</p>
                  <p className="text-[13px] text-sg-muted">Operation Dashboard</p>
                </div>
              ) : null}
            </div>

            <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain py-4 ${effectiveSidebarCollapsed ? "px-3" : "px-3.5"}`}>
              {!effectiveSidebarCollapsed ? (
                <p className="px-3 text-[11px] font-semibold uppercase tracking-normal text-sg-muted">Navigation</p>
              ) : null}
              <nav className="mt-4 space-y-0.5">
                {navItems.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    title={item.label}
                    onClick={() => setOpen(false)}
                    className={({ isActive }) =>
                      `flex rounded-[10px] text-[13px] font-medium transition ${
                        effectiveSidebarCollapsed ? "justify-center px-3 py-3" : "items-center gap-3 px-4 py-2.5"
                      } ${
                        isActive ? "bg-sg-primary-soft text-sg-primary-soft-fg" : "text-sg-text hover:bg-sg-input-bg"
                      }`
                    }
                  >
                    <Icon name={item.icon} className="h-4 w-4 shrink-0" />
                    {effectiveSidebarCollapsed ? <span className="sr-only">{item.label}</span> : <span className="truncate">{item.label}</span>}
                  </NavLink>
                ))}
              </nav>
            </div>

            <div
              className={`mt-auto shrink-0 border-t border-sg-border bg-white ${
                effectiveSidebarCollapsed ? "px-3 py-3.5" : "px-4 py-4"
              }`}
            >
              {!effectiveSidebarCollapsed ? <p className="truncate text-[13px] text-sg-text">{email || "No active session"}</p> : null}
              <div className={`flex flex-col items-center ${effectiveSidebarCollapsed ? "" : "mt-4"}`}>
                <button
                  type="button"
                  title="Sign out"
                  className={`sg25-btn sg25-btn-ghost ${effectiveSidebarCollapsed ? "mx-auto h-10 w-10 px-0" : "w-full"}`}
                  onClick={() => void onSignOut()}
                >
                  <Icon name="logout" className="h-4 w-4" />
                  {effectiveSidebarCollapsed ? <span className="sr-only">Sign out</span> : <span>Sign out</span>}
                </button>
              </div>
              {!effectiveSidebarCollapsed ? <p className="mt-4 text-xs text-sg-muted">Version 2.5.0</p> : null}
            </div>

            <button
              type="button"
              className="absolute right-0 top-4 z-[60] hidden h-8 w-5 translate-x-1/2 items-center justify-center rounded-full border border-sg-border bg-white p-0 text-sg-muted shadow-[0_8px_18px_rgba(31,27,24,0.08)] transition hover:bg-sg-input-bg md:inline-flex"
              aria-label={effectiveSidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
              onClick={() => setSidebarCollapsed((current) => !current)}
            >
              <Icon name="chevron" className={`h-3 w-3 ${effectiveSidebarCollapsed ? "-rotate-90" : "rotate-90"}`} />
            </button>

            <div
              className={`group absolute inset-y-0 right-[-6px] hidden w-3 cursor-col-resize md:block ${effectiveSidebarCollapsed ? "pointer-events-none opacity-0" : ""}`}
              onMouseDown={handleResizeStart}
              aria-hidden="true"
            >
              <div className={`ml-auto h-full w-px bg-transparent transition ${isResizing ? "bg-sg-primary/40" : "group-hover:bg-sg-border"}`} />
            </div>
          </aside>

          <div className="min-w-0 flex-1 overflow-x-clip md:ml-[var(--sg25-sidebar-width)]">
            <header className="fixed left-0 right-0 top-0 z-30 border-b border-sg-border bg-sg-bg/80 shadow-[0_10px_30px_rgba(31,27,24,0.04)] backdrop-blur-xl md:left-[var(--sg25-sidebar-width)]">
              <div className="flex items-center justify-between gap-3 px-4 py-3 md:px-6 xl:px-8">
                <div className="flex min-w-0 items-center gap-3">
                  <button
                    type="button"
                    className="sg25-btn sg25-btn-ghost md:hidden"
                    aria-label="Open menu"
                    onClick={() => setOpen(true)}
                  >
                    <Icon name="menu" className="h-5 w-5" />
                  </button>
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-sg-muted sm:text-[14px]">
                      Hello, {emailHandle} <span aria-hidden="true">👋</span>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {headerMeta ? <div className="hidden text-[12px] leading-none text-sg-muted lg:block">{headerMeta}</div> : null}
                  <button type="button" className="sg25-btn sg25-btn-ghost h-[41px] px-4 text-[13px]" onClick={() => window.location.reload()}>
                    <Icon name="refresh" className="h-4 w-4" />
                    <span>Refresh</span>
                  </button>
                </div>
              </div>
            </header>
            <main className="px-4 pb-6 pt-[88px] md:px-6 xl:px-8">{children}</main>
          </div>
        </div>
      </div>
    </ShellHeaderMetaContext.Provider>
  );
}
