import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createDb, runMigrations, type Database } from "./deps.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://nocon:nocon@127.0.0.1:55432/nocon";

export interface TestDb {
  db: Database;
  pool: { end(): Promise<void> };
  url: string;
  drop(): Promise<void>;
}

/** Creates a uniquely named database, migrates it, and returns handles plus a drop() cleanup. */
export async function createTestDb(): Promise<TestDb> {
  const name = `nocon_test_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const admin = createDb(BASE_URL, 1).pool;
  try { await admin.query(`create database ${name}`); } finally { await admin.end(); }

  const u = new URL(BASE_URL);
  u.pathname = `/${name}`;
  const url = u.toString();
  const { db, pool } = createDb(url, 10);
  await runMigrations(db, path.join(REPO_ROOT, "packages/database/drizzle"));

  return {
    db, pool, url,
    async drop() {
      await pool.end().catch(() => undefined);
      const a = createDb(BASE_URL, 1).pool;
      try { await a.query(`drop database if exists ${name} with (force)`); } finally { await a.end(); }
    },
  };
}
