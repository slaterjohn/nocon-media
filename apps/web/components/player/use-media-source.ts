"use client";

import * as React from "react";
import type HlsType from "hls.js";

export type SourceStatus = "loading" | "preparing" | "ready" | "error";
export interface QualityLevel {
  index: number;
  label: string;
}

interface Input {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mediaId: string;
  streamUrl: string | null;
  hlsUrl: string | null;
  directPlay: boolean;
  /** Bump to tear down and start again (retry button). */
  attempt: number;
}

const HLS_MIME = "application/vnd.apple.mpegurl";
const POLL_MS = 3000;

/**
 * Chooses and attaches a playback source. Direct play uses the stream URL as is. Otherwise HLS:
 * Safari plays it natively, everywhere else hls.js is imported on demand. A 202 from the manifest
 * means the server is still preparing it, so it is polled every 3 seconds.
 */
export function useMediaSource({ videoRef, mediaId, streamUrl, hlsUrl, directPlay, attempt }: Input) {
  const [status, setStatus] = React.useState<SourceStatus>("loading");
  const [levels, setLevels] = React.useState<QualityLevel[]>([]);
  const [level, setLevelState] = React.useState(-1);
  const hlsRef = React.useRef<HlsType | null>(null);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus("loading");
    setLevels([]);
    setLevelState(-1);

    const fail = () => !cancelled && setStatus("error");
    const useDirect = () => {
      if (!streamUrl) return fail();
      video.src = streamUrl;
      video.load();
      setStatus("ready");
    };

    // Non-direct-play media without a rendition yet: asking for the manifest makes the server queue one.
    const manifest = directPlay ? null : (hlsUrl ?? (streamUrl ? `/api/media/${mediaId}/hls/index.m3u8` : null));

    async function attachHls(url: string) {
      if (video!.canPlayType(HLS_MIME)) {
        video!.src = url;
        video!.load();
        setStatus("ready");
        return;
      }
      const { default: Hls } = await import("hls.js");
      if (cancelled) return;
      if (!Hls.isSupported()) return useDirect();
      const hls = new Hls({ enableWorker: true });
      hlsRef.current = hls;
      let recovered = false;
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        if (cancelled) return;
        setLevels(data.levels.map((l, index) => ({ index, label: l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)} kbps` })));
        setStatus("ready");
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal || cancelled) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
          recovered = true;
          hls.recoverMediaError();
          return;
        }
        hls.destroy();
        hlsRef.current = null;
        fail();
      });
      hls.loadSource(url);
      hls.attachMedia(video!);
    }

    async function poll(url: string) {
      try {
        const res = await fetch(url, { credentials: "include", cache: "no-store" });
        if (cancelled) return;
        if (res.status === 202) {
          setStatus("preparing");
          timer = setTimeout(() => void poll(url), POLL_MS);
          return;
        }
        if (res.ok) return void (await attachHls(url));
        // No usable rendition (for example HLS is disabled): fall back to the stream and let the browser try.
        useDirect();
      } catch {
        fail();
      }
    }

    if (manifest) void poll(manifest);
    else useDirect();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [videoRef, mediaId, streamUrl, hlsUrl, directPlay, attempt]);

  const setLevel = React.useCallback((index: number) => {
    if (hlsRef.current) hlsRef.current.currentLevel = index;
    setLevelState(index);
  }, []);

  return { status, levels, level, setLevel };
}
