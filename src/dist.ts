// Distribution commands: extension install/path, doctor, update.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compatible, COMPILED, loadCfg, updateUrlSource, checkUpdateUrl, VERSION } from "./config";
import { rpc } from "./client";
import { serviceCommand } from "./ctl";
import { CliError, WithExit } from "./errors";
import { bundled, extDir, folderState, installExtension, pinnedId, readDir } from "./ext";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = (cmd: string[], stdin?: Buffer) => { try { return Bun.spawnSync(cmd, { stdin, stdout: "ignore", stderr: "ignore" }).exitCode === 0; } catch { return false; } };
const CHROME_APPS = ["/Applications/Google Chrome.app", join(process.env.HOME ?? "", "Applications/Google Chrome.app")];

export function extensionCommand(cmd: string, opts: { open?: boolean }): unknown {
  const { dir } = loadCfg(), path = extDir(dir);
  if (cmd === "path") return { path, installed: folderState(dir).installed };
  const files = bundled();
  mkdirSync(dir, { recursive: true, mode: 0o700 }); // a fresh state dir must not be world-readable (doctor checks 700)
  const r = installExtension(files, path);
  const extensionId = pinnedId(files);
  const clipboard = quiet(["pbcopy"], Buffer.from(path)); // best effort: lets the user paste the path in the file dialog
  const opened = !!opts.open && quiet(["open", "-a", "Google Chrome", "chrome://extensions"]);
  return {
    path, version: r.version, extensionId, changed: r.changed, backup: r.backup, clipboard, opened,
    steps: [
      "Open chrome://extensions in Chrome" + (opened ? " (opened for you)" : ""),
      "Turn on Developer mode (switch in the top right)",
      `Click Load unpacked and select ${path}` + (clipboard ? " (path is in your clipboard: Cmd+Shift+G, Cmd+V)" : ""),
    ],
  };
}

type Check = { name: string; ok: boolean; detail: string; fix: string };

export async function doctor(): Promise<WithExit> {
  const cfg = loadCfg(), checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, fix = "") => checks.push({ name, ok, detail, fix: ok ? "" : fix });
  add("binary version", true, `linkedin ${VERSION} (${COMPILED ? process.execPath : "source checkout"})`);

  const mode = (p: string) => { try { return statSync(p).mode & 0o777; } catch { return null; } };
  const dm = mode(cfg.dir), tm = mode(join(cfg.dir, "token"));
  const bad = [dm === null ? `${cfg.dir} missing` : dm !== 0o700 && `${cfg.dir} is ${dm.toString(8)}, want 700`, tm !== null && tm !== 0o600 && `token is ${tm.toString(8)}, want 600`].filter(Boolean);
  add("state dir permissions", !bad.length, bad.length ? bad.join("; ") : `${cfg.dir} 700, token ${tm === null ? "not created yet" : "600"}`,
    dm === null ? "Run `linkedin service start` (creates it with the right modes)." : `chmod 700 "${cfg.dir}" && chmod 600 "${cfg.dir}/token"`);

  const st: any = await serviceCommand("status").catch((e) => ({ running: false, error: String(e?.message ?? e) }));
  add("service running", !!st.running, st.running ? `pid ${st.pid}, port ${st.port}, server ${st.server}` : "not running", "Run `linkedin service start`.");
  add("port", !st.portInUse, st.portInUse ? st.error : st.running ? `${st.port} is held by linkedin-cli` : `${cfg.port} is free`,
    `Pick another port: \`linkedin config set port N\`, then \`linkedin service start\` and enter the same port in the extension popup.`);
  add("extension connected", !!st.connected, st.connected ? `extension ${st.extension}, id ${st.extensionId}` : "no extension connected" + (st.running ? "" : " (service down)"),
    "Open Chrome with the LinkedIn CLI Bridge extension enabled; check the port in its popup matches `linkedin service status`.");
  add("extension version", !!st.connected && compatible(st.extension, VERSION), st.connected ? `extension ${st.extension ?? "unknown"} vs CLI ${VERSION} (same major.minor required)` : "unknown: extension not connected",
    "Run `linkedin extension install`, then Reload the extension in chrome://extensions (or `linkedin update`).");
  const f = folderState(cfg.dir);
  add("extension files", f.upToDate, f.installed ? `${f.path}: ${f.version}, bundled ${f.bundledVersion}${f.upToDate ? ", identical" : ", differs"}` : `${f.path} not installed`,
    "Run `linkedin extension install`, then Reload the extension in chrome://extensions.");
  add("halted state", !st.halted, st.halted ? `halted: ${st.halted.reason}` : st.running ? "not halted" : "service not running (nothing halted)", "Resolve the checkpoint/captcha in Chrome, then `linkedin service resume`.");
  const chrome = CHROME_APPS.find((p) => existsSync(p));
  add("chrome found", !!chrome, chrome ?? "Google Chrome.app not found in /Applications or ~/Applications", "Install Google Chrome (the extension needs it).");

  const ok = checks.every((c) => c.ok);
  return new WithExit({ ok, checks }, ok ? 0 : 1);
}

