"use client";

import * as React from "react";
import { X } from "lucide-react";

export const SHORTCUTS: [string, string][] = [
  ["Space or K", "Play or pause"],
  ["J / L", "Back or forward 10 seconds"],
  ["Left / Right arrow", "Back or forward 5 seconds"],
  ["Up / Down arrow", "Volume up or down"],
  ["M", "Mute or unmute"],
  ["F", "Fullscreen"],
  ["C", "Captions on or off"],
  ["P", "Picture-in-picture"],
  ["Shift + > / Shift + <", "Faster or slower playback"],
  ["0 to 9", "Jump to 0% to 90% of the video"],
  ["Home / End", "Start or end of the video"],
  ["?", "Show this list"],
];

/** In-player overlay (not a portal) so it also shows in fullscreen. */
export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const closeRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => closeRef.current?.focus(), []);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/85 p-4"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-lg border border-white/20 bg-black p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Keyboard shortcuts</h2>
          <button ref={closeRef} type="button" className="player-btn" onClick={onClose} aria-label="Close keyboard shortcuts">
            <X />
          </button>
        </div>
        <p className="mb-3 text-xs text-white/70">These work while the player is focused or the pointer is over it.</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {SHORTCUTS.map(([k, d]) => (
            <React.Fragment key={k}>
              <dt><kbd className="rounded border border-white/40 bg-white/10 px-1.5 py-0.5 font-mono text-xs">{k}</kbd></dt>
              <dd>{d}</dd>
            </React.Fragment>
          ))}
        </dl>
      </div>
    </div>
  );
}
