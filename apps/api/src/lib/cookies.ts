import fsp from "node:fs/promises";
import path from "node:path";
import { badRequest, type Deps } from "./core.js";

export const MAX_COOKIES_BYTES = 1024 * 1024;

/** Absolute path of a source's cookies file. Derived from the id only, never from user input. */
export const cookiesPathFor = (d: Pick<Deps, "config">, sourceId: string): string =>
  path.resolve(d.config.DATA_ROOT, "secrets", `source-${sourceId}.txt`);

/**
 * Checks that the text looks like a Netscape cookies.txt: the first data lines (blank lines and "# " comments are
 * skipped; "#HttpOnly_" lines are cookies) must have seven tab-separated fields with a numeric expiry and TRUE/FALSE flags.
 * Throws a 400 that never echoes the file contents.
 */
export function validateCookiesText(buf: Buffer): string {
  if (buf.length === 0) throw badRequest("The cookies file is empty.");
  if (buf.includes(0)) throw badRequest("That does not look like a cookies.txt file (it contains binary data).");
  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  let checked = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#") && !line.startsWith("#HttpOnly_")) continue;
    const f = raw.replace(/\r$/, "").split("\t");
    const ok = f.length === 7 && /^(TRUE|FALSE)$/i.test(f[1]!) && /^(TRUE|FALSE)$/i.test(f[3]!) && /^-?\d+$/.test(f[4]!) && f[0]!.trim() !== "" && f[5]!.trim() !== "";
    if (!ok) throw badRequest("That does not look like a Netscape cookies.txt file. Each cookie line needs seven tab-separated fields: domain, subdomains flag, path, secure flag, expiry, name, value.");
    if (++checked >= 5) break;
  }
  if (checked === 0) throw badRequest("The cookies file has no cookie lines.");
  return text;
}

export async function writeCookiesFile(d: Pick<Deps, "config">, sourceId: string, text: string): Promise<string> {
  const file = cookiesPathFor(d, sourceId);
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700).catch(() => undefined);
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, text, { mode: 0o600 });
  await fsp.chmod(tmp, 0o600);
  await fsp.rename(tmp, file);
  return file;
}

export async function removeCookiesFile(d: Pick<Deps, "config">, sourceId: string): Promise<void> {
  await fsp.rm(cookiesPathFor(d, sourceId), { force: true });
}
