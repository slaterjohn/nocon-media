"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { useApi } from "@/lib/api";
import type { SearchResults } from "@/lib/types";
import { useDebounced } from "@/lib/viewer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, PageHeader } from "@/components/layout";
import { Query } from "@/components/common/data";
import { CreatorCard, MediaItemsGrid, PlaylistCard } from "@/components/media/media-card";
import { GridSkeleton } from "@/components/media/media-list";

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const id = React.useId();
  if (count === 0) return null;
  return (
    <section aria-labelledby={id} className="mb-8">
      <h2 id={id} className="mb-3 text-lg font-semibold tracking-tight">
        {title} <span className="text-sm font-normal text-muted-foreground">({count})</span>
      </h2>
      {children}
    </section>
  );
}

export function SearchView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [text, setText] = React.useState(params.get("q") ?? "");
  const debounced = useDebounced(text.trim(), 300);

  // Keep the address in step with the debounced query so results can be shared and bookmarked.
  React.useEffect(() => {
    const current = params.get("q") ?? "";
    if (debounced !== current) router.replace(debounced ? `${pathname}?q=${encodeURIComponent(debounced)}` : pathname, { scroll: false });
  }, [debounced, params, pathname, router]);

  const result = useApi<SearchResults>(debounced ? `/api/library/search?q=${encodeURIComponent(debounced)}` : null);
  const total = result.data ? result.data.media.length + result.data.creators.length + result.data.playlists.length + result.data.collections.length : 0;

  return (
    <>
      <PageHeader title="Search" description="Searches titles, descriptions, channels, playlists and collections on this server. It works offline." />
      <form role="search" className="mb-6 max-w-xl" onSubmit={(e) => e.preventDefault()}>
        <Label htmlFor="q" className="sr-only">Search query</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" aria-hidden="true" />
          <Input id="q" type="search" value={text} onChange={(e) => setText(e.target.value)} className="pl-9" placeholder="Search the library" autoComplete="off" />
        </div>
      </form>

      {!debounced ? (
        <EmptyState icon={Search} title="Search your library" description="Type a title, channel, playlist or collection name." />
      ) : (
        <>
          <p className="sr-only" aria-live="polite">{result.data ? (total === 0 ? `No results for ${debounced}` : `${total} results for ${debounced}`) : "Searching"}</p>
          <Query result={result} skeleton={<GridSkeleton count={4} />}>
            {(r) =>
              total === 0 ? (
                <EmptyState icon={Search} title={`No results for “${debounced}”`} description="Check the spelling, or try a shorter or different word." />
              ) : (
                <>
                  <Section title="Videos" count={r.media.length}>
                    <MediaItemsGrid items={r.media} label="Video results" />
                  </Section>
                  <Section title="Channels" count={r.creators.length}>
                    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {r.creators.map((c) => <li key={c.id}><CreatorCard creator={c} /></li>)}
                    </ul>
                  </Section>
                  <Section title="Playlists" count={r.playlists.length}>
                    <ul className="grid gap-x-4 gap-y-6 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
                      {r.playlists.map((p) => <li key={p.id}><PlaylistCard playlist={p} href={`/playlists/${p.id}`} /></li>)}
                    </ul>
                  </Section>
                  <Section title="Collections" count={r.collections.length}>
                    <ul className="grid gap-x-4 gap-y-6 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
                      {r.collections.map((c) => <li key={c.id}><PlaylistCard playlist={c} href={`/collections/${c.id}`} /></li>)}
                    </ul>
                  </Section>
                  <p className="text-sm text-muted-foreground">
                    Looking for something not downloaded? <Link href="/library" className="underline">Browse the full library</Link>.
                  </p>
                </>
              )
            }
          </Query>
        </>
      )}
    </>
  );
}
