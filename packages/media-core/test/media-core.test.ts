import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDownloadArgs, creatorArtworkDir, extractThumbnail, hlsRemux, inspectStaging, mediaDirFor, moveIntoLibrary,
  parseProgressLine, probe, readSidecar, remuxToMp4, runDownload, scanLibrary, sha256File, validateMedia, validateSidecar, writeSidecar,
  type DownloadProgress,
} from "../src/index.js";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const FAKE = path.resolve(__dirname, "../../../tests/fixtures/fake-yt-dlp.mjs");
let tmp: string;
let clip: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nocon-mc-"));
  clip = path.join(tmp, "clip.mp4");
  execFileSync(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=25", "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clip]);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("buildDownloadArgs", () => {
  const base = { url: "https://www.youtube.com/watch?v=abcdefghijk", outputDir: "/tmp/stage", audioOnly: false, subtitles: { enabled: false, languages: [], auto: false } };
  it("builds video args", () => {
    const a = buildDownloadArgs(base);
    expect(a).toContain("--ignore-config");
    expect(a[a.indexOf("-f") + 1]).toBe("bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]/b");
    expect(a).toContain("--merge-output-format");
    expect(a[a.indexOf("-o") + 1]).toBe("/tmp/stage/media.%(ext)s");
    expect(a.slice(-2)).toEqual(["--", base.url]);
    expect(a.indexOf("--js-runtimes")).toBeGreaterThan(-1);
    expect(a).not.toContain("--write-subs");
  });
  it("resolution, audio only, subs, cookies", () => {
    expect(buildDownloadArgs({ ...base, resolution: 720 })[buildDownloadArgs({ ...base, resolution: 720 }).indexOf("-f") + 1]).toContain("height<=720");
    const au = buildDownloadArgs({ ...base, audioOnly: true });
    expect(au[au.indexOf("-f") + 1]).toBe("ba[ext=m4a]/ba");
    expect(au).not.toContain("--merge-output-format");
    const s = buildDownloadArgs({ ...base, subtitles: { enabled: true, languages: ["en", "fr"], auto: true }, cookiesFile: "/c.txt", extraArgs: ["--limit-rate", "1M"] });
    expect(s).toContain("--write-auto-subs");
    expect(s[s.indexOf("--sub-langs") + 1]).toBe("en,fr");
    expect(s[s.indexOf("--convert-subs") + 1]).toBe("vtt");
    expect(s[s.indexOf("--cookies") + 1]).toBe("/c.txt");
    expect(s).toContain("--limit-rate");
    expect(s.indexOf("--limit-rate")).toBeLessThan(s.indexOf("--"));
  });
  it("honours js runtime opt-out", () => {
    process.env.NOCON_YTDLP_NO_JS_RUNTIME = "1";
    try {
      expect(buildDownloadArgs(base)).not.toContain("--js-runtimes");
    } finally {
      delete process.env.NOCON_YTDLP_NO_JS_RUNTIME;
    }
  });
});

describe("parseProgressLine", () => {
  it("parses", () => {
    expect(parseProgressLine("download:NOCON 500 1000 NA 250.5 2")).toEqual({ downloadedBytes: 500, totalBytes: 1000, speedBps: 250.5, etaSeconds: 2 });
    expect(parseProgressLine("NOCON 500 NA 2000 None NA")).toEqual({ downloadedBytes: 500, totalBytes: 2000, speedBps: null, etaSeconds: null });
    expect(parseProgressLine("NOCON 5 NA NA NA NA")).toEqual({ downloadedBytes: 5, totalBytes: null, speedBps: null, etaSeconds: null });
    expect(parseProgressLine("[download] 10%")).toBeNull();
    expect(parseProgressLine("NOCON NA NA NA NA NA")).toBeNull();
  });
});

