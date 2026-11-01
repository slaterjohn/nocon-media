"use client";

import type { PolicyChangeResult, SimulationResult } from "@/lib/types";
import { formatBytes } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PriorityBadge } from "@/components/common/badges";

/** Result of StorageService.simulate: what would be removed to fit a download. */
export function SimulationView({ result }: { result: SimulationResult }) {
  const { candidates, affectedSources } = result;
  return (
    <div className="space-y-4" aria-live="polite">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Required", result.requiredBytes],
          ["Available now", result.availableBytes],
          ["Would be reclaimed", result.reclaimedBytes],
          ["Free afterwards", result.resultingAvailable],
        ].map(([label, v]) => (
          <div key={label as string} className="rounded-lg border p-3">
            <dt className="text-xs text-muted-foreground">{label as string}</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatBytes(v as number)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">Volume total: {formatBytes(result.totalBytes)}</p>
      {!result.sufficient ? (
        <p role="alert" className="text-sm text-warning">Not enough can be reclaimed. Nothing would be deleted, and the download would wait for storage.</p>
      ) : (
        <p className="text-sm text-success">There is enough space{candidates.length ? " after the removals below" : ""}.</p>
      )}
      {affectedSources.length ? (
        <div>
          <h3 className="mb-1 text-sm font-medium">Affected sources</h3>
          <ul className="flex flex-wrap gap-1.5">
            {affectedSources.map((s) => (
              <li key={s}><Badge variant="outline">{s}</Badge></li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <h3 className="mb-1 text-sm font-medium">Items that would be removed ({candidates.length})</h3>
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No media would be removed.</p>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            <Table aria-label="Eviction candidates">
              <TableHeader>
                <TableRow><TableHead>Title</TableHead><TableHead>Priority</TableHead><TableHead>Size</TableHead><TableHead>Sources</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((c) => (
                  <TableRow key={c.mediaId}>
                    <TableCell className="max-w-xs truncate">{c.title}</TableCell>
                    <TableCell><PriorityBadge priority={c.priority} /></TableCell>
                    <TableCell className="tabular-nums">{formatBytes(c.sizeBytes)}</TableCell>
                    <TableCell>{c.sources.join(", ") || "–"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

/** Result of StorageService.simulatePolicyChange: media that would lose retention protection. */
export function PolicyChangeView({ result }: { result: PolicyChangeResult }) {
  const items = result.losingProtection ?? [];
  return (
    <div className="space-y-3" aria-live="polite">
      <p className="text-sm">
        {items.length === 0
          ? "No downloaded media would lose protection under this retention policy."
          : `${items.length} downloaded ${items.length === 1 ? "video" : "videos"} (${formatBytes(result.totalBytes)}) would lose protection and could be removed when space is needed.`}
      </p>
      {items.length ? (
        <div className="max-h-64 overflow-y-auto">
          <Table aria-label="Media losing protection">
            <TableHeader><TableRow><TableHead>Title</TableHead><TableHead>Size</TableHead></TableRow></TableHeader>
            <TableBody>
              {items.map((m, i) => (
                <TableRow key={m.mediaId ?? m.id ?? i}>
                  <TableCell className="max-w-xs truncate">{m.title ?? m.mediaId ?? m.id ?? "Untitled"}</TableCell>
                  <TableCell className="tabular-nums">{formatBytes(m.sizeBytes)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}
