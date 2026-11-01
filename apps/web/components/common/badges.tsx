import { Badge } from "@/components/ui/badge";
import type { Priority } from "@/lib/types";
import { priorityDescription, priorityLabel } from "@/lib/priority";

export function PriorityBadge({ priority }: { priority: Priority }) {
  const variant = priority === "P0" ? "default" : priority === "P1" ? "success" : priority === "P2" ? "outline" : "secondary";
  return (
    <Badge variant={variant} title={priorityDescription(priority)}>
      {priorityLabel(priority)}
    </Badge>
  );
}

const STATE_VARIANT: Record<string, "default" | "secondary" | "outline" | "success" | "warning" | "destructive"> = {
  active: "success",
  available: "success",
  ready: "success",
  completed: "success",
  online: "success",
  downloading: "default",
  processing: "default",
  verifying: "default",
  checking: "default",
  queued: "secondary",
  pending: "secondary",
  discovered: "secondary",
  paused: "warning",
  waiting_for_storage: "warning",
  evicted: "warning",
  unavailable: "warning",
  error: "destructive",
  failed: "destructive",
  cancelled: "outline",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={STATE_VARIANT[status] ?? "outline"}>{status.replaceAll("_", " ")}</Badge>;
}
