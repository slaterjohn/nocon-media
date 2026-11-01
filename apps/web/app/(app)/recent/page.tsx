import type { Metadata } from "next";
import { Suspense } from "react";
import { RecentView } from "@/components/views/simple-lists";

export const metadata: Metadata = { title: "Recently added" };

export default function Page() {
  return (
    <Suspense>
      <RecentView />
    </Suspense>
  );
}
