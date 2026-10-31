import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../src/errors";
import { chooseFormat, errorText, globalFlags, renderText } from "../src/text";
import { cli, fakeExt, freePort, NEXT_MINOR, startSvc, VERSION } from "./helpers";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "lcli-txt-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noBrace = (out: string) => expect(out.split("\n").filter((l) => l.trimStart().startsWith("{")), out).toEqual([]);
const T = { LINKEDIN_CLI_FORMAT: "text" };

describe("format selection (unit, isTTY injected)", () => {
  test("flags beat env beat TTY", () => {
    expect(chooseFormat({}, {}, true)).toBe("text");
    expect(chooseFormat({}, {}, false)).toBe("json");
    expect(chooseFormat({ json: true }, {}, true)).toBe("json");
    expect(chooseFormat({ text: true }, {}, false)).toBe("text");
    expect(chooseFormat({}, { LINKEDIN_CLI_FORMAT: "json" }, true)).toBe("json");
    expect(chooseFormat({}, { LINKEDIN_CLI_FORMAT: "text" }, false)).toBe("text");
    expect(chooseFormat({ json: true }, { LINKEDIN_CLI_FORMAT: "text" }, true)).toBe("json");
    expect(chooseFormat({}, { LINKEDIN_CLI_FORMAT: "bogus" }, true)).toBe("text"); // unknown env value is ignored
  });
  test("--json with --text is a USAGE error", () => {
    expect(() => chooseFormat({ json: true, text: true }, {}, false)).toThrow(CliError);
    try { chooseFormat({ json: true, text: true }, {}, false); } catch (e: any) { expect(e.code).toBe("USAGE"); }
  });
  test("globalFlags strips --json/--text, but --text stays for commands that own it", () => {
    expect(globalFlags(["doctor", "--text"])).toEqual({ json: false, text: true, rest: ["doctor"] });
    expect(globalFlags(["--json", "queue", "list"])).toEqual({ json: true, text: false, rest: ["queue", "list"] });
    expect(globalFlags(["post", "publish", "--text", "hi", "--json"])).toEqual({ json: true, text: false, rest: ["post", "publish", "--text", "hi"] });
    expect(globalFlags(["extension", "path", "--text"]).text).toBe(true);
  });
});

describe("generic renderer", () => {
  test("objects, nesting, arrays of objects (useful fields first), truncation, no braces", () => {
    const long = "word ".repeat(100);
    const out = renderText("people search", { hasNext: true, results: [{ id: 7, headline: "Eng", name: "Ann", note: long }, { name: "Bob", tags: ["a", "b"], extra: { k: 1 } }], empty: [], meta: {} });
    noBrace(out);
    expect(out).not.toContain("[");
    const lines = out.split("\n");
    expect(lines).toContain("hasNext: true");
    expect(lines).toContain("results:");
    expect(lines).toContain("  1. name: Ann");
    expect(lines[lines.indexOf("  1. name: Ann") + 1]).toBe("     headline: Eng");
    expect(lines).toContain("  2. name: Bob");
    expect(out).toContain("tags: a, b");
    expect(out).toContain("empty: (none)");
    const note = lines.find((l) => l.includes("note: "))!;
    expect(note.endsWith("...")).toBe(true);
    expect(note.length).toBeLessThan(220);
  });
  test("top-level array and preview marker", () => {
    expect(renderText("post scheduled", [{ when: "W", text: "T" }, { when: "X", text: "Y" }]).split("\n")[0]).toBe("1. text: T");
    expect(renderText("post scheduled", [])).toBe("(none)");
    const p = renderText("post publish", { preview: true, tool: "post", args: { text: "hi" } });
    expect(p).toContain("PREVIEW");
    expect(p).toContain("--confirm");
    noBrace(p);
  });
  test("JSON stays untruncated (truncation is text-only)", async () => {
    const svc = await startSvc();
    try {
      const long = "x ".repeat(300);
      const e = await fakeExt(svc, { handler: () => ({ note: long }) });
      expect((await svc.run("tabs", "list")).json.note).toBe(long);
      expect((await cli(["tabs", "list"], { ...svc.env, ...T })).out).toContain("...");
      e.close();
    } finally { await svc.stop(); }
  });
});

describe("error text (unit)", () => {
  const t = (code: string, extra: Record<string, unknown> = {}, path: string[] = ["queue", "list"]) => errorText(new CliError(code, "boom", extra), path);
  test("Error line plus a Hint for codes with an obvious fix", () => {
    expect(t("INTERNAL").split("\n")).toEqual(["Error: boom"]);
    expect(t("SERVICE_UNAVAILABLE")).toContain("Hint: run `linkedin service start`");
    expect(t("HALTED")).toContain("linkedin service resume");
    expect(t("PORT_IN_USE")).toContain("Hint:");
    expect(t("PORT_IN_USE")).toContain("linkedin config set port");
    expect(t("RATE_LIMIT", { retryAt: Date.now() + 60e3 })).toContain("Hint:");
    expect(t("USAGE")).toContain("Hint: linkedin queue list --help");
    expect(t("USAGE", {}, [])).toContain("Hint: linkedin help");
    expect(t("RATE_LIMIT")).toMatch(/^Error: boom\nHint: /);
  });
});

describe("service text", () => {
  test("status: not connected, then connected, then version mismatch; no JSON braces", async () => {
    const svc = await startSvc();
    try {
      const a = await cli(["service", "status", "--text"], svc.env);
      expect(a.code).toBe(0);
      expect(a.json).toBeUndefined();
      noBrace(a.out);
      const L = a.out.trimEnd().split("\n");
      expect(L[0]).toMatch(new RegExp(`^Service: running \\(pid \\d+, port ${svc.port}, version ${VERSION.replace(/\./g, "\\.")}\\)$`));
      expect(L).toContain("Extension: NOT connected");
      expect(L).toContain("Safety: not halted");
      expect(L).toContain("Budget today: 0/1000 actions, 0/1000 this hour, invites 0/20");
      expect(L).toContain("Queue: 0 done, 0 waiting");
      expect(L.some((l) => l.startsWith("Next:"))).toBe(true);
      expect(a.out).toContain("linkedin extension install");
      const e = await fakeExt(svc);
      const b = (await cli(["service", "status", "--text"], svc.env)).out;
      expect(b).toContain(`Extension: connected (version ${VERSION}, ID fake-id)`);
      expect(b).not.toContain("NOT connected");
      expect(b).not.toContain("Next:");
      e.close();
      const bad = await fakeExt(svc, { version: NEXT_MINOR });
      const c = (await cli(["service", "status", "--text"], svc.env)).out;
      expect(c).toContain(`Extension: connected (version ${NEXT_MINOR}`);
      expect(c).toContain("WARNING");
      bad.close();
    } finally { await svc.stop(); }
  });
  test("status with a pinned extension names the expected ID and where to load it from", async () => {
    const d = tmp(), key = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ manifest_version: 3, version: VERSION, key }));
    const svc = await startSvc({ LINKEDIN_CLI_EXT_SRC: d });
    try {
      const o = (await cli(["service", "status", "--text"], svc.env)).out;
      expect(o).toMatch(/\n  Expected extension ID: [a-p]{32} \(pinned\)\. Load it from .*extension in chrome:\/\/extensions, then wait up to 30 s\./);
    } finally { await svc.stop(); }
  });
  test("start says Started / Already running; stop and resume have sentences; down status explains", async () => {
    const svc = await startSvc();
    try {
      await svc.run("service", "stop");
      const a = await cli(["service", "start", "--text"], svc.env);
      expect(a.out.split("\n")[0]).toBe("Started");
      expect(a.out).toContain("Service: running (pid ");
      expect((await cli(["service", "start", "--text"], svc.env)).out.split("\n")[0]).toBe("Already running");
      expect((await cli(["service", "resume", "--text"], svc.env)).out).toMatch(/^Resumed/);
      expect((await cli(["service", "stop", "--text"], svc.env)).out.trim()).toBe("Stopped");
      expect((await cli(["service", "stop", "--text"], svc.env)).out).toContain("was not running");
      const down = await cli(["service", "status", "--text"], svc.env);
      noBrace(down.out);
      expect(down.out).toContain(`Service: NOT running (port ${svc.port})`);
      expect(down.out).toContain("Next: run `linkedin service start`");
    } finally { await svc.stop(); }
  });
  test("HALTED status shows the reason and the resume command", async () => {
    const svc = await startSvc();
    try {
      const e = await fakeExt(svc, { handler: () => { throw Object.assign(new Error("STOPPED. captcha"), { code: "HALT", reason: "captcha" }); } });
      await svc.run("tabs", "list");
      const o = (await cli(["service", "status", "--text"], svc.env)).out;
      expect(o).toContain("HALTED: ");
      expect(o).toContain("-> run linkedin service resume");
      e.close();
    } finally { await svc.stop(); }
  });
  test("queue list and show", async () => {
    const svc = await startSvc();
    try {
      expect((await cli(["queue", "list", "--text"], svc.env)).out.trim()).toBe("Queue is empty.");
      const future = new Date(Date.now() + 3600e3).toISOString();
      const j = (await svc.run("queue", "enqueue", "searchPeople", "--args", '{"keywords":"a"}', "--not-before", future)).json;
      const l = await cli(["queue", "list", "--text"], svc.env);
      noBrace(l.out);
      expect(l.out).toMatch(new RegExp(`#${j.jobId}\\s+queued\\s+searchPeople`));
      const s = await cli(["queue", "show", String(j.jobId), "--text"], svc.env);
      noBrace(s.out);
      expect(s.out.split("\n")[0]).toBe(`Job #${j.jobId}: queued (searchPeople)`);
      expect(s.out).toContain("keywords: a");
    } finally { await svc.stop(); }
  });
});

