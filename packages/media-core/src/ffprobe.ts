import path from "node:path";
import { runProcess } from "@nocon/source-adapters";

export interface ProbeResult {
  container: string;
  durationSeconds: number;
  sizeBytes: number;
  bitrate: number;
  video: { codec: string; width: number; height: number } | null;
  audio: { codec: string } | null;
}

export async function probe(ffprobePath: string, file: string): Promise<ProbeResult> {
  // Absolute paths can never be mistaken for options, so no "--" (older ffprobe builds reject it).
  // Local files only: no network or concat/subfile protocols.
  const abs = path.resolve(file);
  const r = await runProcess(ffprobePath, ["-v", "error", "-protocol_whitelist", "file,pipe", "-print_format", "json", "-show_format", "-show_streams", abs], { timeoutMs: 60_000, maxStdoutBytes: 4 * 1024 * 1024 });
  if (r.exitCode !== 0) throw new Error(`ffprobe failed: ${r.stderrTail.slice(-300)}`);
  const j = JSON.parse(r.stdout) as { format?: Record<string, string>; streams?: Record<string, any>[] };
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const a = streams.find((s) => s.codec_type === "audio");
  const f = j.format ?? {};
  return {
    container: String(f.format_name ?? ""),
    durationSeconds: Number(f.duration ?? v?.duration ?? a?.duration ?? 0) || 0,
    sizeBytes: Number(f.size ?? 0) || 0,
    bitrate: Number(f.bit_rate ?? 0) || 0,
    video: v ? { codec: String(v.codec_name), width: Number(v.width) || 0, height: Number(v.height) || 0 } : null,
    audio: a ? { codec: String(a.codec_name) } : null,
  };
}

export function validateMedia(p: ProbeResult): { ok: boolean; reason?: string } {
  if (!(p.durationSeconds > 0)) return { ok: false, reason: "duration is zero" };
  if (!p.video && !p.audio) return { ok: false, reason: "no audio or video streams" };
  return { ok: true };
}
