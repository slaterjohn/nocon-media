import type { Metadata } from "next";
import { Suspense } from "react";
import { CollectionsView } from "@/components/views/collections-view";

export const metadata: Metadata = { title: "Collections" };

export default function Page() {
  return (
    <Suspense>
      <CollectionsView />
    </Suspense>
  );
}
