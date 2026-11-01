import * as React from "react";
import Link from "next/link";
import { Clapperboard, ListVideo, User } from "lucide-react";
import type { Collection, Creator, MediaSummary, PlaylistRef } from "@/lib/types";
import { cn, formatDuration } from "@/lib/utils";
import { collectionCount, unavailableLabel } from "@/lib/viewer";

const dateFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
export function publishedDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : dateFmt.format(d);
}

export function Thumb({ src, className, alt = "" }: { src: string | null | undefined; className?: string; alt?: string }) {
  if (!src) {
    return (
      <div className={cn("flex items-center justify-center bg-muted text-muted-foreground", className)} aria-hidden="true">
        <Clapperboard className="size-8" />
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" decoding="async" className={cn("object-cover", className)} />;
}

export function MediaCard({
  media,
  listId,
  footer,
  className,
}: {
  media: MediaSummary;
  /** Adds ?list= so the watch page continues through this playlist. */
  listId?: string;
  footer?: React.ReactNode;
  className?: string;
}) {
  const label = unavailableLabel(media);
  const p = media.progress;
  const pctWatched =
    p && !p.completed && p.durationSeconds > 0 ? Math.min(100, Math.round((p.positionSeconds / p.durationSeconds) * 100)) : 0;
  const date = publishedDate(media.publishedAt);
  const href = `/watch/${media.id}${listId ? `?list=${encodeURIComponent(listId)}` : ""}`;
  return (
    <article className={cn("group relative flex min-w-0 flex-col gap-2", className)}>
      <div className="relative aspect-video overflow-hidden rounded-lg border bg-muted">
        <Thumb src={media.thumbnailUrl} className={cn("size-full", label && "opacity-40 grayscale")} />
        {label ? (
          <span className="absolute top-2 left-2 rounded-md border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground">
            {label}
          </span>
        ) : null}
        {media.durationSeconds ? (
          <span className="absolute right-2 bottom-2 rounded bg-black/80 px-1.5 py-0.5 text-xs font-medium tabular-nums text-white">
            <span className="sr-only">Length </span>
            {formatDuration(media.durationSeconds)}
          </span>
        ) : null}
        {pctWatched > 0 ? (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50" aria-hidden="true">
            <div className="h-full bg-primary" style={{ width: `${pctWatched}%` }} />
          </div>
        ) : null}
      </div>
      <div className="min-w-0">
        <h3 className={cn("line-clamp-2 text-sm leading-snug font-medium", label && "text-muted-foreground")}>
          <Link
            href={href}
            className="rounded-sm outline-offset-2 after:absolute after:inset-0 after:content-[''] group-hover:underline"
          >
            {media.title}
          </Link>
        </h3>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {[media.channelName, date].filter(Boolean).join(" · ") || "Unknown channel"}
        </p>
        {label ? <p className="sr-only">{label}</p> : null}
        {pctWatched > 0 ? <p className="sr-only">{pctWatched}% watched</p> : null}
        {p?.completed ? <p className="text-xs text-muted-foreground">Watched</p> : null}
      </div>
      {footer ? <div className="relative z-10">{footer}</div> : null}
    </article>
  );
}

export function MediaGrid({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <ul aria-label={label} className="grid gap-x-4 gap-y-6 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
      {React.Children.map(children, (c, i) => (
        <li key={i} className="min-w-0">
          {c}
        </li>
      ))}
    </ul>
  );
}

export function MediaItemsGrid({ items, listId, label }: { items: MediaSummary[]; listId?: string; label?: string }) {
  return (
    <MediaGrid label={label}>
      {items.map((m) => (
        <MediaCard key={m.id} media={m} listId={listId} />
      ))}
    </MediaGrid>
  );
}

/** Horizontal scrolling row with a heading and optional "See all" link. */
export function Row({
  title,
  seeAllHref,
  children,
}: {
  title: string;
  seeAllHref?: string;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <section aria-labelledby={id} className="mb-8">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {seeAllHref ? (
          <Link href={seeAllHref} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            See all<span className="sr-only"> {title.toLowerCase()}</span>
          </Link>
        ) : null}
      </div>
      <ul className="-mx-1 flex snap-x gap-4 overflow-x-auto px-1 pb-3">
        {React.Children.map(children, (c, i) => (
          <li key={i} className="w-60 shrink-0 snap-start sm:w-64">
            {c}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Avatar({ name, src, className }: { name: string; src: string | null | undefined; className?: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" loading="lazy" className={cn("rounded-full object-cover", className)} />;
  }
  return (
    <span aria-hidden="true" className={cn("flex items-center justify-center rounded-full bg-muted text-lg font-semibold text-muted-foreground", className)}>
      {name.trim().charAt(0).toUpperCase() || <User className="size-5" />}
    </span>
  );
}

export function CreatorCard({ creator }: { creator: Creator }) {
  return (
    <article className="group relative flex items-center gap-3 rounded-lg border p-3 hover:bg-accent/50">
      <Avatar name={creator.name} src={creator.avatarUrl} className="size-14 shrink-0" />
      <div className="min-w-0">
        <h3 className="truncate text-sm font-medium">
          <Link href={`/channels/${creator.id}`} className="after:absolute after:inset-0 after:content-[''] group-hover:underline">
            {creator.name}
          </Link>
        </h3>
        <p className="text-xs text-muted-foreground">
          {creator.mediaCount} {creator.mediaCount === 1 ? "video" : "videos"}, {creator.playableCount} downloaded
        </p>
      </div>
    </article>
  );
}

export function PlaylistCard({ playlist, href }: { playlist: PlaylistRef | Collection; href: string }) {
  const count = collectionCount(playlist as Collection);
  const thumb = playlist.thumbnailUrl ?? null;
  return (
    <article className="group relative flex min-w-0 flex-col gap-2">
      <div className="relative aspect-video overflow-hidden rounded-lg border bg-muted">
        {thumb ? (
          <Thumb src={thumb} className="size-full" />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground" aria-hidden="true">
            <ListVideo className="size-8" />
          </div>
        )}
        <span className="absolute right-2 bottom-2 rounded bg-black/80 px-1.5 py-0.5 text-xs font-medium text-white tabular-nums">
          {count} {count === 1 ? "video" : "videos"}
        </span>
      </div>
      <h3 className="line-clamp-2 text-sm leading-snug font-medium">
        <Link href={href} className="after:absolute after:inset-0 after:content-[''] group-hover:underline">
          {playlist.name}
        </Link>
      </h3>
    </article>
  );
}
