// Output formats. JSON is what agents/pipes get; people at a terminal get plain language.
// Selection: --json | --text > env LINKEDIN_CLI_FORMAT=json|text > stdout is a TTY ? text : json.
import { loadCfg } from "./config";
import { resolve } from "./commands";
import { CliError } from "./errors";
import { folderState } from "./ext";

export type Format = "json" | "text";

// `--json` / `--text` are global. A command that owns a `--text` option (post publish, message send, ...) keeps it as its own
// value; for those, force text with LINKEDIN_CLI_FORMAT=text (or just run it in a terminal).
export function globalFlags(args: string[]) {
  const own = !!(args[0] && args[1] && resolve(args[0], args[1])?.def.opts?.text);
  let json = false, text = false;
  const rest = args.filter((a) => (a === "--json" ? !(json = true) : a === "--text" && !own ? !(text = true) : true));
  return { json, text, rest };
}

export function chooseFormat(flags: { json?: boolean; text?: boolean }, env: Record<string, string | undefined>, isTTY: boolean): Format {
  if (flags.json && flags.text) throw new CliError("USAGE", "--json and --text are mutually exclusive");
  if (flags.json) return "json";
  if (flags.text) return "text";
  const e = env.LINKEDIN_CLI_FORMAT;
  if (e === "json" || e === "text") return e;
  return isTTY ? "text" : "json";
}

// ---- errors ----
const HINTS: Record<string, (e: CliError, path: string[]) => string> = {
  PORT_IN_USE: () => "another program holds the service port. Stop it, or pick another port: `linkedin config set port N`, then `linkedin service start`",
  SERVICE_UNAVAILABLE: () => "run `linkedin service start`",
  HALTED: () => "solve the checkpoint/captcha/login in Chrome, then run `linkedin service resume`",
  RATE_LIMIT: (e) => `the shared action budget is used up; try again ${typeof e.extra.retryAt === "number" ? `after ${new Date(e.extra.retryAt).toLocaleTimeString()}` : "later"} (see \`linkedin service status\`)`,
  USAGE: (_e, path) => `linkedin ${path.length ? `${path.join(" ")} --help` : "help"}`,
  EXTENSION_NOT_CONNECTED: () => "run `linkedin doctor`; the Chrome extension must be loaded and connected",
};
export function errorText(e: CliError, path: string[]) {
  const hint = HINTS[e.code]?.(e, path);
  return `Error: ${e.message}` + (hint ? `\nHint: ${hint}` : "");
}

// ---- generic renderer: objects as `key: value`, arrays of objects as numbered blocks. Truncation is text-only. ----
const MAX = 160;
const PRIORITY = ["name", "title", "headline", "fullName", "text", "company", "location", "state", "status", "url", "id"];
const clip = (s: string) => {
  if (/^https?:\/\/\S+$/.test(s)) return s;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX ? `${t.slice(0, MAX - 3)}...` : t;
};
const scalar = (v: unknown) => (v === null || v === undefined ? "-" : typeof v === "string" ? clip(v) : String(v));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const prims = (v: unknown): v is unknown[] => Array.isArray(v) && v.every((x) => !x || typeof x !== "object");
const keysOf = (o: Record<string, unknown>) => { const k = Object.keys(o); return [...PRIORITY.filter((p) => k.includes(p)), ...k.filter((x) => !PRIORITY.includes(x))]; };

function lines(v: unknown, ind = ""): string[] {
  if (Array.isArray(v)) {
    if (!v.length) return [`${ind}(none)`];
    if (prims(v)) return [ind + v.map(scalar).join(", ")];
    return v.flatMap((x, i) => { const b = lines(x, `${ind}   `); b[0] = `${ind}${i + 1}. ${b[0]!.slice(ind.length + 3)}`; return b; });
  }
  if (isObj(v)) {
    const ks = keysOf(v);
    if (!ks.length) return [`${ind}(empty)`];
    return ks.flatMap((k) => {
      const x = v[k];
      if (!x || typeof x !== "object") return [`${ind}${k}: ${scalar(x)}`];
      if (Array.isArray(x) ? !x.length : !Object.keys(x).length) return [`${ind}${k}: (none)`];
      if (prims(x)) return [`${ind}${k}: ${x.map(scalar).join(", ")}`];
      return [`${ind}${k}:`, ...lines(x, `${ind}  `)];
    });
  }
  return [ind + scalar(v)];
}

