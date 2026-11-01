"use client";

import * as React from "react";
import Link from "next/link";
import { Compass, Upload } from "lucide-react";
import { api, errorMessage, post, useApi } from "@/lib/api";
import type { Recommendation } from "@/lib/types";
import { formatDuration, timeAgo } from "@/lib/utils";
import { useAction } from "@/hooks/use-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { EmptyState, PageHeader } from "@/components/layout/states";
import { Field, FormError, ToggleRow } from "@/components/common/form";
import { Query } from "@/components/common/data";

const STATUSES = ["pending", "approved", "rejected", "queued", "catalogued"] as const;

function humanise(key: string) {
  const s = key.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function TakeoutImport() {
  const [file, setFile] = React.useState<File | null>(null);
  const [queue, setQueue] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [res, setRes] = React.useState<{ imported: number; duplicates: number; skipped: number; matchedMedia: number; queued: number } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRes(null);
    if (!file) { setError("Choose a Takeout file first."); return; }
    if (file.size > 200 * 1024 * 1024) { setError("That file is over 200 MiB. Export only YouTube watch history from Google Takeout."); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("queueDownloads", String(queue));
      fd.append("file", file);
      setRes(await api("/api/history/import", { method: "POST", body: fd }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader><CardTitle>Import watch history</CardTitle><CardDescription>Upload a Google Takeout export (JSON, HTML or ZIP, up to 200 MiB). It's processed on this server and never leaves it.</CardDescription></CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <FormError message={error} />
          <Field id="takeout-file" label="Takeout file" error={null}>
            {(p) => <Input {...p} type="file" accept=".json,.html,.zip,application/json,text/html,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="h-auto py-1.5" />}
          </Field>
          <ToggleRow id="takeout-queue" label="Queue downloads for the videos found" description="Off imports history only, which seeds recommendations without downloading anything.">
            {(p) => <Checkbox {...p} checked={queue} onCheckedChange={(v) => setQueue(v === true)} />}
          </ToggleRow>
          <Button type="submit" disabled={busy}><Upload aria-hidden="true" /> {busy ? "Importing…" : "Import"}</Button>
        </form>
        <div aria-live="polite">
          {res ? (
            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
              {([["Imported", res.imported], ["Duplicates", res.duplicates], ["Skipped", res.skipped], ["Matched in library", res.matchedMedia], ["Queued", res.queued]] as const).map(([l, v]) => (
                <div key={l} className="rounded-lg border p-3"><dt className="text-xs text-muted-foreground">{l}</dt><dd className="text-xl font-semibold tabular-nums">{v}</dd></div>
              ))}
            </dl>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default function DiscoveryPage() {
  const [status, setStatus] = React.useState<(typeof STATUSES)[number]>("pending");
  const result = useApi<{ items: Recommendation[] }>(`/api/discovery/recommendations?status=${status}`, { refreshInterval: 15000 });
  const { run, busy } = useAction();

  return (
    <>
      <PageHeader title="Discovery" description="Recommended videos found from what you watch and follow. Approve one to download it at Optional priority."
        actions={<Button disabled={busy !== null} onClick={() => void run("run", () => post("/api/discovery/run"), { success: "Discovery started" })}><Compass aria-hidden="true" /> Run discovery now</Button>} />

      <Tabs value={status} onValueChange={(v) => setStatus(v as typeof status)}>
        <TabsList aria-label="Recommendation status">{STATUSES.map((s) => <TabsTrigger key={s} value={s}>{humanise(s)}</TabsTrigger>)}</TabsList>

      <TabsContent value={status}>
        <Query result={result}>
          {({ items }) => items.length === 0 ? (
            <EmptyState icon={Compass} title={`No ${status} recommendations`} description={status === "pending" ? "Turn on discovery for a source, import watch history, or run discovery now." : undefined} />
          ) : (
            <ul className="grid gap-3 lg:grid-cols-2">
              {items.map((r) => (
                <li key={r.id}>
                  <Card>
                    <CardContent className="space-y-3 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="line-clamp-2 font-medium">{r.media.title}</h3>
                          <p className="text-sm text-muted-foreground">{r.media.channelName ?? "Unknown channel"} · {formatDuration(r.media.durationSeconds)} · found {timeAgo(r.createdAt)}</p>
                        </div>
                        <Badge variant="outline" title="Recommendation score">Score {r.score.toFixed(2)}</Badge>
                      </div>
                      {r.seed ? <p className="text-xs text-muted-foreground">Because of: {r.seed.title} (depth {r.depth}, {r.strategy})</p> : <p className="text-xs text-muted-foreground">Strategy: {r.strategy}</p>}
                      {r.explanation.reasons?.length ? <ul className="list-disc pl-5 text-sm">{r.explanation.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
                      {r.explanation.components ? (
                        <ul className="space-y-1.5" aria-label="Score components">
                          {Object.entries(r.explanation.components).map(([k, v]) => (
                            <li key={k} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-2 text-xs">
                              <span>{humanise(k)}</span><Progress value={Math.min(1, Math.abs(v)) * 100} label={`${humanise(k)} ${v.toFixed(2)}`} /><span className="text-right tabular-nums">{v.toFixed(2)}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {status === "pending" ? (
                        <div className="flex gap-2">
                          <Button size="sm" disabled={busy !== null} onClick={() => void run(r.id, async () => { await post(`/api/discovery/recommendations/${r.id}/approve`); await result.mutate(); }, { success: "Approved and queued" })}>Approve<span className="sr-only"> {r.media.title}</span></Button>
                          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(r.id, async () => { await post(`/api/discovery/recommendations/${r.id}/reject`); await result.mutate(); }, { success: "Rejected" })}>Reject<span className="sr-only"> {r.media.title}</span></Button>
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </Query>
      </TabsContent>
      </Tabs>

      <div className="mt-8 max-w-3xl">
        <TakeoutImport />
      </div>
      <p className="mt-4 text-sm text-muted-foreground">Limits on what discovery may recommend and download are in <Link href="/admin/settings/discovery" className="underline">Settings, Discovery</Link>. Turn discovery on for each source in <Link href="/admin/sources" className="underline">Sources</Link>.</p>
    </>
  );
}