describe("layout", () => {
  it("dirs", () => {
    expect(mediaDirFor({ platform: "youtube", channelId: "UC1", externalId: "vid" })).toBe("youtube/channels/UC1/vid");
    expect(mediaDirFor({ platform: "youtube", externalId: "vid" })).toBe("youtube/videos/vid");
    expect(mediaDirFor({ platform: "youtube", channelId: "../x", externalId: "a/b" })).toBe("youtube/channels/__x/a_b");
    expect(creatorArtworkDir("youtube", "UC1")).toBe("youtube/channels/UC1/_channel");
  });
});

describe("ffprobe/ffmpeg", () => {
  it("probes and validates", async () => {
    const p = await probe(FFPROBE, clip);
    expect(p.video).toMatchObject({ codec: "h264", width: 320, height: 240 });
    expect(p.audio?.codec).toBe("aac");
    expect(p.durationSeconds).toBeGreaterThan(1.5);
    expect(p.sizeBytes).toBeGreaterThan(0);
    expect(validateMedia(p)).toEqual({ ok: true });
    expect(validateMedia({ ...p, durationSeconds: 0 }).ok).toBe(false);
    expect(validateMedia({ ...p, video: null, audio: null }).ok).toBe(false);
  });
  it("probe fails on garbage", async () => {
    const f = path.join(tmp, "bad.mp4");
    fs.writeFileSync(f, "nope");
    await expect(probe(FFPROBE, f)).rejects.toThrow();
  });
  it("remuxes, thumbnails, hls", async () => {
    const out = path.join(tmp, "remux.mp4");
    await remuxToMp4(FFMPEG, clip, out);
    expect((await probe(FFPROBE, out)).video?.codec).toBe("h264");
    const th = path.join(tmp, "t.jpg");
    await extractThumbnail(FFMPEG, clip, th, 1);
    expect(fs.statSync(th).size).toBeGreaterThan(100);
    const hls = path.join(tmp, "hls");
    const pl = await hlsRemux(FFMPEG, clip, hls);
    expect(fs.readFileSync(pl, "utf8")).toContain("#EXT-X-ENDLIST");
    expect(fs.readdirSync(hls).some((f) => /^seg_\d{5}\.ts$/.test(f))).toBe(true);
  });
  it("remux works with nice", async () => {
    const out = path.join(tmp, "remux2.mp4");
    await remuxToMp4(FFMPEG, clip, out, { nice: true });
    expect(fs.existsSync(out)).toBe(true);
  });
});

