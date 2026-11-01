import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

export function defaultMigrationsFolder(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "drizzle"),
    path.resolve(process.cwd(), "drizzle"),
  ].filter(Boolean) as string[];
  const found = candidates.find((c) => fs.existsSync(path.join(c, "meta/_journal.json")));
  if (!found) throw new Error(`Migrations folder not found (tried ${candidates.join(", ")})`);
  return found;
}

/** Runs migrations under an advisory lock so concurrent starters don't race. */
export async function runMigrations(db: Database, folder = defaultMigrationsFolder()): Promise<void> {
  await db.execute(sql`select pg_advisory_lock(727001)`);
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await db.execute(sql`select pg_advisory_unlock(727001)`);
  }
}
