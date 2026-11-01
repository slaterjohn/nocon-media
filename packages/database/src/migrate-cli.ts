import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";
const { db, pool } = createDb(process.env.DATABASE_URL!);
await runMigrations(db);
await pool.end();
console.log("migrations applied");
