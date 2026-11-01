"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AudioLines, Captions, Keyboard, List, Loader2, Maximize, Minimize, Pause, PictureInPicture2, Play,
  RotateCcw, SlidersHorizontal, Volume1, Volume2, VolumeX,
} from "lucide-react";
import type { MediaDetail } from "@/lib/types";
import { cn, formatDuration } from "@/lib/utils";
import { PlayerMenu, type MenuOption } from "./player-menu";
import { ShortcutsOverlay } from "./shortcuts";
import { useMediaSource } from "./use-media-source";

export type PlayerMedia = Pick<
  MediaDetail,
  "id" | "title" | "channelName" | "thumbnailUrl" | "durationSeconds" | "streamUrl" | "hlsUrl" | "directPlay" | "subtitles" | "chapters" | "progress"
>;

interface SafariAudioTrack {
  id: string;
  label: string;
  language: string;
  enabled: boolean;
}
type VideoWithExtras = HTMLVideoElement & {
  audioTracks?: ArrayLike<SafariAudioTrack> & { addEventListener?: HTMLVideoElement["addEventListener"] };
  webkitEnterFullscreen?: () => void;
};

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const VOLUME_KEY = "nocon.player.volume";
const NEXT_COUNTDOWN = 5;

export interface PlayerControl {
  seek: (seconds: number) => void;
}

