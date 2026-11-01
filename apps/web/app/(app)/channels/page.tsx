import type { Metadata } from "next";
import { Suspense } from "react";
import { ChannelsView } from "@/components/views/channels-view";

export const metadata: Metadata = { title: "Channels" };

export default function Page() {
  return (
    <Suspense>
      <ChannelsView />
    </Suspense>
  );
}
