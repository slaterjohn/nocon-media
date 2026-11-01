import { spawn } from "node:child_process";

export interface RunProcessOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Cap for collected stdout (bytes). Excess is discarded and `stdoutTruncated` set. */
  maxStdoutBytes?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Bytes of stderr tail kept. */
  stderrTailBytes?: number;
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stdoutTruncated: boolean;
  stderrTail: string;
  timedOut: boolean;
  aborted: boolean;
}

const ENV_ALLOW = new Set([
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "XDG_CACHE_HOME", "TMPDIR", "FFMPEG_PATH",
  // network plumbing yt-dlp needs on proxied / custom-CA hosts
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
]);
const ENV_ALLOW_PREFIXES = ["NOCON_YTDLP_", "FAKE_YTDLP_"];

/** Minimal child environment: secrets such as DATABASE_URL / REDIS_URL / NOCON_PROXY_SECRET never reach yt-dlp or ffmpeg. */
export function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && (ENV_ALLOW.has(k) || ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p)))) out[k] = v;
  }
  return out;
}

export class ProcessSpawnError extends Error {}

const KILL_GRACE_MS = 5000;

/** Spawns a process with an argument array (never a shell). Resolves even on non-zero exit. */
export function runProcess(cmd: string, args: string[], opts: RunProcessOptions = {}): Promise<RunProcessResult> {
  const maxStdout = opts.maxStdoutBytes ?? 64 * 1024 * 1024;
  const tailMax = opts.stderrTailBytes ?? 16 * 1024;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ exitCode: null, signal: null, stdout: "", stdoutTruncated: false, stderrTail: "", timedOut: false, aborted: true });
      return;
    }
    const child = spawn(cmd, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
      env: opts.env ?? childEnv(),
    });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;
    let stderrTail = "";
    let timedOut = false;
    let aborted = false;
    let outRemainder = "";
    let errRemainder = "";
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, opts.timeoutMs);
    }

    const feedLines = (buf: string, remainder: string, cb?: (l: string) => void): string => {
      if (!cb) return "";
      const text = remainder + buf;
      const parts = text.split(/\r\n|\n|\r/);
      const rest = parts.pop() ?? "";
      for (const p of parts) if (p.length) cb(p);
      return rest;
    };

    child.stdout.on("data", (d: Buffer) => {
      if (stdoutBytes < maxStdout) {
        const room = maxStdout - stdoutBytes;
        if (d.length > room) {
          chunks.push(d.subarray(0, room));
          stdoutBytes += room;
          truncated = true;
        } else {
          chunks.push(d);
          stdoutBytes += d.length;
        }
      } else truncated = true;
      outRemainder = feedLines(d.toString("utf8"), outRemainder, opts.onStdoutLine);
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stderrTail = (stderrTail + s).slice(-tailMax);
      errRemainder = feedLines(s, errRemainder, opts.onStderrLine);
    });

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ProcessSpawnError(`Failed to spawn ${cmd}: ${err.message}`));
    });
    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (outRemainder && opts.onStdoutLine) opts.onStdoutLine(outRemainder);
      if (errRemainder && opts.onStderrLine) opts.onStderrLine(errRemainder);
      resolve({
        exitCode: code,
        signal: sig,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stdoutTruncated: truncated,
        stderrTail,
        timedOut,
        aborted,
      });
    });
  });
}
