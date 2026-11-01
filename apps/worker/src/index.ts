import { Redis } from "ioredis";
import { createDb } from "@nocon/database";
import { createLogger, loadConfig, sleep } from "@nocon/shared";
import { startWorker } from "./runtime.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger("worker", config.LOG_LEVEL);
  const { db, pool } = createDb(config.DATABASE_URL, config.profile.dbPoolWorker);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  redis.on("error", (e) => log.warn({ err: e.message }, "redis error"));

  const runtime = await startWorker({ config, db, redis, log });

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "received signal");
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    await runtime.stop().catch((e) => log.error({ err: String(e) }, "error during shutdown"));
    await pool.end().catch(() => undefined);
    redis.disconnect();
    await sleep(50);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((e) => {
  console.error("worker failed to start:", e);
  process.exit(1);
});
