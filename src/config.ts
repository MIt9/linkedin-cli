import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors";
import pkg from "../package.json";

export const VERSION: string = pkg.version;
export const DEFAULT_PORT = 47851;
export const DEFAULT_STATE_DIR = join(homedir(), ".linkedin-cli");

export type Cfg = { dir: string; port: number };
export const validPort = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1024 && (n as number) <= 65535;

const stateDir = () => process.env.LINKEDIN_CLI_DIR || DEFAULT_STATE_DIR;
const configFile = (dir: string) => join(dir, "config.json");
type FileCfg = { port?: number; update_url?: string };
const readFileCfg = (dir: string): FileCfg => {
  try {
    const j = JSON.parse(readFileSync(configFile(dir), "utf8"));
    return { ...(validPort(j?.port) && { port: j.port }), ...(typeof j?.update_url === "string" && j.update_url && { update_url: j.update_url }) };
  } catch { return {}; }
};

// https only (the release source decides which binary we install); plain http just for loopback (local test server).
export function checkUpdateUrl(v: string): string {
  let u: URL;
  try { u = new URL(v); } catch { throw new CliError("USAGE", "update_url must be an https:// URL (base of latest.json)"); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))) throw new CliError("USAGE", "update_url must be https:// (http only for localhost)");
  return v.replace(/\/+$/, "");
}
export const DEFAULT_UPDATE_URL = "https://github.com/MIt9/linkedin-cli/releases/latest/download";
// Precedence: env LINKEDIN_CLI_UPDATE_URL > <dir>/config.json update_url > GitHub latest release.
export function updateUrlSource(dir = stateDir()): { value: string; source: "env" | "config" | "default" } {
  const env = process.env.LINKEDIN_CLI_UPDATE_URL, file = readFileCfg(dir).update_url;
  return env ? { value: env, source: "env" } : file ? { value: file, source: "config" } : { value: DEFAULT_UPDATE_URL, source: "default" };
}

// Port precedence: env LINKEDIN_CLI_PORT > <dir>/config.json > default.
export function portSource(dir = stateDir()): { value: number; source: "env" | "config" | "default" } {
  const env = Number(process.env.LINKEDIN_CLI_PORT);
  if (env) return { value: env, source: "env" };
  const file = readFileCfg(dir).port;
  return file ? { value: file, source: "config" } : { value: DEFAULT_PORT, source: "default" };
}
export const loadCfg = (): Cfg => { const dir = stateDir(); return { dir, port: portSource(dir).value }; };

// `linkedin config get|set|unset`: local file only, never talks to the service.
export function configCommand(cmd: string, args: string[]): unknown {
  const usage = (m: string): never => { throw new CliError("USAGE", m); };
  const dir = stateDir();
  const key = (k?: string) => { if (k !== "port" && k !== "update_url") usage(`Unknown config key "${k ?? ""}". Only: port, update_url`); };
  const view = () => ({ port: portSource(dir), update_url: updateUrlSource(dir) });
  const write = (patch: FileCfg, drop?: keyof FileCfg) => {
    const next: FileCfg = { ...readFileCfg(dir), ...patch };
    if (drop) delete next[drop];
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(configFile(dir), JSON.stringify(next) + "\n", { mode: 0o600 });
  };
  if (cmd === "get") {
    if (args.length > 1) usage("Usage: linkedin config get [key]");
    if (args[0] !== undefined) key(args[0]);
    return view();
  }
  if (cmd === "set") {
    if (args.length !== 2) usage("Usage: linkedin config set <key> <value>");
    key(args[0]);
    if (args[0] === "update_url") write({ update_url: checkUpdateUrl(args[1]!) });
    else {
      const n = /^\d+$/.test(args[1]!) ? Number(args[1]) : NaN;
      if (!validPort(n)) usage("port must be an integer 1024..65535");
      write({ port: n });
    }
    return view();
  }
  if (args.length !== 1) usage("Usage: linkedin config unset <key>");
  key(args[0]);
  write({}, args[0] as keyof FileCfg);
  return view();
}

// Same major.minor = compatible (matches extension/protocol.js).
export const compatible = (a: unknown, b: unknown) => {
  const [x, y] = [a, b].map((v) => String(v ?? "").split(".").slice(0, 2).join("."));
  return !!x && x === y;
};

// Running as the `bun build --compile` binary (embedded files live under /$bunfs/), not from a source checkout.
export const COMPILED = Bun.main.startsWith("/$bunfs/");
