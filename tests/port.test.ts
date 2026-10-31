import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probe, rpc } from "../src/client";
import { cli, freePort, startSvc } from "./helpers";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "lcli-port-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("port in use", () => {
  test("service start: foreign HTTP server -> PORT_IN_USE (exit 8), no pidfile, token never sent", async () => {
    const dir = tmp(), port = await freePort();
    writeFileSync(join(dir, "token"), "secret-token");
    const seen: (string | null)[] = [];
    const foreign = Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => { seen.push(req.headers.get("authorization")); return new Response("<html>hi</html>"); } });
    try {
      const env = { LINKEDIN_CLI_DIR: dir, LINKEDIN_CLI_PORT: String(port) };
      const r = await cli(["service", "start"], env);
      expect(r.code).toBe(8);
      expect(r.errJson.error.code).toBe("PORT_IN_USE");
      expect(r.errJson.error.message).toContain(String(port));
      expect(r.errJson.error.message).toContain("linkedin config set port");
      expect(existsSync(join(dir, "service.pid"))).toBe(false);
      expect(seen.every((a) => a === null)).toBe(true);
      const st = await cli(["service", "status"], env);
      expect(st.code).toBe(0);
      expect(st.json).toMatchObject({ running: false, port, portInUse: true });
      const other = await cli(["queue", "list"], env);
      expect(other.errJson.error.code).toBe("PORT_IN_USE");
      expect(seen.every((a) => a === null)).toBe(true);
    } finally { foreign.stop(true); }
  });

  test("service run (foreground) maps EADDRINUSE to PORT_IN_USE and leaves no pidfile", async () => {
    const dir = tmp(), port = await freePort();
    const raw = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {}, open() {} } });
    try {
      const r = await cli(["service", "run"], { LINKEDIN_CLI_DIR: dir, LINKEDIN_CLI_PORT: String(port) });
      expect(r.code).toBe(8);
      expect(r.errJson.error.code).toBe("PORT_IN_USE");
      expect(existsSync(join(dir, "service.pid"))).toBe(false);
      const s = await cli(["service", "start"], { LINKEDIN_CLI_DIR: dir, LINKEDIN_CLI_PORT: String(port) });
      expect(s.errJson.error.code).toBe("PORT_IN_USE");
      expect(existsSync(join(dir, "service.pid"))).toBe(false);
    } finally { raw.stop(true); }
  });

  test("own service is identified; foreign and free are told apart", async () => {
    const svc = await startSvc();
    try {
      expect(await probe(svc.port)).toBe("ours");
      const s: any = await svc.status();
      expect(s).toMatchObject({ port: svc.port, extensionUrl: `ws://127.0.0.1:${svc.port}/ext` });
    } finally { await svc.stop(); }
    expect(await probe(svc.port)).toBe("free");
    const port = await freePort();
    const foreign = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("not json") });
    try {
      expect(await probe(port)).toBe("foreign");
      const dir = tmp(); writeFileSync(join(dir, "token"), "t");
      await expect(rpc("status", {}, { dir, port })).rejects.toMatchObject({ code: "PORT_IN_USE" });
    } finally { foreign.stop(true); }
  });
});

describe("config", () => {
  const run = async (dir: string, args: string[], env: Record<string, string> = {}) => cli(["config", ...args], { LINKEDIN_CLI_DIR: dir, LINKEDIN_CLI_PORT: "", ...env });

  test("get/set/unset round trip, persisted in config.json", async () => {
    const dir = tmp();
    expect((await run(dir, ["get"])).json).toMatchObject({ port: { value: 47851, source: "default" } });
    expect((await run(dir, ["set", "port", "50123"])).json).toMatchObject({ port: { value: 50123, source: "config" } });
    expect(JSON.parse(await Bun.file(join(dir, "config.json")).text())).toEqual({ port: 50123 });
    expect((await run(dir, ["get", "port"])).json).toMatchObject({ port: { value: 50123, source: "config" } });
    expect((await run(dir, ["unset", "port"])).json).toMatchObject({ port: { value: 47851, source: "default" } });
    expect((await run(dir, ["get"])).json.port.source).toBe("default");
  });

  test("validation: only key port, integer 1024-65535", async () => {
    const dir = tmp();
    for (const args of [["set", "port", "80"], ["set", "port", "70000"], ["set", "port", "abc"], ["set", "port", "1.5"], ["set", "port", ""], ["set", "host", "1"], ["set", "port"], ["get", "host"], ["unset", "host"], ["unset"], ["set", "port", "2000", "x"]]) {
      const r = await run(dir, args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.errJson.error.code).toBe("USAGE");
    }
    expect(existsSync(join(dir, "config.json"))).toBe(false);
    expect((await run(dir, ["set", "port", "1024"])).code).toBe(0);
    expect((await run(dir, ["set", "port", "65535"])).code).toBe(0);
  });

  test("precedence: env > config.json > default", async () => {
    const dir = tmp();
    await run(dir, ["set", "port", "50123"]);
    expect((await run(dir, ["get", "port"], { LINKEDIN_CLI_PORT: "50999" })).json.port).toMatchObject({ value: 50999, source: "env" });
    expect((await run(dir, ["get", "port"])).json.port).toMatchObject({ value: 50123, source: "config" });
  });

  test("service uses config port; status reports running vs configured port", async () => {
    const dir = tmp(), port = await freePort(), port2 = await freePort();
    const env = { LINKEDIN_CLI_DIR: dir, LINKEDIN_CLI_PORT: "" };
    await run(dir, ["set", "port", String(port)]);
    try {
      const st = await cli(["service", "start"], env);
      expect(st.json).toMatchObject({ running: true, port, extensionUrl: `ws://127.0.0.1:${port}/ext` });
      await run(dir, ["set", "port", String(port2)]);
      const s2 = await cli(["service", "status"], env);
      expect(s2.json).toMatchObject({ running: true, port, configuredPort: port2, portMismatch: true });
      const again = await cli(["service", "start"], env);
      expect(again.json).toMatchObject({ alreadyRunning: true, port });
    } finally {
      const stop = await cli(["service", "stop"], env);
      expect(stop.json).toMatchObject({ stopped: true });
    }
    expect((await cli(["service", "status"], env)).json).toMatchObject({ running: false, port: port2 });
  });
});
