#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { build, GROUPS, parseOptions, resolve, SERVICE_DEFS, SINGLE } from "./commands";
import { help, Raw } from "./help";
import { rpc } from "./client";
import { configCommand } from "./config";
import { serviceCommand } from "./ctl";
import { CliError, WithExit } from "./errors";
import { doctor, extensionCommand, update } from "./dist";

export { DEFAULT_PORT, DEFAULT_STATE_DIR } from "./config";

// Contract: success -> JSON on stdout, exit 0. Failure -> {"error":{code,message,...}} on stderr, non-zero exit (see errors.ts).
async function main(args: string[]): Promise<unknown> {
  // Help: `help [group [cmd]]` or `[group [cmd]] --help|-h`, text by default, `--json` for structured. Path = leading non-flag words.
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    const words = args[0] === "help" ? args.slice(1) : args;
    const i = words.findIndex((a) => a.startsWith("-"));
    return help(i < 0 ? words : words.slice(0, i), args.includes("--json"));
  }
  const [group, cmd, ...rest] = args;
  if (group && SINGLE.has(group)) { // doctor, update: no subcommand, flags only
    const m = SERVICE_DEFS[group]!;
    let v;
    try { v = parseArgs({ args: args.slice(1), options: parseOptions(m as any), allowPositionals: true, strict: true }); } catch (e: any) { throw new CliError("USAGE", e.message); }
    if (v.positionals.length) throw new CliError("USAGE", `Unknown command: ${args.join(" ")}`);
    return group === "doctor" ? doctor() : update(!!v.values.check);
  }
  if (!group || !cmd || !Object.hasOwn(GROUPS, group)) throw new CliError("USAGE", `Unknown command: ${args.join(" ") || "(empty)"}`);
  if (group === "config") {
    if (!GROUPS.config!.includes(cmd)) throw new CliError("USAGE", `Unknown command: ${args.join(" ")}`);
    return configCommand(cmd, rest);
  }
  if (group === "service") {
    if (!GROUPS.service!.includes(cmd) || rest.length) throw new CliError("USAGE", `Unknown command: ${args.join(" ")}`);
    return serviceCommand(cmd);
  }
  if (group === "extension") {
    const key = `extension ${cmd}`;
    if (!SERVICE_DEFS[key]) throw new CliError("USAGE", `Unknown command: ${args.join(" ")}`);
    let v;
    try { v = parseArgs({ args: rest, options: parseOptions(SERVICE_DEFS[key] as any), allowPositionals: true, strict: true }); } catch (e: any) { throw new CliError("USAGE", e.message); }
    if (v.positionals.length) throw new CliError("USAGE", `Unknown command: ${args.join(" ")}`);
    return extensionCommand(cmd, { open: !!v.values.open });
  }
  const found = resolve(group, cmd);
  if (!found) throw new CliError("USAGE", `Unknown command: ${args.join(" ")}`);
  let parsed;
  try { parsed = parseArgs({ args: rest, options: parseOptions(found.def), allowPositionals: true, strict: true }); } catch (e: any) { throw new CliError("USAGE", e.message); }
  const { method, params } = build(found.def, parsed.values, parsed.positionals);
  return rpc(method, params);
}

if (import.meta.main) {
  try {
    const out = await main(Bun.argv.slice(2));
    if (out instanceof WithExit) { console.log(JSON.stringify(out.value)); process.exitCode = out.code; }
    else console.log(out instanceof Raw ? out.text : JSON.stringify(out));
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError("INTERNAL", String((e as Error)?.message ?? e));
    console.error(JSON.stringify(err.toJSON()));
    process.exitCode = err.exit;
  }
}
