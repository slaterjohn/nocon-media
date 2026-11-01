import type { Metadata } from "next";
import { Suspense } from "react";
import { HomeView } from "@/components/views/home-view";

export const metadata: Metadata = { title: "Home" };

export default function Page() {
  return (
    <Suspense>
      <HomeView />
    </Suspense>
  );
}
