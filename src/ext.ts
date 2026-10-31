import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CliError } from "./errors";

// Chrome extension ID = first 16 bytes of sha256(DER public key), each hex nibble mapped 0-9a-f -> a-p.
export const extensionId = (keyB64: string) =>
  createHash("sha256").update(Buffer.from(keyB64, "base64")).digest("hex").slice(0, 32).replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

export type Files = Record<string, Buffer>;
declare const EXT_BUNDLE_JSON: string | undefined; // injected by scripts/build.ts (--define): {relpath: base64}

// Extension files, relative path -> content. Dotfiles (our .version, .DS_Store) and the extension's own test/ are not part of it.
export function readDir(dir: string, rel = ""): Files {
  const out: Files = {};
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith(".") || (!rel && e.name === "test")) continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, readDir(dir, p));
    else if (e.isFile()) out[p] = readFileSync(join(dir, p));
  }
  return out;
}

// Source of truth for "the bundled extension": LINKEDIN_CLI_EXT_SRC (tests) > embedded in the compiled binary > ../extension (dev checkout).
export function bundled(): Files {
  const src = process.env.LINKEDIN_CLI_EXT_SRC;
  if (src) return readDir(src);
  if (typeof EXT_BUNDLE_JSON !== "undefined") return Object.fromEntries(Object.entries(JSON.parse(EXT_BUNDLE_JSON) as Record<string, string>).map(([k, v]) => [k, Buffer.from(v, "base64")]));
  return readDir(join(import.meta.dir, "..", "extension"));
}

export function manifestOf(files: Files): { version: string; key?: string } {
  try { const m = JSON.parse(files["manifest.json"]!.toString("utf8")); if (typeof m.version === "string") return m; } catch { /* fall through */ }
  throw new CliError("INTERNAL", "Extension bundle has no valid manifest.json");
}

// The ID the service pins /ext to; null = manifest has no key, any chrome-extension:// origin is accepted.
export const pinnedId = (files: Files = bundled()) => { const k = manifestOf(files).key; return k ? extensionId(k) : null; };

export const extDir = (stateDir: string) => join(stateDir, "extension");
const same = (a: Files, b: Files) => { const k = Object.keys(a); return k.length === Object.keys(b).length && k.every((f) => b[f]?.equals(a[f]!)); };

export function folderState(stateDir: string, files: Files = bundled()) {
  const path = extDir(stateDir);
  let cur: Files = {};
  try { cur = readDir(path); } catch { /* not installed */ }
  const installed = "manifest.json" in cur;
  let version: string | null = null;
  if (installed) try { version = manifestOf(cur).version; } catch { /* broken manifest */ }
  return { path, installed, version, bundledVersion: manifestOf(files).version, upToDate: installed && same(cur, files) };
}

// Replace <dest> with `files` via a temp dir + rename. A different existing folder is kept as <dest>.bak (one generation).
export function installExtension(files: Files, dest: string): { changed: boolean; backup: string | null; version: string } {
  const version = manifestOf(files).version;
  let cur: Files = {};
  try { cur = readDir(dest); } catch { /* absent */ }
  if (same(cur, files)) { writeFileSync(join(dest, ".version"), version + "\n"); return { changed: false, backup: null, version }; }
  const tmp = `${dest}.new-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  for (const [f, buf] of Object.entries(files)) { mkdirSync(dirname(join(tmp, f)), { recursive: true }); writeFileSync(join(tmp, f), buf); }
  writeFileSync(join(tmp, ".version"), version + "\n");
  let backup: string | null = null;
  if (existsSync(dest)) {
    if (Object.keys(cur).length) { backup = `${dest}.bak`; rmSync(backup, { recursive: true, force: true }); renameSync(dest, backup); } else rmSync(dest, { recursive: true, force: true });
  }
  renameSync(tmp, dest);
  return { changed: true, backup, version };
}
