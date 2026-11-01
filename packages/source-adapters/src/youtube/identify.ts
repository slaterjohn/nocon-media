import type { IdentifiedSource } from "../types.js";

const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const VIDEO_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_RE = /^UC[A-Za-z0-9_-]{22}$/;
const PLAYLIST_RE = /^[A-Za-z0-9_-]{10,64}$/;
const HANDLE_RE = /^@[A-Za-z0-9._-]{3,30}$/;
const LEGACY_RE = /^[A-Za-z0-9._-]{1,100}$/;

const P = "youtube";

function video(id: string): IdentifiedSource | null {
  if (!VIDEO_RE.test(id)) return null;
  return { platform: P, type: "video", externalId: id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` };
}
function channel(id: string): IdentifiedSource | null {
  if (!CHANNEL_RE.test(id)) return null;
  return { platform: P, type: "channel", externalId: id, canonicalUrl: `https://www.youtube.com/channel/${id}` };
}
function playlist(id: string): IdentifiedSource | null {
  if (!PLAYLIST_RE.test(id)) return null;
  return { platform: P, type: "playlist", externalId: id, canonicalUrl: `https://www.youtube.com/playlist?list=${id}` };
}
function handle(h: string): IdentifiedSource | null {
  if (!HANDLE_RE.test(h)) return null;
  return { platform: P, type: "channel", externalId: h, handle: h, canonicalUrl: `https://www.youtube.com/${h}` };
}

/** Strict YouTube input identification. Returns null for anything not recognised. */
export function identifyYouTube(input: string): IdentifiedSource | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s || s.length > 2048 || /[\s\0]/.test(s)) return null;

  if (s.startsWith("@")) return handle(s);
  if (CHANNEL_RE.test(s)) return channel(s);

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443" && url.port !== "80") return null;
  const host = url.hostname.toLowerCase();
  const segs = url.pathname.split("/").filter((x) => x.length > 0);
  const dec = (x: string | undefined): string => {
    try {
      return decodeURIComponent(x ?? "");
    } catch {
      return "";
    }
  };

  if (host === "youtu.be") {
    if (segs.length !== 1) return null;
    return video(dec(segs[0]));
  }
  if (!HOSTS.has(host)) return null;
  if (segs.length === 0) return null;

  const first = dec(segs[0]);
  if (first.startsWith("@")) return segs.length >= 1 ? handle(first) : null;

  switch (first) {
    case "watch": {
      const v = url.searchParams.get("v");
      return v ? video(v) : null;
    }
    case "playlist": {
      const l = url.searchParams.get("list");
      return l ? playlist(l) : null;
    }
    case "shorts":
    case "live":
    case "embed":
    case "v":
      return segs.length >= 2 && first !== "v" && first !== "embed" ? video(dec(segs[1])) : null;
    case "channel":
      return segs.length >= 2 ? channel(dec(segs[1])) : null;
    case "c":
    case "user": {
      const name = dec(segs[1]);
      if (!name || !LEGACY_RE.test(name)) return null;
      return {
        platform: P,
        type: "channel",
        externalId: `${first}/${name}`,
        canonicalUrl: `https://www.youtube.com/${first}/${name}`,
      };
    }
    default:
      return null;
  }
}
