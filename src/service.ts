import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { compatible, VERSION, type Cfg } from "./config";
import { openDb } from "./db";
import { pinnedId } from "./ext";
import { OWN_HEADER, portInUse } from "./client";
import { CliError, fail } from "./errors";
import { FINAL, parseRateLimit, Queue, type Job } from "./queue";
import { BUDGET, CHECK_ONLY, DID_OUTWARD, HANDLERS, isOutward, needsConfirm } from "./tools";
import { prepare, verifyScheduled } from "./validate";

const HOUR = 36e5, DAY = 864e5, INVITE_LIMIT = 20;
const isHaltText = (e?: string) => /^(Halted since|STOPPED\.)/.test(e || "");
const isAmbiguous = (e?: string) => /^(Extension (disconnected|reconnected)|Service stopped)|timed out$/.test(e || "");
const envNum = (k: string, d: number) => (process.env[k] === undefined ? d : Number(process.env[k]));

// Single owner of the state dir: pidfile (stale pid is replaced). The listening port is the final lock.
function acquireLock(file: string) {
  for (let i = 0; i < 2; i++) {
    try { writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 }); return; } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(readFileSync(file, "utf8"));
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { /* dead */ }
      if (alive && pid !== process.pid) fail("ALREADY_RUNNING", `Service already running (pid ${pid})`, { pid });
      unlinkSync(file);
    }
  }
  fail("ALREADY_RUNNING", "Cannot take the service lock");
}

