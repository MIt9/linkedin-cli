import { existsSync, openSync, readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { alive, isLegacy, portInUse, probe, rpc } from "./client";
import { COMPILED, loadCfg, type Cfg } from "./config";
import { CliError } from "./errors";
import { folderState, pinnedId } from "./ext";
import { startService } from "./service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const down = (e: unknown) => e instanceof CliError && e.code === "SERVICE_UNAVAILABLE";
const num = (file: string) => { try { return Number(readFileSync(file, "utf8")); } catch { return 0; } };

// The port the running service really listens on (service.port), which differs from the configured one after `config set port`.
const pinned = () => { try { return !!pinnedId(); } catch { return false; } };
const live = (cfg: Cfg): Cfg => {
  const pid = num(join(cfg.dir, "service.pid")), port = num(join(cfg.dir, "service.port"));
  return pid && port && alive(pid) ? { ...cfg, port } : cfg;
};

// null = nothing of ours is running. A foreign listener on the port throws PORT_IN_USE.
async function runningStatus(cfg: Cfg) {
  const run = live(cfg);
  const s = await rpc("status", {}, run).catch((e) => { if (down(e)) return null; throw e; });
  return s && run.port !== cfg.port ? { ...s, configuredPort: cfg.port, portMismatch: true } : s;
}

export async function serviceCommand(cmd: string): Promise<unknown> {
  const cfg = loadCfg();
  if (cmd === "run") { // foreground; `start` spawns this detached
    const svc = await startService(cfg);
    for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => void svc.stop());
    await svc.stopped;
    process.exit(0);
  }
  if (cmd === "status") {
    const down = { running: false, port: cfg.port, extensionUrl: `ws://127.0.0.1:${cfg.port}/ext`, extensionPinned: pinned() };
    try { return { ...((await runningStatus(cfg)) ?? down), extensionFolder: folderState(cfg.dir) }; } catch (e) {
      if (e instanceof CliError && e.code === "PORT_IN_USE") return { ...down, portInUse: true, error: e.message, extensionFolder: folderState(cfg.dir) };
      throw e;
    }
  }
  if (cmd === "resume") return rpc("resume", {}, cfg);
  if (cmd === "stop") {
    const run = live(cfg);
    const pid = await isLegacy(run);
    if (pid) { // older service (no header): SIGTERM, then wait for it to exit and drop its pidfile
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 100 && alive(pid); i++) await sleep(50);
      if (alive(pid)) throw new CliError("SERVICE_UNAVAILABLE", `Older service (pid ${pid}) did not exit after SIGTERM. Stop it manually.`);
      for (const f of ["service.pid", "service.port"]) try { unlinkSync(join(cfg.dir, f)); } catch { /* already gone */ }
      return { stopped: true };
    }
    try { await rpc("stop", {}, run); } catch (e) { if (down(e)) return { running: false, stopped: false }; throw e; }
    for (let i = 0; i < 100 && existsSync(join(cfg.dir, "service.pid")); i++) await sleep(50);
    return { stopped: true };
  }
  // start
  const already = await runningStatus(cfg);
  if (already) return { ...already, alreadyRunning: true };
  if ((await probe(cfg.port, cfg.dir)) === "foreign") throw portInUse(cfg.port);
  mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
  const logFile = join(cfg.dir, "service.log");
  const log = openSync(logFile, "a");
  const child = Bun.spawn(COMPILED ? [process.execPath, "service", "run"] : [process.execPath, join(import.meta.dir, "cli.ts"), "service", "run"], { env: process.env, stdin: "ignore", stdout: log, stderr: log });
  child.unref();
  for (let i = 0; i < 100; i++) {
    const s = await runningStatus(cfg);
    if (s) return s;
    if (child.exitCode !== null) break;
    await sleep(50);
  }
  const pidFile = join(cfg.dir, "service.pid");
  if (child.exitCode !== null && existsSync(pidFile) && !alive(num(pidFile))) unlinkSync(pidFile); // child died without cleaning up
  const tail = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(-5).join("\n") : "";
  if (child.exitCode !== null && tail.includes('"code":"PORT_IN_USE"')) throw portInUse(cfg.port); // lost the race for the port after the probe
  throw new CliError("SERVICE_UNAVAILABLE", `Service failed to start. Log ${logFile}: ${tail}`);
}
