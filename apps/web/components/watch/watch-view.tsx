"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Download, Hourglass, HardDriveDownload, Unplug } from "lucide-react";
import { useApi } from "@/lib/api";
import type { MediaDetail, MediaResponse, MediaSummary } from "@/lib/types";
import { useAutoplayPref } from "@/lib/viewer";
import { formatDuration } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/layout";
import { VideoPlayer, type PlayerControl } from "@/components/player/video-player";
import { MediaCard, Thumb, publishedDate } from "@/components/media/media-card";
import { DownloadButton, MediaActions } from "./media-actions";

function WatchSkeleton() {
  return (
    <div role="status" aria-busy="true" className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <span className="sr-only">Loading video…</span>
      <div className="space-y-3" aria-hidden="true">
        <Skeleton className="aspect-video w-full" />
        <Skeleton className="h-7 w-3/4" />
        <Skeleton className="h-4 w-1/3" />
      </div>
    </div>
  );
}

/** Explains why a video can't play and offers the right next step. */
function Unplayable({ media, onChanged }: { media: MediaDetail; onChanged: () => void }) {
  let Icon = Download;
  let title = "This video isn't downloaded";
  let body = "It's in the catalogue but there's no file on this server. Download it to watch offline.";
  let action = true;
  if (media.temporarilyUnavailable) {
    Icon = Unplug;
    title = "Drive disconnected";
    body = "The drive that holds this video isn't connected. Reconnect it and the video will play again.";
    action = false;
  } else if (media.availability === "evicted") {
    Icon = HardDriveDownload;
    title = "Removed to free space";
    body = "This video's file was deleted to make room. The entry stays, and you can download it again.";
  } else if (media.availability === "downloading") {
    Icon = Hourglass;
    title = "Downloading";
    body = "This video is downloading now. This page updates when it's ready to play.";
    action = false;
  } else if (media.availability === "queued") {
    Icon = Hourglass;
    title = "Queued for download";
    body = "This video is waiting its turn. This page updates when it's ready to play.";
    action = false;
  } else if (media.availability === "failed") {
    title = "The download failed";
    body = "The last attempt didn't finish. Try again, or check Downloads under Manage for the error.";
  }
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border bg-muted">
      {media.thumbnailUrl ? <Thumb src={media.thumbnailUrl} className="absolute inset-0 size-full opacity-20 grayscale" /> : null}
      <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon className="size-8 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{body}</p>
        {action ? <DownloadButton media={media} onDone={onChanged} variant="default" size="default" /> : null}
      </div>
    </div>
  );
}

