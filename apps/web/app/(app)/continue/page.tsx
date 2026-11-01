import type { Metadata } from "next";
import { Suspense } from "react";
import { ContinueView } from "@/components/views/simple-lists";

export const metadata: Metadata = { title: "Continue watching" };

export default function Page() {
  return (
    <Suspense>
      <ContinueView />
    </Suspense>
  );
}
