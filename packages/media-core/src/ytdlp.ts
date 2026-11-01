import { runProcess } from "@nocon/source-adapters";

export interface DownloadArgsInput {
  url: string;
  outputDir: string;
  resolution?: number;
  audioOnly: boolean;
  subtitles: { enabled: boolean; languages: string[]; auto: boolean };
  cookiesFile?: string;
  extraArgs?: string[];
}

export const PROGRESS_PREFIX = "NOCON";
export const PROGRESS_TEMPLATE =
  "download:NOCON %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s";

export function formatSelector(height: number): string {
  const H = height;
  return `bv*[height<=${H}][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=${H}][ext=mp4]/bv*[height<=${H}]+ba/b[height<=${H}]/b`;
}

export function buildDownloadArgs(i: DownloadArgsInput): string[] {
  const a: string[] = ["--ignore-config", "--no-warnings"];
  if (process.env.NOCON_YTDLP_NO_JS_RUNTIME !== "1") a.push("--js-runtimes", "node");
  a.push("--no-playlist", "--newline", "--continue");
  a.push("-f", i.audioOnly ? "ba[ext=m4a]/ba" : formatSelector(i.resolution ?? 1080));
  if (!i.audioOnly) a.push("--merge-output-format", "mp4");
  a.push("-o", `${i.outputDir.replace(/\/+$/, "")}/media.%(ext)s`);
  a.push("--write-info-json", "--write-thumbnail", "--convert-thumbnails", "jpg");
  if (i.subtitles.enabled) {
    const langs = i.subtitles.languages.filter((l) => /^[A-Za-z0-9_.*-]+$/.test(l));
    a.push("--write-subs");
    if (i.subtitles.auto) a.push("--write-auto-subs");
    a.push("--sub-langs", langs.length ? langs.join(",") : "en", "--convert-subs", "vtt");
  }
  a.push("--progress-template", PROGRESS_TEMPLATE);
  if (i.cookiesFile) a.push("--cookies", i.cookiesFile);
  a.push(...(i.extraArgs ?? []));
  a.push("--", i.url);
  return a;
}

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  speedBps: number | null;
  etaSeconds: number | null;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || s === "NA" || s === "None" || s === "" || s === "null") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function parseProgressLine(line: string): DownloadProgress | null {
  const m = /^(?:download:)?NOCON\s+(.*)$/.exec(line.trim());
  if (!m) return null;
  const p = m[1]!.trim().split(/\s+/);
  if (p.length < 5) return null;
  const downloaded = num(p[0]);
  if (downloaded === null) return null;
  return { downloadedBytes: downloaded, totalBytes: num(p[1]) ?? num(p[2]), speedBps: num(p[3]), etaSeconds: num(p[4]) };
}

export interface RunDownloadOptions {
  ytDlpPath: string;
  args: string[];
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  timeoutMs?: number;
  /** e.g. ["nice","-n","10"] style prefix: command wrapper. */
  nice?: boolean;
}

export async function runDownload(o: RunDownloadOptions): Promise<{ exitCode: number | null; stderrTail: string; timedOut: boolean; aborted: boolean }> {
  const [cmd, args] = o.nice ? ["nice", ["-n", "10", o.ytDlpPath, ...o.args]] : [o.ytDlpPath, o.args];
  const r = await runProcess(cmd as string, args as string[], {
    signal: o.signal,
    timeoutMs: o.timeoutMs,
    maxStdoutBytes: 1024 * 1024,
    onStdoutLine: (l) => {
      const p = parseProgressLine(l);
      if (p) o.onProgress?.(p);
    },
  });
  return { exitCode: r.exitCode, stderrTail: r.stderrTail, timedOut: r.timedOut, aborted: r.aborted };
}
