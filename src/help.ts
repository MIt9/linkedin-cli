import { GROUPS, GROUP_DESC, SERVICE_DEFS, SINGLE, resolve, spec, type OptSpec, type Spec } from "./commands";
import { CliError } from "./errors";

// Text help is printed raw; --json help goes through the normal JSON path.
export class Raw { constructor(readonly text: string) {} }

const keyOf = (group: string, cmd?: string) => SINGLE.has(group) && !cmd ? group : !cmd ? undefined : resolve(group, cmd)?.key ?? (GROUPS[group]?.includes(cmd) && SERVICE_DEFS[`${group} ${cmd}`] ? `${group} ${cmd}` : undefined);
const unknown = (path: string[]): never => { throw new CliError("USAGE", `Unknown command: ${path.join(" ")}`); };
const descs = (group: string) => Object.fromEntries(GROUPS[group]!.map((c) => [c, spec(keyOf(group, c)!).description]));

const flag = (name: string, o: OptSpec) => (name === name.toUpperCase() ? name : `--${name}${o.type === "boolean" ? "" : ` <${o.values?.join("|") ?? o.type}>`}`);
const tags = (o: OptSpec) => [
  o.required && "required", o.repeatable && "repeatable", o.min !== undefined && `range ${o.min}..${o.max}`, o.default !== undefined && `default ${o.default}`,
].filter(Boolean).join(", ");
const table = (rows: [string, OptSpec][]) => {
  const w = Math.max(...rows.map(([n, o]) => flag(n, o).length));
  return rows.map(([n, o]) => `  ${flag(n, o).padEnd(w)}  ${o.description}${tags(o) ? ` [${tags(o)}]` : ""}`).join("\n");
};

function commandText(key: string, s: Spec) {
  const pos = s.positional ? ` ${s.positional.name}` : "";
  const out = [`linkedin ${key} - ${s.description}`, "", `Usage: linkedin ${key}${pos} [options]`, `Side effect: ${s.sideEffect}`];
  if (s.aliases) out.push(`Aliases: ${s.aliases.join(", ")}`);
  if (s.notes) out.push(`Notes: ${s.notes}`);
  if (s.positional) out.push("", "Arguments:", table([[s.positional.name, s.positional]]));
  const opts = Object.entries(s.options);
  if (opts.length) out.push("", "Options:", table(opts));
  out.push("", `Output: ${s.output} (JSON on stdout)`, "", "Examples:", ...s.examples.map((e) => `  ${e}`), "", "Add --json to this --help for the structured form.");
  return out.join("\n");
}

export function help(path: string[], json: boolean): unknown {
  const [group, cmd] = path;
  if (path.length > 2 || (SINGLE.has(group!) && cmd)) unknown(path);
  if (!group) {
    const groups = Object.fromEntries(Object.keys(GROUPS).map((g) => [g, { description: GROUP_DESC[g], commands: descs(g) }]));
    if (json) return { usage: "linkedin <group> <command> [options]", help: "linkedin help <group> [command] | linkedin <group> [command] --help [--json]", groups };
    const w = Math.max(...Object.keys(groups).map((g) => g.length));
    return new Raw(["Usage: linkedin <group> <command> [options]", "       linkedin help <group> [command]   (or: --help; add --json for structured help)", "", "Groups:",
      ...Object.entries(groups).map(([g, v]) => `  ${g.padEnd(w)}  ${v.description}`), "", "Output is JSON on stdout; errors are JSON on stderr with a non-zero exit code."].join("\n"));
  }
  if (!Object.hasOwn(GROUPS, group)) unknown(path);
  if (!cmd && !SINGLE.has(group)) {
    const commands = descs(group);
    if (json) return { usage: `linkedin ${group} <command> [options]`, group, description: GROUP_DESC[group], commands };
    const w = Math.max(...Object.keys(commands).map((c) => c.length));
    return new Raw([`linkedin ${group} - ${GROUP_DESC[group]}`, "", `Usage: linkedin ${group} <command> [options]`, "", "Commands:", ...Object.entries(commands).map(([c, d]) => `  ${c.padEnd(w)}  ${d}`), "",
      `Details: linkedin ${group} <command> --help`].join("\n"));
  }
  const key = keyOf(group, cmd);
  if (!key) unknown(path);
  const s = spec(key!);
  if (!json) return new Raw(commandText(key!, s));
  const { positional, options, ...rest } = s;
  const withDash = Object.fromEntries(Object.entries(options).map(([f, o]) => [`--${f}`, o]));
  const { name, ...p } = positional ?? ({} as any);
  return {
    usage: `linkedin ${key}${positional ? ` ${name}` : ""} [options]`, command: key, ...rest,
    arguments: positional ? { [name]: p } : {}, options: withDash,
  };
}