describe("fake yt-dlp end to end + finalise + reconcile", () => {
  it("downloads, inspects, finalises, scans", async () => {
    process.env.FFMPEG_PATH = FFMPEG;
    const stage = path.join(tmp, "stage1");
    const url = "https://www.youtube.com/watch?v=fakevid0002";
    const args = buildDownloadArgs({ url, outputDir: stage, audioOnly: false, subtitles: { enabled: true, languages: ["en"], auto: false } });
    const progress: DownloadProgress[] = [];
    const r = await runDownload({ ytDlpPath: FAKE, args, onProgress: (p) => progress.push(p), timeoutMs: 60_000 });
    expect(r.exitCode).toBe(0);
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.at(-1)!.downloadedBytes).toBe(progress.at(-1)!.totalBytes);

    const insp = await inspectStaging(stage);
    expect(insp.mainFile).toBe("media.mp4");
    expect(insp.thumbnail).toBe("media.jpg");
    expect(insp.subtitles).toEqual([{ language: "en", file: "media.en.vtt" }]);
    expect(insp.chapters).toHaveLength(2);
    expect(insp.info?.id).toBe("fakevid0002");

    const pr = await probe(FFPROBE, path.join(stage, insp.mainFile!));
    expect(pr.video).toMatchObject({ codec: "h264", width: 160, height: 120 });
    expect(validateMedia(pr).ok).toBe(true);

    const volume = path.join(tmp, "volume");
    fs.mkdirSync(path.join(volume, ".noconmedia"), { recursive: true });
    const relDir = mediaDirFor({ platform: "youtube", channelId: "UCfakechannel0000000000a", externalId: "fakevid0002" });
    const sha = await sha256File(path.join(stage, "media.mp4"));
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    await writeSidecar(stage, {
      canonicalKey: "youtube:fakevid0002", originalUrl: url, title: "Fake video 2", description: "d",
      creator: { id: "UCfakechannel0000000000a", name: "Fake Channel" }, publishedAt: "2026-10-02T00:00:00.000Z",
      durationSeconds: pr.durationSeconds, categories: ["Education"], tags: ["fake"],
      technical: { container: pr.container, videoCodec: "h264", audioCodec: "aac", width: 160, height: 120, bitrate: pr.bitrate, sizeBytes: pr.sizeBytes },
      artwork: { thumbnail: "media.jpg" }, subtitles: insp.subtitles, chapters: insp.chapters, mainFile: "media.mp4", checksums: { sha256: sha },
    });
    expect(fs.readdirSync(stage).some((f) => f.includes(".tmp-"))).toBe(false);

    const moved = await moveIntoLibrary(stage, volume, relDir);
    expect(fs.existsSync(stage)).toBe(false);
    expect(moved.files).toContain(`${relDir}/media.mp4`);
    expect(moved.files).toContain(`${relDir}/metadata.json`);
    expect(fs.readdirSync(path.dirname(path.join(volume, relDir)))).toEqual(["fakevid0002"]);

    // overwrite existing target
    const stage2 = path.join(tmp, "stage2");
    fs.mkdirSync(stage2);
    fs.writeFileSync(path.join(stage2, "media.mp4"), "replacement");
    await moveIntoLibrary(stage2, volume, relDir);
    expect(fs.readFileSync(path.join(volume, relDir, "media.mp4"), "utf8")).toBe("replacement");
    expect(fs.existsSync(path.join(volume, relDir, "metadata.json"))).toBe(false);
    expect(fs.readdirSync(path.dirname(path.join(volume, relDir)))).toEqual(["fakevid0002"]);
    await expect(moveIntoLibrary(stage2, volume, "../escape")).rejects.toThrow();
  });

  it("scans library non-destructively", async () => {
    const volume = path.join(tmp, "vol2");
    fs.mkdirSync(path.join(volume, ".noconmedia"), { recursive: true });
    const mk = async (rel: string, withThumb: boolean) => {
      const d = path.join(volume, rel);
      fs.mkdirSync(d, { recursive: true });
      fs.copyFileSync(clip, path.join(d, "media.mp4"));
      if (withThumb) fs.writeFileSync(path.join(d, "media.jpg"), "x");
      await writeSidecar(d, {
        canonicalKey: `youtube:${path.basename(rel)}`, originalUrl: "u", title: "t", description: "", creator: { id: "c", name: "n" }, publishedAt: null,
        durationSeconds: 2, categories: [], tags: [], technical: {}, artwork: { thumbnail: "media.jpg" }, subtitles: [], chapters: [], mainFile: "media.mp4", checksums: { sha256: await sha256File(path.join(d, "media.mp4")) },
      });
    };
    await mk("youtube/channels/UC1/aaa", true);
    await mk("youtube/videos/bbb", false);
    fs.mkdirSync(path.join(volume, "youtube/channels/UC1/_channel"), { recursive: true });
    fs.writeFileSync(path.join(volume, "youtube/channels/UC1/_channel/avatar.jpg"), "x");
    fs.mkdirSync(path.join(volume, "youtube/videos/orphan"), { recursive: true });
    fs.writeFileSync(path.join(volume, "youtube/videos/orphan/media.mp4"), "x");
    fs.mkdirSync(path.join(volume, "youtube/videos/ccc.incoming-abc123"), { recursive: true });
    fs.mkdirSync(path.join(volume, "youtube/videos/bad"), { recursive: true });
    fs.writeFileSync(path.join(volume, "youtube/videos/bad/metadata.json"), "{not json");
    const before = fs.readdirSync(volume, { recursive: true }).sort();

    const r = await scanLibrary(volume);
    expect(r.items.map((i) => i.relDir)).toEqual(["youtube/channels/UC1/aaa", "youtube/videos/bbb"]);
    expect(r.items[0]!.missingFiles).toEqual([]);
    expect(r.items[1]!.missingFiles).toEqual(["media.jpg"]);
    expect(r.orphanDirs).toEqual(["youtube/videos/ccc.incoming-abc123", "youtube/videos/orphan"]);
    expect(r.errors.map((e) => e.relDir)).toEqual(["youtube/videos/bad"]);
    expect(fs.readdirSync(volume, { recursive: true }).sort()).toEqual(before);
    await expect(readSidecar(path.join(volume, "youtube/videos/bad/metadata.json"))).rejects.toThrow();
  });

  it("reports failure from fake", async () => {
    process.env.FAKE_YTDLP_FAIL = "fakevid0001";
    try {
      const args = buildDownloadArgs({ url: "https://www.youtube.com/watch?v=fakevid0001", outputDir: path.join(tmp, "stage3"), audioOnly: false, subtitles: { enabled: false, languages: [], auto: false } });
      const r = await runDownload({ ytDlpPath: FAKE, args });
      expect(r.exitCode).toBe(1);
      expect(r.stderrTail).toContain("Video unavailable");
    } finally {
      delete process.env.FAKE_YTDLP_FAIL;
    }
  });
});

