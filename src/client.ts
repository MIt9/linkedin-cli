import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCfg, type Cfg } from "./config";
import { CliError } from "./errors";

export const OWN_HEADER = "x-linkedin-cli"; // every response of the service carries it; foreign listeners do not

const sh = (cmd: string[]) => { try { return Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim(); } catch { return ""; } };
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Best-effort owners of a listening port (lsof may be absent).
const owners = (port: number) => sh(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).split("\n").filter(Boolean).map(Number);
const owner = (port: number) => { const o = owners(port); return o.length ? ` (pid ${o.join(", ")})` : ""; };
export const portInUse = (port: number) => new CliError("PORT_IN_USE",
  `Port ${port} is used by another process${owner(port)}, not by linkedin-cli. Choose another port: \`linkedin config set port N\` (1024-65535), restart the service, and enter the same port in the extension popup.`, { port });

// A service from an older version has no OWN_HEADER. It is still ours if <dir>/service.pid is alive and either runs as a linkedin service or owns the port.
export function legacyPid(dir: string, port: number): number {
  let pid = 0;
  try { pid = Number(readFileSync(join(dir, "service.pid"), "utf8")); } catch { return 0; }
  if (!pid || !alive(pid)) return 0;
  return /\bservice run\b|(^|\/)linkedin(-cli)?(\s|$)/.test(sh(["ps", "-o", "command=", "-p", String(pid)])) || owners(port).includes(pid) ? pid : 0;
}

// Who answers on the port? Unauthenticated GET, so the token never reaches a foreign listener.
export async function probe(port: number, dir?: string): Promise<"free" | "ours" | "foreign"> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, { signal: AbortSignal.timeout(2000) });
    return res.headers.has(OWN_HEADER) || (dir && legacyPid(dir, port)) ? "ours" : "foreign";
  } catch (e: any) { return e?.code === "ConnectionRefused" ? "free" : "foreign"; }
}

// Talks to the local service over HTTP with the per-install token. No timeout: outward actions can take minutes.
export async function rpc(method: string, params: object = {}, cfg: Cfg = loadCfg()): Promise<any> {
  let token: string;
  try { token = readFileSync(join(cfg.dir, "token"), "utf8").trim(); } catch {
    throw new CliError("SERVICE_UNAVAILABLE", "Service is not running (no token). Start it with `linkedin service start`.");
  }
  const who = await probe(cfg.port, cfg.dir);
  if (who === "free") throw new CliError("SERVICE_UNAVAILABLE", `Service is not reachable on 127.0.0.1:${cfg.port}. Start it with \`linkedin service start\`.`);
  if (who === "foreign") throw portInUse(cfg.port);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.port}/rpc`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ method, params }), timeout: false,
    } as RequestInit);
  } catch {
    throw new CliError("SERVICE_UNAVAILABLE", `Service is not reachable on 127.0.0.1:${cfg.port}. Start it with \`linkedin service start\`.`);
  }
  if (!res.headers.has(OWN_HEADER) && !legacyPid(cfg.dir, cfg.port)) throw portInUse(cfg.port);
  if (res.status === 401 || res.status === 403) throw new CliError("UNAUTHORIZED", "Service rejected the token (another install on this port?).");
  const body: any = await res.json();
  if (body.ok) return body.result;
  const { code, message, ...extra } = body.error;
  throw new CliError(code, message, extra);
}

// True when our own (older) service answers on cfg.port without the header: stop it by signal, its RPC set may differ.
export async function isLegacy(cfg: Cfg): Promise<number> {
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/rpc`, { signal: AbortSignal.timeout(2000) });
    return res.headers.has(OWN_HEADER) ? 0 : legacyPid(cfg.dir, cfg.port);
  } catch { return 0; }
}
