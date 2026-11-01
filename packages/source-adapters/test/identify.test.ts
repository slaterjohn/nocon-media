import { describe, expect, it } from "vitest";
import { identifySource } from "../src/index.js";

const UC = "UCfakechannel0000000000a";
const VID = "dQw4w9WgXcQ";

describe("identifySource valid", () => {
  const cases: [string, string, string, string][] = [
    ["@SomeHandle", "channel", "@SomeHandle", "https://www.youtube.com/@SomeHandle"],
    ["https://www.youtube.com/@Some.Handle-1", "channel", "@Some.Handle-1", "https://www.youtube.com/@Some.Handle-1"],
    ["youtube.com/@abc", "channel", "@abc", "https://www.youtube.com/@abc"],
    ["https://m.youtube.com/@abc/videos", "channel", "@abc", "https://www.youtube.com/@abc"],
    [`https://www.youtube.com/channel/${UC}`, "channel", UC, `https://www.youtube.com/channel/${UC}`],
    [UC, "channel", UC, `https://www.youtube.com/channel/${UC}`],
    ["https://www.youtube.com/c/SomeName", "channel", "c/SomeName", "https://www.youtube.com/c/SomeName"],
    ["https://www.youtube.com/user/SomeUser", "channel", "user/SomeUser", "https://www.youtube.com/user/SomeUser"],
    ["https://www.youtube.com/playlist?list=PLfakeplaylist0001", "playlist", "PLfakeplaylist0001", "https://www.youtube.com/playlist?list=PLfakeplaylist0001"],
    [`https://www.youtube.com/watch?v=${VID}`, "video", VID, `https://www.youtube.com/watch?v=${VID}`],
    [`https://www.youtube.com/watch?v=${VID}&list=PLfakeplaylist0001`, "video", VID, `https://www.youtube.com/watch?v=${VID}`],
    [`https://music.youtube.com/watch?v=${VID}`, "video", VID, `https://www.youtube.com/watch?v=${VID}`],
    [`https://youtu.be/${VID}`, "video", VID, `https://www.youtube.com/watch?v=${VID}`],
    [`https://youtu.be/${VID}?t=10`, "video", VID, `https://www.youtube.com/watch?v=${VID}`],
    [`https://www.youtube.com/shorts/${VID}`, "video", VID, `https://www.youtube.com/watch?v=${VID}`],
    [`https://www.youtube.com/live/${VID}`, "video", VID, `https://www.youtube.com/watch?v=${VID}`],
    [`  https://youtube.com/watch?v=${VID}  `, "video", VID, `https://www.youtube.com/watch?v=${VID}`],
  ];
  it.each(cases)("%s", (input, type, id, canon) => {
    const r = identifySource(input);
    expect(r).not.toBeNull();
    expect(r!.platform).toBe("youtube");
    expect(r!.type).toBe(type);
    expect(r!.externalId).toBe(id);
    expect(r!.canonicalUrl).toBe(canon);
  });
  it("sets handle", () => expect(identifySource("@abc")!.handle).toBe("@abc"));
});

describe("identifySource invalid / SSRF", () => {
  const bad = [
    "",
    "   ",
    "hello world",
    `http://127.0.0.1/watch?v=${VID}`,
    `http://localhost/watch?v=${VID}`,
    `https://youtube.com.evil.com/watch?v=${VID}`,
    `https://evil.com/youtube.com/watch?v=${VID}`,
    `https://notyoutube.com/watch?v=${VID}`,
    `https://user:pw@www.youtube.com/watch?v=${VID}`,
    `https://www.youtube.com@evil.com/watch?v=${VID}`,
    `https://www.youtube.com:8080/watch?v=${VID}`,
    "javascript:alert(1)",
    "file:///etc/passwd",
    "ftp://www.youtube.com/watch?v=" + VID,
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=" + VID + "x",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/playlist?list=abc",
    "https://www.youtube.com/channel/UCshort",
    "https://www.youtube.com/channel/XX" + "a".repeat(22),
    "@ab",
    "@" + "a".repeat(31),
    "@bad handle",
    "@bad/handle",
    "https://www.youtube.com/c/bad;name",
    "https://www.youtube.com/",
    "https://www.youtube.com/feed/subscriptions",
    "https://youtu.be/",
    "https://youtu.be/a/b",
    "https://169.254.169.254/latest/meta-data",
    `$(touch x)`,
  ];
  it.each(bad)("rejects %j", (input) => expect(identifySource(input)).toBeNull());
  it("rejects non-strings", () => expect(identifySource(undefined as unknown as string)).toBeNull());
});
