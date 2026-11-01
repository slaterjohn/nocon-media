import { createDb, runMigrations, ensureSystemSources } from "@nocon/database";
import { loadConfig } from "@nocon/shared";
import { buildApp } from "./app.js";
import { closeRuntime, createRuntime } from "./lib/core.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

async function main() {
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL, config.profile.dbPoolApi);
  // The bundle ships migrations next to itself (dist/drizzle); in dev the database package finds its own.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.join(here, "drizzle");
  await runMigrations(db, fs.existsSync(path.join(bundled, "meta/_journal.json")) ? bundled : undefined);
  await ensureSystemSources(db);

  const deps = createRuntime(config, db, pool);
  const app = await buildApp(deps);
  if (!config.NOCON_PROXY_SECRET) {
    app.log.warn("NOCON_PROXY_SECRET is not set: client IPs will be the web container's address and the login throttle is shared by all users. Set it (openssl rand -hex 32) for both api and web.");
  }
  await app.listen({ host: config.API_HOST, port: config.API_PORT });

  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ sig }, "shutting down");
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await app.close().catch(() => undefined);
    await closeRuntime(deps);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
