"use client";

import * as React from "react";
import { Tv } from "lucide-react";
import { useApi } from "@/lib/api";
import type { Creator, MediaSummary } from "@/lib/types";
import { EmptyState, PageHeader } from "@/components/layout";
import { Query } from "@/components/common/data";
import { Avatar, CreatorCard, MediaItemsGrid } from "@/components/media/media-card";
import { GridSkeleton } from "@/components/media/media-list";

export function ChannelsView() {
  const result = useApi<{ items: Creator[] }>("/api/library/creators");
  return (
    <>
      <PageHeader title="Channels" description="Creators whose videos are in your library." />
      <Query result={result}>
        {({ items }) =>
          items.length === 0 ? (
            <EmptyState icon={Tv} title="No channels yet" description="Channels appear here once their videos are catalogued." />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((c) => (
                <li key={c.id}>
                  <CreatorCard creator={c} />
                </li>
              ))}
            </ul>
          )
        }
      </Query>
    </>
  );
}

export function ChannelView({ id }: { id: string }) {
  const result = useApi<{ creator: Creator; media: MediaSummary[] }>(`/api/library/creators/${id}`);
  return (
    <Query result={result} skeleton={<GridSkeleton />}>
      {({ creator, media }) => (
        <>
          <div className="mb-6 overflow-hidden rounded-lg border">
            {creator.bannerUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={creator.bannerUrl} alt="" className="h-28 w-full object-cover sm:h-44" loading="lazy" />
            ) : (
              <div className="h-16 w-full bg-muted sm:h-24" aria-hidden="true" />
            )}
            <div className="flex items-start gap-4 p-4">
              <Avatar name={creator.name} src={creator.avatarUrl} className="-mt-10 size-20 shrink-0 border-4 border-background bg-muted sm:-mt-12 sm:size-24" />
              <div className="min-w-0">
                <h1 className="text-2xl font-semibold tracking-tight">{creator.name}</h1>
                <p className="text-sm text-muted-foreground">
                  {creator.mediaCount} {creator.mediaCount === 1 ? "video" : "videos"}, {creator.playableCount} downloaded
                </p>
                {creator.description ? <ChannelDescription text={creator.description} /> : null}
              </div>
            </div>
          </div>
          <h2 className="sr-only">Videos</h2>
          {media.length === 0 ? (
            <EmptyState title="No videos from this channel yet" />
          ) : (
            <MediaItemsGrid items={media} label={`Videos from ${creator.name}`} />
          )}
        </>
      )}
    </Query>
  );
}

function ChannelDescription({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false);
  const long = text.length > 220;
  return (
    <div className="mt-2 max-w-3xl text-sm">
      <p className={open || !long ? "whitespace-pre-wrap" : "line-clamp-2 whitespace-pre-wrap"}>{text}</p>
      {long ? (
        <button type="button" className="mt-1 text-sm underline underline-offset-4" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
