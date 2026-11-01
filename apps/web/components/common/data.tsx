"use client";

import * as React from "react";
import { cn, formatBytes } from "@/lib/utils";
import type { ApiError, UseApiResult } from "@/lib/api";
import type { Priority } from "@/lib/types";
import { PRIORITIES, priorityDescription, priorityLabel } from "@/lib/priority";
import { Card, CardContent } from "@/components/ui/card";
import { ErrorState, LoadingSkeleton } from "@/components/layout/states";

export function Stat({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "ok" | "warn" | "bad";
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardContent className="p-4">
        <dl>
          <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
          <dd className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "ok" && "text-success", tone === "warn" && "text-warning", tone === "bad" && "text-destructive")}>
            {value}
          </dd>
          {hint ? <dd className="mt-0.5 text-xs text-muted-foreground">{hint}</dd> : null}
        </dl>
      </CardContent>
    </Card>
  );
}

/** Renders loading, error (with retry) or data from a useApi result. */
export function Query<T>({
  result,
  children,
  skeleton,
}: {
  result: UseApiResult<T>;
  children: (data: T) => React.ReactNode;
  skeleton?: React.ReactNode;
}) {
  if (result.data !== undefined) return <>{children(result.data)}</>;
  if (result.error) return <ErrorState message={(result.error as ApiError).message} onRetry={() => void result.mutate()} />;
  return <>{skeleton ?? <LoadingSkeleton />}</>;
}

export const PRIORITY_COLOUR: Record<Priority, string> = {
  P0: "bg-primary",
  P1: "bg-success",
  P2: "bg-warning",
  P3: "bg-muted-foreground",
};

export function StorageBar({
  totalBytes,
  byPriority,
  usedBytes,
}: {
  totalBytes: number;
  byPriority: Record<Priority, number>;
  usedBytes: number;
}) {
  const parts = PRIORITIES.map((p) => ({ p, bytes: byPriority[p] ?? 0 }));
  const media = parts.reduce((a, b) => a + b.bytes, 0);
  const other = Math.max(0, usedBytes - media);
  const free = Math.max(0, totalBytes - usedBytes);
  const w = (b: number) => (totalBytes > 0 ? `${(b / totalBytes) * 100}%` : "0%");
  const summary = `${formatBytes(usedBytes)} used of ${formatBytes(totalBytes)}. ` +
    parts.map((x) => `${priorityLabel(x.p)} ${formatBytes(x.bytes)}`).join(", ");
  return (
    <div>
      <div role="img" aria-label={summary} className="flex h-4 w-full overflow-hidden rounded-full bg-secondary">
        {parts.map((x) => (
          <div key={x.p} className={PRIORITY_COLOUR[x.p]} style={{ width: w(x.bytes) }} />
        ))}
        <div className="bg-border" style={{ width: w(other) }} />
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {parts.map((x) => (
          <li key={x.p} className="flex items-center gap-1.5">
            <span className={cn("size-3 rounded-sm", PRIORITY_COLOUR[x.p])} aria-hidden="true" />
            {priorityLabel(x.p)}: <span className="tabular-nums">{formatBytes(x.bytes)}</span>
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-border" aria-hidden="true" />
          Other files: <span className="tabular-nums">{formatBytes(other)}</span>
        </li>
        <li className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm border bg-secondary" aria-hidden="true" />
          Free: <span className="tabular-nums">{formatBytes(free)}</span>
        </li>
      </ul>
    </div>
  );
}

export function CapacityBar({ used, total, label, reserved = 0 }: { used: number; total: number; label: string; reserved?: number }) {
  const pctUsed = total > 0 ? (used / total) * 100 : 0;
  const pctRes = total > 0 ? (reserved / total) * 100 : 0;
  return (
    <div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pctUsed)}
        aria-valuetext={`${Math.round(pctUsed)}% used, ${formatBytes(total - used)} free`}
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-secondary"
      >
        <div className={cn(pctUsed > 95 ? "bg-destructive" : pctUsed > 85 ? "bg-warning" : "bg-primary")} style={{ width: `${Math.min(100, pctUsed)}%` }} />
        <div className="bg-muted-foreground/60" style={{ width: `${Math.min(100 - pctUsed, pctRes)}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {formatBytes(used)} of {formatBytes(total)} used ({Math.round(pctUsed)}%){reserved > 0 ? `, ${formatBytes(reserved)} reserved` : ""}
      </p>
    </div>
  );
}
