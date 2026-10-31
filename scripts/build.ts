#!/usr/bin/env bun
// Build release artifacts into dist/: compiled binary per arch (extension embedded), tar.gz per arch, extension tar.gz, latest.json.
//   bun scripts/build.ts          host arch only (cross-targets need Bun to fetch the other runtime: use --all with network)
//   bun scripts/build.ts --all    darwin-arm64 and darwin-x64
// The extension folder is embedded by passing {path: base64} as the compile-time constant EXT_BUNDLE_JSON (see src/ext.ts);
// the result is one self-contained binary, no files next to it.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { manifestOf, readDir } from "../src/ext";
import pkg from "../package.json";

const root = join(import.meta.dir, ".."), dist = join(root, "dist");
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit", cwd: root });
  if (r.exitCode !== 0) throw new Error(`failed: ${cmd.join(" ").slice(0, 120)}`);
};

const files = readDir(join(root, "extension"));
const ev = manifestOf(files).version;
const [a, b] = [ev, pkg.version].map((v) => v.split("."));
if (a![0] !== b![0] || a![1] !== b![1]) throw new Error(`extension ${ev} and package ${pkg.version} differ in major.minor: bump both together`);
if (ev !== pkg.version) console.error(`warning: extension ${ev} != package ${pkg.version} (patch only)`);
const bundle = JSON.stringify(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.toString("base64")])));

const hostArch = process.arch === "arm64" ? "arm64" : "x64";
const arches = process.argv.includes("--all") ? ["arm64", "x64"] : [hostArch];
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const stage = mkdtempSync(join(tmpdir(), "linkedin-build-"));
const binaries: Record<string, { url: string; sha256: string }> = {};
try {
  for (const arch of arches) {
    const bin = join(stage, arch, "linkedin");
    mkdirSync(join(stage, arch));
    run(["bun", "build", "--compile", `--target=bun-darwin-${arch}`, "--define", `EXT_BUNDLE_JSON=${JSON.stringify(bundle)}`, "src/cli.ts", "--outfile", bin]);
    chmodSync(bin, 0o755);
    const name = `linkedin-${pkg.version}-darwin-${arch}.tar.gz`;
    run(["tar", "-czf", join(dist, name), "-C", join(stage, arch), "linkedin"]);
    binaries[`darwin-${arch}`] = { url: name, sha256: sha(join(dist, name)) };
    if (arch === hostArch) copyFileSync(bin, join(dist, "linkedin")); // convenient for local smoke tests
  }
  const extDir = join(stage, "extension");
  for (const [f, buf] of Object.entries(files)) {
    mkdirSync(dirname(join(extDir, f)), { recursive: true });
    writeFileSync(join(extDir, f), buf);
  }
  const extName = `extension-${ev}.tar.gz`;
  run(["tar", "-czf", join(dist, extName), "-C", extDir, "."]);
  writeFileSync(join(dist, "latest.json"), JSON.stringify({ version: pkg.version, binaries, extension: { url: extName, sha256: sha(join(dist, extName)) } }, null, 2) + "\n");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
console.log(`built ${pkg.version} (${arches.join(", ")}) -> ${dist}`);