// ---- specialised renderers ----
const plural = (n: number, w: string) => `${n} ${w}`;
function statusLines(s: any, head?: string): string[] {
  const out: string[] = head ? [head] : [];
  const next: string[] = [];
  const folder = s.extensionFolder ?? folderState(loadCfg().dir);
  if (!s.running) {
    out.push(`Service: NOT running (port ${s.port})`);
    if (s.portInUse) { out.push(`  Port ${s.port} is held by another program: ${s.error}`); next.push(`free the port, or run \`linkedin config set port N\` and then \`linkedin service start\``); }
    else next.push("run `linkedin service start`");
    out.push(`Extension folder: ${folder.path} (${folder.installed ? `version ${folder.version}` : "not installed yet"})`);
  } else {
    out.push(`Service: running (pid ${s.pid}, port ${s.port}, version ${s.server})`);
    if (s.portMismatch) out.push(`  WARNING: configured port is ${s.configuredPort}; the running service uses ${s.port}. Restart it to apply: linkedin service stop && linkedin service start`);
    if (s.connected) {
      out.push(`Extension: connected (version ${s.extension ?? "unknown"}, ID ${s.extensionId ?? "unknown"})`);
      if (!s.match) { out.push(`  WARNING: extension ${s.extension ?? "unknown"} does not match CLI ${s.server} (same major.minor required). Run linkedin extension install, then Reload it in chrome://extensions.`); next.push("run `linkedin extension install`, then Reload the extension in chrome://extensions"); }
      if (s.extensionPinned === false) out.push("  Note: the bundled manifest has no key, so any chrome-extension:// origin is accepted.");
    } else {
      out.push("Extension: NOT connected");
      out.push(`  ${s.expectedExtensionId ? `Expected extension ID: ${s.expectedExtensionId} (pinned). ` : ""}Load it from ${folder.path} in chrome://extensions, then wait up to 30 s.`);
      next.push(folder.installed && folder.upToDate ? "open Chrome with the extension enabled (chrome://extensions), then run `linkedin doctor`" : "run `linkedin extension install` (prints the Chrome steps), then `linkedin doctor`");
    }
    out.push(s.halted ? `Safety: HALTED: ${s.halted.reason} -> run linkedin service resume` : "Safety: not halted");
    const b = s.budget, q = s.queue ?? {};
    out.push(`Budget today: ${b.day.used}/${b.day.limit} actions, ${b.hour.used}/${b.hour.limit} this hour, invites ${b.invites.used}/${b.invites.limit}`);
    const extra = ["running", "failed", "unverified", "cancelled"].filter((k) => q[k]).map((k) => plural(q[k], k));
    out.push(`Queue: ${[plural(q.done ?? 0, "done"), plural(q.queued ?? 0, "waiting"), ...extra].join(", ")}`);
  }
  if (next.length === 1) out.push(`Next: ${next[0]}`);
  else if (next.length) out.push("Next:", ...next.map((n, i) => `  ${i + 1}. ${n}`));
  return out;
}

const when = (ms: unknown) => (typeof ms === "number" ? new Date(ms).toISOString() : ms);
function jobText(j: any) {
  const { id, tool, state, ...rest } = j;
  const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, /At$|^notBefore$/.test(k) ? when(v) : v]));
  return [`Job #${id}: ${state} (${tool})`, ...lines(body)];
}
const settings = (r: any) => Object.entries(r).map(([k, v]: [string, any]) => `${k}: ${v.value} (${v.source})`);

const extensionInstallText = (r: any) => [
  `Extension ${r.version} ${r.changed ? "installed to" : "already installed to"} ${r.path}` + (r.changed ? "" : " (files unchanged)"),
  ...(r.backup ? [`Previous folder kept as ${r.backup}`] : []),
  ...(r.extensionId ? [`Extension ID: ${r.extensionId}`] : []),
  ...(r.clipboard ? ["Path copied to clipboard"] : []),
  "",
  "Next, in Chrome:",
  "  1. Open chrome://extensions" + (r.opened ? " (opened for you)" : ""),
  "  2. Turn on Developer mode (top right)",
  "  3. If an older 'LinkedIn CLI Bridge' is loaded, click Remove (the extension ID changed in 0.2.x; Reload is not enough)",
  "  4. Click Load unpacked, press Cmd+Shift+G in the folder dialog, paste the path (Cmd+V) and confirm",
  "  5. Then run: linkedin service start && linkedin doctor",
];

const doctorText = (r: { ok: boolean; checks: { name: string; ok: boolean; detail: string; fix: string }[] }) => {
  const bad = r.checks.filter((c) => !c.ok).length, n = r.checks.length;
  return [
    r.ok ? `Doctor: all good (${n} of ${n} checks passed)` : `Doctor: ${bad} of ${n} checks FAILED. Do the fix line under each [FAIL], then run linkedin doctor again.`,
    ...r.checks.flatMap((c) => [`[${c.ok ? "ok" : "FAIL"}] ${c.name}: ${c.detail}`, ...(c.ok || !c.fix ? [] : [`    fix: ${c.fix}`])]),
  ];
};

const updateText = (r: any) =>
  !r.updated
    ? [r.updateAvailable ? `Update available: ${r.current} -> ${r.latest}. Run: linkedin update` : `linkedin ${r.current} is up to date`]
    : [
      `Updated linkedin ${r.current} -> ${r.latest}`,
      `Previous binary kept as ${r.binary.previous}`,
      ...(r.extension?.changed ? [`Extension folder updated${r.extension.backup ? ` (old one kept as ${r.extension.backup})` : ""}. If Chrome does not reload it by itself, click Reload on it in chrome://extensions`] : []),
      r.service?.restarted ? "Service restarted" : `Service not restarted: ${r.service?.reason ?? "unknown"}`,
      `Extension reload: ${r.extensionReload}`,
    ];

export function renderText(key: string, v: any): string {
  const L = ((): string[] => {
    switch (key) {
      case "service status": return statusLines(v);
      case "service start": return statusLines(v, v.alreadyRunning ? "Already running" : "Started");
      case "service stop": return [v.stopped ? "Stopped" : "Service was not running"];
      case "service resume": return ["Resumed: the halted state is cleared and queued jobs continue."];
      case "doctor": return doctorText(v);
      case "extension install": return extensionInstallText(v);
      case "extension path": return [`Extension folder: ${v.path} (${v.installed ? "installed" : "not installed yet; run linkedin extension install"})`];
      case "update": return updateText(v);
      case "config get": return settings(v);
      case "config set": case "config unset": return ["Saved. Now:", ...settings(v).map((s) => `  ${s}`)];
      case "queue list": return Array.isArray(v) && v.length ? v.map((j) => `#${j.id}  ${j.state}  ${j.tool}  ${when(j.createdAt)}${j.error ? `  ${clip(String(j.error))}` : ""}`) : ["Queue is empty."];
      case "queue get": case "queue cancel": return jobText(v);
      default: return [...(isObj(v) && v.preview === true ? ["PREVIEW: nothing was sent. Add --confirm to perform it.", ""] : []), ...lines(v)];
    }
  })();
  return L.join("\n");
}
