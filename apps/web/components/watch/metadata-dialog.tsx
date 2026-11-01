"use client";

import * as React from "react";
import { Info } from "lucide-react";
import type { MediaDetail } from "@/lib/types";
import { priorityLabel } from "@/lib/priority";
import { formatBytes, formatDate, formatDuration } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function MetadataDialog({ media }: { media: MediaDetail }) {
  const rows: [string, React.ReactNode][] = [
    ["Platform", media.platform ?? "–"],
    ["Platform ID", media.externalId ?? "–"],
    ["Length", formatDuration(media.durationSeconds)],
    ["Published", formatDate(media.publishedAt)],
    ["Downloaded", formatDate(media.downloadedAt)],
    ["Language", media.language ?? "–"],
    ["Size on disk", formatBytes(media.sizeBytes)],
    ["Availability", media.availability + (media.temporarilyUnavailable ? " (drive disconnected)" : "")],
    ["Priority", `${priorityLabel(media.effectivePriority)}${media.manualPriority ? " (set by you)" : " (automatic)"}`],
    ["Categories", media.categories.join(", ") || "–"],
    ["Sources", media.sources.map((s) => `${s.name} (${priorityLabel(s.priority)})`).join(", ") || "–"],
    ["Direct play", media.directPlay ? "Yes" : "No, uses HLS"],
  ];
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm"><Info aria-hidden="true" /> View metadata</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Metadata</DialogTitle>
          <DialogDescription>{media.title}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {rows.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </React.Fragment>
          ))}
        </dl>
        <div>
          <h3 className="mb-1 text-sm font-medium">Files</h3>
          {media.files.length === 0 ? (
            <p className="text-sm text-muted-foreground">No files on disk.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table aria-label="Files">
                <TableHeader>
                  <TableRow><TableHead>Kind</TableHead><TableHead>Container</TableHead><TableHead>Video</TableHead><TableHead>Audio</TableHead><TableHead>Resolution</TableHead><TableHead>Size on disk</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {media.files.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell>{f.kind}{f.label ? ` (${f.label})` : ""}{f.language ? `, ${f.language}` : ""}</TableCell>
                      <TableCell>{f.container ?? f.mimeType ?? "–"}</TableCell>
                      <TableCell>{f.videoCodec ?? "–"}</TableCell>
                      <TableCell>{f.audioCodec ?? "–"}</TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">{f.width && f.height ? `${f.width}×${f.height}` : "–"}</TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">{formatBytes(f.sizeBytes)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
        {media.evictions.length ? (
          <div>
            <h3 className="mb-1 text-sm font-medium">Removal history</h3>
            <ul className="list-disc pl-5 text-sm">
              {media.evictions.map((e, i) => <li key={i}>{formatDate(e.at)}: {e.reason.replaceAll("_", " ")}, freed {formatBytes(e.reclaimedBytes)}</li>)}
            </ul>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
