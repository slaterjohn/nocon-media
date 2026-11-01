"use client";

import * as React from "react";
import { del, post } from "@/lib/api";
import type { Retention, Schedule, Source } from "@/lib/types";
import { priorityLabel } from "@/lib/priority";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { SourceForm } from "./source-form";

export function describeRetention(r: Retention): string {
  switch (r.mode) {
    case "all": return "Keep all";
    case "none": return "Keep none";
    case "latest_n": return `Latest ${r.count ?? "?"}`;
    case "rolling": return `Rolling ${r.count ?? "?"}`;
    case "last_days": return `Last ${r.days ?? "?"} days`;
    case "quota": return `Quota ${r.quotaBytes ? Math.round(r.quotaBytes / 1024 ** 3) : "?"} GB`;
    case "prefer_unwatched": return "Prefer unwatched";
    default: return r.mode;
  }
}

export function describeSchedule(s: Schedule): string {
  if (s.kind === "cron") return `Cron ${s.cron ?? ""}`;
  return s.kind === "manual" ? "Manual" : s.kind.charAt(0).toUpperCase() + s.kind.slice(1);
}

export function SourceEditDialog({
  source, open, onOpenChange, onSaved,
}: { source?: Source; open: boolean; onOpenChange: (o: boolean) => void; onSaved: (s: Source) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{source ? `Edit ${source.name}` : "Add a source"}</DialogTitle>
          <DialogDescription>{source ? "Changes apply from the next run. Priority and retention changes take effect straight away." : "A source is a channel, playlist, video or search that NoConMedia keeps up to date."}</DialogDescription>
        </DialogHeader>
        {open ? <SourceForm source={source} onSaved={(s) => { onSaved(s); onOpenChange(false); }} onCancel={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

export function DeleteSourceDialog({
  source, open, onOpenChange, onDeleted,
}: { source: Source; open: boolean; onOpenChange: (o: boolean) => void; onDeleted: (r: { retainedMedia: number; deletedMedia: number }) => void }) {
  const [mode, setMode] = React.useState<"keep" | "delete" | "">("");
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => { if (open) { setMode(""); setErr(null); } }, [open]);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      destructive
      title={`Delete ${source.name}?`}
      confirmLabel="Delete source"
      description="Choose what happens to the videos this source downloaded. The source itself is removed either way."
      onConfirm={async () => {
        if (!mode) { setErr("Choose what to do with the media first."); throw new Error("Choose what to do with the media first."); }
        const r = await del<{ ok: boolean; retainedMedia: number; deletedMedia: number }>(`/api/sources/${source.id}?media=${mode}`);
        onDeleted(r);
      }}
    >
      <fieldset className="space-y-2">
        <legend className="sr-only">Downloaded media</legend>
        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary">
          <input type="radio" name="del-mode" checked={mode === "keep"} onChange={() => setMode("keep")} className="mt-1 size-4 accent-[var(--primary)]" />
          <span><span className="block text-sm font-medium">Keep the media</span><span className="block text-xs text-muted-foreground">Videos stay on disk at this source's priority ({priorityLabel(source.priority)}) and are protected from automatic removal.</span></span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-destructive">
          <input type="radio" name="del-mode" checked={mode === "delete"} onChange={() => setMode("delete")} className="mt-1 size-4 accent-[var(--destructive)]" />
          <span><span className="block text-sm font-medium">Delete media only this source owns</span><span className="block text-xs text-muted-foreground">Files are removed. Videos that also belong to another source, are pinned or have a manual priority stay. Titles and details are kept.</span></span>
        </label>
        {err && !mode ? <p role="alert" className="text-xs font-medium text-destructive">{err}</p> : null}
      </fieldset>
    </ConfirmDialog>
  );
}

export function useSourceActions(onChange: () => void | Promise<void>, run: <T>(key: string, fn: () => Promise<T>, o?: { success?: string; failure?: string }) => Promise<T | undefined>) {
  return {
    pause: (s: Source) => run(`pause-${s.id}`, async () => { await post(`/api/sources/${s.id}/pause`); await onChange(); }, { success: `Paused ${s.name}` }),
    resume: (s: Source) => run(`resume-${s.id}`, async () => { await post(`/api/sources/${s.id}/resume`); await onChange(); }, { success: `Resumed ${s.name}` }),
    sync: (s: Source) => run(`sync-${s.id}`, async () => { await post(`/api/sources/${s.id}/sync`); await onChange(); }, { success: `Sync started for ${s.name}` }),
    duplicate: (s: Source) => run(`dup-${s.id}`, async () => { await post(`/api/sources/${s.id}/duplicate`); await onChange(); }, { success: `Duplicated ${s.name}` }),
  };
}

export function SourceRowActions({
  source, busy, actions, onEdit, onDelete,
}: {
  source: Source;
  busy: string | null;
  actions: ReturnType<typeof useSourceActions>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const paused = source.status === "paused";
  return (
    <div className="flex flex-wrap gap-1">
      <Button size="sm" variant="outline" onClick={onEdit}>Edit<span className="sr-only"> {source.name}</span></Button>
      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void (paused ? actions.resume(source) : actions.pause(source))}>
        {paused ? "Resume" : "Pause"}<span className="sr-only"> {source.name}</span>
      </Button>
      <Button size="sm" variant="outline" disabled={busy !== null || paused} onClick={() => void actions.sync(source)}>Sync now<span className="sr-only"> {source.name}</span></Button>
      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void actions.duplicate(source)}>Duplicate<span className="sr-only"> {source.name}</span></Button>
      {!source.system ? <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete}>Delete<span className="sr-only"> {source.name}</span></Button> : null}
    </div>
  );
}
