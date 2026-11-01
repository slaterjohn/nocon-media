"use client";

import * as React from "react";
import { Download as DownloadIcon } from "lucide-react";
import { errorMessage, post, useApi } from "@/lib/api";
import type { Download } from "@/lib/types";
import { formatBytes, formatDate, formatDuration, pct, timeAgo } from "@/lib/utils";
import { useAction } from "@/hooks/use-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/layout/states";
import { Field, FormError } from "@/components/common/form";
import { PriorityBadge, StatusBadge } from "@/components/common/badges";
import { useToast } from "@/components/ui/toast";

const TABS = [
  { key: "active", label: "Active", states: ["downloading", "checking", "processing", "verifying", "paused"] },
  { key: "queued", label: "Queued", states: ["queued", "pending"] },
  { key: "waiting", label: "Waiting for storage", states: ["waiting_for_storage"] },
  { key: "failed", label: "Failed", states: ["failed"] },
  { key: "completed", label: "Completed", states: ["ready", "completed"] },
] as const;

const ACTIVE = new Set(["downloading", "checking", "processing", "verifying"]);

interface DownloadDetail {
  download: Download;
  attempts: Record<string, unknown>[];
  events: { fromState: string | null; toState: string; reason: string | null; at: string }[];
}

function DetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const result = useApi<DownloadDetail>(id ? `/api/downloads/${id}` : null, { refreshInterval: 3000 });
  const d = result.data;
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full max-w-xl">
        <SheetTitle>{d?.download.title ?? "Download details"}</SheetTitle>
        <SheetDescription>Attempts and state changes for this download.</SheetDescription>
        {result.error ? <ErrorState message={result.error.message} onRetry={() => void result.mutate()} /> : !d ? <LoadingSkeleton rows={4} /> : (
          <div className="space-y-5 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">State</dt><dd><StatusBadge status={d.download.state} /></dd>
              <dt className="text-muted-foreground">Source</dt><dd>{d.download.sourceName ?? "–"}</dd>
              <dt className="text-muted-foreground">Progress</dt><dd>{pct(d.download.progress)}</dd>
              <dt className="text-muted-foreground">Size</dt><dd>{formatBytes(d.download.bytesDownloaded)} of {formatBytes(d.download.totalBytes ?? d.download.estimatedBytes)}</dd>
              <dt className="text-muted-foreground">Attempts</dt><dd>{d.download.attempts}</dd>
              <dt className="text-muted-foreground">Created</dt><dd>{formatDate(d.download.createdAt)}</dd>
              {d.download.waitingReason ? (<><dt className="text-muted-foreground">Waiting because</dt><dd>{d.download.waitingReason}</dd></>) : null}
            </dl>
            {d.download.error ? <p role="alert" className="rounded-md border border-destructive/60 p-2">{d.download.errorClass ? `${d.download.errorClass}: ` : ""}{d.download.error}</p> : null}
            <section aria-labelledby="dl-attempts">
              <h3 id="dl-attempts" className="mb-1 font-semibold">Attempts</h3>
              {d.attempts.length === 0 ? <p className="text-muted-foreground">No attempts recorded.</p> : (
                <ol className="space-y-2">
                  {d.attempts.map((a, i) => (
                    <li key={i} className="rounded-md border p-2">
                      <p className="font-medium">Attempt {String(a.attempt ?? a.number ?? i + 1)}</p>
                      <pre className="mt-1 overflow-x-auto text-xs whitespace-pre-wrap text-muted-foreground">{JSON.stringify(a, null, 2)}</pre>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <section aria-labelledby="dl-events">
              <h3 id="dl-events" className="mb-1 font-semibold">State changes</h3>
              {d.events.length === 0 ? <p className="text-muted-foreground">No changes recorded.</p> : (
                <ol className="space-y-1.5">
                  {d.events.map((e, i) => (
                    <li key={i} className="flex flex-wrap gap-x-2">
                      <span className="text-muted-foreground tabular-nums">{formatDate(e.at)}</span>
                      <span>{e.fromState ? `${e.fromState.replaceAll("_", " ")} → ` : ""}{e.toState.replaceAll("_", " ")}</span>
                      {e.reason ? <span className="text-muted-foreground">({e.reason})</span> : null}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default function DownloadsPage() {
  const [tab, setTab] = React.useState<(typeof TABS)[number]["key"]>("active");
  const current = TABS.find((t) => t.key === tab)!;
  const result = useApi<{ items: Download[]; counts: Record<string, number> }>(`/api/downloads?state=${current.states.join(",")}&limit=100`, { refreshInterval: 3000 });
  const counts = useApi<{ items: Download[]; counts: Record<string, number> }>("/api/downloads?limit=1", { refreshInterval: 3000 });
  const { run, busy } = useAction();
  const { toast } = useToast();
  const [detail, setDetail] = React.useState<string | null>(null);
  const [url, setUrl] = React.useState("");
  const [urlError, setUrlError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  const act = (d: Download, verb: "retry" | "cancel" | "pause" | "resume") =>
    run(`${verb}-${d.id}`, async () => { await post(`/api/downloads/${d.id}/${verb}`); await result.mutate(); }, { success: `${verb === "retry" ? "Retrying" : verb === "cancel" ? "Cancelled" : verb === "pause" ? "Paused" : "Resumed"}: ${d.title}` });

  async function addUrl(e: React.FormEvent) {
    e.preventDefault();
    setUrlError(null);
    if (!url.trim()) { setUrlError("Enter a video address."); return; }
    setAdding(true);
    try {
      await post("/api/downloads", { url: url.trim() });
      toast({ title: "Download queued", variant: "success" });
      setUrl("");
      await result.mutate();
    } catch (err) {
      setUrlError(errorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  const countFor = (states: readonly string[]) => {
    const c = counts.data?.counts;
    return c ? states.reduce((a, s) => a + (c[s] ?? 0), 0) : null;
  };

  return (
    <>
      <PageHeader title="Downloads" description="Progress updates every 3 seconds." />
      <form onSubmit={addUrl} noValidate className="mb-6 flex flex-wrap items-start gap-2">
        <Field id="dl-url" label="Download a video" hint="Paste a video address. It's added to the Manual downloads source at Keep priority." error={urlError} className="min-w-64 flex-1">
          {(p) => <Input {...p} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" />}
        </Field>
        <Button type="submit" disabled={adding} className="mt-[1.375rem]"><DownloadIcon aria-hidden="true" /> {adding ? "Adding…" : "Download"}</Button>
      </form>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList aria-label="Download state">
          {TABS.map((t) => {
            const n = countFor(t.states);
            return <TabsTrigger key={t.key} value={t.key}>{t.label}{n !== null ? <span className="text-xs tabular-nums">({n})</span> : null}</TabsTrigger>;
          })}
        </TabsList>

      <TabsContent value={tab}>
        {result.error && !result.data ? <ErrorState message={result.error.message} onRetry={() => void result.mutate()} /> : !result.data ? <LoadingSkeleton /> : result.data.items.length === 0 ? (
          <EmptyState icon={DownloadIcon} title={`Nothing in ${current.label.toLowerCase()}`} description={tab === "failed" ? "Failed downloads are retried automatically a few times, then listed here." : "Downloads appear here as sources find new videos."} />
        ) : (
          <Table aria-label={`${current.label} downloads`}>
            <TableHeader>
              <TableRow><TableHead>Title</TableHead><TableHead>Source</TableHead><TableHead>State</TableHead><TableHead>Progress</TableHead><TableHead>Speed</TableHead><TableHead>ETA</TableHead><TableHead>Updated</TableHead><TableHead>Actions</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {result.data.items.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="max-w-72">
                    <button type="button" onClick={() => setDetail(d.id)} className="line-clamp-2 text-left font-medium underline-offset-2 hover:underline">{d.title}</button>
                    <PriorityBadge priority={d.priority} />
                    {d.error ? <span className="mt-1 block text-xs text-destructive">{d.error}</span> : null}
                    {d.waitingReason ? <span className="mt-1 block text-xs text-warning">{d.waitingReason}</span> : null}
                  </TableCell>
                  <TableCell>{d.sourceName ?? "–"}</TableCell>
                  <TableCell><StatusBadge status={d.state} /></TableCell>
                  <TableCell className="min-w-36">
                    <Progress value={d.progress * 100} label={`Progress for ${d.title}`} />
                    <span className="text-xs tabular-nums text-muted-foreground">{pct(d.progress)} · {formatBytes(d.bytesDownloaded)}/{formatBytes(d.totalBytes ?? d.estimatedBytes)}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{ACTIVE.has(d.state) && d.speedBps ? `${formatBytes(d.speedBps)}/s` : "–"}</TableCell>
                  <TableCell className="tabular-nums">{ACTIVE.has(d.state) && d.etaSeconds ? formatDuration(d.etaSeconds) : "–"}</TableCell>
                  <TableCell className="whitespace-nowrap">{timeAgo(d.updatedAt)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {d.state === "failed" ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(d, "retry")}>Retry<span className="sr-only"> {d.title}</span></Button> : null}
                      {d.state === "paused" ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(d, "resume")}>Resume<span className="sr-only"> {d.title}</span></Button> : null}
                      {["downloading", "queued", "pending"].includes(d.state) ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(d, "pause")}>Pause<span className="sr-only"> {d.title}</span></Button> : null}
                      {!["ready", "completed", "failed", "cancelled"].includes(d.state) ? <Button size="sm" variant="ghost" className="text-destructive" disabled={busy !== null} onClick={() => void act(d, "cancel")}>Cancel<span className="sr-only"> {d.title}</span></Button> : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TabsContent>
      </Tabs>
      <FormError message={null} />
      <DetailDrawer id={detail} onClose={() => setDetail(null)} />
    </>
  );
}
