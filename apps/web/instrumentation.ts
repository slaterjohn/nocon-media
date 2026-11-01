/**
 * Records the real TCP peer address of every incoming request in `x-nocon-peer-ip`.
 *
 * Why this exists: Next sets `x-forwarded-for` from the socket only when the header is
 * absent (`req.headers['x-forwarded-for'] ??= socket.remoteAddress`), so a client-supplied
 * value is passed through untouched and no entry Next "appends" can be trusted. Route
 * handlers have no access to the socket, so we stamp the peer address onto the Node request
 * before Next sees it, overwriting anything the client sent under that name.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const http = await import("node:http");
  const proto = http.Server.prototype as unknown as { emit: (...a: unknown[]) => boolean; __nocon_peer?: boolean };
  if (proto.__nocon_peer) return;
  proto.__nocon_peer = true;
  const original = proto.emit;
  proto.emit = function (this: unknown, event: unknown, ...args: unknown[]) {
    if (event === "request") {
      const req = args[0] as { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } };
      delete req.headers["x-nocon-peer-ip"];
      const addr = req.socket?.remoteAddress;
      if (addr) req.headers["x-nocon-peer-ip"] = addr;
    }
    return original.call(this, event, ...args);
  };
}
