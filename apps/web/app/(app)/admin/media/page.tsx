"use client";

import * as React from "react";
import Link from "next/link";
import { Database, ExternalLink, Heart, Pin } from "lucide-react";
import { del, get, patch, post, useApi } from "@/lib/api";
import type { MediaDetail, MediaSummary, Priority, Source } from "@/lib/types";
import { formatBytes, formatDuration, timeAgo } from "@/lib/utils";
import { useAction } from "@/hooks/use-action";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader } from "@/components/layout/states";
import { Query } from "@/components/common/data";
import { PRIORITIES, priorityLabel } from "@/lib/priority";
import { PriorityBadge, StatusBadge } from "@/components/common/badges";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Badge } from "@/components/ui/badge";

const PAGE = 50;

function OriginalLink({ id }: { id: string }) {
  const [url, setUrl] = React.useState<string | null | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);
  if (url) {
    return <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-sm underline">Original <ExternalLink className="size-3" aria-hidden="true" /><span className="sr-only">(opens in a new tab)</span></a>;
  }
  if (url === null) return <span className="text-xs text-muted-foreground">No link</span>;
  return (
    <Button size="sm" variant="ghost" disabled={busy} onClick={async () => {
      setBusy(true);
      try { setUrl((await get<{ media: MediaDetail }>(`/api/media/${id}`)).media.url); } catch { setUrl(null); } finally { setBusy(false); }
    }}>{busy ? "Loading…" : "Original link"}</Button>
  );
}

