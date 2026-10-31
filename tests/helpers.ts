import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpc } from "../src/client";
import { VERSION } from "../src/config";

export { VERSION };
const [MAJ, MIN] = VERSION.split(".").map(Number) as [number, number];
export const PATCH = `${MAJ}.${MIN}.7`; // same major.minor = compatible
export const NEXT_MINOR = `${MAJ}.${MIN + 1}.0`; // incompatible
export const KEYLESS_EXT = join(import.meta.dir, "fixtures", "ext-keyless"); // LINKEDIN_CLI_EXT_SRC with no manifest key

export const ROOT = join(import.meta.dir, "..");
export const halt = (reason: string) => Object.assign(new Error(`STOPPED. ${reason}`), { code: "HALT", reason });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function freePort() {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port as number;
  await s.stop(true);
  return p;
}

export async function cli(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn([process.execPath, "src/cli.ts", ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  const parse = (s: string) => { try { return JSON.parse(s); } catch { return undefined; } };
  return { code, out, err, json: parse(out), errJson: parse(err) };
}

// Real service in a child process, throwaway dir and port, gap/limits relaxed (tests override as needed).
export async function startSvc(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lcli-"));
  const port = await freePort();
  const env = {
    LINKEDIN_CLI_DIR: dir, LINKEDIN_CLI_EXT_SRC: KEYLESS_EXT, LINKEDIN_CLI_PORT: String(port), LINKEDIN_CLI_GAP_MIN_MS: "0", LINKEDIN_CLI_GAP_MAX_MS: "0",
    LINKEDIN_CLI_LIMIT_HOUR: "1000", LINKEDIN_CLI_LIMIT_DAY: "1000", ...extra,
  };
  const run = (...a: string[]) => cli(a, env);
  const started = await run("service", "start");
  if (started.code !== 0) throw new Error(`service start failed: ${started.err}`);
  const cfg = { dir, port };
  return {
    dir, port, env, run, cfg,
    call: (tool: string, args: object = {}, confirm = true, key?: string) => rpc("call", { tool, args, confirm, key }, cfg),
    status: () => rpc("status", {}, cfg) as Promise<any>,
    stop: async () => { await run("service", "stop"); rmSync(dir, { recursive: true, force: true }); },
  };
}
export type Svc = Awaited<ReturnType<typeof startSvc>>;

export async function fakeExt(svc: { port: number; cfg: { dir: string; port: number } }, o: { version?: string | null; handler?: (tool: string, args: any) => any; origin?: string } = {}) {
  const { version = VERSION, handler = () => ({ ok: true }), origin = "chrome-extension://fake" } = o;
  const ws = new WebSocket(`ws://127.0.0.1:${svc.port}/ext`, { headers: { Origin: origin } } as any);
  const calls: { id: number; tool: string; args: any }[] = [];
  const received: any[] = [];
  ws.onmessage = async (e) => {
    const msg = JSON.parse(String(e.data));
    received.push(msg);
    if (msg.type === "ping") return ws.send('{"type":"pong"}');
    if (msg.id === undefined) return;
    calls.push(msg);
    try { ws.send(JSON.stringify({ id: msg.id, result: await handler(msg.tool, msg.args) })); } catch (err: any) { ws.send(JSON.stringify({ id: msg.id, error: err.message, ...(err.code === "HALT" ? { code: "HALT", reason: err.reason } : {}) })); }
  };
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws refused")); });
  if (version !== null) ws.send(JSON.stringify({ type: "hello", version, extensionId: "fake-id" }));
  for (let i = 0; i < 100; i++) { // wait until the service registered the hello
    const s: any = await rpc("status", {}, svc.cfg);
    if (s.connected && (version === null || s.extension === version)) break;
    await sleep(20);
  }
  return { ws, calls, received, close: () => ws.close() };
}
