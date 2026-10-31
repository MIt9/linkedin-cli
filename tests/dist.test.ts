import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { extensionId } from "../src/ext";
import { cli, fakeExt, NEXT_MINOR, sleep, startSvc, VERSION } from "./helpers";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "lcli-dist-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const tar = (out: string, dir: string) => { if (Bun.spawnSync(["tar", "-czf", out, "-C", dir, "."]).exitCode !== 0) throw new Error("tar failed"); };
const key = () => generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");

function extSrc(version: string, k?: string, bg = "bg-v1") {
  const d = tmp();
  writeFileSync(join(d, "manifest.json"), JSON.stringify({ manifest_version: 3, version, ...(k ? { key: k } : {}) }));
  writeFileSync(join(d, "background.js"), bg);
  return d;
}
// PATH shims that record instead of touching the real clipboard / Chrome.
function shims(pbcopyExit = 0) {
  const d = tmp(), rec = join(d, "rec"); mkdirSync(rec);
  writeFileSync(join(d, "pbcopy"), `#!/bin/sh\ncat > "${rec}/pbcopy"\nexit ${pbcopyExit}\n`); chmodSync(join(d, "pbcopy"), 0o755);
  writeFileSync(join(d, "open"), `#!/bin/sh\necho "$@" >> "${rec}/open"\n`); chmodSync(join(d, "open"), 0o755);
  return { PATH: `${d}:${process.env.PATH}`, rec };
}
const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : null);

describe("extension install / path", () => {
  test("copies files, prints 3 steps + id, clipboard + --open via shims, idempotent, .bak on change", async () => {
    const k = key(), src = extSrc("1.2.3", k), state = tmp(), sh = shims();
    const env = { LINKEDIN_CLI_DIR: state, LINKEDIN_CLI_EXT_SRC: src, PATH: sh.PATH };
    const r = await cli(["extension", "install", "--open"], env);
    expect(r.code).toBe(0);
    const path = join(state, "extension");
    expect(r.json).toMatchObject({ path, version: "1.2.3", extensionId: extensionId(k), changed: true, backup: null, clipboard: true, opened: true });
    expect(r.json.steps).toHaveLength(3);
    expect(r.json.steps.join(" ")).toContain("chrome://extensions");
    expect(r.json.steps.join(" ")).toContain("Developer mode");
    expect(r.json.steps.join(" ")).toContain(path);
    expect(readFileSync(join(path, "background.js"), "utf8")).toBe("bg-v1");
    expect(readFileSync(join(path, ".version"), "utf8").trim()).toBe("1.2.3");
    expect(read(join(sh.rec, "pbcopy"))).toBe(path);
    expect(read(join(sh.rec, "open"))?.trim()).toBe("-a Google Chrome chrome://extensions");

    expect((await cli(["extension", "path"], env)).json).toEqual({ path, installed: true });
    rmSync(join(sh.rec, "open"));
    const again = await cli(["extension", "install"], env);
    expect(again.json).toMatchObject({ changed: false, backup: null, opened: false });
    expect(existsSync(join(sh.rec, "open"))).toBe(false);

    writeFileSync(join(path, "background.js"), "user edit");
    const upd = await cli(["extension", "install"], { ...env, LINKEDIN_CLI_EXT_SRC: extSrc("1.2.4", k, "bg-v2") });
    expect(upd.json).toMatchObject({ changed: true, backup: `${path}.bak`, version: "1.2.4" });
    expect(readFileSync(join(`${path}.bak`, "background.js"), "utf8")).toBe("user edit");
    expect(readFileSync(join(path, "background.js"), "utf8")).toBe("bg-v2");
  });
  test("clipboard/open failures never fail the command; no key -> extensionId null", async () => {
    const state = join(tmp(), "fresh"), sh = shims(1);
    const r = await cli(["extension", "install", "--open"], { LINKEDIN_CLI_DIR: state, LINKEDIN_CLI_EXT_SRC: extSrc("1.0.0"), PATH: sh.PATH });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ clipboard: false, extensionId: null });
    expect(statSync(state).mode & 0o777).toBe(0o700);
    const bare = await cli(["extension", "install", "--open"], { LINKEDIN_CLI_DIR: tmp(), LINKEDIN_CLI_EXT_SRC: extSrc("1.0.0"), PATH: "/nonexistent" });
    expect(bare.code).toBe(0);
    expect(bare.json).toMatchObject({ clipboard: false, opened: false });
  });
  test("usage errors", async () => {
    expect((await cli(["extension", "nope"], { LINKEDIN_CLI_DIR: tmp() })).code).toBe(2);
    expect((await cli(["extension", "install", "--bogus"], { LINKEDIN_CLI_DIR: tmp() })).code).toBe(2);
    expect((await cli(["extension", "install", "x"], { LINKEDIN_CLI_DIR: tmp() })).code).toBe(2);
  });
});

