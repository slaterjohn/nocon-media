/** Remove credentials from URLs / query strings before logging. */
export function redactUrl(url: string): string {
  if (!url) return url;
  return url
    .replace(/(\/(?:movie|series|live|xtream-art)\/)[^/]+\/[^/]+\//g, "$1***/***/")
    .replace(/(\/m3u\/)[^/]+\//g, "$1***/")
    .replace(/([?&](?:password|username|token|pass|api_key)=)[^&#]*/gi, "$1***");
}

const SECRET_KEYS = /pass(word)?|secret|token|cookie|authorization/i;
export function redactObject<T>(obj: T): T {
  if (Array.isArray(obj)) return obj.map(redactObject) as unknown as T;
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = SECRET_KEYS.test(k) ? "***" : redactObject(v);
    return out as T;
  }
  if (typeof obj === "string" && /^https?:|^\//.test(obj)) return redactUrl(obj) as unknown as T;
  return obj;
}
