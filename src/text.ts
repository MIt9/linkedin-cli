// Opt-in plain-language output (`--text`) for the commands people run by hand. JSON stays the default for agents.
import { Raw } from "./help";

export const extensionInstallText = (r: any) => new Raw([
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
].join("\n"));

export const doctorText = (r: { ok: boolean; checks: { name: string; ok: boolean; detail: string; fix: string }[] }) => {
  const bad = r.checks.filter((c) => !c.ok).length;
  return new Raw([
    ...r.checks.flatMap((c) => [`[${c.ok ? "ok" : "FAIL"}] ${c.name}: ${c.detail}`, ...(c.ok || !c.fix ? [] : [`    fix: ${c.fix}`])]),
    r.ok ? `All good: ${r.checks.length} of ${r.checks.length} checks passed.` : `Problems found: ${bad} of ${r.checks.length} checks failed. Apply the fix lines above, then run: linkedin doctor --text`,
  ].join("\n"));
};

export const updateText = (r: any) => new Raw(
  !r.updated
    ? r.updateAvailable ? `Update available: ${r.current} -> ${r.latest}. Run: linkedin update` : `linkedin ${r.current} is up to date`
    : [
      `Updated linkedin ${r.current} -> ${r.latest}`,
      `Previous binary kept as ${r.binary.previous}`,
      ...(r.extension?.changed ? [`Extension folder updated${r.extension.backup ? ` (old one kept as ${r.extension.backup})` : ""}. If Chrome does not reload it by itself, click Reload on it in chrome://extensions`] : []),
      r.service?.restarted ? "Service restarted" : `Service not restarted: ${r.service?.reason ?? "unknown"}`,
      `Extension reload: ${r.extensionReload}`,
    ].join("\n"));
