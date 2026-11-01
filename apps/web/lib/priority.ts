import type { Priority } from "@/lib/types";

/**
 * Storage priority names shown to people. The codes P0-P3 stay in data (API
 * values, query params, option values). Keep in step with PRIORITY_LABELS in
 * packages/shared, which the web app does not import.
 */
export const PRIORITIES: readonly Priority[] = ["P0", "P1", "P2", "P3"];

const LABELS: Record<Priority, string> = {
  P0: "Protected",
  P1: "Keep",
  P2: "Optional",
  P3: "Spare",
};

const DESCRIPTIONS: Record<Priority, string> = {
  P0: "Never removed automatically",
  P1: "Kept unless your retention rules say otherwise",
  P2: "Removed when Keep videos need room",
  P3: "Removed first when space runs low",
};

export const priorityLabel = (code: Priority): string => LABELS[code];
export const priorityDescription = (code: Priority): string => DESCRIPTIONS[code];