export async function startService(cfg: Cfg) {
  mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
  const pidFile = join(cfg.dir, "service.pid"), tokenFile = join(cfg.dir, "token"), portFile = join(cfg.dir, "service.port");
  acquireLock(pidFile);
  const LIMIT_HOUR = envNum("LINKEDIN_CLI_LIMIT_HOUR", 15), LIMIT_DAY = envNum("LINKEDIN_CLI_LIMIT_DAY", 60);
  const GAP_MIN = envNum("LINKEDIN_CLI_GAP_MIN_MS", 20000), GAP_MAX = envNum("LINKEDIN_CLI_GAP_MAX_MS", 30000);
  const CALL_TIMEOUT = envNum("LINKEDIN_CLI_CALL_TIMEOUT_MS", 20 * 60000); // long: per-character typing, video processing

  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  const token = Buffer.from(readFileSync(tokenFile, "utf8").trim());

  // /ext is pinned to the ID derived from the bundled manifest key; without a key any chrome-extension:// origin is accepted.
  let pinned: string | null = null;
  try { pinned = pinnedId(); } catch { /* no readable bundle */ }
  if (!pinned) console.error("[linkedin-cli] warning: extension manifest has no key; /ext accepts any chrome-extension:// origin (extensionPinned:false)");

  const db = openDb(join(cfg.dir, "state.db"));
  const q = new Queue(db);
  q.recover();

  // ---- halt state (persisted) ----
  const kvGet = (k: string) => { const r = db.query("SELECT value FROM kv WHERE key=?").get(k) as any; return r ? JSON.parse(r.value) : null; };
  const kvSet = (k: string, v: unknown) => v === null ? db.query("DELETE FROM kv WHERE key=?").run(k) : db.query("INSERT OR REPLACE INTO kv VALUES (?,?)").run(k, JSON.stringify(v));
  let halted: { reason: string; at: number } | null = kvGet("halted");
  const setHalt = (reason: string) => { halted = { reason, at: Date.now() }; kvSet("halted", halted); };

  // ---- budget (shared by every outward action; survives restarts because it is read from the action log) ----
  const since = (ms: number, tool?: string) =>
    (db.query(`SELECT ts FROM actions WHERE counted=1 AND ts>? ${tool ? "AND tool=?" : ""} ORDER BY ts`).all(...(tool ? [Date.now() - ms, tool] : [Date.now() - ms])) as any[]).map((r) => r.ts as number);
  const budgetInfo = () => ({
    hour: { used: since(HOUR).length, limit: LIMIT_HOUR }, day: { used: since(DAY).length, limit: LIMIT_DAY },
    invites: { used: since(DAY, "connect").length, limit: INVITE_LIMIT },
  });
  function limited(tool: string): { retryAt: number; message: string } | null {
    if (!BUDGET.has(tool) && !CHECK_ONLY.has(tool)) return null;
    const day = since(DAY), hour = day.filter((t) => t > Date.now() - HOUR), hits: { retryAt: number; message: string }[] = [];
    if (hour.length >= LIMIT_HOUR) hits.push({ retryAt: hour[0]! + HOUR, message: `Hourly limit reached: ${hour.length} outward actions in 1 h (max ${LIMIT_HOUR})` });
    if (day.length >= LIMIT_DAY) hits.push({ retryAt: day[0]! + DAY, message: `Daily limit reached: ${day.length} outward actions in 24 h (max ${LIMIT_DAY})` });
    if (tool === "connect") {
      const inv = since(DAY, "connect");
      if (inv.length >= INVITE_LIMIT) hits.push({ retryAt: inv[0]! + DAY, message: `Daily limit reached: ${inv.length} invitations in 24 h (max ${INVITE_LIMIT})` });
    }
    return hits.sort((a, b) => b.retryAt - a.retryAt)[0] ?? null;
  }
  const lastOutward = () => ((db.query("SELECT MAX(ts) t FROM actions WHERE counted=1").get() as any).t as number | null) ?? 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ---- extension link ----
  type Pending = { ws: ServerWebSocket<unknown>; resolve: (v: any) => void; reject: (e: Error) => void };
  let ext: ServerWebSocket<unknown> | null = null, extVersion: string | null = null, extId: string | null = null, extOk = false;
  let seq = 0;
  const pending = new Map<number, Pending>();
  const failPending = (ws: ServerWebSocket<unknown>, message: string) => {
    for (const [id, p] of pending) if (p.ws === ws) { pending.delete(id); p.reject(new Error(message)); }
  };

  function send(ws: ServerWebSocket<unknown> | null, tool: string, args: object = {}): Promise<any> {
    if (!ws) return Promise.reject(new Error("Extension not connected."));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${tool} timed out`)); }, CALL_TIMEOUT);
      pending.set(id, { ws, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      ws.send(JSON.stringify({ id, tool, args }));
    });
  }
  function assertReady() {
    if (!ext) fail("EXTENSION_NOT_CONNECTED", 'Extension not connected. Open Chrome with the "LinkedIn CLI Bridge" extension enabled.');
    if (!extOk) fail("VERSION_MISMATCH", extVersion
      ? `Version mismatch: extension ${extVersion}, service ${VERSION}. Reload the extension in chrome://extensions or update the service.`
      : `Extension is older than ${VERSION} (no version handshake). Reload it in chrome://extensions.`, { extension: extVersion, server: VERSION });
  }
  const assertNotHalted = () => { if (halted) fail("HALTED", `Halted: ${halted.reason}. Resolve it in Chrome, then run \`linkedin service resume\`.`, { reason: halted.reason, since: halted.at }); };

  function onExtMessage(ws: ServerWebSocket<unknown>, raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (ws !== ext) return;
    if (msg.type === "hello") {
      extVersion = msg.version ?? null; extId = msg.extensionId ?? null;
      extOk = compatible(msg.version, VERSION);
      ws.send(JSON.stringify(extOk ? { type: "hello", version: VERSION } : { type: "reject", reason: "version_mismatch", serverVersion: VERSION }));
      kick();
      return;
    }
    const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error === undefined) return p.resolve(msg.result);
    p.reject(Object.assign(new Error(String(msg.error)), msg.code === "HALT" ? { halt: String(msg.reason || msg.error) } : {}));
  }

  // ---- worker: ONE job at a time, so the browser never runs two things at once ----
  let working = false, wake: ReturnType<typeof setTimeout> | undefined, stopping = false;
  const waiters = new Map<number, (j: Job) => void>();
  const notify = (j: Job) => { const w = waiters.get(j.id); if (w && FINAL.has(j.state)) { waiters.delete(j.id); w(j); } };

  async function runJob(job: Job) {
    const ws = ext, t0 = Date.now();
    q.start(job.id);
    const lim = limited(job.tool);
    if (lim) {
      const j = q.complete(job.id, { error: `RATE_LIMIT:${JSON.stringify(lim)}`, retryAt: lim.retryAt });
      return notify(j);
    }
    let out: any;
    try {
      if (BUDGET.has(job.tool) || CHECK_ONLY.has(job.tool)) {
        const wait = lastOutward() + GAP_MIN + Math.random() * Math.max(0, GAP_MAX - GAP_MIN) - Date.now();
        if (wait > 0) await sleep(wait);
      }
      out = { result: await send(ws, job.tool, job.args) };
      if (job.tool === "schedule") {
        try {
          const v = typeof out.result?.verified === "boolean" ? out.result.verified : undefined;
          if (!(v ?? verifyScheduled(job.args, await send(ws, "listScheduled")))) out.unverified = "not found in scheduled list";
        } catch (e: any) { out.unverified = `verification failed: ${e.message}`; }
      }
    } catch (e: any) {
      const text = String(e.message);
      if (e.halt || isHaltText(text)) out = { error: isHaltText(text) ? text : `STOPPED. ${e.halt}`, halt: true, reason: e.halt ?? text };
      else out = { error: text, ambiguous: isAmbiguous(text) };
      const rl = parseRateLimit(text);
      if (rl) out.retryAt = rl;
    }
    const j = q.complete(job.id, out);
    if (out.halt) setHalt(out.reason);
    if (isOutward(job.tool)) {
      const counted = BUDGET.has(job.tool) && (j.state === "unverified" || (j.state === "done" && DID_OUTWARD(out.result)));
      db.query("INSERT INTO actions (ts,job_id,tool,args,state,result,error,duration_ms,counted) VALUES (?,?,?,?,?,?,?,?,?)").run(
        Date.now(), j.id, j.tool, JSON.stringify(j.args), j.state, out.result === undefined ? null : JSON.stringify(out.result), j.error ?? null, Date.now() - t0, counted ? 1 : 0);
    }
    notify(j);
  }

  async function pump() {
    if (working || stopping) return;
    working = true;
    try {
      while (!stopping && ext && extOk && !halted) {
        const job = q.next();
        if (!job) break;
        await runJob(job);
      }
    } finally { working = false; }
    clearTimeout(wake);
    const at = q.wakeAt();
    if (at && ext && !halted && !stopping) wake = setTimeout(kick, Math.min(Math.max(at - Date.now(), 200), 2 ** 31 - 1));
  }
  const kick = () => { pump().catch((e) => console.error(`[linkedin-cli] worker: ${e.stack}`)); };

  function jobError(j: Job): CliError {
    if (j.state === "unverified") return new CliError("UNVERIFIED", `Unverified (job ${j.id}): ${j.error}. Check LinkedIn before retrying.`, { jobId: j.id });
    if (j.state === "cancelled") return new CliError("CANCELLED", j.error || `Job ${j.id} cancelled`, { jobId: j.id });
    const e = j.error || `Job ${j.id} ${j.state}`;
    if (/^STOPPED\./.test(e) || isHaltText(e)) return new CliError("HALTED", e, { reason: halted?.reason ?? e, jobId: j.id });
    const rl = /^RATE_LIMIT:(\{.*\})/s.exec(e);
    if (rl) { const o = JSON.parse(rl[1]!); return new CliError("RATE_LIMIT", o.message ?? "Rate limit reached", { retryAt: o.retryAt, jobId: j.id }); }
    return new CliError("EXTENSION_ERROR", e, { jobId: j.id });
  }

  function runSync(tool: string, args: object, key?: string) {
    const job = q.enqueue({ tool, args, priority: 1, key });
    return new Promise<any>((resolve, reject) => {
      const settle = (j: Job) => (j.state === "done" ? resolve(j.result) : reject(jobError(j)));
      if (FINAL.has(job.state)) return settle(job); // deduped onto an already finished job
      waiters.set(job.id, settle);
      kick();
    });
  }

  // ---- RPC ----
  const preview = (tool: string, args: object, extra: object = {}) => ({
    preview: true, tool, args, ...extra, countsAgainstBudget: BUDGET.has(tool), budget: budgetInfo(),
    hint: "Nothing was sent. Re-run the same command with --confirm to execute.",
  });

  function checkAction(tool: string, args: any) {
    if (typeof tool !== "string" || !HANDLERS.has(tool)) fail("INVALID", `Unknown action "${tool}". Known: ${[...HANDLERS].join(", ")}`);
    return prepare(tool, args ?? {});
  }

  const rpcs: Record<string, (p: any) => any> = {
    status: () => ({
      running: true, pid: process.pid, port: cfg.port, extensionUrl: `ws://127.0.0.1:${cfg.port}/ext`, server: VERSION, extension: extVersion, extensionId: extId,
      extensionPinned: !!pinned, expectedExtensionId: pinned, match: !!ext && extOk, connected: !!ext, halted, queue: q.counts(), budget: budgetInfo(), error: null,
    }),
    async call(p) {
      const args = checkAction(p.tool, p.args);
      if (needsConfirm(p.tool) && !p.confirm) return preview(p.tool, args);
      assertNotHalted();
      assertReady();
      const lim = limited(p.tool);
      if (lim) fail("RATE_LIMIT", lim.message, { retryAt: lim.retryAt });
      return runSync(p.tool, args, p.tool === "likeComment" ? `like:${args.commentId}` : p.key);
    },
    enqueue(p) {
      const args = checkAction(p.tool, p.args);
      let notBefore: number | undefined;
      if (p.notBefore !== undefined) {
        notBefore = typeof p.notBefore === "string" && !/^\d+$/.test(p.notBefore) ? Date.parse(p.notBefore) : Number(p.notBefore);
        if (Number.isNaN(notBefore)) fail("INVALID", "notBefore must be ISO 8601 or epoch ms");
      }
      if (needsConfirm(p.tool) && !p.confirm) return preview(p.tool, args, { notBefore, key: p.key });
      assertNotHalted();
      const j = q.enqueue({ tool: p.tool, args, key: p.key, priority: 0, notBefore });
      kick();
      return { jobId: j.id, status: j.state };
    },
    queue(p) {
      if (p.action === "list") return q.list({ status: p.status, limit: p.limit }).map(({ result, ...j }) => ({ ...j, hasResult: result !== undefined }));
      if (!Number.isInteger(p.id)) fail("USAGE", "job id required");
      const j = q.get(p.id);
      if (!j) fail("NOT_FOUND", `No job ${p.id}`);
      if (p.action === "get") return j;
      const c = q.cancel(p.id);
      if (!c) fail("INVALID", `Job ${p.id} is ${j!.state}; only queued jobs can be cancelled`);
      notify(c!);
      return c;
    },
    resume() {
      halted = null; kvSet("halted", null);
      ext?.send(JSON.stringify({ type: "resume" }));
      kick();
      return { resumed: true, halted: null };
    },
    reloadExtension() { // ask the extension to chrome.runtime.reload(); works even when its version is rejected
      if (!ext) fail("EXTENSION_NOT_CONNECTED", "Extension not connected.");
      ext!.send(JSON.stringify({ type: "reload" }));
      return { sent: true };
    },
    stop() { setTimeout(() => void stop(), 10); return { stopping: true }; },
  };

  const origin = (req: Request) => req.headers.get("origin");
  const handle = async (req: Request, srv: ReturnType<typeof Bun.serve>) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/ext") {
        // Browsers always send Origin on WebSocket handshakes; only our extension may connect (exact ID when pinned).
        const o = origin(req);
        if (pinned ? o !== `chrome-extension://${pinned}` : !o?.startsWith("chrome-extension://")) return new Response("forbidden", { status: 403 });
        return srv.upgrade(req, { data: null }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (pathname !== "/rpc" || req.method !== "POST") return new Response("not found", { status: 404 });
      if (origin(req)) return new Response("forbidden", { status: 403 }); // a web page, never the CLI
      const given = Buffer.from((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
      if (given.length !== token.length || !timingSafeEqual(given, token)) return new Response("unauthorized", { status: 401 });
      try {
        const { method, params } = (await req.json()) as any;
        const fn = Object.hasOwn(rpcs, method) ? rpcs[method] : undefined;
        if (!fn) fail("USAGE", `Unknown method ${method}`);
        return Response.json({ ok: true, result: await fn!(params ?? {}) });
      } catch (e: any) {
        const err = e instanceof CliError ? e : new CliError("INTERNAL", String(e?.message ?? e));
        return Response.json({ ok: false, ...err.toJSON() });
      }
  };
  let server: ReturnType<typeof Bun.serve>;
  try {
  server = Bun.serve({
    hostname: "127.0.0.1", port: cfg.port, idleTimeout: 0,
    async fetch(req, srv) { const r = await handle(req, srv); r?.headers.set(OWN_HEADER, VERSION); return r; },
    websocket: {
      idleTimeout: 960,
      open(ws) {
        if (ext && ext !== ws) { failPending(ext, "Extension reconnected while the action was running"); ext.close(); }
        ext = ws; extVersion = null; extId = null; extOk = false;
      },
      message: (ws, data) => onExtMessage(ws, String(data)),
      close(ws) {
        failPending(ws, "Extension disconnected while the action was running");
        if (ext !== ws) return;
        ext = null; extOk = false;
        for (const id of [...waiters.keys()]) { // direct callers must not hang until the extension returns
          const j = q.get(id);
          if (j?.state === "queued" && j.priority === 1) { const c = q.cancel(id); if (c) notify({ ...c, error: "Extension disconnected before the action started" }); }
        }
      },
    },
  });
  } catch (e: any) { // release what was taken above, otherwise a stale pidfile/db handle outlives the failed start
    db.close();
    try { unlinkSync(pidFile); } catch { /* already gone */ }
    if (e?.code === "EADDRINUSE" || /in use/i.test(String(e?.message))) throw portInUse(cfg.port);
    throw e;
  }
  writeFileSync(portFile, String(server.port), { mode: 0o600 });

  const ping = setInterval(() => ext?.send('{"type":"ping"}'), 20000);
  let stopResolve!: () => void;
  const stopped = new Promise<void>((r) => (stopResolve = r));
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(ping); clearTimeout(wake);
    for (const p of pending.values()) p.reject(new Error("Service stopped while the action was running"));
    await server.stop(true);
    // wait for the in-flight job to be recorded before closing the db
    for (let i = 0; i < 50 && working; i++) await sleep(20);
    db.close();
    for (const f of [pidFile, portFile]) try { unlinkSync(f); } catch { /* already gone */ }
    stopResolve();
  }
  kick();
  return { stop, stopped, port: server.port };
}
