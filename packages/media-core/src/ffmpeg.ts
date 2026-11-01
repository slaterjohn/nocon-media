import fs from "node:fs";
import path from "node:path";
import { runProcess, type RunProcessResult } from "@nocon/source-adapters";

export interface FfmpegOpts {
  /** Prefix with `nice -n 10`. */
  nice?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Input options for local files only: no network, concat, subfile or other nested protocols. */
const LOCAL_IN = ["-protocol_whitelist", "file,pipe"];

async function ff(ffmpegPath: string, args: string[], o: FfmpegOpts = {}): Promise<RunProcessResult> {
  const base = ["-hide_banner", "-nostdin", "-y", "-v", "error", ...args];
  const [cmd, a] = o.nice ? ["nice", ["-n", "10", ffmpegPath, ...base]] : [ffmpegPath, base];
  const r = await runProcess(cmd as string, a as string[], { signal: o.signal, timeoutMs: o.timeoutMs ?? 30 * 60_000, maxStdoutBytes: 64 * 1024 });
  return r;
}
function ensure(r: RunProcessResult, what: string): void {
  if (r.exitCode !== 0) throw new Error(`${what} failed (exit ${r.exitCode}): ${r.stderrTail.slice(-400)}`);
}

export async function remuxToMp4(ffmpegPath: string, input: string, output: string, o?: FfmpegOpts): Promise<void> {
  ensure(await ff(ffmpegPath, [...LOCAL_IN, "-i", input, "-c", "copy", "-movflags", "+faststart", output], o), "remux");
}

export async function extractThumbnail(ffmpegPath: string, input: string, output: string, atSeconds: number, o?: FfmpegOpts): Promise<void> {
  ensure(await ff(ffmpegPath, ["-ss", String(Math.max(0, atSeconds)), ...LOCAL_IN, "-i", input, "-frames:v", "1", "-q:v", "3", output], o), "thumbnail");
  if (!fs.existsSync(output)) throw new Error("thumbnail not produced");
}

export async function hlsRemux(ffmpegPath: string, input: string, outDir: string, o?: FfmpegOpts): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  const playlist = path.join(outDir, "index.m3u8");
  const common = ["-f", "hls", "-hls_time", "6", "-hls_playlist_type", "vod", "-hls_segment_filename", path.join(outDir, "seg_%05d.ts"), playlist];
  let r = await ff(ffmpegPath, [...LOCAL_IN, "-i", input, "-c", "copy", ...common], o);
  if (r.exitCode !== 0) {
    r = await ff(ffmpegPath, [...LOCAL_IN, "-i", input, "-c:v", "copy", "-c:a", "aac", ...common], o);
    ensure(r, "hls remux");
  }
  return playlist;
}
