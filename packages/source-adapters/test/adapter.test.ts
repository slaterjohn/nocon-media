import path from "node:path";
import { describe, expect, it } from "vitest";
import { estimateBytes, getAdapter, mapFlatEntry, mapMediaInfo, mapSourceInfo, classifyYouTubeError, runProcess } from "../src/index.js";

const FAKE = path.resolve(__dirname, "../../../tests/fixtures/fake-yt-dlp.mjs");
const adapter = getAdapter("youtube", { ytDlpPath: FAKE, extraArgs: [] });

describe("classifyError", () => {
  const cases: [string, string][] = [
    ["ERROR: [youtube] x: Video unavailable", "unavailable"],
    ["This video has been removed by the uploader", "unavailable"],
    ["The uploader: not available in your country", "unavailable"],
    ["ERROR: Private video. Sign in", "private"],
    ["Join this channel to get access to members-only content", "private"],
    ["Sign in to confirm your age", "private"],
    ["HTTP Error 429: Too Many Requests", "rate_limited"],
    ["You are being rate-limited", "rate_limited"],
    ["Sign in to confirm you’re not a bot", "rate_limited"],
    ["Sign in to confirm you're not a bot", "rate_limited"],
    ["Unable to download webpage: boom", "network"],
    ["getaddrinfo failed", "network"],
    ["read timed out", "network"],
    ["Network is unreachable", "network"],
    ["Connection refused", "network"],
    ["Temporary failure in name resolution", "network"],
    ["something odd", "unknown"],
    ["", "unknown"],
  ];
  it.each(cases)("%s -> %s", (s, c) => expect(classifyYouTubeError(s)).toBe(c));
});

describe("mapFlatEntry", () => {
  it("maps flat playlist entry", () => {
    const e = mapFlatEntry(
      { id: "abcdefghijk", title: "T", duration: 61.4, upload_date: "20261031", channel_id: "UC1", channel: "C", live_status: "is_live", url: "https://www.youtube.com/shorts/abcdefghijk", playlist_index: 3, thumbnails: [{ url: "a", width: 1, height: 1 }, { url: "b", width: 10, height: 10 }], view_count: 5, description: "d" },
      false,
    )!;
    expect(e).toMatchObject({ externalId: "abcdefghijk", canonicalKey: "youtube:abcdefghijk", title: "T", durationSeconds: 61, channelId: "UC1", channelName: "C", isShort: true, isLive: true, position: 3, thumbnailUrl: "b", viewCount: 5, description: "d" });
    expect(e.publishedAt!.toISOString()).toBe("2026-10-31T00:00:00.000Z");
  });
  it("falls back to timestamp and skips invalid ids", () => {
    expect(mapFlatEntry({ id: "abcdefghijk", timestamp: 1_700_000_000 }, true)!.publishedAt!.getTime()).toBe(1_700_000_000_000);
    expect(mapFlatEntry({ id: "short" }, false)).toBeNull();
  });
});

describe("estimateBytes", () => {
  it("sums requested formats", () => {
    expect(estimateBytes({ requested_formats: [{ filesize: 100 }, { filesize_approx: 50 }] })).toBe(150);
  });
  it("uses filesize", () => expect(estimateBytes({ filesize: 42 })).toBe(42));
  it("uses bitrate by height", () => {
    expect(estimateBytes({ duration: 80, height: 1080 })).toBe((80 * 6_000_000) / 8);
    expect(estimateBytes({ duration: 80, height: 2160 })).toBe((80 * 20_000_000) / 8);
    expect(estimateBytes({ duration: 80, height: 720 })).toBe((80 * 3_000_000) / 8);
    expect(estimateBytes({ duration: 80, height: 480 })).toBe((80 * 1_500_000) / 8);
    expect(estimateBytes({ duration: 80, height: 360 })).toBe((80 * 1_000_000) / 8);
    expect(estimateBytes({ duration: 80 })).toBe((80 * 200_000) / 8);
  });
  it("falls back to 2 GiB", () => expect(estimateBytes({})).toBe(2 * 1024 ** 3));
});

describe("mappers", () => {
  it("source info prefers uncropped", () => {
    const i = mapSourceInfo({ channel: "C", description: "D", channel_id: "UC1", thumbnails: [{ id: "avatar_uncropped", url: "A" }, { id: "banner_uncropped", url: "B" }] });
    expect(i).toMatchObject({ title: "C", description: "D", avatarUrl: "A", bannerUrl: "B", channelId: "UC1" });
  });
  it("media info", () => {
    const m = mapMediaInfo({ title: "t", duration: 10, upload_date: "20260101", channel_id: "UC1", channel: "C", chapters: [{ start_time: 0, end_time: 5, title: "x" }], subtitles: { en: [] }, tags: ["a"] });
    expect(m.chapters).toEqual([{ start: 0, end: 5, title: "x" }]);
    expect(m.subtitleLanguages).toEqual(["en"]);
    expect(m.channel.url).toBe("https://www.youtube.com/channel/UC1");
  });
});

