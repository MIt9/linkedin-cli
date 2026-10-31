// Release hook, hooks installer and install.sh: everything runs against throwaway repos, a local bare remote and a fake `gh` on PATH.
// Nothing here talks to GitHub or touches ~/.linkedin-cli.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import pkg from "../package.json";
import { ROOT } from "./helpers";

const V = pkg.version;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "lcli-rel-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|RELEASE_|SKIP_RELEASE|GH_)/.test(k))) as Record<string, string>;
const sh = (cwd: string, cmd: string[], env: Record<string, string> = {}) => {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...cleanEnv(), ...env }, stdin: "ignore" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};
const git = (cwd: string, ...a: string[]) => { const r = sh(cwd, ["git", ...a]); if (r.code !== 0) throw new Error(`git ${a.join(" ")}: ${r.out}`); return r.out.trim(); };

// Fake gh: logs each call as args joined by \x1f, calls ended by \x1e. GH_FAKE_EXISTS=1 makes `release view` succeed; otherwise "release not found".
const GH = `#!/bin/sh
for a; do printf '%s\\037' "$a"; done >> "$GH_LOG"; printf '\\036' >> "$GH_LOG"
if [ "$1" = release ] && [ "$2" = view ]; then
  [ "\${GH_FAKE_EXISTS:-}" = 1 ] && { echo "title: x"; exit 0; }
  echo "release not found" >&2; exit 1
fi
exit 0
`;
// Stub build: writes the dist/ layout of scripts/build.ts without compiling. STUB_BAD_SHA=1 corrupts one sha.
const STUB = `#!/bin/sh
set -e
ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' package.json | head -1)
case "\${RELEASE_TARGETS:-host}" in all) arches="arm64 x64" ;; *) case "$(uname -m)" in arm64) arches=arm64 ;; *) arches=x64 ;; esac ;; esac
rm -rf dist; mkdir dist
bins=""
for a in $arches; do
  f="linkedin-$ver-darwin-$a.tar.gz"; echo "bin $a" > "dist/$f"
  s=$(shasum -a 256 "dist/$f" | cut -d' ' -f1)
  [ "\${STUB_BAD_SHA:-}" = 1 ] && s=0000000000000000000000000000000000000000000000000000000000000000
  bins="$bins\${bins:+,}\\"darwin-$a\\":{\\"url\\":\\"$f\\",\\"sha256\\":\\"$s\\"}"
done
echo ext > "dist/extension-$ver.tar.gz"
es=$(shasum -a 256 "dist/extension-$ver.tar.gz" | cut -d' ' -f1)
echo "{\\"version\\":\\"$ver\\",\\"binaries\\":{$bins},\\"extension\\":{\\"url\\":\\"extension-$ver.tar.gz\\",\\"sha256\\":\\"$es\\"}}" > dist/latest.json
`;

