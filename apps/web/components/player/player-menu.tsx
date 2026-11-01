"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface MenuOption {
  value: string;
  label: string;
  checked?: boolean;
}

/**
 * Menu button for the player. It renders inside the player container (not a portal) so it stays
 * visible in fullscreen. Arrow keys move, Enter/Space choose, Escape closes and returns focus.
 */
export function PlayerMenu({
  label,
  icon,
  buttonText,
  current,
  options,
  onSelect,
  onOpenChange,
  radio = true,
  tooltip,
}: {
  label: string;
  icon: React.ReactNode;
  buttonText?: string;
  /** Visible state shown inside the icon (for example "1×"); included in the accessible name so it matches what is seen. */
  current?: string;
  options: MenuOption[];
  onSelect: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  /** false renders plain menu items (used for chapters). */
  radio?: boolean;
  tooltip?: string;
}) {
  const [open, setOpenState] = React.useState(false);
  const wrap = React.useRef<HTMLDivElement>(null);
  const btn = React.useRef<HTMLButtonElement>(null);
  const items = React.useRef<(HTMLButtonElement | null)[]>([]);
  const id = React.useId();

  const setOpen = React.useCallback(
    (o: boolean) => {
      setOpenState(o);
      onOpenChange?.(o);
    },
    [onOpenChange],
  );

  React.useEffect(() => {
    if (!open) return;
    const checked = options.findIndex((o) => o.checked);
    items.current[checked >= 0 ? checked : 0]?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
    const idx = items.current.findIndex((el) => el === document.activeElement);
    const n = options.length;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items.current[(idx + 1) % n]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items.current[(idx - 1 + n) % n]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items.current[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items.current[n - 1]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div ref={wrap} className="relative">
      <button
        ref={btn}
        type="button"
        className="player-btn"
        aria-label={current ? `${label}, ${current}` : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={tooltip ?? label}
        onClick={() => setOpen(!open)}
      >
        {icon}
        {buttonText ? <span className="text-xs font-medium tabular-nums">{buttonText}</span> : null}
      </button>
      {open ? (
        <div
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          className="absolute right-0 bottom-full z-30 mb-2 max-h-64 min-w-40 overflow-y-auto rounded-md border border-white/20 bg-black/90 p-1 text-sm text-white shadow-lg"
        >
          {options.map((o, i) => (
            <button
              key={o.value}
              ref={(el) => {
                items.current[i] = el;
              }}
              type="button"
              role={radio ? "menuitemradio" : "menuitem"}
              aria-checked={radio ? !!o.checked : undefined}
              className={cn(
                "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left hover:bg-white/15 focus-visible:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-white",
                o.checked && "font-semibold",
              )}
              onClick={() => {
                onSelect(o.value);
                setOpen(false);
                btn.current?.focus();
              }}
            >
              <span aria-hidden="true" className="w-4 shrink-0 text-center">{o.checked ? "✓" : ""}</span>
              <span className="min-w-0 flex-1">{o.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
