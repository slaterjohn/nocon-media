import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { parseRange, mimeFor, serveFile } from "../src/index.js";

describe("parseRange", () => {
  it("handles forms", () => {
    expect(parseRange(undefined, 100)).toEqual({ type: "none" });
    expect(parseRange("bytes=0-9", 100)).toEqual({ type: "range", start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ type: "range", start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ type: "range", start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ type: "range", start: 0, end: 99 });
    expect(parseRange("bytes=10-500", 100)).toEqual({ type: "range", start: 10, end: 99 });
    expect(parseRange("bytes=0-1,5-6", 100)).toEqual({ type: "range", start: 0, end: 1 });
    expect(parseRange("bytes=100-", 100)).toEqual({ type: "unsatisfiable" });
    expect(parseRange("bytes=-0", 100)).toEqual({ type: "unsatisfiable" });
    expect(parseRange("items=0-1", 100)).toEqual({ type: "none" });
    expect(parseRange("bytes=abc", 100)).toEqual({ type: "none" });
    expect(parseRange("bytes=9-3", 100)).toEqual({ type: "none" });
    expect(parseRange("bytes=-", 100)).toEqual({ type: "none" });
  });
});

describe("mimeFor", () => {
  it("maps", () => {
    expect(mimeFor("/a/b.MP4")).toBe("video/mp4");
    expect(mimeFor("x.mkv")).toBe("video/x-matroska");
    expect(mimeFor("x.m3u8")).toBe("application/vnd.apple.mpegurl");
    expect(mimeFor("x.jpeg")).toBe("image/jpeg");
    expect(mimeFor("x.unknown")).toBe("application/octet-stream");
    expect(mimeFor("noext")).toBe("application/octet-stream");
  });
});

describe("serveFile", () => {
  let dir: string, server: http.Server, base: string;
  const small = Buffer.from("0123456789abcdefghij");
  const bigSize = 20 * 1024 * 1024;
  let bigHash: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-"));
    fs.writeFileSync(path.join(dir, "small.mp4"), small);
    const big = crypto.randomBytes(bigSize);
    bigHash = crypto.createHash("sha256").update(big).digest("hex");
    fs.writeFileSync(path.join(dir, "big.mkv"), big);
    server = http.createServer((req, res) => {
      const name = (req.url ?? "/").slice(1);
      void serveFile(req, res, path.join(dir, name));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("full GET", async () => {
    const r = await fetch(`${base}/small.mp4`);
    expect(r.status).toBe(200);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-length")).toBe("20");
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("etag")).toMatch(/^W\/"20-\d+"$/);
    expect(r.headers.get("last-modified")).toBeTruthy();
    expect(Buffer.from(await r.arrayBuffer()).equals(small)).toBe(true);
  });
  it("sets nosniff and no-referrer on files, partials and errors", async () => {
    for (const [url, init] of [["small.mp4", {}], ["small.mp4", { headers: { range: "bytes=0-3" } }], ["missing.mp4", {}]] as const) {
      const r = await fetch(`${base}/${url}`, init);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });
  it("HEAD", async () => {
    const r = await fetch(`${base}/small.mp4`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBe("20");
    expect((await r.text())).toBe("");
  });
  it("ranges", async () => {
    let r = await fetch(`${base}/small.mp4`, { headers: { Range: "bytes=2-5" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 2-5/20");
    expect(await r.text()).toBe("2345");
    r = await fetch(`${base}/small.mp4`, { headers: { Range: "bytes=15-" } });
    expect(r.headers.get("content-range")).toBe("bytes 15-19/20");
    expect(await r.text()).toBe("fghij");
    r = await fetch(`${base}/small.mp4`, { headers: { Range: "bytes=-3" } });
    expect(await r.text()).toBe("hij");
  });
  it("416", async () => {
    const r = await fetch(`${base}/small.mp4`, { headers: { Range: "bytes=50-" } });
    expect(r.status).toBe(416);
    expect(r.headers.get("content-range")).toBe("bytes */20");
    await r.text();
  });
  it("304 and If-Range", async () => {
    const first = await fetch(`${base}/small.mp4`);
    const etag = first.headers.get("etag")!;
    await first.arrayBuffer();
    const r = await fetch(`${base}/small.mp4`, { headers: { "If-None-Match": etag } });
    expect(r.status).toBe(304);
    const ok = await fetch(`${base}/small.mp4`, { headers: { Range: "bytes=0-1", "If-Range": etag } });
    expect(ok.status).toBe(206);
    await ok.arrayBuffer();
    const mismatch = await fetch(`${base}/small.mp4`, { headers: { Range: "bytes=0-1", "If-Range": 'W/"x"' } });
    expect(mismatch.status).toBe(200);
    expect((await mismatch.arrayBuffer()).byteLength).toBe(20);
  });
  it("404 without leaking path", async () => {
    const r = await fetch(`${base}/missing.mp4`);
    expect(r.status).toBe(404);
    const t = await r.text();
    expect(t).not.toContain(dir);
  });
  it("streams 20MB intact", async () => {
    const r = await fetch(`${base}/big.mkv`);
    expect(r.status).toBe(200);
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.length).toBe(bigSize);
    expect(crypto.createHash("sha256").update(buf).digest("hex")).toBe(bigHash);
  });
  it("survives client abort mid-stream", async () => {
    await new Promise<void>((resolve) => {
      const sock = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1", () => {
        sock.write("GET /big.mkv HTTP/1.1\r\nHost: x\r\n\r\n");
        sock.once("data", () => { sock.destroy(); setTimeout(resolve, 100); });
      });
      sock.on("error", () => {});
    });
    const r = await fetch(`${base}/small.mp4`);
    expect(r.status).toBe(200);
    await r.arrayBuffer();
  });
});