describe("config, extension, doctor, help in text", () => {
  test("config get/set/unset, extension path", async () => {
    const env = { LINKEDIN_CLI_DIR: tmp(), LINKEDIN_CLI_PORT: "", ...T };
    const g = (await cli(["config", "get"], env)).out;
    expect(g).toContain("port: 47851 (default)");
    expect(g).toContain("update_url: https://github.com/MIt9/linkedin-cli/releases/latest/download (default)");
    noBrace(g);
    const s = (await cli(["config", "set", "port", "50123"], env)).out;
    expect(s).toContain("port: 50123 (config)");
    expect(s).toMatch(/^Saved/);
    expect((await cli(["config", "unset", "port"], env)).out).toContain("port: 47851 (default)");
    const p = await cli(["extension", "path", "--text"], { LINKEDIN_CLI_DIR: tmp() });
    expect(p.code).toBe(0);
    expect(p.out).toMatch(/^Extension folder: .*extension \(not installed yet; run linkedin extension install\)/);
  });
  test("doctor text puts a one-line verdict first, fixes stay indented, exit 1 on failure", async () => {
    const r = await cli(["doctor", "--text"], { LINKEDIN_CLI_DIR: join(tmp(), "none"), LINKEDIN_CLI_PORT: "47999" });
    expect(r.code).toBe(1);
    const L = r.out.trimEnd().split("\n");
    expect(L[0]).toMatch(/^Doctor: \d+ of 9 checks FAILED/);
    expect(L[1]).toMatch(/^\[(ok|FAIL)\] /);
    expect(L.some((l) => l.startsWith("    fix: "))).toBe(true);
  });
  test("help documents the output contract", async () => {
    for (const a of [["post", "publish", "--help"], ["queue", "list", "--help"], ["doctor", "--help"], ["--help"]]) {
      const o = (await cli(a)).out;
      expect(o, a.join(" ")).toContain("LINKEDIN_CLI_FORMAT");
      expect(o, a.join(" ")).toContain("--json");
    }
  });
});

