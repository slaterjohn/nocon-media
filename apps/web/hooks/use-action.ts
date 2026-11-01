"use client";

import { useCallback, useState } from "react";
import { errorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/toast";

/**
 * Runs an async action, tracks a busy flag and reports failures as an error toast.
 * Returns the result, or undefined if it failed.
 */
export function useAction() {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, opts?: { success?: string; failure?: string }) => {
      setBusy(key);
      try {
        const res = await fn();
        if (opts?.success) toast({ title: opts.success, variant: "success" });
        return res;
      } catch (e) {
        toast({ title: opts?.failure ?? "That didn't work", description: errorMessage(e), variant: "error" });
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { run, busy };
}
