"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api, useApi } from "@/lib/api";
import type { MediaSummary, Source, SourceRun } from "@/lib/types";
import { formatBytes, formatDate, formatDuration, timeAgo } from "@/lib/utils";
import { useAction } from "@/hooks/use-action";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader } from "@/components/layout/states";
import { Query } from "@/components/common/data";
import { PriorityBadge, StatusBadge } from "@/components/common/badges";
import {
  DeleteSourceDialog, SourceEditDialog, SourceRowActions, describeRetention, describeSchedule, useSourceActions,
} from "@/components/sources/source-actions";

export default function SourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const detail = useApi<{ source: Source; recentRuns: SourceRun[] }>(`/api/sources/${id}`, { refreshInterval: 15000 });
  const media = useApi<{ items: MediaSummary[] }>(`/api/sources/${id}/media?limit=50`);
  const { run, busy } = useAction();
  const actions = useSourceActions(async () => { await detail.mutate(); }, run);
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  return (
    <Query result={detail}>
      {({ source: s, recentRuns }) => (
        <>
          <PageHeader
            title={s.name}
            description={<>Back to <Link href="/admin/sources" className="underline">all sources</Link>. {s.url ? <a href={s.url} className="underline" target="_blank" rel="noreferrer noopener">Open original<span className="sr-only"> (opens in a new tab)</span></a> : null}</>}
            actions={<SourceRowActions source={s} busy={busy} actions={actions} onEdit={() => setEditing(true)} onDelete={() => setDeleting(true)} />}
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Details</CardTitle></CardHeader>
              <CardContent>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">Status</dt><dd><StatusBadge status={s.status} /></dd>
                  <dt className="text-muted-foreground">Platform</dt><dd>{s.platform} {s.type}</dd>
                  <dt className="text-muted-foreground">Priority</dt><dd><PriorityBadge priority={s.priority} /></dd>
                  <dt className="text-muted-foreground">Retention</dt><dd>{describeRetention(s.retention)}</dd>
                  <dt className="text-muted-foreground">Automatic eviction</dt><dd>{s.automaticEviction ? "On" : "Off"}</dd>
                  <dt className="text-muted-foreground">Schedule</dt><dd>{describeSchedule(s.schedule)}</dd>
                  <dt className="text-muted-foreground">Last checked</dt><dd>{formatDate(s.lastCheckedAt)}</dd>
                  <dt className="text-muted-foreground">Last success</dt><dd>{formatDate(s.lastSuccessAt)}</dd>
                  <dt className="text-muted-foreground">Next run</dt><dd>{formatDate(s.nextRunAt)}</dd>
                  <dt className="text-muted-foreground">Media</dt><dd>{s.downloadedCount} downloaded of {s.mediaCount}</dd>
                  <dt className="text-muted-foreground">Storage</dt><dd>{formatBytes(s.storageBytes)}</dd>
                  {s.query ? (<><dt className="text-muted-foreground">Search query</dt><dd>{s.query}</dd></>) : null}
                </dl>
                {s.lastError ? <p role="alert" className="mt-3 rounded-md border border-destructive/60 p-2 text-sm">{s.lastError} ({s.consecutiveFailures} failures in a row)</p> : null}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Recent runs</CardTitle></CardHeader>
              <CardContent>
                {recentRuns.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet. Choose Sync now to start one.</p> : (
                  <Table aria-label="Recent runs">
                    <TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Trigger</TableHead><TableHead>Status</TableHead><TableHead>Found</TableHead><TableHead>New</TableHead><TableHead>Queued</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {recentRuns.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="whitespace-nowrap">{timeAgo(r.startedAt)}</TableCell><TableCell>{r.trigger}</TableCell>
                          <TableCell><StatusBadge status={r.status} />{r.error ? <span className="block text-xs text-destructive">{r.error}</span> : null}</TableCell>
                          <TableCell className="tabular-nums">{r.discoveredCount}</TableCell><TableCell className="tabular-nums">{r.newCount}</TableCell><TableCell className="tabular-nums">{r.queuedCount}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
          {s.system ? null : <CookiesCard source={s} onChanged={() => void detail.mutate()} run={run} busy={busy} />}
          <section aria-labelledby="src-media" className="mt-6">
            <h2 id="src-media" className="mb-2 text-lg font-semibold">Media from this source</h2>
            <Query result={media}>
              {({ items }) => items.length === 0 ? <EmptyState title="No media yet" description="Videos appear here after the first sync." /> : (
                <Table aria-label="Media from this source">
                  <TableHeader><TableRow><TableHead>Title</TableHead><TableHead>Status</TableHead><TableHead>Priority</TableHead><TableHead>Length</TableHead><TableHead>Size</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {items.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="max-w-md truncate">{m.playable ? <Link href={`/watch/${m.id}`} className="underline-offset-2 hover:underline">{m.title}</Link> : m.title}</TableCell>
                        <TableCell><StatusBadge status={m.availability} /></TableCell>
                        <TableCell><PriorityBadge priority={m.effectivePriority} /></TableCell>
                        <TableCell className="tabular-nums">{formatDuration(m.durationSeconds)}</TableCell>
                        <TableCell className="tabular-nums">{formatBytes(m.sizeBytes)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Query>
          </section>
          <SourceEditDialog source={s} open={editing} onOpenChange={setEditing} onSaved={() => void detail.mutate()} />
          <DeleteSourceDialog source={s} open={deleting} onOpenChange={setDeleting} onDeleted={() => router.push("/admin/sources")} />
        </>
      )}
    </Query>
  );
}

function CookiesCard({ source, onChanged, run, busy }: { source: Source; onChanged: () => void; run: ReturnType<typeof useAction>["run"]; busy: string | null }) {
  const input = React.useRef<HTMLInputElement>(null);
  const [file, setFile] = React.useState<File | null>(null);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const res = await run("cookies", () => api(`/api/sources/${source.id}/cookies`, { method: "PUT", body: fd }), { success: "Cookies saved", failure: "Couldn't save the cookies" });
    if (res !== undefined) {
      setFile(null);
      if (input.current) input.current.value = "";
      onChanged();
    }
  }
  async function remove() {
    const res = await run("cookies", () => api(`/api/sources/${source.id}/cookies`, { method: "DELETE" }), { success: "Cookies removed", failure: "Couldn't remove the cookies" });
    if (res !== undefined) onChanged();
  }

  return (
    <Card className="mt-4">
      <CardHeader><CardTitle>Authentication cookies (optional)</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>Only use cookies for content your account is entitled to. They are stored on this server and never shown again.</p>
        <p><span className="text-muted-foreground">Status: </span><strong>{source.hasCookies ? "Cookies are set" : "No cookies set"}</strong></p>
        <form onSubmit={(e) => void upload(e)} className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="cookies-file" className="mb-1 block font-medium">Cookies file (Netscape cookies.txt, up to 1 MiB)</label>
            <input id="cookies-file" ref={input} type="file" accept=".txt,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <Button type="submit" disabled={!file || busy !== null}>{source.hasCookies ? "Replace cookies" : "Upload cookies"}</Button>
          {source.hasCookies ? <Button type="button" variant="outline" onClick={() => void remove()} disabled={busy !== null}>Remove cookies</Button> : null}
        </form>
      </CardContent>
    </Card>
  );
}
