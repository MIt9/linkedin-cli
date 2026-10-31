#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { build, GROUPS, parseOptions, resolve, SERVICE_DEFS, SINGLE } from "./commands";
import { help, Raw } from "./help";
import { rpc } from "./client";
import { configCommand } from "./config";
import { serviceCommand } from "./ctl";
import { CliError } from "./errors";
import { doctor, extensionCommand, update } from "./dist";
import { chooseFormat, errorText, globalFlags, renderText, type Format } from "./text";

export { DEFAULT_PORT, DEFAULT_STATE_DIR } from "./config";

// Contract: stdout is JSON unless a terminal (or --text / LINKEDIN_CLI_FORMAT=text) asks for text; --json forces JSON. See text.ts.
// Failure: JSON {"error":{code,message,...}} on stderr (text `Error:`/`Hint:` on a terminal), non-zero exit (see errors.ts).
type Result = { key: string; value: unknown; code?: number };
const ok = (key: string, value: unknown, code?: number): Result => ({ key, value, code });

async function main(args: string[], json: boolean): Promise<Result> {
  // Help: `help [group [cmd]]` or `[group [cmd]] --help|-h`, text by default, `--json` for structured. Path = leading non-flag words.
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    const words = args[0] === "help" ? args.slice(1) : args;
    const i = words.findIndex((a) => a.startsWith("-"));
    return ok("help", help(i < 0 ? words : words.slice(0, i), json));
  }
  const [group, cmd, ...rest] = args;
  if (group && SINGLE.has(group)) { // doctor, update: no subcommand, flags only
    const m = SERVICE_DEFS[group]!;
    let v;
    try { v = parseArgs({ args: args.slice(1), options: parseOptions(m as any), allowPositionals: true, strict: true }); } catch (e: any) { throw new CliError("USAGE", e.message); }
    if (v.positionals.length) throw new CliError("USAGE", `Unknown command: ${args.join(" ")}`);
    if (group === "doctor") { const d = await doctor(); return ok("doctor", d.value, d.code); }
    return ok("update", await update(!!v.values.check));
  }
  if (!group || !cmd || !Object.hasOwn(GROUPS, group)) throw new CliError("USAGE", `Unknown command: ${args.join(" ") || "(empty)"}`);
  if (group === "config") {
    if (!GROUPS.config!.includes(cmd)) throw new CliError("USAGE", `Unknown command: ${args.join(" ")}`);
    return ok(`config ${cmd}`, configCommand(cmd, rest));
  }
  if (group === "service") {
    if (!GROUPS.service!.includes(cmd) || rest.length) throw new CliError("USAGE", `Unknown command: ${args.join(" ")}`);
    return ok(`service ${cmd}`, await serviceCommand(cmd));
  }
  if (group === "extension") {
    const key = `extension ${cmd}`;
    if (!SERVICE_DEFS[key]) throw new CliError("USAGE", `Unknown command: ${args.join(" ")}`);
    let v;
    try { v = parseArgs({ args: rest, options: parseOptions(SERVICE_DEFS[key] as any), allowPositionals: true, strict: true }); } catch (e: any) { throw new CliError("USAGE", e.message); }
    if (v.positionals.length) throw new CliError("USAGE", `Unknown command: ${args.join(" ")}`);
    return ok(key, extensionCommand(cmd, { open: !!v.values.open }));
  }
  const found = resolve(group, cmd);
  if (!found) throw new CliError("USAGE", `Unknown command: ${args.join(" ")}`);
  let parsed;
  try { parsed = parseArgs({ args: rest, options: parseOptions(found.def), allowPositionals: true, strict: true }); } catch (e: any) { throw new CliError("USAGE", e.message); }
  const { method, params } = build(found.def, parsed.values, parsed.positionals);
  return ok(found.key, await rpc(method, params));
}

if (import.meta.main) {
  const flags = globalFlags(Bun.argv.slice(2));
  try {
    const fmt = chooseFormat(flags, process.env, !!process.stdout.isTTY);
    const r = await main(flags.rest, flags.json);
    const v = r.key === "help" || fmt === "json" ? r.value : new Raw(renderText(r.key, r.value));
    console.log(v instanceof Raw ? v.text : JSON.stringify(v));
    if (r.code) process.exitCode = r.code;
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError("INTERNAL", String((e as Error)?.message ?? e));
    const tty = !!process.stderr.isTTY;
    let fmt: Format = tty ? "text" : "json";
    try { fmt = chooseFormat(flags, process.env, tty); } catch { /* conflicting flags: fall back to the terminal default */ }
    const [g, k] = flags.rest.filter((a) => !a.startsWith("-"));
    const path = !g || !Object.hasOwn(GROUPS, g) ? [] : k && (resolve(g, k) || SERVICE_DEFS[`${g} ${k}`]) ? [g, k] : [g];
    console.error(fmt === "text" ? errorText(err, path) : JSON.stringify(err.toJSON()));
    process.exitCode = err.exit;
  }
}
