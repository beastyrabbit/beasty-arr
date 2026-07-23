import type { ReactNode } from "react";
import { cn } from "../lib/utils.js";

/** Hairline-bordered surface panel — the only card treatment in the app. */
export function Panel({
  children,
  className,
  title,
  actions,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  actions?: ReactNode;
}) {
  return (
    <section className={cn("rounded-[6px] border border-line bg-surface", className)}>
      {title !== undefined || actions !== undefined ? (
        <header className="flex h-8 items-center justify-between border-b border-line px-3">
          <h2 className="microlabel">{title}</h2>
          {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function EmptyState({
  message,
  hint,
  className,
}: {
  message: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center gap-1 py-10 text-center", className)}
    >
      <p className="text-[13px] text-muted">{message}</p>
      {hint ? <p className="text-[11px] text-faint">{hint}</p> : null}
    </div>
  );
}

export function ErrorState({ message, className }: { message: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center py-10", className)}>
      <p className="text-[13px] text-missing">{message}</p>
    </div>
  );
}

/** Shown above cached data when the backend is unreachable. */
export function StaleBanner({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="mb-2 flex h-7 items-center gap-2 rounded-[6px] border border-nongerman/40 bg-nongerman/10 px-3 text-[12px] text-nongerman">
      Backend unreachable — showing last known data.
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-4", className)} />;
}

export function SkeletonRows({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
        <tr key={r} className="h-8 border-b border-line">
          {Array.from({ length: cols }, (_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
            <td key={c} className="px-2">
              <Skeleton className="h-3 w-full max-w-[160px]" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Dense table shell: 32px rows, 8px cell padding, hairline borders. */
export function DataTable({
  head,
  children,
  className,
}: {
  head: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="h-8 border-b border-line text-left">{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cn("microlabel px-2 font-semibold", className)}>{children}</th>;
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn("px-2 py-0", className)}>{children}</td>;
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex h-9 items-center justify-between px-3 text-[12px] text-muted">
      <span className="font-mono">
        {total === 0 ? "0" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)}`} of{" "}
        {total}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="cursor-pointer rounded px-2 py-0.5 hover:bg-raised disabled:opacity-40"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Prev
        </button>
        <span className="font-mono">
          {page}/{pages}
        </span>
        <button
          type="button"
          className="cursor-pointer rounded px-2 py-0.5 hover:bg-raised disabled:opacity-40"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
