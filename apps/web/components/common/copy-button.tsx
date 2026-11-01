"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = React.useState(false);
  const { toast } = useToast();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          toast({ title: `${label} copied`, variant: "success" });
          setTimeout(() => setDone(false), 2000);
        } catch {
          toast({ title: "Couldn't copy", description: "Select the text and copy it by hand.", variant: "error" });
        }
      }}
    >
      {done ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {done ? "Copied" : "Copy"}
      <span className="sr-only"> {label}</span>
    </Button>
  );
}
