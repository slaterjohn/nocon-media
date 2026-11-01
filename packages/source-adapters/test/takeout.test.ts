import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { parseTakeout, parseTakeoutDate } from "../src/index.js";

const json = [
  { header: "YouTube", title: "Watched Video One", titleUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa", subtitles: [{ name: "Chan A", url: "https://www.youtube.com/channel/UCx" }], time: "2026-11-01T14:03:22.000Z" },
  { header: "YouTube", title: "Watched Video One", titleUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa", subtitles: [], time: "2026-11-01T14:03:22.000Z" },
  { header: "YouTube", title: "Watched Video One", titleUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa", time: "2026-11-02T10:00:00.000Z" },
  { header: "YouTube", title: "Watched a video that has been removed", titleUrl: "https://www.youtube.com/watch?v=", time: "2026-11-01T14:03:22.000Z" },
  { header: "YouTube", title: "Viewed ad", time: "2026-11-01T14:03:22.000Z" },
  { header: "YouTube", title: "Watched Evil", titleUrl: "https://evil.com/watch?v=bbbbbbbbbbb", time: "2026-11-01T14:03:22.000Z" },
  { header: "YouTube", title: "Watched Two", titleUrl: "https://youtu.be/bbbbbbbbbbb", time: "not a date" },
];

const html = `<html><body><div class="mdl-grid">
<div class="content-cell">Watched&nbsp;<a href="https://www.youtube.com/watch?v=ccccccccccc">Cool &amp; Good</a><br><a href="https://www.youtube.com/channel/UCabc">The Channel</a><br>1 Nov 2026, 14:03:22 GMT</div>
<div class="content-cell">Watched <a href="https://www.youtube.com/watch?v=ddddddddddd">Second</a><br>Nov 1, 2026, 2:03:22 PM PST</div>
<div class="content-cell">Watched <a href="https://www.youtube.com/watch?v=eeeeeeeeeee">Undated</a><br>garbage</div>
<div class="content-cell">Watched <a href="https://www.youtube.com/watch?v=ccccccccccc">Cool &amp; Good</a><br>1 Nov 2026, 14:03:22 GMT</div>
</div></body></html>`;

describe("parseTakeout json", () => {
  const r = parseTakeout(strToU8(JSON.stringify(json)), "watch-history.json");
  it("parses and dedupes", () => {
    expect(r.format).toBe("json");
    expect(r.entries).toHaveLength(2);
    expect(r.skipped).toBe(5);
    expect(r.entries[0]).toMatchObject({ videoId: "aaaaaaaaaaa", canonicalKey: "youtube:aaaaaaaaaaa", title: "Video One", channelName: "Chan A" });
    expect(r.entries[0]!.watchedAt.toISOString()).toBe("2026-11-01T14:03:22.000Z");
  });
  it("rejects non-array", () => expect(() => parseTakeout(strToU8("{}"), "x.json")).toThrow());
});

describe("parseTakeout html", () => {
  const r = parseTakeout(strToU8(html), "watch-history.html");
  it("parses best effort", () => {
    expect(r.format).toBe("html");
    expect(r.entries.map((e) => e.videoId)).toEqual(["ccccccccccc", "ddddddddddd"]);
    expect(r.entries[0]!.watchedAt.toISOString()).toBe("2026-11-01T14:03:22.000Z");
    expect(r.entries[0]!.title).toBe("Cool & Good");
    expect(r.entries[0]!.channelName).toBe("The Channel");
    expect(r.entries[1]!.watchedAt.toISOString()).toBe("2026-11-01T22:03:22.000Z");
    expect(r.skipped).toBe(2);
  });
});

describe("parseTakeout zip", () => {
  it("finds nested watch-history.json", () => {
    const zip = zipSync({
      "Takeout/YouTube and YouTube Music/history/watch-history.json": strToU8(JSON.stringify(json)),
      "Takeout/other.txt": strToU8("x"),
    });
    const r = parseTakeout(zip, "takeout.zip");
    expect(r.format).toBe("json");
    expect(r.entries).toHaveLength(2);
  });
  it("finds html in zip", () => {
    const r = parseTakeout(zipSync({ "Takeout/watch-history.html": strToU8(html) }), "t.zip");
    expect(r.format).toBe("html");
    expect(r.entries).toHaveLength(2);
  });
  it("throws when missing", () => {
    expect(() => parseTakeout(zipSync({ "a.txt": strToU8("x") }), "t.zip")).toThrow(/watch-history/);
  });
});

describe("parseTakeoutDate", () => {
  it("handles formats", () => {
    expect(parseTakeoutDate("1 Nov 2026, 14:03:22 GMT")?.toISOString()).toBe("2026-11-01T14:03:22.000Z");
    expect(parseTakeoutDate("Nov 1, 2026, 2:03:22 PM PST")?.toISOString()).toBe("2026-11-01T22:03:22.000Z");
    expect(parseTakeoutDate("Nov 1, 2026, 12:00:00 AM UTC")?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(parseTakeoutDate("nonsense")).toBeNull();
  });
});

describe("parseTakeout limits (security)", () => {
  it("parses 50k unclosed anchors in linear time", () => {
    const html = "<html><body>" + '<a href="https://www.youtube.com/watch?v=aaaaaaaaaaa">'.repeat(50_000) + "</body></html>";
    const t0 = Date.now();
    const r = parseTakeout(strToU8(html), "watch-history.html");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.entries).toHaveLength(0);
  });

  it("still parses an anchor that is closed far away only if it is under 4 KB", () => {
    const far = `<a href="https://www.youtube.com/watch?v=aaaaaaaaaaa">${"x".repeat(5000)}</a><br>1 Nov 2026, 14:03:22 GMT`;
    expect(parseTakeout(strToU8(far), "watch-history.html").entries).toHaveLength(0);
  });

  it("rejects a zip bomb before inflating it into memory", async () => {
    const { TakeoutTooLargeError, MAX_TAKEOUT_DECOMPRESSED } = await import("../src/index.js");
    // ~257 MiB of zeros compresses to a few hundred KB.
    const big = new Uint8Array(MAX_TAKEOUT_DECOMPRESSED + 1024 * 1024);
    const zip = zipSync({ "Takeout/YouTube/history/watch-history.json": big }, { level: 9 });
    expect(zip.length).toBeLessThan(2 * 1024 * 1024);
    expect(() => parseTakeout(zip, "takeout.zip")).toThrow(TakeoutTooLargeError);
  });

  it("still imports a normal zip", () => {
    const zip = zipSync({ "Takeout/YouTube/history/watch-history.json": strToU8(JSON.stringify(json)) });
    expect(parseTakeout(zip, "takeout.zip").entries).toHaveLength(2);
  });
});
