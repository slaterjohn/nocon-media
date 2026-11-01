import type { Metadata } from "next";
import { Suspense } from "react";
import { PlaylistsView } from "@/components/views/collections-view";

export const metadata: Metadata = { title: "Playlists" };

export default function Page() {
  return (
    <Suspense>
      <PlaylistsView />
    </Suspense>
  );
}
