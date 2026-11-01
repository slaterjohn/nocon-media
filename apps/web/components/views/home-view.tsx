"use client";

import Link from "next/link";
import { Clapperboard } from "lucide-react";
import { useApi } from "@/lib/api";
import type { HomeData } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/layout";
import { Query } from "@/components/common/data";
import { CreatorCard, MediaCard, PlaylistCard, Row } from "@/components/media/media-card";
import { GridSkeleton } from "@/components/media/media-list";

export function HomeView() {
  const result = useApi<HomeData>("/api/library/home", { refreshInterval: 30000 });
  return (
    <>
      <PageHeader title="Home" />
      <Query result={result} skeleton={<GridSkeleton count={4} />}>
        {(d) => {
          const empty =
            !d.continueWatching?.length && !d.recentlyDownloaded?.length && !d.newFromSubscriptions?.length &&
            !d.recommended?.length && !d.favouriteChannels?.length && !d.playlists?.length;
          if (empty) {
            return (
              <EmptyState
                icon={Clapperboard}
                title="Your library is empty"
                description="Add a channel, playlist or search as a source. Videos appear here once they've downloaded."
                action={<Button asChild><Link href="/admin/sources">Go to Sources</Link></Button>}
              />
            );
          }
          return (
            <>
              {d.continueWatching?.length ? (
                <Row title="Continue watching" seeAllHref="/continue">
                  {d.continueWatching.map((m) => <MediaCard key={m.id} media={m} />)}
                </Row>
              ) : null}
              {d.recentlyDownloaded?.length ? (
                <Row title="Recently downloaded" seeAllHref="/recent">
                  {d.recentlyDownloaded.map((m) => <MediaCard key={m.id} media={m} />)}
                </Row>
              ) : null}
              {d.newFromSubscriptions?.length ? (
                <Row title="New from subscriptions" seeAllHref="/library?sort=published">
                  {d.newFromSubscriptions.map((m) => <MediaCard key={m.id} media={m} />)}
                </Row>
              ) : null}
              {d.recommended?.length ? (
                <Row title="Recommended">
                  {d.recommended.map((m) => <MediaCard key={m.id} media={m} />)}
                </Row>
              ) : null}
              {d.favouriteChannels?.length ? (
                <Row title="Favourite channels" seeAllHref="/channels">
                  {d.favouriteChannels.map((c) => <CreatorCard key={c.id} creator={c} />)}
                </Row>
              ) : null}
              {d.playlists?.length ? (
                <Row title="Playlists" seeAllHref="/playlists">
                  {d.playlists.map((p) => <PlaylistCard key={p.id} playlist={p} href={`/playlists/${p.id}`} />)}
                </Row>
              ) : null}
            </>
          );
        }}
      </Query>
    </>
  );
}
