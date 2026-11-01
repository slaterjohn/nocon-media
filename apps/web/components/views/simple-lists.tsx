"use client";

import { PageHeader } from "@/components/layout";
import { PagedMedia } from "@/components/media/media-list";

export function RecentView() {
  return (
    <>
      <PageHeader title="Recently added" description="The newest downloads, newest first." />
      <PagedMedia path="/api/library/recently-added" emptyTitle="Nothing downloaded yet" emptyDescription="New downloads appear here as soon as they finish." />
    </>
  );
}

export function ContinueView() {
  return (
    <>
      <PageHeader title="Continue watching" description="Videos you started and haven't finished." />
      <PagedMedia path="/api/library/continue-watching" emptyTitle="Nothing in progress" emptyDescription="Start a video and it will be here to pick up later." />
    </>
  );
}

export function FavouritesView() {
  return (
    <>
      <PageHeader title="Favourites" description="Videos you've marked as favourites." />
      <PagedMedia path="/api/library/favourites" emptyTitle="No favourites yet" emptyDescription="Use the Favourite button on a video's page to add it here." />
    </>
  );
}
