import { safeSegment } from "@nocon/shared";

export const FILES = {
  media: "media",
  sidecar: "metadata.json",
  thumbnail: "media.jpg",
  info: "media.info.json",
  hlsDir: "hls",
  hlsPlaylist: "index.m3u8",
  incomingMarker: ".incoming-",
  volumeMeta: ".noconmedia",
} as const;

export function mediaDirFor(i: { platform: string; channelId?: string | null; externalId: string }): string {
  const p = safeSegment(i.platform);
  const id = safeSegment(i.externalId);
  if (i.channelId) return `${p}/channels/${safeSegment(i.channelId)}/${id}`;
  return `${p}/videos/${id}`;
}

export function creatorArtworkDir(platform: string, channelId: string): string {
  return `${safeSegment(platform)}/channels/${safeSegment(channelId)}/_channel`;
}