export function VideoPlayer({
  media,
  next,
  autoplayNext,
  controlRef,
}: {
  media: PlayerMedia;
  next: { href: string; title: string } | null;
  autoplayNext: boolean;
  /** Lets the page (for example a chapter list) seek the player. */
  controlRef?: React.MutableRefObject<PlayerControl | null>;
}) {
  const router = useRouter();
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const osdTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverRef = React.useRef(false);
  const openMenus = React.useRef(0);
  const initialProgress = React.useRef(media.progress);
  const lastCaption = React.useRef(0);

  const [attempt, setAttempt] = React.useState(0);
  const { status, levels, level, setLevel } = useMediaSource({
    videoRef, mediaId: media.id, streamUrl: media.streamUrl, hlsUrl: media.hlsUrl, directPlay: media.directPlay, attempt,
  });

  const [playing, setPlaying] = React.useState(false);
  const [time, setTime] = React.useState(0);
  const [duration, setDuration] = React.useState(media.durationSeconds ?? 0);
  const [bufferedEnd, setBufferedEnd] = React.useState(0);
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);
  const [rate, setRate] = React.useState(1);
  const [waiting, setWaiting] = React.useState(false);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [pip, setPip] = React.useState(false);
  const [pipAvailable, setPipAvailable] = React.useState(false);
  const [controlsVisible, setControlsVisible] = React.useState(true);
  const [captionIdx, setCaptionIdx] = React.useState(-1);
  const [audioTracks, setAudioTracks] = React.useState<SafariAudioTrack[]>([]);
  const [live, setLive] = React.useState("");
  const [osd, setOsd] = React.useState<string | null>(null);
  const [resume, setResume] = React.useState<number | null>(null);
  const [countdown, setCountdown] = React.useState<number | null>(null);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [mediaError, setMediaError] = React.useState(false);

  const failed = status === "error" || mediaError;

  const announce = React.useCallback((msg: string, visual = true) => {
    setLive((prev) => (prev === msg ? `${msg} ` : msg));
    if (visual) {
      setOsd(msg);
      clearTimeout(osdTimer.current);
      osdTimer.current = setTimeout(() => setOsd(null), 1200);
    }
  }, []);

  // ---- Progress saving -------------------------------------------------------------------
  const save = React.useCallback(
    (forceCompleted?: boolean) => {
      const v = videoRef.current;
      if (!v) return;
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : (media.durationSeconds ?? 0);
      if (!dur) return;
      const pos = v.ended ? dur : v.currentTime;
      if (pos <= 0 && !forceCompleted) return;
      const completed = forceCompleted ?? pos / dur > 0.95;
      // sendBeacon can't set the CSRF header, so use fetch with keepalive.
      fetch(`/api/media/${media.id}/progress`, {
        method: "POST",
        keepalive: true,
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-NoCon-CSRF": "1" },
        body: JSON.stringify({ positionSeconds: Math.floor(pos), durationSeconds: Math.floor(dur), completed }),
      }).catch(() => {});
    },
    [media.id, media.durationSeconds],
  );
  const saveRef = React.useRef(save);
  saveRef.current = save;

  React.useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => saveRef.current(), 10000);
    return () => clearInterval(t);
  }, [playing]);

  React.useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") saveRef.current();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      saveRef.current();
    };
  }, []);

  // ---- Controls visibility ---------------------------------------------------------------
  const wake = React.useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      const v = videoRef.current;
      if (!v || v.paused || openMenus.current > 0) return;
      if (containerRef.current?.querySelector(":focus-visible")) return;
      setControlsVisible(false);
    }, 3000);
  }, []);
  React.useEffect(() => {
    if (playing) wake();
    else {
      clearTimeout(hideTimer.current);
      setControlsVisible(true);
    }
    return () => clearTimeout(hideTimer.current);
  }, [playing, wake]);
  const onMenuOpen = React.useCallback((open: boolean) => {
    openMenus.current += open ? 1 : -1;
    if (open) setControlsVisible(true);
  }, []);

  // ---- Actions ---------------------------------------------------------------------------
  const togglePlay = React.useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) {
      void v.play().catch(() => {});
      announce("Playing");
    } else {
      v.pause();
      announce("Paused");
    }
  }, [announce]);

  const seekTo = React.useCallback((t: number, say = true) => {
    const v = videoRef.current;
    if (!v) return;
    const max = Number.isFinite(v.duration) ? v.duration : t;
    v.currentTime = Math.max(0, Math.min(max, t));
    setTime(v.currentTime);
    if (say) announce(`${formatDuration(v.currentTime)} of ${formatDuration(max)}`);
  }, [announce]);

  React.useEffect(() => {
    if (!controlRef) return;
    controlRef.current = {
      seek: (t) => {
        seekTo(t);
        void videoRef.current?.play().catch(() => {});
      },
    };
    return () => {
      controlRef.current = null;
    };
  }, [controlRef, seekTo]);

  const setVol = React.useCallback((val: number) => {
    const v = videoRef.current;
    if (!v) return;
    const c = Math.max(0, Math.min(1, val));
    v.volume = c;
    v.muted = c === 0;
    announce(c === 0 ? "Muted" : `Volume ${Math.round(c * 100)}%`);
  }, [announce]);

  const toggleMute = React.useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 0.5;
    announce(v.muted ? "Muted" : "Unmuted");
  }, [announce]);

  const setSpeed = React.useCallback((r: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = r;
    announce(`Speed ${r}×`);
  }, [announce]);

  const toggleFullscreen = React.useCallback(() => {
    const c = containerRef.current;
    const v = videoRef.current as VideoWithExtras | null;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (c?.requestFullscreen) void c.requestFullscreen().catch(() => {});
    else v?.webkitEnterFullscreen?.();
  }, []);

  const togglePip = React.useCallback(async () => {
    const v = videoRef.current;
    if (!v || !document.pictureInPictureEnabled) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      announce("Picture-in-picture isn't available for this video", false);
    }
  }, [announce]);

  const chooseCaption = React.useCallback((idx: number) => {
    setCaptionIdx(idx);
    if (idx >= 0) lastCaption.current = idx;
    const label = idx >= 0 ? media.subtitles[idx]?.label || media.subtitles[idx]?.language : null;
    announce(label ? `Captions on, ${label}` : "Captions off");
  }, [announce, media.subtitles]);
  const toggleCaptions = React.useCallback(() => {
    if (media.subtitles.length === 0) return announce("No captions for this video");
    chooseCaption(captionIdx >= 0 ? -1 : Math.min(lastCaption.current, media.subtitles.length - 1));
  }, [captionIdx, chooseCaption, announce, media.subtitles.length]);

  // Only our <track> elements exist, in order, so the index matches media.subtitles.
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const apply = () => {
      for (let i = 0; i < v.textTracks.length; i++) v.textTracks[i].mode = i === captionIdx ? "showing" : "disabled";
    };
    apply();
    v.textTracks.addEventListener("addtrack", apply);
    return () => v.textTracks.removeEventListener("addtrack", apply);
  }, [captionIdx, media.subtitles.length]);

  // ---- Video events ----------------------------------------------------------------------
  React.useEffect(() => {
    const v = videoRef.current as VideoWithExtras | null;
    if (!v) return;
    try {
      const stored = Number(localStorage.getItem(VOLUME_KEY));
      if (stored > 0 && stored <= 1) v.volume = stored;
    } catch { /* storage unavailable */ }
    setVolume(v.volume);
    setMuted(v.muted);
    setPipAvailable(typeof document !== "undefined" && !!document.pictureInPictureEnabled);

    const readBuffered = () => {
      const b = v.buffered;
      let end = 0;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5) end = Math.max(end, b.end(i));
      setBufferedEnd(end);
    };
    const on = <K extends keyof HTMLVideoElementEventMap>(name: K, fn: () => void) => {
      v.addEventListener(name, fn);
      return () => v.removeEventListener(name, fn);
    };
    const offs = [
      on("play", () => { setPlaying(true); setCountdown(null); setMediaError(false); }),
      on("pause", () => {
        setPlaying(false);
        if (!v.ended) saveRef.current();
      }),
      on("timeupdate", () => { setTime(v.currentTime); readBuffered(); }),
      on("durationchange", () => { if (Number.isFinite(v.duration)) setDuration(v.duration); }),
      on("progress", readBuffered),
      on("volumechange", () => {
        setVolume(v.volume);
        setMuted(v.muted);
        try { if (v.volume > 0) localStorage.setItem(VOLUME_KEY, String(v.volume)); } catch { /* storage unavailable */ }
      }),
      on("ratechange", () => setRate(v.playbackRate)),
      on("waiting", () => setWaiting(true)),
      on("playing", () => setWaiting(false)),
      on("canplay", () => setWaiting(false)),
      on("seeked", () => saveRef.current()),
      on("error", () => { if (v.getAttribute("src")) setMediaError(true); }),
      on("enterpictureinpicture", () => setPip(true)),
      on("leavepictureinpicture", () => setPip(false)),
      on("ended", () => {
        setPlaying(false);
        saveRef.current(true);
        if (nextRef.current && autoplayRef.current) setCountdown(NEXT_COUNTDOWN);
      }),
      on("loadedmetadata", () => {
        if (Number.isFinite(v.duration)) setDuration(v.duration);
        const p = initialProgress.current;
        initialProgress.current = null;
        if (p && !p.completed && p.positionSeconds > 5 && v.duration && p.positionSeconds < v.duration * 0.95) {
          v.currentTime = p.positionSeconds;
          setResume(p.positionSeconds);
        }
        const at = v.audioTracks;
        if (at && at.length > 1) {
          setAudioTracks(Array.from({ length: at.length }, (_, i) => ({ id: at[i].id, label: at[i].label, language: at[i].language, enabled: at[i].enabled })));
        }
        void v.play().catch(() => {});
      }),
    ];
    const onFs = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      offs.forEach((f) => f());
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, []);

  const nextRef = React.useRef(next);
  nextRef.current = next;
  const autoplayRef = React.useRef(autoplayNext);
  autoplayRef.current = autoplayNext;

  React.useEffect(() => {
    if (!resume) return;
    const t = setTimeout(() => setResume(null), 10000);
    return () => clearTimeout(t);
  }, [resume]);

  // Autoplay-next countdown.
  React.useEffect(() => {
    if (countdown === null || !next) return;
    if (countdown <= 0) {
      router.push(next.href);
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, next, router]);
  React.useEffect(() => {
    if (countdown !== null && !next) setCountdown(null);
  }, [countdown, next]);

  // Media Session: lock-screen and hardware media keys.
  React.useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({
      title: media.title,
      artist: media.channelName ?? "",
      artwork: media.thumbnailUrl ? [{ src: media.thumbnailUrl }] : [],
    });
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => { try { ms.setActionHandler(a, h); } catch { /* unsupported */ } };
    set("play", () => void videoRef.current?.play());
    set("pause", () => videoRef.current?.pause());
    set("seekbackward", () => seekTo((videoRef.current?.currentTime ?? 0) - 10, false));
    set("seekforward", () => seekTo((videoRef.current?.currentTime ?? 0) + 10, false));
    set("nexttrack", next ? () => router.push(next.href) : null);
    return () => (["play", "pause", "seekbackward", "seekforward", "nexttrack"] as MediaSessionAction[]).forEach((a) => set(a, null));
  }, [media.title, media.channelName, media.thumbnailUrl, next, router, seekTo]);

  // ---- Keyboard shortcuts ----------------------------------------------------------------
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = containerRef.current;
      const v = videoRef.current;
      if (!c || !v || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const inside = !!t && c.contains(t);
      if (!inside) {
        if (!hoverRef.current) return;
        if (t?.closest('input, textarea, select, a, button, summary, [role="dialog"], [role="menu"], [contenteditable="true"]')) return;
      }
      if (t?.closest('[role="menu"]')) return;
      if (helpOpen) return; // the overlay handles Escape itself
      const isRange = t instanceof HTMLInputElement && t.type === "range";
      const onButton = !!t?.closest("button");
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      const handled = () => { e.preventDefault(); wake(); };
      switch (e.key) {
        case " ":
          if (onButton) return;
          handled(); togglePlay(); return;
        case "k": case "K":
          handled(); togglePlay(); return;
        case "j": case "J":
          handled(); seekTo(v.currentTime - 10); return;
        case "l": case "L":
          handled(); seekTo(v.currentTime + 10); return;
        case "ArrowLeft":
          if (isRange) return;
          handled(); seekTo(v.currentTime - 5); return;
        case "ArrowRight":
          if (isRange) return;
          handled(); seekTo(v.currentTime + 5); return;
        case "ArrowUp":
          if (isRange) return;
          handled(); setVol((v.muted ? 0 : v.volume) + 0.1); return;
        case "ArrowDown":
          if (isRange) return;
          handled(); setVol((v.muted ? 0 : v.volume) - 0.1); return;
        case "m": case "M":
          handled(); toggleMute(); return;
        case "f": case "F":
          handled(); toggleFullscreen(); return;
        case "c": case "C":
          handled(); toggleCaptions(); return;
        case "p": case "P":
          handled(); void togglePip(); return;
        case ">": case "<": {
          handled();
          const i = SPEEDS.indexOf(v.playbackRate);
          const base = i === -1 ? SPEEDS.findIndex((s) => s >= v.playbackRate) : i;
          setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, base + (e.key === ">" ? 1 : -1)))]);
          return;
        }
        case "Home":
          if (isRange) return;
          handled(); seekTo(0); return;
        case "End":
          if (isRange) return;
          handled(); seekTo(dur); return;
        case "?":
          handled(); setHelpOpen(true); return;
        default:
          if (/^[0-9]$/.test(e.key) && !e.shiftKey && !isRange && dur) {
            handled(); seekTo((Number(e.key) / 10) * dur);
          }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [helpOpen, wake, togglePlay, seekTo, setVol, toggleMute, toggleFullscreen, toggleCaptions, togglePip, setSpeed]);

  function retry() {
    const v = videoRef.current;
    if (v && v.currentTime > 0) initialProgress.current = { positionSeconds: v.currentTime, durationSeconds: duration, completed: false };
    setMediaError(false);
    setAttempt((a) => a + 1);
  }

  // ---- Derived values --------------------------------------------------------------------
  const pctPlayed = duration > 0 ? (time / duration) * 100 : 0;
  const pctBuffered = duration > 0 ? (bufferedEnd / duration) * 100 : 0;
  const currentChapter = media.chapters.filter((c) => c.startSeconds <= time).at(-1);
  const hidden = !controlsVisible && playing && !failed;
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const ready = status === "ready" && !failed;

  const captionOptions: MenuOption[] = [
    { value: "-1", label: "Off", checked: captionIdx === -1 },
    ...media.subtitles.map((s, i) => ({ value: String(i), label: s.label || s.language, checked: captionIdx === i })),
  ];

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={`Video player: ${media.title}`}
      aria-describedby="player-hint"
      tabIndex={0}
      className={cn(
        "relative aspect-video w-full overflow-hidden rounded-lg bg-black text-white outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring [&:fullscreen]:rounded-none",
        hidden && "cursor-none",
      )}
      onPointerMove={wake}
      onPointerDown={wake}
      onPointerEnter={() => { hoverRef.current = true; }}
      onPointerLeave={() => { hoverRef.current = false; }}
      onFocus={wake}
      onBlur={wake}
    >
      <video
        ref={videoRef}
        className="size-full bg-black object-contain"
        playsInline
        preload="metadata"
        poster={media.thumbnailUrl ?? undefined}
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
      >
        {media.subtitles.map((s) => (
          <track key={s.id} kind="subtitles" src={s.url} srcLang={s.language} label={s.label || s.language} />
        ))}
      </video>

      <p id="player-hint" className="sr-only">Press question mark for keyboard shortcuts.</p>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{live}</div>

      {/* Status overlays */}
      {status === "loading" && !failed ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
          <Loader2 className="size-10 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <span className="sr-only">Loading video</span>
        </div>
      ) : null}
      {status === "preparing" && !failed ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 p-4 text-center" role="status">
          <Loader2 className="size-8 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <p className="font-medium">Preparing this video for playback</p>
          <p className="max-w-sm text-sm text-white/80">The server is converting it for your browser. This can take a few minutes the first time. Playback starts when it's ready.</p>
        </div>
      ) : null}
      {waiting && ready && playing ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
          <Loader2 className="size-10 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <span className="sr-only">Buffering</span>
        </div>
      ) : null}
      {failed ? (
        <div role="alert" className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/90 p-4 text-center">
          <p className="max-w-md font-medium">This video can't play. The file may be missing or the drive disconnected.</p>
          <button type="button" className="player-text-btn inline-flex items-center gap-2" onClick={retry}>
            <RotateCcw className="size-4" aria-hidden="true" /> Try again
          </button>
        </div>
      ) : null}

      {osd ? (
        <div aria-hidden="true" className="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 rounded-md bg-black/80 px-3 py-1.5 text-sm font-medium">
          {osd}
        </div>
      ) : null}

      {resume !== null && ready ? (
        <div role="status" className="absolute top-3 left-3 z-10 flex items-center gap-3 rounded-md bg-black/85 px-3 py-2 text-sm">
          <span>Resuming from {formatDuration(resume)}</span>
          <button type="button" className="player-text-btn" onClick={() => { seekTo(0); setResume(null); }}>Start over</button>
        </div>
      ) : null}

      {countdown !== null && next ? (
        <div role="group" aria-label="Up next" className="absolute right-3 bottom-24 z-20 max-w-xs rounded-lg border border-white/25 bg-black/90 p-3 text-sm">
          <p className="text-xs text-white/70">Up next</p>
          <p className="line-clamp-2 font-medium">{next.title}</p>
          <p className="mt-1" aria-hidden="true">Playing in {countdown}</p>
          <p className="sr-only" role="status">Playing {next.title} in {NEXT_COUNTDOWN} seconds unless cancelled.</p>
          <div className="mt-2 flex gap-2">
            <button type="button" autoFocus className="player-text-btn" onClick={() => setCountdown(null)}>Cancel</button>
            <button type="button" className="player-text-btn" onClick={() => router.push(next.href)}>Play now</button>
          </div>
        </div>
      ) : null}

      {/* Big play button when paused before starting */}
      {ready && !playing && time === 0 && countdown === null && !waiting ? (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play"
          className="absolute top-1/2 left-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/70 hover:bg-black/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <Play className="size-8" aria-hidden="true" />
        </button>
      ) : null}

      {/* Controls */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-3 pt-10 pb-2 transition-opacity duration-200 motion-reduce:transition-none",
          hidden && "pointer-events-none opacity-0",
        )}
      >
        <div className="relative h-5">
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/30" aria-hidden="true">
            <div className="absolute inset-y-0 left-0 bg-white/40" style={{ width: `${pctBuffered}%` }} />
            <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${pctPlayed}%` }} />
          </div>
          {duration > 0
            ? media.chapters.filter((c) => c.startSeconds > 0).map((c) => (
                <span
                  key={c.startSeconds}
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 h-2 w-0.5 -translate-y-1/2 bg-white"
                  style={{ left: `${(c.startSeconds / duration) * 100}%` }}
                />
              ))
            : null}
          <input
            type="range"
            className="player-range absolute inset-0"
            aria-label="Seek"
            min={0}
            max={duration || 0}
            step="any"
            value={Math.min(time, duration || 0)}
            aria-valuetext={`${formatDuration(time)} of ${formatDuration(duration)}`}
            disabled={!ready || !duration}
            onChange={(e) => seekTo(Number(e.target.value), false)}
          />
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1">
          <button type="button" className="player-btn" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (K)" : "Play (K)"} disabled={!ready}>
            {playing ? <Pause /> : <Play />}
          </button>
          <button type="button" className="player-btn" onClick={toggleMute} aria-label={muted || volume === 0 ? "Unmute" : "Mute"} title="Mute (M)">
            <VolIcon />
          </button>
          <input
            type="range"
            className="player-range player-volume-range w-20"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-valuetext={muted ? "Muted" : `${Math.round(volume * 100)}%`}
            onChange={(e) => setVol(Number(e.target.value))}
          />
          <span className="ml-2 text-sm tabular-nums" aria-hidden="true">
            {formatDuration(time)} / {formatDuration(duration)}
          </span>
          {currentChapter ? <span className="ml-2 hidden max-w-48 truncate text-sm text-white/80 sm:inline" aria-hidden="true">{currentChapter.title}</span> : null}

          <div className="ml-auto flex flex-wrap items-center gap-1">
            {media.chapters.length > 0 ? (
              <PlayerMenu
                label="Chapters"
                icon={<List />}
                radio={false}
                options={media.chapters.map((c) => ({ value: String(c.startSeconds), label: `${formatDuration(c.startSeconds)}  ${c.title}`, checked: c === currentChapter }))}
                onSelect={(v) => seekTo(Number(v))}
                onOpenChange={onMenuOpen}
              />
            ) : null}
            {media.subtitles.length === 0 ? (
              <button type="button" className="player-btn opacity-60" disabled aria-label="Captions unavailable" title="No captions for this video">
                <Captions />
              </button>
            ) : media.subtitles.length === 1 ? (
              <button type="button" className="player-btn" aria-pressed={captionIdx >= 0} aria-label="Captions" title="Captions (C)" onClick={toggleCaptions}>
                <Captions />
              </button>
            ) : (
              <PlayerMenu label="Captions" tooltip="Captions (C)" icon={<Captions />} options={captionOptions} onSelect={(v) => chooseCaption(Number(v))} onOpenChange={onMenuOpen} />
            )}
            <PlayerMenu
              label="Playback speed"
              current={`${rate}×`}
              icon={<span className="text-sm font-medium tabular-nums">{rate}×</span>}
              options={SPEEDS.map((s) => ({ value: String(s), label: s === 1 ? "Normal" : `${s}×`, checked: s === rate }))}
              onSelect={(v) => setSpeed(Number(v))}
              onOpenChange={onMenuOpen}
            />
            {audioTracks.length > 1 ? (
              <PlayerMenu
                label="Audio track"
                icon={<AudioLines />}
                options={audioTracks.map((a, i) => ({ value: String(i), label: a.label || a.language || `Track ${i + 1}`, checked: a.enabled }))}
                onSelect={(v) => {
                  const at = (videoRef.current as VideoWithExtras | null)?.audioTracks;
                  if (!at) return;
                  for (let i = 0; i < at.length; i++) at[i].enabled = i === Number(v);
                  setAudioTracks((l) => l.map((a, i) => ({ ...a, enabled: i === Number(v) })));
                  announce("Audio track changed");
                }}
                onOpenChange={onMenuOpen}
              />
            ) : null}
            {levels.length > 1 ? (
              <PlayerMenu
                label="Quality"
                icon={<SlidersHorizontal />}
                options={[
                  { value: "-1", label: "Auto", checked: level === -1 },
                  ...[...levels].reverse().map((l) => ({ value: String(l.index), label: l.label, checked: level === l.index })),
                ]}
                onSelect={(v) => { setLevel(Number(v)); announce(Number(v) === -1 ? "Quality automatic" : `Quality ${levels.find((l) => l.index === Number(v))?.label}`); }}
                onOpenChange={onMenuOpen}
              />
            ) : null}
            {pipAvailable ? (
              <button type="button" className="player-btn" aria-pressed={pip} aria-label="Picture-in-picture" title="Picture-in-picture (P)" onClick={() => void togglePip()}>
                <PictureInPicture2 />
              </button>
            ) : null}
            <button type="button" className="player-btn" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}>
              <Keyboard />
            </button>
            <button type="button" className="player-btn" aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} title="Fullscreen (F)" onClick={toggleFullscreen}>
              {fullscreen ? <Minimize /> : <Maximize />}
            </button>
          </div>
        </div>
      </div>

      {helpOpen ? <ShortcutsOverlay onClose={() => { setHelpOpen(false); containerRef.current?.focus(); }} /> : null}
    </div>
  );
}
