import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";

const DB_URL = process.env.ARBITER_DB_URL ?? process.env.DATABASE_URL ?? "";
const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

let pool: Pool | null = null;
let migrationsPromise: Promise<void> | null = null;

export function dbEnabled(): boolean {
  return DB_URL.trim().length > 0;
}

export function getPool(): Pool | null {
  if (!dbEnabled()) {
    return null;
  }
  if (!pool) {
    pool = new Pool({
      connectionString: DB_URL,
      max: Number(process.env.ARBITER_DB_POOL_MAX ?? 10),
      idleTimeoutMillis: Number(process.env.ARBITER_DB_IDLE_TIMEOUT_MS ?? 30_000),
      connectionTimeoutMillis: Number(process.env.ARBITER_DB_CONN_TIMEOUT_MS ?? 5_000)
    });
  }
  return pool;
}

export async function ensureMigrations(): Promise<void> {
  if (!dbEnabled()) {
    return;
  }
  if (!migrationsPromise) {
    migrationsPromise = runMigrations();
  }
  return migrationsPromise;
}

async function runMigrations(): Promise<void> {
  const db = getPool();
  if (!db) {
    return;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const applied = await db.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
    if (applied.rowCount && applied.rowCount > 0) {
      continue;
    }

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function closePool(): Promise<void> {
  if (!pool) {
    return;
  }
  const current = pool;
  pool = null;
  migrationsPromise = null;
  await current.end();
}