function setup(o: { pkgVer?: string; manVer?: string; pushMain?: boolean } = {}) {
  const base = tmp(), work = join(base, "work"), remote = join(base, "remote.git"), bin = join(base, "bin");
  mkdirSync(join(work, "extension"), { recursive: true }); mkdirSync(join(work, "scripts")); mkdirSync(join(work, ".githooks")); mkdirSync(bin);
  copyFileSync(join(ROOT, ".githooks/pre-push"), join(work, ".githooks/pre-push")); chmodSync(join(work, ".githooks/pre-push"), 0o755);
  writeFileSync(join(work, "scripts/install.sh"), "#!/bin/sh\n");
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "x", version: o.pkgVer ?? "0.2.2" }, null, 2));
  writeFileSync(join(work, "extension/manifest.json"), JSON.stringify({ manifest_version: 3, version: o.manVer ?? "0.2.2" }, null, 2));
  writeFileSync(join(work, ".gitignore"), "dist/\n");
  writeFileSync(join(bin, "gh"), GH); chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(base, "build-stub.sh"), STUB); chmodSync(join(base, "build-stub.sh"), 0o755);
  git(work, "init", "-q", "-b", "main"); git(work, "config", "user.email", "t@t"); git(work, "config", "user.name", "t");
  Bun.spawnSync(["git", "init", "-q", "--bare", remote]);
  git(work, "remote", "add", "origin", remote); git(work, "config", "core.hooksPath", ".githooks");
  git(work, "add", "-A"); git(work, "commit", "-qm", "first feature");
  git(work, "commit", "-q", "--allow-empty", "-m", "second feature");
  if (o.pushMain !== false) git(work, "push", "-q", "origin", "main");
  const log = join(base, "gh.log");
  const env = { PATH: `${bin}:${process.env.PATH}`, GH_LOG: log, RELEASE_TEST_CMD: "true", RELEASE_TYPECHECK_CMD: "true", RELEASE_BUILD_CMD: `sh ${join(base, "build-stub.sh")}` };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\x1e").filter(Boolean).map((r) => r.split("\x1f").slice(0, -1)) : []);
  const creates = () => calls().filter((c) => c[0] === "release" && c[1] === "create");
  const push = (ref: string, extra: Record<string, string> = {}) => sh(work, ["git", "push", "origin", ref], { ...env, ...extra });
  const remoteTags = () => git(remote, "tag", "-l");
  return { work, remote, env, calls, creates, push, remoteTags, tag: (t = `v${V}`) => git(work, "tag", t) };
}