describe("--text (human output; JSON stays the default)", () => {
  const STEPS = ["1. Open chrome://extensions", "2. Turn on Developer mode (top right)", "Remove", "extension ID changed", "Load unpacked", "Cmd+Shift+G", "Cmd+V", "5. Then run: linkedin service start && linkedin doctor"];
  test("extension install --text: new install, clipboard, steps; stdout is not JSON", async () => {
    const k = key(), state = tmp(), sh = shims(), path = join(state, "extension");
    const r = await cli(["extension", "install", "--text"], { LINKEDIN_CLI_DIR: state, LINKEDIN_CLI_EXT_SRC: extSrc("1.2.3", k), PATH: sh.PATH });
    expect(r.code).toBe(0);
    expect(r.json).toBeUndefined();
    expect(r.out).toContain(`Extension 1.2.3 installed to ${path}`);
    expect(r.out).toContain(`Extension ID: ${extensionId(k)}`);
    expect(r.out).toContain("Path copied to clipboard");
    for (const s of STEPS) expect(r.out, s).toContain(s);
    expect(r.out).not.toMatch(/unchanged|\.bak/);
  });
  test("extension install --text: no clipboard line when pbcopy fails; unchanged and backup cases", async () => {
    const k = key(), state = tmp(), sh = shims(1), path = join(state, "extension");
    const env = { LINKEDIN_CLI_DIR: state, LINKEDIN_CLI_EXT_SRC: extSrc("1.2.3", k), PATH: sh.PATH };
    const first = await cli(["extension", "install", "--text"], env);
    expect(first.out).not.toContain("clipboard");
    const same = await cli(["extension", "install", "--text"], env);
    expect(same.out).toContain(`Extension 1.2.3 already installed to ${path}`);
    expect(same.out).toContain("files unchanged");
    const upd = await cli(["extension", "install", "--text"], { ...env, LINKEDIN_CLI_EXT_SRC: extSrc("1.2.4", k, "bg-v2") });
    expect(upd.out).toContain(`Extension 1.2.4 installed to ${path}`);
    expect(upd.out).toContain(`Previous folder kept as ${path}.bak`);
  });
  test("default output is still JSON (extension install, doctor)", async () => {
    const r = await cli(["extension", "install"], { LINKEDIN_CLI_DIR: tmp(), LINKEDIN_CLI_EXT_SRC: extSrc("1.0.0"), PATH: shims().PATH });
    expect(r.json.steps).toHaveLength(3);
    expect((await cli(["doctor"], { LINKEDIN_CLI_DIR: join(tmp(), "none"), LINKEDIN_CLI_EXT_SRC: extSrc("1.0.0"), LINKEDIN_CLI_PORT: "47999" })).json.checks).toBeTruthy();
  });
  test("doctor --text on a fresh machine: verdict first, [ok]/[FAIL] lines, indented fix, exit 1", async () => {
    const r = await cli(["doctor", "--text"], { LINKEDIN_CLI_DIR: join(tmp(), "none"), LINKEDIN_CLI_EXT_SRC: extSrc("1.0.0"), LINKEDIN_CLI_PORT: "47999" });
    expect(r.code).toBe(1);
    expect(r.json).toBeUndefined();
    const lines = r.out.trimEnd().split("\n");
    expect(lines).toContain(`[ok] binary version: linkedin ${VERSION} (source checkout)`);
    const i = lines.findIndex((l) => l.startsWith("[FAIL] service running: "));
    expect(i).toBeGreaterThan(-1);
    expect(lines[i + 1]).toBe("    fix: Run `linkedin service start`.");
    expect(lines[0]).toMatch(/^Doctor: \d+ of 9 checks FAILED/);
  });
  test("doctor --text healthy: all [ok], verdict, exit 0 when Chrome is present", async () => {
    const svc = await startSvc(), sh = shims(), env = { ...svc.env, PATH: sh.PATH };
    try {
      await cli(["extension", "install"], env);
      const ext = await fakeExt(svc);
      const r = await cli(["doctor", "--text"], env);
      const lines = r.out.trimEnd().split("\n");
      expect(lines.filter((l) => l.startsWith("[ok] ")).length).toBeGreaterThanOrEqual(8);
      if (r.code === 0) { expect(lines.some((l) => l.startsWith("[FAIL]"))).toBe(false); expect(lines[0]).toBe("Doctor: all good (9 of 9 checks passed)"); }
      else expect(lines.filter((l) => l.startsWith("[FAIL]"))).toHaveLength(1); // only Chrome.app may be missing on a CI box
      ext.close();
    } finally { await svc.stop(); }
  });
  test("--text is a global flag: help lists it, every command accepts it, --text=x is rejected", async () => {
    for (const c of [["extension", "install"], ["doctor"], ["update"], ["extension", "path"]]) expect((await cli([...c, "--help"])).out, c.join(" ")).toContain("--text");
    expect((await cli(["extension", "path", "--text"], { LINKEDIN_CLI_DIR: tmp() })).code).toBe(0);
    expect((await cli(["doctor", "--text=x"], { LINKEDIN_CLI_DIR: tmp() })).code).toBe(2);
  });
});

