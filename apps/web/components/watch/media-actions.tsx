"use client";

import * as React from "react";
import { Download, ExternalLink, Heart, Pin, Trash2 } from "lucide-react";
import { del, patch, post } from "@/lib/api";
import type { MediaDetail, Priority } from "@/lib/types";
import { PRIORITIES, priorityDescription, priorityLabel } from "@/lib/priority";
import { formatBytes } from "@/lib/utils";
import { useAction } from "@/hooks/use-action";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { PriorityBadge } from "@/components/common/badges";
import { AddToCollection } from "./add-to-collection";
import { MetadataDialog } from "./metadata-dialog";

export function DownloadButton({ media, onDone, variant = "outline", size = "sm" }: { media: MediaDetail; onDone: () => void; variant?: "outline" | "default"; size?: "sm" | "default" }) {
  const { run, busy } = useAction();
  const again = media.availability === "available" || media.availability === "evicted";
  return (
    <Button variant={variant} size={size} disabled={busy !== null} onClick={() => void run("dl", async () => { await post(`/api/media/${media.id}/download`); onDone(); }, { success: "Download queued" })}>
      <Download aria-hidden="true" /> {again ? "Re-download" : "Download"}
    </Button>
  );
}

export function MediaActions({ media, onChanged }: { media: MediaDetail; onChanged: () => void }) {
  const { run, busy } = useAction();
  const [deleting, setDeleting] = React.useState(false);
  const edit = (body: Record<string, unknown>, success: string) =>
    run("edit", async () => { await patch(`/api/media/${media.id}`, body); onChanged(); }, { success });
  const hasFile = media.availability === "available";

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Video actions">
      <Button variant="outline" size="sm" aria-pressed={media.favourite} disabled={busy !== null} onClick={() => void edit({ favourite: !media.favourite }, media.favourite ? "Removed from favourites" : "Added to favourites")}>
        <Heart className={media.favourite ? "fill-current" : ""} aria-hidden="true" /> {media.favourite ? "Favourited" : "Favourite"}
      </Button>
      <Button
        variant="outline"
        size="sm"
        aria-pressed={media.pinned}
        title="Protected videos are never removed automatically."
        disabled={busy !== null}
        onClick={() => void edit({ pinned: !media.pinned }, media.pinned ? "Unpinned" : "Pinned. This video won't be removed automatically")}
      >
        <Pin className={media.pinned ? "fill-current" : ""} aria-hidden="true" /> {media.pinned ? "Protected" : "Protect"}
      </Button>

      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">Priority <PriorityBadge priority={media.effectivePriority} /></Button>
        </PopoverTrigger>
        <PopoverContent align="start" aria-label="Change priority">
          <Label htmlFor="prio" className="mb-1.5 block text-sm font-semibold">Priority</Label>
          <Select
            id="prio"
            value={media.manualPriority ?? "auto"}
            disabled={busy !== null}
            aria-describedby="prio-help"
            onChange={(e) => {
              const v = e.target.value;
              void edit({ manualPriority: v === "auto" ? null : (v as Priority) }, v === "auto" ? "Priority set to automatic" : `Priority set to ${priorityLabel(v as Priority)}`);
            }}
          >
            <option value="auto">Automatic (currently {priorityLabel(media.effectivePriority)})</option>
            {PRIORITIES.map((p) => <option key={p} value={p}>{priorityLabel(p)}</option>)}
          </Select>
          <p id="prio-help" className="mt-2 text-xs text-muted-foreground">
            Priority decides what is removed first when the drive fills up. {priorityDescription(media.manualPriority ?? media.effectivePriority)}.
          </p>
        </PopoverContent>
      </Popover>

      <AddToCollection mediaId={media.id} />
      <DownloadButton media={media} onDone={onChanged} />
      {hasFile ? (
        <Button variant="outline" size="sm" className="text-destructive" onClick={() => setDeleting(true)}>
          <Trash2 aria-hidden="true" /> Delete download
        </Button>
      ) : null}
      <MetadataDialog media={media} />
      {media.url ? (
        <Button asChild variant="outline" size="sm">
          <a href={media.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden="true" /> View original <span className="text-xs font-normal text-muted-foreground">(needs internet)</span>
            <span className="sr-only">, opens in a new tab</span>
          </a>
        </Button>
      ) : null}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        destructive
        title="Delete this download?"
        confirmLabel="Delete download"
        description={<>Remove the downloaded file? The catalogue entry stays. This frees {formatBytes(media.sizeBytes)}, and you can download it again later.</>}
        onConfirm={async () => { await del(`/api/media/${media.id}`); onChanged(); }}
      />
    </div>
  );
}