describe("pre-push hook", () => {
  test("non-tag push does nothing and prints nothing from the hook", () => {
    const s = setup({ pushMain: false });
    const r = s.push("main", { RELEASE_TEST_CMD: "false", RELEASE_BUILD_CMD: "false" });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/release|pre-push/i);
    expect(s.calls()).toEqual([]);
  });

  test("tag that differs from package.json version aborts", () => {
    const s = setup(); s.tag("v9.9.9");
    const r = s.push("v9.9.9");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("v9.9.9");
    expect(r.out).toContain("0.2.2");
    expect(s.creates()).toEqual([]); expect(s.remoteTags()).toBe("");
  });

  test("tag that differs from manifest.json version aborts", () => {
    const s = setup({ manVer: "0.2.1" }); s.tag("v0.2.2");
    const r = s.push("v0.2.2");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("manifest.json");
    expect(s.creates()).toEqual([]);
  });

  test("dirty working tree aborts", () => {
    const s = setup(); s.tag("v0.2.2");
    writeFileSync(join(s.work, "package.json"), readFileSync(join(s.work, "package.json"), "utf8") + "\n");
    const r = s.push("v0.2.2");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/clean|uncommitted/i);
    expect(s.creates()).toEqual([]);
  });

  test("tag not on the checked-out commit aborts", () => {
    const s = setup(); s.tag("v0.2.2");
    git(s.work, "commit", "-q", "--allow-empty", "-m", "later"); git(s.work, "push", "-q", "origin", "main");
    const r = s.push("v0.2.2");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/HEAD|check out/i);
  });

  test("annotated tag aborts", () => {
    const s = setup(); git(s.work, "tag", "-a", "v0.2.2", "-m", "x");
    const r = s.push("v0.2.2");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/annotated|lightweight/i);
  });

  test("commit not on the remote yet aborts with a hint to push the branch first", () => {
    const s = setup({ pushMain: false }); s.tag("v0.2.2");
    const r = s.push("v0.2.2");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("git push origin main");
    expect(s.creates()).toEqual([]);
  });

  test("failing tests abort before build", () => {
    const s = setup(); s.tag("v0.2.2");
    const r = s.push("v0.2.2", { RELEASE_TEST_CMD: "false" });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/tests failed/i);
    expect(existsSync(join(s.work, "dist"))).toBe(false);
    expect(s.creates()).toEqual([]);
  });

  test("failing typecheck aborts", () => {
    const s = setup(); s.tag("v0.2.2");
    const r = s.push("v0.2.2", { RELEASE_TYPECHECK_CMD: "false" });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/typecheck failed/i);
    expect(s.creates()).toEqual([]);
  });

  test("sha256 mismatch in latest.json aborts", () => {
    const s = setup(); s.tag("v0.2.2");
    const r = s.push("v0.2.2", { STUB_BAD_SHA: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/sha256/i);
    expect(s.creates()).toEqual([]);
  });

  test("existing release aborts and the tag is not pushed", () => {
    const s = setup(); s.tag("v0.2.2");
    const r = s.push("v0.2.2", { GH_FAKE_EXISTS: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/already exists/i);
    expect(s.creates()).toEqual([]); expect(s.remoteTags()).toBe("");
  });

  test("RELEASE_DRY_RUN prints the gh command and does not create", () => {
    const s = setup(); s.tag("v0.2.2");
    const r = s.push("v0.2.2", { RELEASE_DRY_RUN: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("gh release create v0.2.2 --target");
    expect(r.out).toContain("scripts/install.sh");
    expect(s.creates()).toEqual([]);
  });

  test("happy path: gh release create with target, title, notes and all assets", () => {
    const s = setup(); s.tag("v0.2.2");
    const sha = git(s.work, "rev-parse", "HEAD");
    const r = s.push("v0.2.2");
    expect(r.code).toBe(0);
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    expect(r.out).toContain(`built arches: ${arch}`);
    const [c] = s.creates(); expect(s.creates().length).toBe(1);
    expect(c!.slice(0, 7)).toEqual(["release", "create", "v0.2.2", "--target", sha, "--title", "v0.2.2"]);
    expect(c![7]).toBe("--notes");
    expect(c![8]).toContain("second feature"); expect(c![8]).toContain("first feature");
    expect(c!.slice(9)).toEqual([`dist/extension-0.2.2.tar.gz`, `dist/linkedin-0.2.2-darwin-${arch}.tar.gz`, "dist/latest.json", "scripts/install.sh"]);
    expect(s.remoteTags()).toBe("v0.2.2");
  });

  test("notes cover only commits since the previous v* tag", () => {
    const s = setup(); git(s.work, "tag", "v0.2.1"); // previous release marker on HEAD
    git(s.work, "commit", "-q", "--allow-empty", "-m", "only this one"); git(s.work, "push", "-q", "origin", "main");
    s.tag("v0.2.2");
    expect(s.push("v0.2.2").code).toBe(0);
    const notes = s.creates()[0]![8]!;
    expect(notes).toContain("only this one"); expect(notes).not.toContain("first feature");
  });

  test("RELEASE_TARGETS=all uploads both arches", () => {
    const s = setup(); s.tag("v0.2.2");
    const r = s.push("v0.2.2", { RELEASE_TARGETS: "all" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("built arches: arm64 x64");
    const assets = s.creates()[0]!.slice(9);
    expect(assets).toContain("dist/linkedin-0.2.2-darwin-arm64.tar.gz"); expect(assets).toContain("dist/linkedin-0.2.2-darwin-x64.tar.gz");
  });

  test("SKIP_RELEASE=1 prints a notice and lets the push through", () => {
    const s = setup(); s.tag("v9.9.9");
    const r = s.push("v9.9.9", { SKIP_RELEASE: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("SKIP_RELEASE");
    expect(s.calls()).toEqual([]); expect(s.remoteTags()).toBe("v9.9.9");
  });
});

describe("install-hooks", () => {
  test("sets core.hooksPath, idempotent", () => {
    const base = tmp(); mkdirSync(join(base, "scripts")); mkdirSync(join(base, ".githooks"));
    copyFileSync(join(ROOT, "scripts/install-hooks.sh"), join(base, "scripts/install-hooks.sh"));
    writeFileSync(join(base, ".githooks/pre-push"), "#!/bin/sh\n");
    git(base, "init", "-q");
    const a = sh(base, ["sh", "scripts/install-hooks.sh"]);
    expect(a.code).toBe(0); expect(git(base, "config", "core.hooksPath")).toBe(".githooks"); expect(a.out).toMatch(/set/i);
    const b = sh(base, ["sh", "scripts/install-hooks.sh"]);
    expect(b.code).toBe(0); expect(b.out).toMatch(/already/i);
    expect(Bun.spawnSync(["test", "-x", join(base, ".githooks/pre-push")]).exitCode).toBe(0);
  });
});

describe("install.sh", () => {
  const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
  // Release dir with a fake "binary" (shell script) and latest.json for this machine's arch.
  function release() {
    const d = tmp(), stage = join(d, "stage"); mkdirSync(stage);
    writeFileSync(join(stage, "linkedin"), "#!/bin/sh\necho fake linkedin \"$@\"\n"); chmodSync(join(stage, "linkedin"), 0o755);
    const arch = process.arch === "arm64" ? "arm64" : "x64", name = `linkedin-${V}-darwin-${arch}.tar.gz`;
    Bun.spawnSync(["tar", "-czf", join(d, name), "-C", stage, "linkedin"]);
    writeFileSync(join(d, "latest.json"), JSON.stringify({ version: V, binaries: { [`darwin-${arch}`]: { url: name, sha256: sha(join(d, name)) } } }));
    return d;
  }
  const run = (env: Record<string, string>) => {
    const home = tmp();
    return { home, ...sh(home, ["sh", join(ROOT, "scripts/install.sh")], { HOME: home, LINKEDIN_CLI_BIN_DIR: join(home, "bin"), ...env }) };
  };
  // curl that behaves like a 404 from the release host, recording the URL; gh that serves files from GH_ASSETS.
  function shims(ghAuthed: boolean, withCurl = true) {
    const d = tmp();
    if (withCurl) writeFileSync(join(d, "curl"), `#!/bin/sh\nfor a; do u=$a; done\necho "$u" >> "$CURL_LOG"\nprintf 404\nexit 22\n`);
    writeFileSync(join(d, "gh"), `#!/bin/sh
echo "$@" >> "$GH_LOG"
[ "$1" = auth ] && exit ${ghAuthed ? 0 : 1}
if [ "$1" = release ] && [ "$2" = download ]; then
  while [ $# -gt 0 ]; do case "$1" in --pattern) p=$2;; --output) o=$2;; esac; shift; done
  cp "$GH_ASSETS/$p" "$o"; exit 0
fi
exit 1
`);
    if (withCurl) chmodSync(join(d, "curl"), 0o755); chmodSync(join(d, "gh"), 0o755);
    return { d, curlLog: join(d, "curl.log"), ghLog: join(d, "gh.log") };
  }

  test("default base URL is the GitHub latest-release download URL", () => {
    const s = shims(false);
    const r = run({ PATH: `${s.d}:${process.env.PATH}`, CURL_LOG: s.curlLog, GH_LOG: s.ghLog });
    expect(r.code).not.toBe(0);
    expect(readFileSync(s.curlLog, "utf8")).toContain("https://github.com/MIt9/linkedin-cli/releases/latest/download/latest.json");
  });

  test("404 without an authenticated gh says the release was not found", () => {
    const s = shims(false);
    const r = run({ PATH: `${s.d}:${process.env.PATH}`, CURL_LOG: s.curlLog, GH_LOG: s.ghLog });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/release not found/i); expect(r.out).not.toMatch(/private/i);
  });

  test("404 with an authenticated gh falls back to gh release download and installs", () => {
    const s = shims(true), rel = release();
    const r = run({ PATH: `${s.d}:${process.env.PATH}`, CURL_LOG: s.curlLog, GH_LOG: s.ghLog, GH_ASSETS: rel });
    expect(r.out).toContain("Installing linkedin");
    expect(r.code).toBe(0);
    expect(existsSync(join(r.home, "bin/linkedin"))).toBe(true);
    expect(readFileSync(s.ghLog, "utf8")).toContain("--repo MIt9/linkedin-cli");
  });

  test("LINKEDIN_CLI_BASE_URL override works (file://) and never calls gh", () => {
    const rel = release(), s = shims(true, false);
    const r = run({ LINKEDIN_CLI_BASE_URL: `file://${rel}`, PATH: `${s.d}:${process.env.PATH}`, GH_LOG: s.ghLog, CURL_LOG: s.curlLog });
    expect(r.code).toBe(0);
    expect(existsSync(s.ghLog)).toBe(false);
  });
});