describe("selection through the real CLI", () => {
  const env = () => ({ LINKEDIN_CLI_DIR: tmp() });
  test("default (pipe) is JSON; env text -> text; --json beats env; both flags -> USAGE", async () => {
    expect((await cli(["config", "get"], env())).json.port.source).toBeTruthy();
    expect((await cli(["config", "get"], { ...env(), ...T })).json).toBeUndefined();
    expect((await cli(["config", "get", "--json"], { ...env(), ...T })).json.port).toBeTruthy();
    expect((await cli(["config", "get"], { ...env(), LINKEDIN_CLI_FORMAT: "json" })).json.port).toBeTruthy();
    const both = await cli(["config", "get", "--json", "--text"], env());
    expect(both.code).toBe(2);
    expect(both.errJson.error.code).toBe("USAGE");
  });
  test("--json and --text are accepted as global flags", async () => {
    for (const a of [["config", "get"], ["extension", "path"], ["service", "status"]]) {
      const e = { ...env(), LINKEDIN_CLI_PORT: String(await freePort()) };
      expect((await cli([...a, "--json"], e)).json, a.join(" ")).toBeTruthy();
      expect((await cli([...a, "--text"], e)).json, a.join(" ")).toBeUndefined();
      expect((await cli([...a, "--text"], e)).code, a.join(" ")).toBe(0);
    }
  });
  test("errors: text on request with a Hint; JSON by default and with --json; exit codes unchanged", async () => {
    const e = { ...env(), LINKEDIN_CLI_PORT: String(await freePort()) };
    const t = await cli(["queue", "list"], { ...e, ...T });
    expect(t.code).toBe(3);
    expect(t.errJson).toBeUndefined();
    expect(t.err).toMatch(/^Error: .+\nHint: run `linkedin service start`/);
    expect(t.out).toBe("");
    const j = await cli(["queue", "list"], e);
    expect(j.code).toBe(3);
    expect(j.errJson.error.code).toBe("SERVICE_UNAVAILABLE");
    expect((await cli(["queue", "list", "--json"], { ...e, ...T })).errJson.error.code).toBe("SERVICE_UNAVAILABLE");
    const u = await cli(["people", "profile"], { ...e, ...T });
    expect(u.code).toBe(2);
    expect(u.err).toContain("Hint: linkedin people profile --help");
  });
});
