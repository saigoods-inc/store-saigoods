import { lazy, Suspense, type FormEvent, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "./auth/AuthProvider";
import { AdminShell } from "./components/layout/AdminShell";
import { Icon } from "./lib/icons";

const DiscountCodesPage = lazy(() =>
  import("./pages/DiscountCodesPage").then((module) => ({ default: module.DiscountCodesPage })),
);
const InternalLabelPage = lazy(() =>
  import("./pages/InternalLabelPage").then((module) => ({ default: module.InternalLabelPage })),
);
const InventoryPage = lazy(() =>
  import("./pages/InventoryPage").then((module) => ({ default: module.InventoryPage })),
);
const NexusPage = lazy(() =>
  import("./pages/NexusPage").then((module) => ({ default: module.NexusPage })),
);
const OrderBuilderPage = lazy(() =>
  import("./pages/OrderBuilderPage").then((module) => ({ default: module.OrderBuilderPage })),
);
const OrdersPage = lazy(() =>
  import("./pages/OrdersPage").then((module) => ({ default: module.OrdersPage })),
);
const SalesTaxPage = lazy(() =>
  import("./pages/SalesTaxPage").then((module) => ({ default: module.SalesTaxPage })),
);
const SummaryPage = lazy(() =>
  import("./pages/SummaryPage").then((module) => ({ default: module.SummaryPage })),
);
const AdvancedPage = lazy(() =>
  import("./pages/AdvancedPage").then((module) => ({ default: module.AdvancedPage })),
);

const ADVANCED_ACCESS_SESSION_KEY = "saigoods.admin-v2.5.advanced-access";
const ADVANCED_ACCESS_PASSWORD = "Saigoods2025#";

function RouteLoading() {
  return <div className="flex min-h-[12rem] items-center justify-center text-sg-muted">Loading...</div>;
}

function LoginScreen() {
  const auth = useAuth();
  const [forgotPassword, setForgotPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") || "").trim();
    setSubmitting(true);
    setMessage(null);
    setFormError(null);
    try {
      if (forgotPassword) {
        await auth.requestPasswordReset(email);
        setMessage("If this email has a staff account, a password-reset link has been sent. The link can be used once and may expire.");
      } else {
        const password = String(form.get("password") || "");
        await auth.signIn(email, password);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : forgotPassword ? "Could not send the reset link." : "Could not sign in.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-sg-bg p-6">
      <div className="w-full max-w-md rounded-[18px] border border-sg-border bg-white p-8">
        <h1 className="text-3xl font-bold">{forgotPassword ? "Reset staff password" : "Staff Login"}</h1>
        <p className="mt-3 text-base leading-7 text-sg-muted">
          {forgotPassword
            ? "Enter your staff email and we’ll send a secure link to choose a new password."
            : "Sign in with your Supabase account to open admin-v2.5."}
        </p>
        {auth.error ? <p className="mt-4 rounded-[10px] bg-sg-danger-soft px-4 py-3 text-sm text-sg-danger">{auth.error}</p> : null}
        {formError ? <p role="alert" className="mt-4 rounded-[10px] bg-sg-danger-soft px-4 py-3 text-sm text-sg-danger">{formError}</p> : null}
        {message ? <p role="status" className="mt-4 rounded-[10px] bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</p> : null}
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <label className="block space-y-2">
            <span className="text-sm font-medium">Email</span>
            <input className="sg25-input" type="email" name="email" autoComplete="username" required />
          </label>
          {!forgotPassword ? (
            <label className="block space-y-2">
              <span className="text-sm font-medium">Password</span>
              <input className="sg25-input" type="password" name="password" autoComplete="current-password" required />
            </label>
          ) : null}
          <button type="submit" className="sg25-btn sg25-btn-primary w-full" disabled={submitting}>
            {submitting ? (forgotPassword ? "Sending reset link..." : "Signing in...") : forgotPassword ? "Send reset link" : "Sign in"}
          </button>
          <button
            type="button"
            className="w-full text-sm font-semibold text-sg-accent underline-offset-4 hover:underline"
            onClick={() => {
              setForgotPassword((current) => !current);
              setMessage(null);
              setFormError(null);
            }}
          >
            {forgotPassword ? "Back to staff login" : "Forgot password?"}
          </button>
        </form>
      </div>
    </div>
  );
}

function PasswordRecoveryScreen() {
  const auth = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    const confirmation = String(form.get("passwordConfirmation") || "");
    setFormError(null);

    if (password.length < 10) {
      setFormError("Use at least 10 characters for the new password.");
      return;
    }
    if (password !== confirmation) {
      setFormError("The passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      await auth.updatePassword(password);
      setComplete(true);
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "This recovery link is invalid or expired. Return to staff login and request a new link.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-sg-bg p-6">
      <div className="w-full max-w-md rounded-[18px] border border-sg-border bg-white p-8">
        <h1 className="text-3xl font-bold">Choose a new password</h1>
        {complete ? (
          <div className="mt-5 space-y-5">
            <p role="status" className="rounded-[10px] bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              Your staff password has been updated. Sign in again with the new password.
            </p>
            <button type="button" className="sg25-btn sg25-btn-primary w-full" onClick={auth.finishPasswordRecovery}>
              Return to staff login
            </button>
          </div>
        ) : (
          <>
            <p className="mt-3 text-base leading-7 text-sg-muted">Enter and confirm a new password with at least 10 characters.</p>
            {formError ? <p role="alert" className="mt-4 rounded-[10px] bg-sg-danger-soft px-4 py-3 text-sm text-sg-danger">{formError}</p> : null}
            <form className="mt-6 space-y-4" onSubmit={onSubmit}>
              <label className="block space-y-2">
                <span className="text-sm font-medium">New password</span>
                <input className="sg25-input" type="password" name="password" autoComplete="new-password" minLength={10} required />
              </label>
              <label className="block space-y-2">
                <span className="text-sm font-medium">Confirm new password</span>
                <input className="sg25-input" type="password" name="passwordConfirmation" autoComplete="new-password" minLength={10} required />
              </label>
              <button type="submit" className="sg25-btn sg25-btn-primary w-full" disabled={submitting || !auth.session}>
                {submitting ? "Updating password..." : "Update password"}
              </button>
              {!auth.session ? (
                <p className="text-sm leading-6 text-sg-danger">This recovery link is invalid or expired. Request a new link from staff login.</p>
              ) : null}
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function hasAdvancedSessionAccess() {
  if (typeof window === "undefined") return false;

  try {
    return window.sessionStorage.getItem(ADVANCED_ACCESS_SESSION_KEY) === "granted";
  } catch {
    return false;
  }
}

function AdvancedAccessGate() {
  const navigate = useNavigate();
  const [granted, setGranted] = useState(hasAdvancedSessionAccess);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("advancedPassword") || "");

    if (password !== ADVANCED_ACCESS_PASSWORD) {
      setError("That password is incorrect. Please try again.");
      return;
    }

    try {
      window.sessionStorage.setItem(ADVANCED_ACCESS_SESSION_KEY, "granted");
    } catch {
      // The page can still be unlocked when browser storage is unavailable.
    }
    setError(null);
    setGranted(true);
  }

  if (granted) return <AdvancedPage />;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#1f1b18]/45 p-4 backdrop-blur-[2px]">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="advanced-access-title"
        aria-describedby="advanced-access-description"
        className="w-full max-w-md rounded-[18px] border border-sg-border bg-white p-6 shadow-[0_24px_70px_rgba(31,27,24,0.22)] sm:p-7"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-sg-primary-soft text-sg-primary">
          <Icon name="settings" className="h-5 w-5" />
        </div>
        <h1 id="advanced-access-title" className="mt-5 text-[1.45rem] font-extrabold tracking-[-0.02em]">
          Advanced access
        </h1>
        <p id="advanced-access-description" className="mt-2 text-[13px] leading-6 text-sg-muted">
          Enter the Advanced page password. You will only be asked once during this browser session.
        </p>
        {error ? (
          <p role="alert" className="mt-4 rounded-[10px] bg-sg-danger-soft px-4 py-3 text-[12px] text-sg-danger">
            {error}
          </p>
        ) : null}
        <form className="mt-5 space-y-4" onSubmit={onSubmit}>
          <label className="block space-y-2">
            <span className="text-[12px] font-semibold">Password</span>
            <input
              className="sg25-input"
              type="password"
              name="advancedPassword"
              autoComplete="off"
              autoFocus
              required
              onChange={() => setError(null)}
            />
          </label>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className="sg25-btn sg25-btn-ghost" onClick={() => navigate("/summary", { replace: true })}>
              Cancel
            </button>
            <button type="submit" className="sg25-btn sg25-btn-primary">
              Open Advanced
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function AppRoutes() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route path="/" element={<Navigate to="/summary" replace />} />
        <Route path="/summary" element={<SummaryPage />} />
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/internal-label" element={<InternalLabelPage />} />
        <Route path="/order-builder" element={<OrderBuilderPage />} />
        <Route path="/manual-order" element={<Navigate to="/order-builder" replace />} />
        <Route path="/walk-in-order" element={<Navigate to="/order-builder" replace />} />
        <Route path="/inventory" element={<InventoryPage />} />
        <Route path="/discount-codes" element={<DiscountCodesPage />} />
        <Route path="/tax" element={<SalesTaxPage />} />
        <Route path="/nexus" element={<NexusPage />} />
        <Route path="/advanced" element={<AdvancedAccessGate />} />
        <Route path="*" element={<Navigate to="/summary" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  const auth = useAuth();
  const location = useLocation();

  if (auth.loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-sg-bg p-6 text-sg-muted">
        Loading admin-v2.5...
      </div>
    );
  }

  if (auth.passwordRecovery) {
    return <PasswordRecoveryScreen />;
  }

  if (!auth.session) {
    return <LoginScreen />;
  }

  if (location.pathname === "/internal-label") {
    return <AppRoutes />;
  }

  return (
    <AdminShell
      email={auth.email}
      onSignOut={async () => {
        try {
          window.sessionStorage.removeItem(ADVANCED_ACCESS_SESSION_KEY);
        } catch {
          // Signing out should continue even when browser storage is unavailable.
        }
        await auth.signOut();
      }}
    >
      <AppRoutes />
    </AdminShell>
  );
}
