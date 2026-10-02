"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * A dialog for whatever is not the page's main path — a table of past runs, a
 * write-up, an email, the machinery behind a result — so pages stay short and
 * the page underneath stays exactly as it was.
 *
 * Native <dialog>: Escape closes it, focus stays inside, and a click on the
 * backdrop closes it too. Colours are the console's greys, which flip with
 * light and dark mode.
 */
export default function Dialog({
  open,
  onClose,
  title,
  subtitle,
  size = "lg",
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  footer?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const width = { sm: "w-[min(94vw,28rem)]", md: "w-[min(94vw,40rem)]", lg: "w-[min(94vw,56rem)]", xl: "w-[min(96vw,72rem)]" }[size];
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={`${width} m-auto max-h-[88vh] overflow-hidden rounded-2xl border border-gray-800 bg-gray-950 p-0 text-gray-200 shadow-2xl backdrop:bg-black/55 backdrop:backdrop-blur-[2px]`}
    >
      {open && (
        <div className="flex max-h-[88vh] flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-gray-800 px-5 py-4">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-100">{title}</h2>
              {subtitle && <p className="mt-0.5 text-sm text-gray-400">{subtitle}</p>}
            </div>
            <button onClick={onClose} className="rounded-md p-1 text-gray-400 hover:bg-gray-800/60 hover:text-gray-100" aria-label="Close">
              <X className="size-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="border-t border-gray-800 px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

/** Button looks in the console's tokens: the theme's accent with near-black text, in light and dark. */
export const buttonStyles = {
  primary:
    "inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
  primarySm:
    "inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
  secondary: "inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-200 transition hover:bg-gray-800/60 disabled:opacity-40",
  secondarySm: "inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-200 transition hover:bg-gray-800/60 disabled:opacity-40",
  ghost: "inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-gray-400 transition hover:bg-gray-800/60 hover:text-gray-100",
  link: "text-[13px] text-gray-400 underline decoration-gray-600 underline-offset-2 hover:text-gray-100",
};