function Description({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false);
  const long = text.length > 280 || text.split("\n").length > 4;
  return (
    <div className="rounded-lg bg-muted/50 p-3 text-sm">
      <p className={open || !long ? "whitespace-pre-wrap break-words" : "line-clamp-3 whitespace-pre-wrap break-words"}>{text}</p>
      {long ? (
        <button type="button" className="mt-1 font-medium underline underline-offset-4" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function useListItems(listId: string | null): MediaSummary[] | null {
  const pl = useApi<{ items: MediaSummary[] }>(listId ? `/api/library/playlists/${encodeURIComponent(listId)}` : null);
  const col = useApi<{ items?: MediaSummary[]; collection?: { items?: MediaSummary[] } }>(
    listId && pl.error ? `/api/collections/${encodeURIComponent(listId)}` : null,
  );
  if (!listId) return null;
  if (pl.data) return pl.data.items;
  return col.data?.collection?.items ?? col.data?.items ?? null;
}

export function WatchView({ id }: { id: string }) {
  const listId = useSearchParams().get("list");
  const result = useApi<MediaResponse>(`/api/media/${id}`);
  const listItems = useListItems(listId);
  const [autoplay, setAutoplay] = useAutoplayPref();
  const controlRef = React.useRef<PlayerControl | null>(null);

  const data = result.data;
  const title = data?.media.title;
  React.useEffect(() => {
    if (title) document.title = `${title} | NoConMedia`;
  }, [title]);

  // Poll while a download is in flight so the page switches to the player when it finishes.
  const waiting = !!data && !data.media.playable && (data.media.availability === "queued" || data.media.availability === "downloading");
  const { mutate } = result;
  React.useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void mutate(), 5000);
    return () => clearInterval(t);
  }, [waiting, mutate]);

  const listIndex = listItems ? listItems.findIndex((m) => m.id === id) : -1;
  const nextItem: MediaSummary | null = React.useMemo(() => {
    if (listItems && listIndex >= 0) return listItems.slice(listIndex + 1).find((m) => m.playable) ?? null;
    return data?.next ?? null;
  }, [listItems, listIndex, data?.next]);
  const nextHref = nextItem ? `/watch/${nextItem.id}${listId ? `?list=${encodeURIComponent(listId)}` : ""}` : null;
  const playerNext = React.useMemo(
    () => (nextItem && nextItem.playable && nextHref ? { href: nextHref, title: nextItem.title } : null),
    [nextItem, nextHref],
  );

  if (!data) {
    if (result.error) return <ErrorState title="Couldn't load this video" message={result.error.message} onRetry={() => void result.mutate()} />;
    return <WatchSkeleton />;
  }
  const { media, related } = data;
  const date = publishedDate(media.publishedAt);
  const upcoming = listItems && listIndex >= 0 ? listItems.slice(listIndex + 1, listIndex + 9) : nextItem ? [nextItem] : [];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-4">
        <div id="player-wrap">
          {media.playable && (media.streamUrl || media.hlsUrl) ? (
            <VideoPlayer key={media.id} media={media} next={playerNext} autoplayNext={autoplay} controlRef={controlRef} />
          ) : (
            <Unplayable media={media} onChanged={() => void result.mutate()} />
          )}
        </div>

        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{media.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {media.creatorId && media.channelName ? (
              <Link href={`/channels/${media.creatorId}`} className="font-medium text-foreground underline-offset-4 hover:underline">{media.channelName}</Link>
            ) : (
              media.channelName ?? "Unknown channel"
            )}
            {date ? <> · Published {date}</> : null}
            {media.durationSeconds ? <> · {formatDuration(media.durationSeconds)}</> : null}
          </p>
        </div>

        <MediaActions media={media} onChanged={() => void result.mutate()} />

        {media.description ? <Description text={media.description} /> : null}

        {media.tags.length ? (
          <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
            {media.tags.map((t) => (
              <li key={t}>
                <Link href={`/search?q=${encodeURIComponent(t)}`}><Badge variant="outline" className="hover:bg-accent">{t}</Badge></Link>
              </li>
            ))}
          </ul>
        ) : null}

        {media.chapters.length ? (
          <section aria-labelledby="chapters-h">
            <h2 id="chapters-h" className="mb-2 text-base font-semibold">Chapters</h2>
            <ol className="divide-y rounded-lg border">
              {media.chapters.map((c) => (
                <li key={c.startSeconds}>
                  <button
                    type="button"
                    disabled={!media.playable}
                    className="flex w-full items-baseline gap-3 px-3 py-2 text-left text-sm hover:bg-accent disabled:cursor-default disabled:opacity-70 disabled:hover:bg-transparent"
                    onClick={() => {
                      controlRef.current?.seek(c.startSeconds);
                      document.getElementById("player-wrap")?.scrollIntoView({ block: "nearest" });
                    }}
                  >
                    <span className="w-14 shrink-0 tabular-nums text-muted-foreground">{formatDuration(c.startSeconds)}</span>
                    <span className="min-w-0">{c.title}<span className="sr-only">, jump to {formatDuration(c.startSeconds)}</span></span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>

      <aside className="min-w-0 space-y-6" aria-label="More videos">
        <section aria-labelledby="upnext-h">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 id="upnext-h" className="text-base font-semibold">{listId ? "Up next in playlist" : "Up next"}</h2>
            <div className="flex items-center gap-2">
              <Switch id="autoplay" checked={autoplay} onCheckedChange={setAutoplay} />
              <Label htmlFor="autoplay" className="text-sm">Autoplay</Label>
            </div>
          </div>
          {upcoming.length ? (
            <ul className="space-y-4">
              {upcoming.map((m) => (
                <li key={m.id}><MediaCard media={m} listId={listId ?? undefined} /></li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{listId ? "That's the end of the playlist." : "Nothing queued after this video."}</p>
          )}
        </section>
        {related.length ? (
          <section aria-labelledby="related-h">
            <h2 id="related-h" className="mb-2 text-base font-semibold">Related</h2>
            <ul className="space-y-4">
              {related.map((m) => (
                <li key={m.id}><MediaCard media={m} /></li>
              ))}
            </ul>
          </section>
        ) : null}
      </aside>
    </div>
  );
}
