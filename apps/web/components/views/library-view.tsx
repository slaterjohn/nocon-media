"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/layout";
import { Input, Select } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { PagedMedia } from "@/components/media/media-list";
import { useDebounced } from "@/lib/viewer";

export function LibraryView() {
  const [q, setQ] = React.useState("");
  const [availability, setAvailability] = React.useState("playable");
  const initialSort = useSearchParams().get("sort");
  const [sort, setSort] = React.useState(["recent", "published", "title", "duration"].includes(initialSort ?? "") ? initialSort! : "recent");
  const [fav, setFav] = React.useState(false);
  const dq = useDebounced(q.trim(), 300);

  const params = new URLSearchParams({ availability, sort });
  if (dq) params.set("q", dq);
  if (fav) params.set("favourite", "true");

  return (
    <>
      <PageHeader title="Library" description="Everything in the catalogue. Downloaded videos play, even without internet." />
      <form role="search" aria-label="Filter the library" className="mb-6 flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()}>
        <div className="min-w-48 flex-1 space-y-1.5">
          <Label htmlFor="lib-q">Search within library</Label>
          <Input id="lib-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title or channel" autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lib-av">Show</Label>
          <Select id="lib-av" value={availability} onChange={(e) => setAvailability(e.target.value)}>
            <option value="playable">Playable now</option>
            <option value="all">Everything</option>
            <option value="unavailable">Not playable</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lib-sort">Sort by</Label>
          <Select id="lib-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="recent">Recently added</option>
            <option value="published">Publish date</option>
            <option value="title">Title</option>
            <option value="duration">Length</option>
          </Select>
        </div>
        <div className="flex h-9 items-center gap-2">
          <Checkbox id="lib-fav" checked={fav} onCheckedChange={(v) => setFav(v === true)} />
          <Label htmlFor="lib-fav">Favourites only</Label>
        </div>
      </form>
      <PagedMedia
        path={`/api/library/media?${params}`}
        emptyTitle={dq || fav || availability !== "playable" ? "No videos match" : "No downloaded videos yet"}
        emptyDescription={
          dq || fav || availability !== "playable" ? (
            "Change the filters or clear the search."
          ) : (
            <>
              Add a channel or playlist in <Link href="/admin/sources" className="underline">Sources</Link> and downloads will appear here.
            </>
          )
        }
      />
    </>
  );
}
