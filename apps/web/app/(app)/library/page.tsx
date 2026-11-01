import type { Metadata } from "next";
import { Suspense } from "react";
import { LibraryView } from "@/components/views/library-view";

export const metadata: Metadata = { title: "Library" };

export default function Page() {
  return (
    <Suspense>
      <LibraryView />
    </Suspense>
  );
}