export default function AdminMediaPage() {
  const [q, setQ] = React.useState("");
  const [dq, setDq] = React.useState("");
  const [availability, setAvailability] = React.useState("");
  const [priority, setPriority] = React.useState("");
  const [sourceId, setSourceId] = React.useState("");
  const [offset, setOffset] = React.useState(0);
  React.useEffect(() => { const t = setTimeout(() => { setDq(q.trim()); setOffset(0); }, 300); return () => clearTimeout(t); }, [q]);

  const params = new URLSearchParams({ availability: "all", sort: "recent", limit: String(PAGE), offset: String(offset) });
  if (dq) params.set("q", dq);
  if (sourceId) params.set("sourceId", sourceId);
  if (priority) params.set("priority", priority);
  const result = useApi<{ items: MediaSummary[]; total: number }>(`/api/library/media?${params}`, { refreshInterval: 15000 });
  const sources = useApi<{ items: Source[] }>("/api/sources");
  const { run, busy } = useAction();
  const [deleting, setDeleting] = React.useState<MediaSummary | null>(null);

  const edit = (m: MediaSummary, body: Record<string, unknown>, success: string) =>
    run(`${m.id}`, async () => { await patch(`/api/media/${m.id}`, body); await result.mutate(); }, { success });

  return (
    <>
      <PageHeader title="Media library" description="Every video the catalogue knows about, downloaded or not." />
      <form role="search" className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => e.preventDefault()}>
        <div><label htmlFor="m-q" className="sr-only">Search titles</label><Input id="m-q" type="search" placeholder="Search titles" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div><label htmlFor="m-av" className="sr-only">Availability</label>
          <Select id="m-av" value={availability} onChange={(e) => { setAvailability(e.target.value); setOffset(0); }}>
            <option value="">Any availability</option>
            {["available", "downloading", "queued", "discovered", "evicted", "unavailable", "failed"].map((a) => <option key={a} value={a}>{a.charAt(0).toUpperCase() + a.slice(1)}</option>)}
          </Select></div>
        <div><label htmlFor="m-pr" className="sr-only">Priority</label>
          <Select id="m-pr" value={priority} onChange={(e) => { setPriority(e.target.value); setOffset(0); }}>
            <option value="">Any priority</option>{PRIORITIES.map((p) => <option key={p} value={p}>{priorityLabel(p)}</option>)}
          </Select></div>
        <div><label htmlFor="m-src" className="sr-only">Source</label>
          <Select id="m-src" value={sourceId} onChange={(e) => { setSourceId(e.target.value); setOffset(0); }}>
            <option value="">Any source</option>{sources.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select></div>
      </form>

      <Query result={result}>
        {({ items, total }) => {
          const rows = items.filter((m) => (!availability || m.availability === availability));
          return rows.length === 0 ? (
            <EmptyState icon={Database} title="No media matches" description="Change the filters, or add a source to start collecting videos." />
          ) : (
            <>
              <p className="mb-2 text-sm text-muted-foreground" aria-live="polite">Showing {rows.length} of {total ?? rows.length} {availability ? "(availability filter applies to this page)" : ""}</p>
              <Table aria-label="Media">
                <TableHeader><TableRow><TableHead>Title</TableHead><TableHead>Channel</TableHead><TableHead>Status</TableHead><TableHead>Priority</TableHead><TableHead>Length</TableHead><TableHead>Size</TableHead><TableHead>Downloaded</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
                <TableBody>
                  {rows.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="max-w-72">
                        <Link href={`/watch/${m.id}`} className="line-clamp-2 font-medium underline-offset-2 hover:underline">{m.title}</Link>
                        <div className="mt-0.5 flex gap-1">{m.pinned ? <Badge variant="outline"><Pin className="size-3" aria-hidden="true" />Pinned</Badge> : null}{m.favourite ? <Badge variant="outline"><Heart className="size-3" aria-hidden="true" />Favourite</Badge> : null}</div>
                      </TableCell>
                      <TableCell>{m.channelName ?? "–"}</TableCell>
                      <TableCell><StatusBadge status={m.availability} />{m.temporarilyUnavailable ? <span className="block text-xs text-warning">Drive offline</span> : null}</TableCell>
                      <TableCell><PriorityBadge priority={m.effectivePriority} /></TableCell>
                      <TableCell className="tabular-nums">{formatDuration(m.durationSeconds)}</TableCell>
                      <TableCell className="tabular-nums whitespace-nowrap">{formatBytes(m.sizeBytes)}</TableCell>
                      <TableCell className="whitespace-nowrap">{timeAgo(m.downloadedAt)}</TableCell>
                      <TableCell className="min-w-72">
                        <div className="flex flex-wrap items-center gap-1">
                          <Button size="sm" variant="outline" disabled={busy !== null} aria-pressed={m.pinned} onClick={() => void edit(m, { pinned: !m.pinned }, m.pinned ? "Unpinned" : "Pinned")}>{m.pinned ? "Unpin" : "Pin"}<span className="sr-only"> {m.title}</span></Button>
                          <Button size="sm" variant="outline" disabled={busy !== null} aria-pressed={m.favourite} onClick={() => void edit(m, { favourite: !m.favourite }, m.favourite ? "Removed from favourites" : "Added to favourites")}>{m.favourite ? "Unfavourite" : "Favourite"}<span className="sr-only"> {m.title}</span></Button>
                          <span>
                            <label htmlFor={`pr-${m.id}`} className="sr-only">Manual priority for {m.title}</label>
                            <Select id={`pr-${m.id}`} className="h-8 w-28 text-xs" value="" disabled={busy !== null} onChange={(e) => { const v = e.target.value; if (v) void edit(m, { manualPriority: v === "auto" ? null : (v as Priority) }, v === "auto" ? "Priority set to automatic" : `Priority set to ${priorityLabel(v as Priority)}`); }}>
                              <option value="">Set priority</option><option value="auto">Automatic</option>{PRIORITIES.map((p) => <option key={p} value={p}>{priorityLabel(p)}</option>)}
                            </Select>
                          </span>
                          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(m.id, async () => { await post(`/api/media/${m.id}/download`); await result.mutate(); }, { success: "Download queued" })}>Re-download<span className="sr-only"> {m.title}</span></Button>
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleting(m)}>Delete<span className="sr-only"> {m.title}</span></Button>
                          <OriginalLink id={m.id} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-3 flex items-center justify-between">
                <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
                <span className="text-sm text-muted-foreground">{offset + 1} to {Math.min(offset + PAGE, total ?? offset + items.length)}</span>
                <Button variant="outline" size="sm" disabled={total === undefined ? items.length < PAGE : offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
              </div>
            </>
          );
        }}
      </Query>

      {deleting ? (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} destructive title="Delete this download?" confirmLabel="Delete files"
          description={<>The files for “{deleting.title}” are removed to free {formatBytes(deleting.sizeBytes)}. The title and details stay in the catalogue, and it can be downloaded again.</>}
          onConfirm={async () => { await del(`/api/media/${deleting.id}`); await result.mutate(); }} />
      ) : null}
    </>
  );
}
