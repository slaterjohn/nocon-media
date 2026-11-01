"use client";

import * as React from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { errorMessage, get, post, useApi } from "@/lib/api";
import type { ReadinessResult, SystemHealth } from "@/lib/types";
import { formatBytes, formatDate, timeAgo } from "@/lib/utils";
import { useAction } from "@/hooks/use-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/layout/states";
import { FormError, ToggleRow } from "@/components/common/form";
import { CapacityBar, Query, Stat } from "@/components/common/data";

const CHECK_LABELS: Record<string, string> = {
  auth: "Sign-in", database: "Database", media_files: "Media files", thumbnails: "Thumbnails", search: "Search",
  streaming: "Streaming", xtream: "Xtream and M3U", external_dependencies: "No external dependencies",
};

function Readiness() {
  const [result, setResult] = React.useState<ReadinessResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  async function run() {
    setBusy(true); setError(null);
    try { setResult(await get<ReadinessResult>("/api/system/offline-readiness")); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Card>
      <CardHeader><CardTitle>Offline readiness</CardTitle><CardDescription>Checks that playback, search and external players work without an internet connection.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={() => void run()} disabled={busy}>{busy ? "Running…" : "Run offline readiness test"}</Button>
        <div aria-live="polite" className="space-y-2">
          <FormError message={error} />
          {result ? (
            <>
              <p className={result.ok ? "font-medium text-success" : "font-medium text-destructive"}>{result.ok ? "Everything needed offline is working." : "Some checks failed. Fix them before relying on offline use."}</p>
              <ul className="space-y-1.5">
                {result.checks.map((c) => (
                  <li key={c.key} className="flex items-start gap-2 text-sm">
                    {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />}
                    <span><span className="font-medium">{CHECK_LABELS[c.key] ?? c.key}: {c.ok ? "passed" : "failed"}.</span> {c.message}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default function SystemPage() {
  const result = useApi<SystemHealth>("/api/system/health", { refreshInterval: 5000 });
  const { run, busy } = useAction();
  return (
    <>
      <PageHeader title="System health" description="Resources, services and recent errors. Updates every 5 seconds." />
      <Query result={result}>
        {(h) => (
          <div className="space-y-6">
            {h.remediation.length ? (
              <Card className="border-warning/60">
                <CardHeader><CardTitle>Needs attention</CardTitle></CardHeader>
                <CardContent><ul className="list-disc space-y-1 pl-5 text-sm">{h.remediation.map((r) => <li key={r.key}>{r.message}</li>)}</ul></CardContent>
              </Card>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="CPU" value={`${Math.round(h.cpu.percent)}%`} hint={`${h.cpu.cores} cores, load ${h.cpu.load.map((l) => l.toFixed(2)).join(" / ")}`} tone={h.cpu.percent > 90 ? "warn" : undefined} />
              <Stat label="Memory" value={`${formatBytes(h.memory.usedBytes)}`} hint={`of ${formatBytes(h.memory.totalBytes)}; API uses ${formatBytes(h.memory.processRss)}`} />
              {h.temperatureC !== null ? <Stat label="Temperature" value={`${h.temperatureC.toFixed(1)} °C`} tone={h.temperatureC > 80 ? "bad" : h.temperatureC > 70 ? "warn" : undefined} /> : null}
              <Stat label="Active downloads" value={h.downloads.active} />
              <Stat label="Active streams" value={h.streams.active} />
              <Stat label="Database" value={h.database.ok ? `${h.database.latencyMs} ms` : "Down"} tone={h.database.ok ? "ok" : "bad"} />
              <Stat label="Redis" value={h.redis.ok ? `${h.redis.latencyMs} ms` : "Down"} tone={h.redis.ok ? "ok" : "bad"} />
              <Stat label="Connectivity" value={h.connectivity.online ? "Online" : "Offline"} tone={h.connectivity.online ? "ok" : "warn"} hint={h.connectivity.checkedAt ? `Checked ${timeAgo(h.connectivity.checkedAt)}` : undefined} />
            </div>

            <Card>
              <CardHeader className="flex-row items-start justify-between gap-2">
                <div><CardTitle>Worker</CardTitle><CardDescription>Last heartbeat {timeAgo(h.worker.lastHeartbeat)}</CardDescription></div>
                <Badge variant={h.worker.online ? "success" : "destructive"}>{h.worker.online ? "Online" : "Offline"}</Badge>
              </CardHeader>
              <CardContent className="space-y-4">
                <ToggleRow id="worker-pause" label="Pause background work" description="Stops new syncs and downloads. Playback and search keep working. Running jobs finish first.">
                  {(p) => <Switch {...p} checked={h.worker.paused} disabled={busy !== null} onCheckedChange={(paused) => void run("pause", async () => { await post("/api/system/worker", { paused }); await result.mutate(); }, { success: paused ? "Worker paused" : "Worker resumed" })} />}
                </ToggleRow>
                {Object.keys(h.worker.queues).length ? (
                  <Table aria-label="Queues">
                    <TableHeader><TableRow><TableHead>Queue</TableHead><TableHead>Waiting</TableHead><TableHead>Active</TableHead><TableHead>Delayed</TableHead><TableHead>Failed</TableHead></TableRow></TableHeader>
                    <TableBody>{Object.entries(h.worker.queues).map(([name, q]) => <TableRow key={name}><TableCell className="font-medium">{name}</TableCell><TableCell className="tabular-nums">{q.waiting}</TableCell><TableCell className="tabular-nums">{q.active}</TableCell><TableCell className="tabular-nums">{q.delayed}</TableCell><TableCell className={`tabular-nums ${q.failed ? "text-destructive" : ""}`}>{q.failed}</TableCell></TableRow>)}</TableBody>
                  </Table>
                ) : <p className="text-sm text-muted-foreground">No queue data. The worker may be offline.</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Volumes</CardTitle></CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                {h.volumes.map((v) => (
                  <div key={v.id} className="space-y-1">
                    <p className="flex items-center gap-2 text-sm font-medium">{v.name} <Badge variant={v.isOnline ? "success" : "destructive"}>{v.isOnline ? "Online" : "Offline"}</Badge></p>
                    <CapacityBar used={v.usedBytes} total={v.totalBytes} reserved={v.reservedBytes} label={`${v.name} capacity`} />
                    {v.lastError ? <p className="text-xs text-destructive">{v.lastError}</p> : null}
                  </div>
                ))}
              </CardContent>
            </Card>

            <Readiness />

            <Card>
              <CardHeader><CardTitle>Recent errors</CardTitle></CardHeader>
              <CardContent>
                {h.recentErrors.length === 0 ? <p className="text-sm text-muted-foreground">No recent errors.</p> : (
                  <ul className="space-y-2 text-sm">{h.recentErrors.map((e) => <li key={e.id}><span className="text-muted-foreground tabular-nums">{formatDate(e.at)}</span> <span className="font-mono text-xs">{e.type}</span> {e.message}</li>)}</ul>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </Query>
    </>
  );
}
