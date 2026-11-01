import type { Metadata } from "next";
import { Suspense } from "react";
import { WatchView } from "@/components/watch/watch-view";

export const metadata: Metadata = { title: "Watch" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <WatchView id={id} />
    </Suspense>
  );
}
