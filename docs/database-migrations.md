# Database migrations

PostgreSQL 17 with Drizzle ORM. The schema is defined in `packages/database/src/schema.ts`. SQL migrations are generated from it and committed in `packages/database/drizzle/`. [database-schema.md](database-schema.md) explains the tables.

## Changing the schema

1. Edit `packages/database/src/schema.ts`.
2. Generate a migration:

```bash
pnpm db:generate
```

   This runs `drizzle-kit generate` in `@nocon/database` and writes a new numbered `.sql` file and an updated `meta/_journal.json` snapshot.
3. Read the generated SQL. Edit it if it is wrong; Drizzle cannot express everything.
4. Test against a database that already has the previous migrations as well as an empty one. The integration tests run all migrations from empty. To apply to a dev database by hand:

```bash
pnpm test:infra
DATABASE_URL=postgres://nocon:nocon@127.0.0.1:55432/nocon pnpm db:migrate
```

5. Commit the schema change, the `.sql` file and the `meta/` files together. Never edit or rename a migration that has been released; add a new one.

## The custom function in migration 0000

`0000_init.sql` begins with a hand-written statement before anything Drizzle generated:

```sql
CREATE OR REPLACE FUNCTION nocon_tags_text(text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT coalesce(array_to_string($1, ' '), '') $$;
```

The media table has a generated full-text search column built from the title, channel name, tags, categories and description. PostgreSQL requires every function in a generated column expression to be `IMMUTABLE`, and the built-in `array_to_string` is only `STABLE`, so it is rejected. Wrapping it in an `IMMUTABLE` SQL function lets the column be generated and indexed. The function must exist before the table, which is why it is first in the file. Keep it when regenerating or squashing migrations.

## How migrations are applied

The API applies pending migrations every time it starts, before it listens for requests. It takes a PostgreSQL advisory lock (`pg_advisory_lock(727001)`) around the migration, so two processes starting together cannot race. The worker container waits for the API to be healthy, so it always starts against the migrated schema. The production API bundle ships the migration files next to itself (`dist/drizzle`); `MIGRATIONS_DIR` can point elsewhere.

There is no separate migration step when upgrading. `docker compose up -d --build --wait` is enough.

## Checking what has been applied

Drizzle records applied migrations in `drizzle.__drizzle_migrations`:

```bash
docker compose exec postgres psql -U nocon -d nocon -c \
  'select id, created_at from drizzle.__drizzle_migrations order by id'
```

Each row is one applied migration, keyed by hash and timestamp. The count should equal the number of entries in `packages/database/drizzle/meta/_journal.json`.

## Rules

- **Prefer additive changes.** Add tables, nullable columns and columns with defaults. Add indexes. These are safe to deploy and safe for the previous version of the code to run against.
- **Destructive changes take two releases.** Dropping or renaming a column, changing a type or adding a constraint that existing rows might break is done in steps. First release: add the new structure, write to both, backfill. Second release: stop reading the old structure, then drop it. Never remove something in the same release that stops using it.
- **Large data changes** belong in a migration only if they are quick. Otherwise add the column in a migration and backfill from the worker.
- **Migrations run in a transaction.** Statements that cannot (such as `CREATE INDEX CONCURRENTLY`) need care; check that Drizzle's migrator can run them before using them.
- **Do not edit applied migrations.** The migrator tracks them, and changing history makes installs disagree.

## Rolling back

Migrations only go forward; there are no down scripts. To roll back an upgrade, restore the backup taken before it and run the older version of the code:

```bash
scripts/backup.sh                    # before upgrading
# ... upgrade, find a problem ...
git checkout <previous-version>
docker compose build
scripts/restore.sh backups/nocon-backup-<timestamp>.tar.gz
```

Restoring replaces the database, including migration history, with the state in the backup. See [Backup and restore](guides/backup-restore.md). Everything that happened after the backup, such as new watch history, is lost.