describe("YouTubeAdapter with fake yt-dlp", () => {
  const ch = adapter.identify("UCfakechannel0000000000a")!;
  it("discovers channel with limit/offset", async () => {
    const all = await adapter.discover(ch, { limit: 10 });
    expect(all.map((e) => e.externalId)).toEqual(["fakevid0001", "fakevid0002", "fakevid0003"]);
    expect(all[0]!.channelId).toBe("UCfakechannel0000000000a");
    const page = await adapter.discover(ch, { limit: 1, offset: 1 });
    expect(page.map((e) => e.externalId)).toEqual(["fakevid0002"]);
  });
  it("discovers playlist", async () => {
    const p = adapter.identify("https://www.youtube.com/playlist?list=PLfakeplaylist0001")!;
    const e = await adapter.discover(p, { limit: 10 });
    expect(e.map((x) => x.position)).toEqual([1, 2]);
  });
  it("source info", async () => {
    const i = await adapter.fetchSourceInfo(ch);
    expect(i.avatarUrl).toContain("avatar-uncropped");
    expect(i.bannerUrl).toContain("banner-uncropped");
  });
  it("media info", async () => {
    const m = await adapter.fetchMediaInfo("https://www.youtube.com/watch?v=fakevid0001");
    expect(m.estimatedBytes).toBe(5_500_000);
    expect(m.chapters).toHaveLength(2);
    expect(m.categories).toEqual(["Education"]);
  });
  it("search", async () => {
    const r = await adapter.search!("anything", 2);
    expect(r).toHaveLength(2);
  });
  it("classifies failures", async () => {
    const prev = process.env.FAKE_YTDLP_FAIL;
    process.env.FAKE_YTDLP_FAIL = "fakevid0001";
    try {
      await expect(adapter.fetchMediaInfo("https://www.youtube.com/watch?v=fakevid0001")).rejects.toMatchObject({ errorClass: "unavailable" });
    } finally {
      if (prev === undefined) delete process.env.FAKE_YTDLP_FAIL;
      else process.env.FAKE_YTDLP_FAIL = prev;
    }
  });
});

describe("runProcess", () => {
  it("collects output and caps stdout", async () => {
    const lines: string[] = [];
    const r = await runProcess(process.execPath, ["-e", "console.log('a');console.log('b'.repeat(100));console.error('err')"], { maxStdoutBytes: 10, onStdoutLine: (l) => lines.push(l) });
    expect(r.exitCode).toBe(0);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stdout.length).toBe(10);
    expect(r.stderrTail).toContain("err");
    expect(lines).toHaveLength(2);
  });
  it("times out", async () => {
    const r = await runProcess(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
  });
  it("aborts", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await runProcess(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { signal: ac.signal });
    expect(r.aborted).toBe(true);
  });
});

describe("security: child env and URL vetting (L5, M5)", () => {
  it("child processes get a minimal environment", async () => {
    process.env.NOCON_TEST_SECRET = "s3cret";
    process.env.DATABASE_URL_TEST_ONLY = "postgres://x";
    process.env.FAKE_YTDLP_KEEP = "yes";
    try {
      const r = await runProcess(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"]);
      const env = JSON.parse(r.stdout) as Record<string, string>;
      expect(env.NOCON_TEST_SECRET).toBeUndefined();
      expect(env.DATABASE_URL_TEST_ONLY).toBeUndefined();
      expect(env.FAKE_YTDLP_KEEP).toBe("yes");
      expect(env.PATH).toBeTruthy();
    } finally {
      delete process.env.NOCON_TEST_SECRET; delete process.env.DATABASE_URL_TEST_ONLY; delete process.env.FAKE_YTDLP_KEEP;
    }
  });
  it("callers can still pass env explicitly", async () => {
    const r = await runProcess(process.execPath, ["-e", "console.log(process.env.X)"], { env: { X: "1" } });
    expect(r.stdout.trim()).toBe("1");
  });
  it.each(["https://evil.example/watch?v=aaaaaaaaaaa", "file:///etc/passwd", "https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa", "-J"])(
    "fetchMediaInfo refuses %s", async (url) => {
      await expect(adapter.fetchMediaInfo(url)).rejects.toMatchObject({ name: "AdapterError", errorClass: "invalid" });
    });
});
