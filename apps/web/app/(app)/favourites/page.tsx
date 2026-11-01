import type { Metadata } from "next";
import { Suspense } from "react";
import { FavouritesView } from "@/components/views/simple-lists";

export const metadata: Metadata = { title: "Favourites" };

export default function Page() {
  return (
    <Suspense>
      <FavouritesView />
    </Suspense>
  );
}
