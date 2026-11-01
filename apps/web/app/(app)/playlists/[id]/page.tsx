import type { Metadata } from "next";
import { Suspense } from "react";
import { PlaylistDetailView } from "@/components/views/collections-view";

export const metadata: Metadata = { title: "Playlist" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <PlaylistDetailView id={id} />
    </Suspense>
  );
}
