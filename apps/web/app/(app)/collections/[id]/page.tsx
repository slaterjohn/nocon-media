import type { Metadata } from "next";
import { Suspense } from "react";
import { CollectionDetailView } from "@/components/views/collections-view";

export const metadata: Metadata = { title: "Collection" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <CollectionDetailView id={id} />
    </Suspense>
  );
}
