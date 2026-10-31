import { Database } from "bun:sqlite";

// Append-only: each entry is applied once, in order, tracked by PRAGMA user_version.
const MIGRATIONS = [
  `CREATE TABLE jobs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     tool TEXT NOT NULL,
     args TEXT NOT NULL DEFAULT '{}',
     state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled','unverified')),
     result TEXT, error TEXT,
     priority INTEGER NOT NULL DEFAULT 0,
     not_before INTEGER,
     idempotency_key TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   );
   CREATE INDEX jobs_state ON jobs(state, priority DESC, id);
   CREATE UNIQUE INDEX jobs_key ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL AND state NOT IN ('failed','cancelled');
   CREATE TABLE actions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL, job_id INTEGER, tool TEXT NOT NULL, args TEXT, state TEXT NOT NULL,
     result TEXT, error TEXT, duration_ms INTEGER, counted INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX actions_ts ON actions(counted, ts);
   CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];

export function openDb(file: string) {
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  let v = (db.query("PRAGMA user_version").get() as any).user_version as number;
  for (; v < MIGRATIONS.length; v++) db.transaction(() => { db.exec(MIGRATIONS[v]!); db.exec(`PRAGMA user_version=${v + 1}`); })();
  return db;
}
