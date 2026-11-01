import type { Metadata } from "next";
import { Suspense } from "react";
import { ChannelView } from "@/components/views/channels-view";

export const metadata: Metadata = { title: "Channel" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <ChannelView id={id} />
    </Suspense>
  );
}
