// Worker health: the worker writes `nocon:worker:heartbeat` (EX 60) to Redis every 15 s.
// This speaks minimal RESP over TCP so no client library is needed in the runtime image.
import net from "node:net";

const url = new URL(process.env.REDIS_URL ?? "redis://redis:6379");
const KEY = "nocon:worker:heartbeat";
const cmd = (...a) => `*${a.length}\r\n${a.map((x) => `$${Buffer.byteLength(x)}\r\n${x}\r\n`).join("")}`;
let out = "";
if (url.password) out += cmd("AUTH", ...(url.username ? [decodeURIComponent(url.username)] : []), decodeURIComponent(url.password));
if (url.pathname.length > 1) out += cmd("SELECT", url.pathname.slice(1));
const expectReplies = out.split("*").length - 1;
out += cmd("EXISTS", KEY);

const sock = net.connect({ host: url.hostname, port: Number(url.port || 6379) });
let buf = "";
const fail = () => process.exit(1);
sock.setTimeout(4000, fail);
sock.on("error", fail);
sock.on("connect", () => sock.write(out));
sock.on("data", (d) => {
  buf += d.toString();
  const lines = buf.split("\r\n").filter(Boolean);
  if (lines.length > expectReplies) process.exit(lines[expectReplies] === ":1" ? 0 : 1);
});
