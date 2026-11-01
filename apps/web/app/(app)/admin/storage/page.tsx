"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, HardDrive, Plus } from "lucide-react";
import { errorMessage, get, patch, post, useApi } from "@/lib/api";
import type { EvictionRecord, Priority, ReconcileJob, ReconcileResult, SimulationResult, StorageOverview, StorageValidation, Volume } from "@/lib/types";
import { formatBytes, formatDate, timeAgo } from "@/lib/utils";
import { useAction } from "@/hooks/use-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, PageHeader } from "@/components/layout/states";
import { Field, FormError, ToggleRow } from "@/components/common/form";
import { CapacityBar, Query, StorageBar } from "@/components/common/data";
import { PRIORITIES, priorityDescription, priorityLabel } from "@/lib/priority";
import { PriorityBadge, StatusBadge } from "@/components/common/badges";
import { SimulationView } from "@/components/storage/simulation-view";

function AddVolumeDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; onAdded: () => void }) {
  const [path, setPath] = React.useState("");
  const [name, setName] = React.useState("");
  const [result, setResult] = React.useState<StorageValidation | null>(null);
  const [checked, setChecked] = React.useState("");
  const [busy, setBusy] = React.useState<"validate" | "add" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { if (open) { setPath(""); setName(""); setResult(null); setError(null); } }, [open]);

  async function validate() {
    setBusy("validate"); setError(null);
    try { setResult(await post<StorageValidation>("/api/setup/storage/validate", { path: path.trim(), name: name.trim() || undefined })); setChecked(path.trim()); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }
  async function add() {
    setBusy("add"); setError(null);
    try { await post("/api/storage/volumes", { path: path.trim(), name: name.trim() || path.trim() }); onAdded(); onOpenChange(false); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }
  const ok = !!result && result.ok && result.errors.length === 0 && checked === path.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add a volume</DialogTitle><DialogDescription>Mount the drive first, then enter its path. The path must be inside an allowed media root.</DialogDescription></DialogHeader>
        <FormError message={error} />
        <Field id="vol-path" label="Folder path">{(p) => <Input {...p} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/media/usb1" spellCheck={false} />}</Field>
        <Field id="vol-name" label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="USB drive" />}</Field>
        <div aria-live="polite">
          {result ? (
            <div className="space-y-1 rounded-md border p-3 text-sm">
              <p>Writable: {result.writable ? "yes" : "no"}. Capacity {formatBytes(result.totalBytes)}, free {formatBytes(result.freeBytes)}.{result.mount ? ` Mounted at ${result.mount.mountPoint} (${result.mount.fsType}).` : ""}</p>
              {result.onRootFs ? <p className="text-warning">This looks like the container's own filesystem. Is the drive mounted?</p> : null}
              {result.warnings.map((w) => <p key={w} className="text-warning">{w}</p>)}
              {result.errors.map((w) => <p key={w} role="alert" className="text-destructive">{w}</p>)}
              {ok ? <p className="text-success">This location can be used.</p> : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => void validate()} disabled={!path.trim() || busy !== null}>{busy === "validate" ? "Validating…" : "Validate"}</Button>
          <Button onClick={() => void add()} disabled={!ok || busy !== null}>{busy === "add" ? "Adding…" : "Add volume"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VolumeCard({ v, onChange }: { v: Volume; onChange: () => void }) {
  const { run, busy } = useAction();
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle>{v.name}</CardTitle>
          <CardDescription className="break-all">{v.mountPath}{v.filesystem ? ` · ${v.filesystem}` : ""}</CardDescription>
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          <Badge variant={v.isOnline ? "success" : "destructive"}>{v.isOnline ? "Online" : "Offline"}</Badge>
          <Badge variant={v.isWritable ? "outline" : "warning"}>{v.isWritable ? "Writable" : "Read only"}</Badge>
          {v.isDefault ? <Badge>Default</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <CapacityBar used={v.usedBytes} total={v.totalBytes} reserved={v.reservedBytes} label={`${v.name} capacity`} />
        {v.lastError ? <p role="alert" className="flex gap-1.5 text-sm text-destructive"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{v.lastError}</p> : null}
        <p className="text-xs text-muted-foreground">Last verified {timeAgo(v.lastVerifiedAt)}</p>
        <ToggleRow id={`accept-${v.id}`} label="Accepts new downloads">
          {(p) => <Switch {...p} checked={v.acceptsNew} disabled={busy !== null} onCheckedChange={(c) => void run(v.id, async () => { await patch(`/api/storage/volumes/${v.id}`, { acceptsNew: c }); onChange(); }, { success: "Volume updated" })} />}
        </ToggleRow>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(v.id, async () => { await post(`/api/storage/volumes/${v.id}/verify`); onChange(); }, { success: `Verified ${v.name}`, failure: `Couldn't verify ${v.name}` })}>Verify<span className="sr-only"> {v.name}</span></Button>
          {!v.isDefault ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(v.id, async () => { await patch(`/api/storage/volumes/${v.id}`, { isDefault: true }); onChange(); }, { success: `${v.name} is now the default` })}>Make default<span className="sr-only"> {v.name}</span></Button> : null}
        </div>
      </CardContent>
    </Card>
  );
}

function SimulationTool({ volumes }: { volumes: Volume[] }) {
  const [gb, setGb] = React.useState("10");
  const [priority, setPriority] = React.useState<Priority>("P1");
  const [volumeId, setVolumeId] = React.useState("");
  const [result, setResult] = React.useState<SimulationResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const n = Number(gb);
    if (!(n > 0)) { setError("Enter a size above 0 GB."); return; }
    setBusy(true);
    try { setResult(await post<SimulationResult>("/api/storage/simulate", { bytes: Math.round(n * 1024 ** 3), priority, volumeId: volumeId || undefined })); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return (
    <Card>
      <CardHeader><CardTitle>Simulate a download</CardTitle><CardDescription>See what would be removed to fit a download of a given size. Nothing is changed.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={run} noValidate className="grid items-start gap-3 sm:grid-cols-4">
          <Field id="sim-gb" label="Size (GB)">{(p) => <Input {...p} type="number" min={0} step="any" value={gb} onChange={(e) => setGb(e.target.value)} />}</Field>
          <Field id="sim-pr" label="Priority" hint={priorityDescription(priority)}>{(p) => <Select {...p} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>{PRIORITIES.map((x) => <option key={x} value={x}>{priorityLabel(x)}</option>)}</Select>}</Field>
          <Field id="sim-vol" label="Volume">{(p) => <Select {...p} value={volumeId} onChange={(e) => setVolumeId(e.target.value)}><option value="">Default volume</option>{volumes.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select>}</Field>
          <Button type="submit" disabled={busy} className="sm:mt-[1.375rem]">{busy ? "Simulating…" : "Run simulation"}</Button>
        </form>
        <FormError message={error} />
        {result ? <SimulationView result={result} /> : null}
      </CardContent>
    </Card>
  );
}

function Evictions() {
  const result = useApi<{ items: EvictionRecord[] }>("/api/storage/evictions");
  const { run, busy } = useAction();
  return (
    <Card>
      <CardHeader><CardTitle>Eviction history</CardTitle><CardDescription>Files removed to make room. Restore queues the download again.</CardDescription></CardHeader>
      <CardContent>
        <Query result={result}>
          {({ items }) => items.length === 0 ? <EmptyState title="Nothing has been evicted" /> : (
            <Table aria-label="Eviction history">
              <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Title</TableHead><TableHead>Reason</TableHead><TableHead>Was</TableHead><TableHead>Reclaimed</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {items.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap">{formatDate(e.createdAt)}</TableCell>
                    <TableCell className="max-w-64 truncate">{e.media.title}</TableCell>
                    <TableCell>{e.reason.replaceAll("_", " ")}</TableCell>
                    <TableCell>{e.previousPriority ? <PriorityBadge priority={e.previousPriority} /> : "–"}</TableCell>
                    <TableCell className="tabular-nums">{formatBytes(e.reclaimedBytes)}</TableCell>
                    <TableCell><StatusBadge status={e.status} /></TableCell>
                    <TableCell>{e.restorable ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(e.id, async () => { await post(`/api/storage/evictions/${e.id}/restore`); await result.mutate(); }, { success: "Download queued" })}>Restore<span className="sr-only"> {e.media.title}</span></Button> : <span className="text-xs text-muted-foreground">Not restorable</span>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Query>
      </CardContent>
    </Card>
  );
}

/** Expandable list of reconcile findings. Renders nothing when empty. */
function ResultList({ title, items, open }: { title: string; items: string[]; open?: boolean }) {
  if (items.length === 0) return null;
  return (
    <details open={open} className="rounded-lg border p-3 text-sm">
      <summary className="cursor-pointer font-medium">{title} ({items.length})</summary>
      <ul className="mt-2 list-disc space-y-1 break-all pl-5">{items.map((i, k) => <li key={k}>{i}</li>)}</ul>
    </details>
  );
}

function Reconcile() {
  const [dry, setDry] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ReconcileResult | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);

  async function start() {
    setBusy(true); setError(null); setResult(null); setStatus("Queued");
    try {
      const { jobId } = await post<{ jobId: string }>("/api/storage/reconcile", { dryRun: dry });
      let job: ReconcileJob | null = null;
      for (let i = 0; i < 90; i++) {
        setStatus(i === 0 ? "Queued" : "Running…");
        await new Promise((res) => setTimeout(res, 2000));
        job = await get<ReconcileJob>(`/api/storage/reconcile/${jobId}`);
        if (job.state === "failed") throw new Error(job.error || "The reconcile job failed. Check the worker logs in System health.");
        if (job.state === "completed" && job.result) break;
      }
      if (!job?.result) throw new Error("The worker didn't finish in time. Check that it's running on System health, then try again.");
      setResult(job.result);
      setStatus(null);
    } catch (e) { setError(errorMessage(e)); setStatus(null); } finally { setBusy(false); }
  }
  return (
    <Card>
      <CardHeader><CardTitle>Reconcile with disk</CardTitle><CardDescription>Compares the files on each volume with the catalogue. Use it after moving or restoring a drive. A dry run changes nothing.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <ToggleRow id="dry" label="Dry run" description="Report what would change without changing it.">{(p) => <Switch {...p} checked={dry} onCheckedChange={setDry} />}</ToggleRow>
        <Button onClick={() => void start()} disabled={busy}>{busy ? "Reconciling…" : dry ? "Run dry reconcile" : "Reconcile now"}</Button>
        <div aria-live="polite">
          <FormError message={error} />
          {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
          {result ? (
            <div className="space-y-2">
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {([["Files found", result.found], ["Rebuilt", result.rebuilt], ["Missing files", result.missingFiles.length], ["Orphans", result.orphans.length], ["Duplicates", result.duplicates.length]] as const).map(([l, v]) => (
                  <div key={l} className="rounded-lg border p-3"><dt className="text-xs text-muted-foreground">{l}</dt><dd className="text-xl font-semibold tabular-nums">{v}</dd></div>
                ))}
              </dl>
              <ResultList title="Missing files" items={result.missingFiles.map((m) => `${m.relativePath} (${m.canonicalKey})`)} />
              <ResultList title="Orphans" items={result.orphans.map((o) => o.relDir)} />
              <ResultList title="Duplicates" items={result.duplicates.map((x) => `${x.canonicalKey}: ${x.relDirs.join(", ")}`)} />
              {result.issues.length ? <ResultList title="Issues" items={result.issues} open /> : <p className="text-sm text-muted-foreground">No issues reported.</p>}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default function StoragePage() {
  const result = useApi<StorageOverview>("/api/storage", { refreshInterval: 10000 });
  const [adding, setAdding] = React.useState(false);
  return (
    <>
      <PageHeader title="Storage" description="Volumes, what uses the space, and what would be removed when it runs short."
        actions={<Button onClick={() => setAdding(true)}><Plus aria-hidden="true" /> Add volume</Button>} />
      <Query result={result}>
        {(s) => {
          const total = s.volumes.reduce((a, v) => a + v.totalBytes, 0);
          const used = s.volumes.reduce((a, v) => a + v.usedBytes, 0);
          return (
            <div className="space-y-6">
              {s.volumes.length === 0 ? <EmptyState icon={HardDrive} title="No volumes" description="Add a volume to store media." /> : (
                <div className="grid gap-4 lg:grid-cols-2">{s.volumes.map((v) => <VolumeCard key={v.id} v={v} onChange={() => void result.mutate()} />)}</div>
              )}
              <Card>
                <CardHeader><CardTitle>Usage by priority</CardTitle><CardDescription>Soft limit {s.thresholds.soft}%: above it, Spare media is cleaned up. Minimum free {s.thresholds.minFree}%: new downloads stop below it. Change these in <Link className="underline" href="/admin/settings/storage">Settings, Storage</Link>.</CardDescription></CardHeader>
                <CardContent><StorageBar totalBytes={total} usedBytes={used} byPriority={s.byPriority} /></CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Reservations</CardTitle><CardDescription>Space held for downloads in progress.</CardDescription></CardHeader>
                <CardContent>
                  {s.reservations.length === 0 ? <p className="text-sm text-muted-foreground">No space is reserved.</p> : (
                    <Table aria-label="Reservations">
                      <TableHeader><TableRow><TableHead>Download</TableHead><TableHead>Reserved</TableHead><TableHead>Written</TableHead></TableRow></TableHeader>
                      <TableBody>{s.reservations.map((r) => <TableRow key={r.downloadId}><TableCell className="max-w-96 truncate">{r.title}</TableCell><TableCell className="tabular-nums">{formatBytes(r.bytes)}</TableCell><TableCell className="tabular-nums">{formatBytes(r.writtenBytes)}</TableCell></TableRow>)}</TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
              <SimulationTool volumes={s.volumes} />
              <Evictions />
              <Reconcile />
            </div>
          );
        }}
      </Query>
      <AddVolumeDialog open={adding} onOpenChange={setAdding} onAdded={() => void result.mutate()} />
    </>
  );
}
