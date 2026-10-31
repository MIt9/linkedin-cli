import type { Database } from "bun:sqlite";
import { READ_ONLY } from "./tools";

export type Job = {
  id: number; tool: string; args: any; state: string; result?: any; error?: string; priority: number;
  notBefore?: number; idempotencyKey?: string; attempts: number; createdAt: number; updatedAt: number;
};
export const FINAL = new Set(["done", "failed", "unverified", "cancelled"]);
const KEEP_FINAL = 1000; // ponytail: prune oldest finished jobs beyond this; key dedupe only sees what is kept
const parse = (s: string | null) => (s === null ? undefined : JSON.parse(s));
const toJob = (r: any): Job => ({
  id: r.id, tool: r.tool, args: parse(r.args), state: r.state, result: parse(r.result), error: r.error ?? undefined,
  priority: r.priority, notBefore: r.not_before ?? undefined, idempotencyKey: r.idempotency_key ?? undefined,
  attempts: r.attempts, createdAt: r.created_at, updatedAt: r.updated_at,
});
// Extension-side `RATE_LIMIT:{"retryAt":ms}`.
export const parseRateLimit = (e?: string) => {
  const m = /^RATE_LIMIT:(\{.*\})/s.exec(e || "");
  try { const t = m && JSON.parse(m[1]!).retryAt; return Number.isFinite(t) ? (t as number) : null; } catch { return null; }
};
export type Outcome = { result?: unknown; unverified?: string; error?: string; halt?: boolean; ambiguous?: boolean; retryAt?: number };

export class Queue {
  constructor(private db: Database, private now = Date.now) {}

  // Jobs left `running` by a dead service: read-only -> queued again, anything else -> unverified (never re-sent).
  recover() {
    for (const r of this.db.query("SELECT * FROM jobs WHERE state='running'").all() as any[]) {
      if (READ_ONLY.has(r.tool)) this.db.query("UPDATE jobs SET state='queued', updated_at=? WHERE id=?").run(this.now(), r.id);
      else this.db.query("UPDATE jobs SET state='unverified', error=?, updated_at=? WHERE id=?").run("service restarted while running; may have been executed", this.now(), r.id);
    }
  }

  // Same key as a job that is not failed/cancelled -> that job (enforced by a partial unique index).
  enqueue(o: { tool: string; args: object; key?: string; priority?: number; notBefore?: number }): Job {
    const t = this.now();
    try {
      const r = this.db.query("INSERT INTO jobs (tool,args,state,priority,not_before,idempotency_key,created_at,updated_at) VALUES (?,?,'queued',?,?,?,?,?) RETURNING *")
        .get(o.tool, JSON.stringify(o.args), o.priority ?? 0, o.notBefore ?? null, o.key ?? null, t, t);
      return toJob(r);
    } catch (e: any) {
      if (!o.key || !/UNIQUE/.test(String(e?.message))) throw e;
      return toJob(this.db.query("SELECT * FROM jobs WHERE idempotency_key=? AND state NOT IN ('failed','cancelled')").get(o.key));
    }
  }

  get(id: number) { const r = this.db.query("SELECT * FROM jobs WHERE id=?").get(id); return r ? toJob(r) : undefined; }

  list({ status, limit = 50 }: { status?: string; limit?: number } = {}) {
    const rows = status
      ? this.db.query("SELECT * FROM jobs WHERE state=? ORDER BY id DESC LIMIT ?").all(status, limit)
      : this.db.query("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit);
    return rows.map(toJob);
  }

  counts() {
    return Object.fromEntries((this.db.query("SELECT state, COUNT(*) n FROM jobs GROUP BY state").all() as any[]).map((r) => [r.state, r.n]));
  }

  cancel(id: number) {
    const r = this.db.query("UPDATE jobs SET state='cancelled', updated_at=? WHERE id=? AND state='queued' RETURNING *").get(this.now(), id);
    return r ? toJob(r) : undefined;
  }

  // Due queued job: priority desc, then FIFO. Priority never interrupts a running job.
  next() {
    const r = this.db.query("SELECT * FROM jobs WHERE state='queued' AND (not_before IS NULL OR not_before<=?) ORDER BY priority DESC, id LIMIT 1").get(this.now());
    return r ? toJob(r) : undefined;
  }
  wakeAt() {
    const r = this.db.query("SELECT MIN(not_before) t FROM jobs WHERE state='queued' AND not_before>?").get(this.now()) as any;
    return (r?.t as number | null) ?? null;
  }

  start(id: number) {
    this.db.query("UPDATE jobs SET state='running', attempts=attempts+1, updated_at=? WHERE id=?").run(this.now(), id);
  }

  complete(id: number, o: Outcome): Job {
    const j = this.get(id)!;
    const set = (state: string, f: { result?: unknown; error?: string | null; notBefore?: number | null; attempts?: number }) =>
      this.db.query("UPDATE jobs SET state=?, result=?, error=?, not_before=?, attempts=?, updated_at=? WHERE id=?").run(
        state, f.result === undefined ? null : JSON.stringify(f.result), f.error ?? null,
        f.notBefore === undefined ? j.notBefore ?? null : f.notBefore, f.attempts ?? j.attempts, this.now(), id);
    if (o.error === undefined) {
      if (o.unverified) set("unverified", { result: o.result, error: o.unverified });
      else set("done", { result: o.result });
    } else if (o.retryAt !== undefined && j.priority === 0) set("queued", { error: o.error, notBefore: o.retryAt, attempts: Math.max(0, j.attempts - 1) }); // not executed
    else if (o.halt && j.priority === 0) set("queued", { error: o.error, attempts: Math.max(0, j.attempts - 1) }); // not executed; waits for resume
    else if (o.ambiguous && !READ_ONLY.has(j.tool)) set("unverified", { error: o.error });
    else set("failed", { error: o.error }); // never auto-retry an outward action
    this.db.query(`DELETE FROM jobs WHERE state IN ('done','failed','unverified','cancelled') AND id <= (SELECT id FROM jobs WHERE state IN ('done','failed','unverified','cancelled') ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(KEEP_FINAL);
    return this.get(id)!;
  }
}
