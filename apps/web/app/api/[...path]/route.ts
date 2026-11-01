import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FORWARD_REQUEST_HEADERS = [
  "cookie",
  "content-type",
  "content-length",
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
  "x-nocon-csrf",
  "origin",
  "referer",
  "user-agent",
  "authorization",
  "accept",
  "accept-language",
];

const FORWARD_RESPONSE_HEADERS = [
  "content-range",
  "accept-ranges",
  "content-length",
  "content-type",
  "content-disposition",
  "etag",
  "last-modified",
  "cache-control",
  "location",
  "retry-after",
  "vary",
];

function upstreamBase(): string {
  return (process.env.API_INTERNAL_URL ?? "http://localhost:3001").replace(/\/+$/, "");
}

async function proxy(req: NextRequest): Promise<Response> {
  const url = `${upstreamBase()}${req.nextUrl.pathname}${req.nextUrl.search}`;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // Ask for an uncompressed body so content-length and ranges stay accurate.
  headers.set("accept-encoding", "identity");

  // Never pass client-supplied forwarding/identity headers upstream. The real peer address comes from
  // instrumentation.ts (`x-nocon-peer-ip`, stamped from the socket); it is handed to the API together
  // with a shared secret so the API only honours it when it really came from this proxy.
  const host = req.headers.get("host") ?? req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const secret = process.env.NOCON_PROXY_SECRET;
  const peer = req.headers.get("x-nocon-peer-ip");
  headers.set("x-forwarded-host", host);
  headers.set("x-forwarded-proto", proto === "https" ? "https" : "http");
  if (secret) {
    headers.set("x-nocon-proxy-secret", secret);
    if (peer) headers.set("x-nocon-client-ip", peer);
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: req.signal,
    cache: "no-store",
  };
  if (hasBody) {
    init.body = req.body;
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (err) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return Response.json(
      {
        error: "bad_gateway",
        message: "The NoConMedia API isn't reachable. Check that the api service is running, then try again.",
        details: err instanceof Error ? err.message : undefined,
      },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }

  const out = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);

  const noBody = req.method === "HEAD" || upstream.status === 204 || upstream.status === 304;
  return new Response(noBody ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

export {
  proxy as GET,
  proxy as HEAD,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
};