describe("doctor", () => {
  test("fresh machine: fails with a fix for each failing check, exit 1", async () => {
    const r = await cli(["doctor"], { LINKEDIN_CLI_DIR: join(tmp(), "none"), LINKEDIN_CLI_EXT_SRC: extSrc("1.0.0"), LINKEDIN_CLI_PORT: "47999" });
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    const by = Object.fromEntries(r.json.checks.map((c: any) => [c.name, c]));
    expect(by["binary version"].ok).toBe(true);
    for (const n of ["state dir permissions", "service running", "extension connected", "extension version", "extension files"]) { expect(by[n].ok, n).toBe(false); expect(by[n].fix, n).toBeTruthy(); }
    expect(Object.keys(by)).toEqual(["binary version", "state dir permissions", "service running", "port", "extension connected", "extension version", "extension files", "halted state", "chrome found"]);
  });
  test("healthy install passes every check except possibly chrome; detects mismatches", async () => {
    const svc = await startSvc(), sh = shims();
    const env = { ...svc.env, PATH: sh.PATH };
    try {
      await cli(["extension", "install"], env);
      const ext = await fakeExt(svc);
      const r = await cli(["doctor"], env);
      const by = Object.fromEntries(r.json.checks.map((c: any) => [c.name, c]));
      for (const c of r.json.checks) if (c.name !== "chrome found") expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
      expect(r.code).toBe(by["chrome found"].ok ? 0 : 1);
      ext.close();

      const bad = await fakeExt(svc, { version: NEXT_MINOR });
      const v = (await cli(["doctor"], env)).json.checks.find((c: any) => c.name === "extension version");
      expect(v.ok).toBe(false);
      expect(v.detail).toContain(NEXT_MINOR);
      bad.close();

      writeFileSync(join(svc.dir, "extension", "manifest.json"), "{}");
      expect((await cli(["doctor"], env)).json.checks.find((c: any) => c.name === "extension files").ok).toBe(false);
      chmodSync(svc.dir, 0o755);
      const p = (await cli(["doctor"], env)).json.checks.find((c: any) => c.name === "state dir permissions");
      expect(p.ok).toBe(false);
      expect(p.fix).toContain("chmod 700");
    } finally { chmodSync(svc.dir, 0o700); await svc.stop(); }
  });
  test("halted state is reported", async () => {
    const svc = await startSvc();
    try {
      const ext = await fakeExt(svc, { handler: () => { throw Object.assign(new Error("STOPPED. captcha"), { code: "HALT", reason: "captcha" }); } });
      await svc.call("searchPeople", { keywords: "x" }).catch(() => {});
      const h = (await cli(["doctor"], svc.env)).json.checks.find((c: any) => c.name === "halted state");
      expect(h.ok).toBe(false);
      expect(h.detail).toContain("captcha");
      ext.close();
    } finally { await svc.stop(); }
  });
});

