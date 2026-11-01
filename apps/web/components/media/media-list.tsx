"use client";

import * as React from "react";
import { Clapperboard } from "lucide-react";
import type { MediaSummary } from "@/lib/types";
import { useLoadMore } from "@/lib/viewer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/layout/states";
import { MediaCard, MediaGrid } from "./media-card";

export function GridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading videos…</span>
      <div className="grid gap-x-4 gap-y-6 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]" aria-hidden="true">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="aspect-video w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Paged media grid backed by a list endpoint, with a "Load more" button. */
export function PagedMedia({
  path,
  emptyTitle,
  emptyDescription,
  emptyAction,
  renderFooter,
  listId,
  pageSize = 24,
  refreshKey,
}: {
  /** Endpoint plus filters, without limit and offset. */
  path: string;
  emptyTitle: string;
  emptyDescription?: React.ReactNode;
  emptyAction?: React.ReactNode;
  renderFooter?: (m: MediaSummary) => React.ReactNode;
  listId?: string;
  pageSize?: number;
  refreshKey?: number;
}) {
  const { items, total, hasMore, loading, loadingMore, error, loadMore, reload } = useLoadMore<MediaSummary>(path, pageSize);
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reload();
  }, [refreshKey, reload]);

  if (loading && items.length === 0) return <GridSkeleton />;
  if (error && items.length === 0) return <ErrorState message={error.message} onRetry={reload} />;
  if (items.length === 0) return <EmptyState icon={Clapperboard} title={emptyTitle} description={emptyDescription} action={emptyAction} />;
  return (
    <div>
      <p className="sr-only" aria-live="polite">
        Showing {items.length}
        {total !== undefined ? ` of ${total}` : ""} videos
      </p>
      <MediaGrid>
        {items.map((m) => (
          <MediaCard key={m.id} media={m} listId={listId} footer={renderFooter?.(m)} />
        ))}
      </MediaGrid>
      {error ? <ErrorState className="mt-4" title="Couldn't load more" message={error.message} onRetry={loadMore} /> : null}
      {hasMore ? (
        <div className="mt-8 flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : total !== undefined ? (
        <p className="mt-8 text-center text-sm text-muted-foreground">
          {items.length} {items.length === 1 ? "video" : "videos"}
        </p>
      ) : null}
    </div>
  );
}
