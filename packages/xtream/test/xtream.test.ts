import { describe, it, expect } from "vitest";
import * as x from "../src/index.js";

const ctx: x.ServerCtx = { host: "nas.local", port: 8080, protocol: "http", timezone: "Europe/London", now: new Date("2026-01-02T03:04:05Z") };
const user: x.XtreamUser = { username: "u", password: "p", createdAt: new Date("2026-01-01T00:00:00Z"), status: "active" };
const vods: x.XtreamVod[] = [
  { streamId: 12, title: 'He said "hi"\nbye', description: "d", thumbnailUrl: "http://t/1.jpg", categoryIds: [1, 2], addedAt: new Date(1_700_000_000_000), publishedAt: new Date("2024-05-06T00:00:00Z"), durationSeconds: 3725, containerExtension: "mp4", genre: "Music", channelName: "Chan", video: { codec: "h264", width: 1920, height: 1080 }, audio: { codec: "aac" }, bitrate: 2000, backdropUrl: "http://t/b.jpg" },
  { streamId: 13, title: "Two", description: "", thumbnailUrl: "", categoryIds: [2], addedAt: new Date(1_700_000_100_000), containerExtension: "mkv" },
];
const cats = [{ id: 1, name: "Recently added" }, { id: 2, name: "Music" }];

describe("xtream", () => {
  it("authResponse", () => {
    const r = x.authResponse(user, ctx);
    expect(r.user_info).toMatchObject({ username: "u", auth: 1, status: "Active", exp_date: null, created_at: "1767225600", max_connections: "10" });
    expect(r.server_info).toMatchObject({ url: "nas.local", port: "8080", server_protocol: "http", timestamp_now: 1767323045, time_now: "2026-01-02 03:04:05", process: true });
    expect(typeof r.server_info.timestamp_now).toBe("number");
  });
  it("authFailed", () => expect(x.authFailed()).toEqual({ user_info: { auth: 0 } }));
  it("categories", () => expect(x.vodCategories(cats)[0]).toEqual({ category_id: "1", category_name: "Recently added", parent_id: 0 }));
  it("streams: one entry per category membership", () => {
    const s = x.vodStreams(vods);
    expect(s).toHaveLength(3);
    expect(s.map((v) => [v.num, v.stream_id, v.category_id])).toEqual([[1, 12, "1"], [2, 12, "2"], [3, 13, "2"]]);
    expect(s[0]).toMatchObject({ stream_type: "movie", category_ids: [1, 2], added: "1700000000", container_extension: "mp4", year: "2024", duration_secs: 3725, custom_sid: null, rating_5based: 0 });
    expect(s[1]!.category_ids).toEqual([1, 2]);
  });
  it("category filter sets category_id to the requested category", () => {
    expect(x.vodStreams(vods, 1).map((v) => [v.stream_id, v.category_id])).toEqual([[12, "1"]]);
    expect(x.vodStreams(vods, "2").map((v) => [v.num, v.stream_id, v.category_id])).toEqual([[1, 12, "2"], [2, 13, "2"]]);
    expect(x.vodStreams(vods, 99)).toEqual([]);
  });
  it("vodInfo", () => {
    const i = x.vodInfo(vods[0]!);
    expect(i.info.duration).toBe("01:02:05");
    expect(i.info.episode_run_time).toBe(62);
    expect(i.info.backdrop_path).toEqual(["http://t/b.jpg"]);
    expect(i.info.video).toEqual({ codec_name: "h264", width: 1920, height: 1080 });
    expect(i.movie_data).toMatchObject({ stream_id: 12, category_id: "1", container_extension: "mp4" });
    const j = x.vodInfo(vods[1]!);
    expect(j.info.video).toEqual({});
    expect(j.info.audio).toEqual({});
    expect(j.info.backdrop_path).toEqual([]);
  });
  it("empties", () => {
    expect(x.emptyList()).toEqual([]);
    expect(x.shortEpg()).toEqual({ epg_listings: [] });
    expect(x.xmltvEmpty()).toBe('<?xml version="1.0" encoding="UTF-8"?><tv generator-info-name="NoConMedia"></tv>');
  });
  it("m3u escapes", () => {
    const m = x.m3uPlaylist({ baseUrl: "http://h:1/", username: "u s", password: "p", vods, categories: cats });
    const lines = m.split("\n");
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines[1]).toBe(`#EXTINF:-1 tvg-id="" tvg-name="He said 'hi' bye" tvg-logo="http://t/1.jpg" group-title="Recently added",He said "hi" bye`);
    expect(lines[2]).toBe("http://h:1/movie/u%20s/p/12.mp4");
    expect(m.endsWith("\n")).toBe(true);
  });
  it("paths", () => {
    expect(x.movieUrl("http://h", "a/b", "p@", 5, "mp4")).toBe("http://h/movie/a%2Fb/p%40/5.mp4");
    expect(x.parseMoviePath("/movie/u/p/12.mp4")).toEqual({ username: "u", password: "p", streamId: 12, ext: "mp4" });
    expect(x.parseMoviePath("/movie/a%2Fb/p%40/5.mkv")).toEqual({ username: "a/b", password: "p@", streamId: 5, ext: "mkv" });
    expect(x.parseMoviePath("/movie/u/p/x.mp4")).toBeNull();
    expect(x.parseMoviePath("/series/u/p/1.mp4")).toBeNull();
    expect(x.parseMoviePath("/movie/%E0/p/1.mp4")).toBeNull();
  });
});