// ---- update ----
const gt = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map((n) => parseInt(n, 10) || 0));
  for (let i = 0; i < 3; i++) if ((x![i] ?? 0) !== (y![i] ?? 0)) return (x![i] ?? 0) > (y![i] ?? 0);
  return false;
};
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function download(base: string, ref: { url: string; sha256: string }, what: string): Promise<Buffer> {
  if (typeof ref?.url !== "string" || !/^[0-9a-f]{64}$/i.test(String(ref.sha256))) throw new CliError("INVALID", `latest.json: bad ${what} entry`);
  const url = new URL(ref.url, base + "/").toString();
  checkUpdateUrl(url);
  let buf: Buffer;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e: any) { throw new CliError("UPDATE_FAILED", `Download of ${what} failed (${url}): ${e.message}`); }
  if (sha256(buf) !== ref.sha256.toLowerCase()) throw new CliError("UPDATE_FAILED", `sha256 mismatch for ${what} (${url}); nothing was changed.`);
  return buf;
}
const untar = (buf: Buffer, work: string, name: string) => {
  const f = join(work, name);
  writeFileSync(f, buf);
  const out = join(work, name + ".d"); mkdirSync(out);
  if (!quiet(["tar", "-xzf", f, "-C", out])) throw new CliError("UPDATE_FAILED", `Cannot extract ${name} (is it a .tar.gz?)`);
  return out;
};

export async function update(check: boolean): Promise<unknown> {
  const root = checkUpdateUrl(updateUrlSource().value);
  let latest: any;
  try {
    const res = await fetch(`${root}/latest.json`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    latest = await res.json();
  } catch (e: any) { throw new CliError("UPDATE_FAILED", `Cannot read ${root}/latest.json: ${e.message}`); }
  if (typeof latest?.version !== "string" || !/^\d+\.\d+\.\d+$/.test(latest.version)) throw new CliError("INVALID", "latest.json has no valid version");
  const updateAvailable = gt(latest.version, VERSION);
  const head = { current: VERSION, latest: latest.version, updateAvailable };
  if (check || !updateAvailable) return { ...head, updated: false };

  const target = process.env.LINKEDIN_CLI_BINARY_PATH ?? (COMPILED ? process.execPath : null);
  if (!target) throw new CliError("USAGE", "Running from a source checkout: update with `git pull` instead. `linkedin update` replaces the compiled binary.");
  const arch = `darwin-${process.arch === "arm64" ? "arm64" : "x64"}`;
  if (!latest.binaries?.[arch]) throw new CliError("INVALID", `latest.json has no binary for ${arch}`);

  const cfg = loadCfg();
  mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(cfg.dir, "update-"));
  try {
    // 1. download + verify everything before touching anything
    const binDir = untar(await download(root, latest.binaries[arch], `binary ${arch}`), work, "bin.tgz");
    const extFiles = latest.extension ? readDir(untar(await download(root, latest.extension, "extension"), work, "ext.tgz")) : null;
    const fresh = join(binDir, "linkedin");
    if (!existsSync(fresh)) throw new CliError("UPDATE_FAILED", "Release archive has no `linkedin` binary.");
    chmodSync(fresh, 0o755);
    if (!quiet([fresh, "--help"])) throw new CliError("UPDATE_FAILED", "The downloaded binary does not run (--help failed); nothing was changed.");

    // 2. binary: same-directory copy, previous kept as .old via hardlink, atomic rename over the target
    const staged = `${target}.new`;
    writeFileSync(staged, readFileSync(fresh), { mode: 0o755 });
    rmSync(`${target}.old`, { force: true });
    if (existsSync(target)) linkSync(target, `${target}.old`);
    renameSync(staged, target);

    // 3. extension folder (old one kept as .bak when it differs)
    const extension = extFiles ? installExtension(extFiles, extDir(cfg.dir)) : null;

    // 4. service + extension reload, never while a job is running
    const st: any = await serviceCommand("status").catch(() => ({ running: false }));
    let service: unknown, extensionReload = "skipped: service was not running";
    const running = st.queue?.running ?? 0;
    if (st.running && running > 0) {
      service = { restarted: false, reason: `${running} job(s) running; restart later: linkedin service stop && linkedin service start` };
      extensionReload = "skipped: jobs running";
    } else if (st.running) {
      await serviceCommand("stop");
      await serviceCommand("start");
      service = { restarted: true };
      const deadline = Date.now() + Number(process.env.LINKEDIN_CLI_RELOAD_WAIT_MS ?? (st.connected ? 45_000 : 0));
      for (;;) { // the extension reconnects to the new service within ~30 s
        try { await rpc("reloadExtension"); extensionReload = "sent"; break; } catch (e: any) {
          if (e?.code !== "EXTENSION_NOT_CONNECTED" || Date.now() >= deadline) { extensionReload = `skipped: ${e?.message ?? e}`; break; }
          await sleep(300);
        }
      }
    } else service = { restarted: false, reason: "service was not running" };

    return { ...head, updated: true, binary: { path: target, previous: `${target}.old` }, extension, service, extensionReload };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
