import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, freePort, sleep } from "./helpers";

// A service from an older version answers without the x-linkedin-cli header; it must still be recognised as ours (via pidfile).
const dirs: string[] = [], procs: { kill(): void }[] = [];
afterEach(() => { while (procs.length) procs.pop()!.kill(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function legacy(argv: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "lcli-legacy-")); dirs.push(dir);
  const port = await freePort();
  const script = join(dir, "legacy.js");
  writeFileSync(script, `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => Response.json({ ok: true, result: { running: true, server: "0.1.1", connected: false } }) }); setInterval(() => {}, 1e6);`);
  const p = Bun.spawn([process.execPath, script, ...argv], { stdout: "ignore", stderr: "ignore" });
  procs.push(p);
  writeFileSync(join(dir, "service.pid"), String(p.pid)); writeFileSync(join(dir, "service.port"), String(port)); writeFileSync(join(dir, "token"), "tok");
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await sleep(20); } }
  return { dir, port, pid: p.pid, env: { LINKEDIN_CLI_DIR: dir, LINKEDIN_CLI_PORT: String(port) } };
}

describe("service started by an older version (no x-linkedin-cli header)", () => {
  test.each([["command line is `service run`", ["service", "run"]], ["port owner equals pidfile pid", ["whatever"]]])("%s: status ok, stop SIGTERMs it, start proceeds", async (_n, argv) => {
    const l = await legacy(argv);
    const st = await cli(["service", "status"], l.env);
    expect(st.code).toBe(0);
    expect(st.json).toMatchObject({ running: true, server: "0.1.1" });
    const stop = await cli(["service", "stop"], l.env);
    expect(stop.json).toEqual({ stopped: true });
    expect(alive(l.pid)).toBe(false);
    expect(existsSync(join(l.dir, "service.pid"))).toBe(false);
    const start = await cli(["service", "start"], l.env);
    expect(start.code).toBe(0);
    expect(start.json).toMatchObject({ running: true, port: l.port });
    expect((await cli(["service", "stop"], l.env)).json).toEqual({ stopped: true });
  });

  test("a live but unrelated pid in the pidfile does not make a foreign listener ours", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcli-legacy-")); dirs.push(dir);
    const port = await freePort();
    const foreign = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("hi") });
    const other = Bun.spawn(["sleep", "30"]); procs.push(other);
    writeFileSync(join(dir, "service.pid"), String(other.pid)); writeFileSync(join(dir, "token"), "t");
    try {
      const r = await cli(["service", "start"], { LINKEDIN_CLI_DIR: dir, LINKEDIN_CLI_PORT: String(port) });
      expect(r.errJson.error.code).toBe("PORT_IN_USE");
      expect((await cli(["service", "stop"], { LINKEDIN_CLI_DIR: dir, LINKEDIN_CLI_PORT: String(port) })).errJson?.error.code).toBe("PORT_IN_USE");
      expect(alive(other.pid)).toBe(true);
    } finally { foreign.stop(true); }
  });
});
