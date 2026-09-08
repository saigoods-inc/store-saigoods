import { useEffect, useRef, useState } from "react";

import { Icon } from "../../lib/icons";

export function CustomSelect<T extends string>({
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
      if (event.key === "Escape") setOpen(false);
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
        className={`sg25-pill-field flex min-w-0 items-center justify-between gap-2.5 text-left focus-visible:ring-2 focus-visible:ring-sg-primary/20 ${triggerClassName}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="truncate">{selectedOption?.label || ""}</span>
        <Icon name="chevron" className={`h-3.5 w-3.5 shrink-0 text-sg-muted transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div
          role="listbox"
          className={`absolute right-0 top-[calc(100%+6px)] z-50 w-max min-w-full max-w-[calc(100vw-2rem)] rounded-[10px] border border-sg-border bg-white p-1.5 shadow-[0_18px_40px_rgba(31,27,24,0.14)] ${panelClassName}`}
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                className={`flex min-h-10 w-full items-center justify-between gap-3 rounded-[7px] px-3.5 py-2 text-left text-[12px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sg-primary/20 ${
                  active ? "bg-sg-primary-soft font-semibold text-sg-primary" : "text-sg-text hover:bg-sg-input-bg"
                }`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="truncate">{option.label}</span>
                {active ? (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sg-primary text-white">
                    <Icon name="check" className="h-3 w-3" />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
