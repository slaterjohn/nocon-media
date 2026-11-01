"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, Rss } from "lucide-react";
import { useApi } from "@/lib/api";
import type { Source } from "@/lib/types";
import { formatBytes, timeAgo } from "@/lib/utils";
import { useAction } from "@/hooks/use-action";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader } from "@/components/layout/states";
import { Query } from "@/components/common/data";
import { PriorityBadge, StatusBadge } from "@/components/common/badges";
import {
  DeleteSourceDialog, SourceEditDialog, SourceRowActions, describeRetention, describeSchedule, useSourceActions,
} from "@/components/sources/source-actions";

export default function SourcesPage() {
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [type, setType] = React.useState("");
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (status) params.set("status", status);
  if (type) params.set("type", type);
  const result = useApi<{ items: Source[] }>(`/api/sources${params.size ? `?${params}` : ""}`, { refreshInterval: 15000 });
  const { run, busy } = useAction();
  const { toast } = useToast();
  const actions = useSourceActions(result.mutate, run);
  const [editing, setEditing] = React.useState<Source | undefined>();
  const [adding, setAdding] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Source | null>(null);

  return (
    <>
      <PageHeader
        title="Sources"
        description="Channels, playlists, videos and searches that NoConMedia keeps up to date."
        actions={<Button onClick={() => setAdding(true)}><Plus aria-hidden="true" /> Add source</Button>}
      />
      <form role="search" className="mb-4 flex flex-wrap gap-2" onSubmit={(e) => e.preventDefault()}>
        <div className="min-w-48 flex-1">
          <label htmlFor="src-q" className="sr-only">Search sources</label>
          <Input id="src-q" type="search" placeholder="Search sources" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div>
          <label htmlFor="src-status" className="sr-only">Status</label>
          <Select id="src-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option><option value="active">Active</option><option value="paused">Paused</option><option value="error">Error</option>
          </Select>
        </div>
        <div>
          <label htmlFor="src-type" className="sr-only">Type</label>
          <Select id="src-type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option><option value="channel">Channel</option><option value="playlist">Playlist</option><option value="search">Search</option><option value="video">Video</option>
          </Select>
        </div>
      </form>

      <Query result={result}>
        {({ items }) =>
          items.length === 0 ? (
            <EmptyState icon={Rss} title="No sources yet" description="Add a channel, playlist or search to start building your library." action={<Button onClick={() => setAdding(true)}>Add source</Button>} />
          ) : (
            <Table aria-label="Sources">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead><TableHead>Platform</TableHead><TableHead>Type</TableHead><TableHead>Priority</TableHead>
                  <TableHead>Retention</TableHead><TableHead>Schedule</TableHead><TableHead>Last success</TableHead>
                  <TableHead>Downloaded</TableHead><TableHead>Storage</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="max-w-56 font-medium">
                      <Link href={`/admin/sources/${s.id}`} className="underline-offset-2 hover:underline">{s.name}</Link>
                      {s.needsAttention ? <span className="ml-2 text-xs text-warning">Needs attention</span> : null}
                    </TableCell>
                    <TableCell>{s.platform}</TableCell>
                    <TableCell>{s.type}</TableCell>
                    <TableCell><PriorityBadge priority={s.priority} /></TableCell>
                    <TableCell>{describeRetention(s.retention)}</TableCell>
                    <TableCell>{describeSchedule(s.schedule)}</TableCell>
                    <TableCell className="whitespace-nowrap">{timeAgo(s.lastSuccessAt)}</TableCell>
                    <TableCell className="tabular-nums">{s.downloadedCount} / {s.mediaCount}</TableCell>
                    <TableCell className="tabular-nums whitespace-nowrap">{formatBytes(s.storageBytes)}</TableCell>
                    <TableCell><StatusBadge status={s.status} /></TableCell>
                    <TableCell className="min-w-64">
                      <SourceRowActions source={s} busy={busy} actions={actions} onEdit={() => setEditing(s)} onDelete={() => setDeleting(s)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        }
      </Query>

      <SourceEditDialog open={adding} onOpenChange={setAdding} onSaved={(s) => { toast({ title: `Added ${s.name}`, variant: "success" }); void result.mutate(); }} />
      <SourceEditDialog source={editing} open={!!editing} onOpenChange={(o) => !o && setEditing(undefined)} onSaved={(s) => { toast({ title: `Saved ${s.name}`, variant: "success" }); void result.mutate(); }} />
      {deleting ? (
        <DeleteSourceDialog source={deleting} open onOpenChange={(o) => !o && setDeleting(null)} onDeleted={(r) => { toast({ title: "Source deleted", description: `${r.retainedMedia} kept, ${r.deletedMedia} deleted.`, variant: "success" }); void result.mutate(); }} />
      ) : null}
    </>
  );
}
