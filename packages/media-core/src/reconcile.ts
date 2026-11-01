import fsp from "node:fs/promises";
import path from "node:path";
import { FILES } from "./layout.js";
import { readSidecar, type Sidecar } from "./finalise.js";

export interface LibraryItem {
  relDir: string;
  sidecar: Sidecar;
  mainFile: string;
  missingFiles: string[];
}
export interface ScanResult {
  items: LibraryItem[];
  orphanDirs: string[];
  errors: { relDir: string; error: string }[];
}

const exists = (p: string) => fsp.access(p).then(() => true, () => false);

/** Non-destructive scan: reads sidecars, reports missing files and orphan directories. */
export async function scanLibrary(volumeRoot: string): Promise<ScanResult> {
  const result: ScanResult = { items: [], orphanDirs: [], errors: [] };
  const walk = async (rel: string): Promise<void> => {
    const abs = rel ? path.join(volumeRoot, rel) : volumeRoot;
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    if (rel && entries.some((e) => e.isFile() && e.name === FILES.sidecar)) {
      try {
        const sc = await readSidecar(path.join(abs, FILES.sidecar));
        const expected = [sc.mainFile, ...(sc.artwork.thumbnail ? [sc.artwork.thumbnail] : []), ...sc.subtitles.map((s) => s.file)];
        const missing: string[] = [];
        for (const f of expected) if (!(await exists(path.join(abs, f)))) missing.push(f);
        result.items.push({ relDir: rel, sidecar: sc, mainFile: sc.mainFile, missingFiles: missing });
      } catch (e) {
        result.errors.push({ relDir: rel, error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (rel && (rel.includes(FILES.incomingMarker) || /\.old-[0-9a-f]+$/.test(rel))) {
      result.orphanDirs.push(rel);
      return;
    }
    if (rel && entries.some((e) => e.isFile() && e.name.startsWith(FILES.media + "."))) {
      result.orphanDirs.push(rel);
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!rel && e.name === FILES.volumeMeta) continue;
      if (e.name === ".noconmedia" || e.name === "_channel") continue;
      await walk(rel ? path.posix.join(rel, e.name) : e.name);
    }
  };
  await walk("");
  result.items.sort((a, b) => a.relDir.localeCompare(b.relDir));
  result.orphanDirs.sort();
  return result;
}
