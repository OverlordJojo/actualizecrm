# packages/db

The Prisma schema and client, shared by `apps/web` and `apps/worker`.

Both services must agree on the schema exactly, so it lives in one package that
each imports rather than being duplicated or copied at build time.

## What this module does

- Owns `prisma/schema.prisma` — the single source of truth for the database
- Exports a shared `db` client with connection reuse suited to both a
  hot-reloading Next.js dev server and a long-lived worker process
- Owns migrations and the seed

## Env vars this folder owns

| Key | What it is |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |

`.env` here is a **symlink to the repo root `.env`**. The Prisma CLI looks for
`.env` next to the schema, not at the workspace root, so without the symlink
every command fails with "Environment variable not found: DATABASE_URL". Do
not replace it with a copy — two files drift.

## Why Postgres, and why not SQLite

v1 used SQLite and it was the right call: zero cost, zero hosting, one file to
back up. v2 moved to Postgres for exactly one reason — the Railway worker has
to execute scheduled automations while the MacBook is closed, and a remote
process cannot read a local file.

This is a genuine tradeoff, not an upgrade. The app is now dependent on network
connectivity to run at all, where before it worked on a plane. The connection-
loss banner and the `localStorage` call-event buffer exist because of that.

## Schema conventions

**"Enum-ish" columns are `String`, not Prisma enums.** Dispositions, stage
names, and job types change often. Adding a value to a Prisma enum requires a
migration deployed to both services in lockstep; adding one to a string column
requires nothing. Allowed values are documented above each field and enforced
in TypeScript.

**JSON columns are real `Json`.** v1 stored JSON as text because SQLite has no
JSON type. That is no longer necessary, and the migration script parses the old
text columns on import.

**No `userId` anywhere.** Single-operator by design. If a change seems to need
one, it is solving the wrong problem.

## Commands

Run these from the repo root:

```bash
npm run db:generate       # regenerate the client after a schema edit
npm run db:migrate        # create + apply a migration (local dev)
npm run db:deploy         # apply existing migrations (production/worker)
npm run db:studio         # browse the data
npm run db:seed           # default pipeline and stages
npm run db:import-sqlite  # one-time v1 SQLite import
```

## Migrating from v1 SQLite

```bash
npm run db:migrate        # build the Postgres schema first
npm run db:import-sqlite  # then import
```

`scripts/migrate-sqlite-to-postgres.ts` reads `data/actualizecrm.db` directly
with Node's built-in `node:sqlite` — no dependency — and upserts by primary
key, so a partial run is safe to repeat. It prints a per-table row-count
comparison at the end and exits non-zero on any mismatch.

The SQLite file is opened read-only and never modified. Keep it as a backup.

## Testing end to end

**1. Schema is valid**
`cd packages/db && npx prisma validate` → "The schema is valid".

**2. Migration applies to a clean database**
Point `DATABASE_URL` at a scratch database and run `npm run db:migrate`.
It should apply with no interactive prompts.

**3. Import preserves everything** ← the one that matters
Run `npm run db:import-sqlite` and read the verification table it prints.
Every row must show `OK` with matching counts. Then spot-check in Studio: open
a contact you recognise and confirm its calls, notes, and tags all came across.

**4. Both services see the same data**
Start the web app, create a contact, then query it from the worker's shell.
If the worker cannot see it, the two are pointed at different databases —
almost always the internal/public URL mix-up described in
`apps/worker/CLAUDE.md`.
