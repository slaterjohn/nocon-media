"use client";

import Link from "next/link";
import { useApi } from "@/lib/api";
import type { Dashboard } from "@/lib/types";
import { formatBytes, timeAgo } from "@/lib/utils";
import { PageHeader } from "@/components/layout/states";
import { Query, Stat, StorageBar } from "@/components/common/data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`g-${title}`} className="space-y-3">
      <h2 id={`g-${title}`} className="text-sm font-semibold text-muted-foreground">{title}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </section>
  );
}

export default function AdminDashboard() {
  const result = useApi<Dashboard>("/api/dashboard", { refreshInterval: 10000 });
  return (
    <>
      <PageHeader title="Dashboard" description="Library size, storage, downloads and background services. Updates every 10 seconds." />
      <Query result={result} skeleton={<div className="space-y-4"><div className="grid gap-3 sm:grid-cols-4"><div className="h-24 animate-pulse rounded-lg bg-muted" /><div className="h-24 animate-pulse rounded-lg bg-muted" /><div className="h-24 animate-pulse rounded-lg bg-muted" /><div className="h-24 animate-pulse rounded-lg bg-muted" /></div></div>}>
        {(d) => {
          const usedPct = d.storage.totalBytes ? Math.round((d.storage.usedBytes / d.storage.totalBytes) * 100) : 0;
          return (
            <div className="space-y-6">
              <Card>
                <CardHeader><CardTitle>Storage by priority</CardTitle></CardHeader>
                <CardContent>
                  <StorageBar totalBytes={d.storage.totalBytes} usedBytes={d.storage.usedBytes} byPriority={d.storage.byPriority} />
                </CardContent>
              </Card>
              <Group title="Storage">
                <Stat label="Total" value={formatBytes(d.storage.totalBytes)} />
                <Stat label="Used" value={formatBytes(d.storage.usedBytes)} hint={`${usedPct}% of capacity`} tone={usedPct > 95 ? "bad" : usedPct > 85 ? "warn" : undefined} />
                <Stat label="Free" value={formatBytes(d.storage.freeBytes)} />
              </Group>
              <Group title="Media">
                <Stat label="Total items" value={d.media.total} />
                <Stat label="Available" value={d.media.available} />
                <Stat label="Evicted" value={d.media.evicted} hint="Files removed, details kept" />
                <Stat label="Discovered" value={d.media.discovered} hint="Not downloaded yet" />
              </Group>
              <Group title="Downloads">
                <Stat label="Active" value={d.downloads.active} />
                <Stat label="Pending" value={d.downloads.pending} />
                <Stat label="Waiting for storage" value={d.downloads.waitingForStorage} tone={d.downloads.waitingForStorage ? "warn" : undefined} />
                <Stat label="Failed" value={d.downloads.failed} tone={d.downloads.failed ? "bad" : undefined} />
              </Group>
              <Group title="Sources">
                <Stat label="Total" value={d.sources.total} />
                <Stat label="Active" value={d.sources.active} />
                <Stat label="Paused" value={d.sources.paused} />
                <Stat label="Errors" value={d.sources.error} tone={d.sources.error ? "bad" : undefined} />
                <Stat label="Need attention" value={d.sources.needsAttention} tone={d.sources.needsAttention ? "warn" : undefined} />
                <Stat label="Last sync" value={<span className="text-lg">{timeAgo(d.sources.lastSyncAt)}</span>} />
              </Group>
              <Group title="Services">
                <Stat label="Active streams" value={d.streams.active} />
                <Stat label="Connectivity" value={d.connectivity.online ? "Online" : "Offline"} tone={d.connectivity.online ? "ok" : "warn"} hint={`Checked ${timeAgo(d.connectivity.checkedAt)}`} />
                <Stat label="Worker" value={d.worker.online ? (d.worker.paused ? "Paused" : "Running") : "Offline"} tone={!d.worker.online ? "bad" : d.worker.paused ? "warn" : "ok"} hint={`Last heartbeat ${timeAgo(d.worker.lastHeartbeat)}`} />
                <Stat label="Unread notifications" value={d.notifications.unread} />
              </Group>
              <p className="text-sm text-muted-foreground">
                <Link href="/admin/system" className="underline">System health</Link> has CPU, memory and queue detail.{" "}
                {d.sources.needsAttention > 0 ? <Badge variant="warning">{d.sources.needsAttention} sources need attention</Badge> : null}
              </p>
            </div>
          );
        }}
      </Query>
    </>
  );
}
