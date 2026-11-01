"use client";

import { ErrorState } from "@/components/layout/states";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main id="main" className="mx-auto max-w-lg p-6">
      <ErrorState title="Something went wrong" message="The page hit an unexpected problem. Try again, and reload the browser if it keeps happening." onRetry={reset} />
    </main>
  );
}