describe("service status: pinning and extension folder", () => {
  test("reports extensionFolder (also when down) and extensionPinned", async () => {
    const state = tmp(), env = { LINKEDIN_CLI_DIR: state, LINKEDIN_CLI_EXT_SRC: extSrc("1.0.0", key()), LINKEDIN_CLI_PORT: "47998" };
    const down = (await cli(["service", "status"], env)).json;
    expect(down).toMatchObject({ running: false, extensionPinned: true, extensionFolder: { installed: false, bundledVersion: "1.0.0", upToDate: false } });
    await cli(["extension", "install"], { ...env, PATH: shims().PATH });
    expect((await cli(["service", "status"], env)).json.extensionFolder).toMatchObject({ installed: true, version: "1.0.0", upToDate: true });
  });
});

describe("update (fake local release server; the real download path is not live-verified)", () => {
  // release dir with latest.json, a fake "binary" per arch and an extension tarball
  function release(version: string, o: { badSha?: boolean; noExt?: boolean } = {}) {
    const rel = tmp(), work = tmp();
    mkdirSync(join(work, "b")); writeFileSync(join(work, "b", "linkedin"), `#!/bin/sh\necho "fake ${version}"\n`); chmodSync(join(work, "b", "linkedin"), 0o755);
    tar(join(rel, "bin.tar.gz"), join(work, "b"));
    tar(join(rel, "ext.tar.gz"), extSrc(version, undefined, "bg-new"));
    const bin = { url: "bin.tar.gz", sha256: o.badSha ? "0".repeat(64) : sha(join(rel, "bin.tar.gz")) };
    writeFileSync(join(rel, "latest.json"), JSON.stringify({ version, binaries: { "darwin-arm64": bin, "darwin-x64": bin }, ...(o.noExt ? {} : { extension: { url: "ext.tar.gz", sha256: sha(join(rel, "ext.tar.gz")) } }) }));
    const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => { const f = join(rel, new URL(req.url).pathname); return existsSync(f) ? new Response(Bun.file(f)) : new Response("nf", { status: 404 }); } });
    return { url: `http://127.0.0.1:${srv.port}`, stop: () => srv.stop(true) };
  }
  const setup = (url: string, extra: Record<string, string> = {}) => {
    const state = tmp(), bin = join(tmp(), "linkedin"); writeFileSync(bin, "OLD"); chmodSync(bin, 0o755);
    return { state, bin, env: { LINKEDIN_CLI_DIR: state, LINKEDIN_CLI_UPDATE_URL: url, LINKEDIN_CLI_BINARY_PATH: bin, LINKEDIN_CLI_PORT: "47997", LINKEDIN_CLI_EXT_SRC: extSrc("0.0.1"), ...extra } };
  };

  test("--check compares versions and changes nothing; same version is a no-op", async () => {
    const rel = release(NEXT_MINOR), s = setup(rel.url);
    try {
      expect((await cli(["update", "--check"], s.env)).json).toEqual({ current: VERSION, latest: NEXT_MINOR, updateAvailable: true, updated: false });
      expect(readFileSync(s.bin, "utf8")).toBe("OLD");
    } finally { rel.stop(); }
    const same = release(VERSION), s2 = setup(same.url);
    try { expect((await cli(["update"], s2.env)).json).toMatchObject({ updateAvailable: false, updated: false }); expect(readFileSync(s2.bin, "utf8")).toBe("OLD"); } finally { same.stop(); }
  });
  test("--text: check says what to run, same version says up to date, real update names the files", async () => {
    const rel = release(NEXT_MINOR), s = setup(rel.url);
    try {
      const c = await cli(["update", "--check", "--text"], s.env);
      expect(c.json).toBeUndefined();
      expect(c.out).toContain(`Update available: ${VERSION} -> ${NEXT_MINOR}. Run: linkedin update`);
      const u = await cli(["update", "--text"], s.env);
      expect(u.code).toBe(0);
      expect(u.out).toContain(`Updated linkedin ${VERSION} -> ${NEXT_MINOR}`);
      expect(u.out).toContain(`Previous binary kept as ${s.bin}.old`);
      expect(u.out).toContain("chrome://extensions");
    } finally { rel.stop(); }
    const same = release(VERSION), s2 = setup(same.url);
    try { expect((await cli(["update", "--text"], s2.env)).out).toContain(`linkedin ${VERSION} is up to date`); } finally { same.stop(); }
  });
  test("update with service down: binary replaced (previous kept as .old), extension folder refreshed, no temp left", async () => {
    const rel = release(NEXT_MINOR), s = setup(rel.url);
    try {
      mkdirSync(join(s.state, "extension"), { recursive: true }); writeFileSync(join(s.state, "extension", "background.js"), "ancient");
      const r = await cli(["update"], s.env);
      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({ updated: true, latest: NEXT_MINOR, binary: { path: s.bin, previous: `${s.bin}.old` }, service: { restarted: false }, extension: { changed: true, backup: join(s.state, "extension.bak") } });
      expect(readFileSync(s.bin, "utf8")).toContain(`fake ${NEXT_MINOR}`);
      expect(readFileSync(`${s.bin}.old`, "utf8")).toBe("OLD");
      expect(readFileSync(join(s.state, "extension", "background.js"), "utf8")).toBe("bg-new");
      expect(readFileSync(join(s.state, "extension.bak", "background.js"), "utf8")).toBe("ancient");
      expect(readdirSync(s.state).filter((f) => f.startsWith("update-"))).toEqual([]);
    } finally { rel.stop(); }
  });
  test("sha256 mismatch aborts before anything changes", async () => {
    const rel = release(NEXT_MINOR, { badSha: true }), s = setup(rel.url);
    try {
      const r = await cli(["update"], s.env);
      expect(r.code).toBe(1);
      expect(r.errJson.error).toMatchObject({ code: "UPDATE_FAILED" });
      expect(r.errJson.error.message).toContain("sha256");
      expect(readFileSync(s.bin, "utf8")).toBe("OLD");
      expect(existsSync(`${s.bin}.old`)).toBe(false);
      expect(existsSync(join(s.state, "extension"))).toBe(false);
      expect(readdirSync(s.state).filter((f) => f.startsWith("update-"))).toEqual([]);
    } finally { rel.stop(); }
  });
  test("update_url defaults to the GitHub latest-release URL; env/config override; unset returns to the default", async () => {
    const st = tmp();
    const env = { LINKEDIN_CLI_DIR: st, LINKEDIN_CLI_UPDATE_URL: "" };
    const DEF = "https://github.com/MIt9/linkedin-cli/releases/latest/download";
    expect((await cli(["config", "get"], env)).json.update_url).toEqual({ value: DEF, source: "default" });
    expect((await cli(["config", "set", "update_url", "https://example.com/rel"], env)).json.update_url.source).toBe("config");
    expect((await cli(["config", "get"], { ...env, LINKEDIN_CLI_UPDATE_URL: "https://example.com/e" })).json.update_url).toEqual({ value: "https://example.com/e", source: "env" });
    expect((await cli(["config", "unset", "update_url"], env)).json.update_url).toEqual({ value: DEF, source: "default" });
  });
  test("remote http update_url is refused; config set validates", async () => {
    const st = tmp();
    const env = { LINKEDIN_CLI_DIR: st, LINKEDIN_CLI_UPDATE_URL: "" };
    expect((await cli(["update"], { ...env, LINKEDIN_CLI_UPDATE_URL: "http://example.com/x" })).code).toBe(2);
    expect((await cli(["config", "set", "update_url", "http://example.com/x"], env)).code).toBe(2);
    expect((await cli(["config", "set", "update_url", "not a url"], env)).code).toBe(2);
    const ok = await cli(["config", "set", "update_url", "https://example.com/rel/"], env);
    expect(ok.json.update_url).toEqual({ value: "https://example.com/rel", source: "config" });
    expect((await cli(["config", "set", "port", "50123"], env)).json.update_url.value).toBe("https://example.com/rel"); // keys do not clobber each other
    expect((await cli(["config", "unset", "update_url"], env)).json.update_url.source).toBe("default");
    expect((await cli(["config", "get", "port"], env)).json.port.value).toBe(50123);
  });
  test("idle service is restarted and the extension is told to reload", async () => {
    const svc = await startSvc(), rel = release(NEXT_MINOR), bin = join(tmp(), "linkedin"); writeFileSync(bin, "OLD");
    const pid = ((await svc.status()) as any).pid;
    const first = await fakeExt(svc);
    let got: any = null;
    const watcher = (async () => { // the extension reconnects to the new service; keep trying until it receives `reload`
      for (let i = 0; i < 200 && !got; i++) {
        try { const e = await fakeExt(svc); await sleep(150); if (e.received.some((m) => m.type === "reload")) got = e; else e.close(); } catch { await sleep(50); }
      }
    })();
    try {
      const r = await cli(["update"], { ...svc.env, LINKEDIN_CLI_UPDATE_URL: rel.url, LINKEDIN_CLI_BINARY_PATH: bin, LINKEDIN_CLI_RELOAD_WAIT_MS: "15000" });
      expect(r.json).toMatchObject({ updated: true, service: { restarted: true }, extensionReload: "sent" });
      await watcher;
      expect(got).not.toBeNull();
      expect(got.received.find((m: any) => m.type === "reload")).toEqual({ type: "reload" });
      expect(((await svc.status()) as any).pid).not.toBe(pid);
      got.close();
    } finally { first.close(); rel.stop(); await svc.stop(); }
  });
  test("a running job blocks restart and reload; the service keeps running untouched", async () => {
    const svc = await startSvc(), rel = release(NEXT_MINOR), bin = join(tmp(), "linkedin"); writeFileSync(bin, "OLD");
    let release_!: () => void;
    const gate = new Promise<void>((r) => (release_ = r));
    const ext = await fakeExt(svc, { handler: async () => { await gate; return { ok: true }; } });
    const pid = ((await svc.status()) as any).pid;
    const job = svc.call("searchPeople", { keywords: "x" });
    try {
      for (let i = 0; i < 100 && ((await svc.status()) as any).queue.running !== 1; i++) await sleep(20);
      const r = await cli(["update"], { ...svc.env, LINKEDIN_CLI_UPDATE_URL: rel.url, LINKEDIN_CLI_BINARY_PATH: bin });
      expect(r.json).toMatchObject({ updated: true, service: { restarted: false }, extensionReload: "skipped: jobs running" });
      expect(r.json.service.reason).toContain("1 job(s) running");
      expect(readFileSync(bin, "utf8")).toContain("fake");
      expect(((await svc.status()) as any).pid).toBe(pid);
      expect(ext.received.some((m) => m.type === "reload")).toBe(false);
    } finally { release_(); await job.catch(() => {}); ext.close(); rel.stop(); await svc.stop(); }
  });
});
