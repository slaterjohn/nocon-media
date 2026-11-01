import type { Priority } from "./enums.js";

export const priorityRank = (p: Priority): number => Number(p.slice(1));
export const rankToPriority = (n: number): Priority => `P${Math.max(0, Math.min(3, n))}` as Priority;

/** Highest importance (lowest number) of the given priorities; P3 if empty. */
export function highestPriority(list: Array<Priority | null | undefined>): Priority {
  let best = 3;
  for (const p of list) if (p) best = Math.min(best, priorityRank(p));
  return rankToPriority(best);
}

export interface PriorityInputs {
  pinned: boolean;
  manualPriority?: Priority | null;
  sourcePriorities: Priority[];
  watched: boolean;
  approved: boolean;
}

export function computeEffectivePriority(i: PriorityInputs): Priority {
  if (i.pinned) return "P0";
  const list: Array<Priority | null | undefined> = [i.manualPriority, ...i.sourcePriorities];
  if (i.watched || i.approved) list.push("P2");
  return highestPriority(list);
}

/** Human-readable names for the storage priorities. The codes stay P0-P3 in data. */
export const PRIORITY_LABELS: Record<Priority, string> = {
  P0: "Protected",
  P1: "Keep",
  P2: "Optional",
  P3: "Spare",
};

export const priorityLabel = (p: Priority): string => PRIORITY_LABELS[p];