describe("validateSidecar referenced files (M5)", () => {
  const good = () => ({
    version: 1, canonicalKey: "youtube:aaaaaaaaaaa", originalUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa", title: "t", description: "",
    creator: { id: "", name: "c" }, publishedAt: null, durationSeconds: 1, categories: [], tags: [], downloadedAt: "x", technical: {},
    artwork: { thumbnail: "thumbnail.jpg" }, subtitles: [{ language: "en", file: "subtitles.en.vtt" }], chapters: [], mainFile: "video.mp4", checksums: { sha256: "ab" },
  });
  it("accepts plain filenames", () => expect(() => validateSidecar(good())).not.toThrow());
  const mutate: Array<[string, (s: any) => void]> = [
    ["thumbnail with a slash", (s) => { s.artwork.thumbnail = "sub/thumb.jpg"; }],
    ["thumbnail traversal", (s) => { s.artwork.thumbnail = "../../etc/passwd"; }],
    ["thumbnail NUL", (s) => { s.artwork.thumbnail = "a\0.jpg"; }],
    ["subtitle traversal", (s) => { s.subtitles[0].file = "../x.vtt"; }],
    ["subtitle absolute", (s) => { s.subtitles[0].file = "/etc/passwd"; }],
    ["subtitle backslash", (s) => { s.subtitles[0].file = "a\\b.vtt"; }],
    ["subtitle not a string", (s) => { s.subtitles[0].file = 5; }],
    ["info traversal", (s) => { s.info = "../info.json"; }],
    ["mainFile NUL", (s) => { s.mainFile = "v\0.mp4"; }],
  ];
  it.each(mutate)("rejects %s", (_n, fn) => { const s = good(); fn(s); expect(() => validateSidecar(s)).toThrow(/Invalid sidecar/); });
});

describe("ffprobe argument handling (L6)", () => {
  it("probes a local file without the -- separator", async () => {
    const r = await probe(FFPROBE, clip);
    expect(r.video?.width).toBe(320);
  });
  it("refuses network protocols as input", async () => {
    await expect(probe(FFPROBE, "http://127.0.0.1:9/x.mp4")).rejects.toThrow();
  });
  it("remuxes with the local-only protocol whitelist", async () => {
    const out = path.join(tmp, "wl.mp4");
    await remuxToMp4(FFMPEG, clip, out);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
  });
});
