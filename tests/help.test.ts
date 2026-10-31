import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { allCommands } from "../src/commands";

const run = (args: string[]) => {
  const r = Bun.spawnSync([process.execPath, "src/cli.ts", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const json = (args: string[]) => JSON.parse(run([...args, "--help", "--json"]).out);

describe("command table completeness", () => {
  const all = allCommands();
  test("every command is fully described", () => {
    expect(all.length).toBeGreaterThanOrEqual(38);
    for (const [key, c] of all) {
      expect(c.description, key).toBeTruthy();
      expect(c.output, key).toBeTruthy();
      expect(c.examples?.length, key).toBeGreaterThan(0);
      for (const e of c.examples) expect(e.startsWith(`linkedin ${key}`), e).toBe(true);
      expect(["read", "outward", "destructive", "local"], key).toContain(c.sideEffect);
      for (const [f, o] of Object.entries(c.options)) {
        expect(o.description, `${key} --${f}`).toBeTruthy();
        expect(["string", "number", "boolean", "enum"], `${key} --${f}`).toContain(o.type);
      }
      if (c.positional) { expect(c.positional.description, key).toBeTruthy(); expect(c.positional.type, key).toBeTruthy(); }
      if (c.sideEffect === "outward" || c.sideEffect === "destructive") expect(c.notes, key).toBeTruthy();
    }
  });
  test("every command in COMMANDS.md is in the table", () => {
    const keys = new Set(all.map(([k]) => k));
    const found = [...readFileSync("COMMANDS.md", "utf8").matchAll(/`linkedin ([a-z]+) ([a-z-]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(found.length).toBeGreaterThan(30);
    for (const k of found) expect(keys.has(k), k).toBe(true);
  });
});

describe("help output", () => {
  test("command help is readable text", () => {
    const r = run(["post", "publish", "--help"]);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    for (const s of ["Usage: linkedin post publish", "--text", "--media", "--confirm", "preview", "Examples", "Side effect: outward"]) expect(r.out).toContain(s);
    expect(() => JSON.parse(r.out)).toThrow();
  });
  test("--json gives structured help with types, enums, ranges, defaults", () => {
    const h = json(["post", "publish"]);
    expect(h.sideEffect).toBe("outward");
    expect(h.options["--text"]).toMatchObject({ type: "string", required: true, repeatable: false });
    expect(h.options["--media"]).toMatchObject({ type: "string", repeatable: true });
    expect(h.options["--confirm"].type).toBe("boolean");
    expect(json(["job", "search"]).options["--posted-within"]).toMatchObject({ type: "enum", values: ["day", "week", "month"] });
    expect(json(["post", "list"]).options["--limit"]).toMatchObject({ type: "number", min: 1, max: 50, default: 10 });
    expect(json(["people", "search"]).options["--network"]).toMatchObject({ type: "enum", repeatable: true, values: ["1", "2", "3"] });
    expect(json(["people", "profile"]).arguments.PROFILE).toMatchObject({ type: "string", required: true });
    expect(json(["tabs", "use"]).arguments.TABID.type).toBe("number");
  });
  test("group and root help list commands with descriptions", () => {
    const g = json(["post"]);
    expect(g.commands.publish).toBeTruthy();
    expect(run(["post", "--help"]).out).toContain("publish");
    expect(json([]).groups.post).toBeTruthy();
    expect(run(["--help"]).out).toContain("post");
  });
  test("service commands have help", () => {
    for (const c of ["start", "stop", "status", "resume"]) {
      const r = run(["service", c, "--help"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`linkedin service ${c}`);
    }
  });
  test("help alias", () => {
    expect(run(["help", "post", "publish"]).out).toBe(run(["post", "publish", "--help"]).out);
    expect(run(["help", "post"]).out).toBe(run(["post", "--help"]).out);
    expect(run(["help"]).out).toBe(run(["--help"]).out);
    expect(run(["help", "nope"]).code).toBe(2);
  });
  test("invalid enum / range gives USAGE naming allowed values", () => {
    let r = run(["job", "search", "--keywords", "x", "--posted-within", "year"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("day|week|month");
    r = run(["post", "list", "--limit", "99"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("1..50");
    r = run(["people", "search", "--keywords", "x", "--network", "5"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("1|2|3");
  });
});

describe("single-word commands (doctor, update)", () => {
  test("have help, flags in help, and rows in COMMANDS.md", () => {
    const md = readFileSync("COMMANDS.md", "utf8");
    for (const k of ["doctor", "update", "extension install", "extension path"]) {
      expect(md, k).toContain(`\`linkedin ${k}\``);
      expect(run([...k.split(" "), "--help"]).out, k).toContain(`linkedin ${k}`);
    }
    expect(json(["update"]).options["--check"]).toMatchObject({ type: "boolean" });
    expect(json(["extension", "install"]).options["--open"]).toMatchObject({ type: "boolean" });
    expect(run(["help", "doctor", "x"]).code).toBe(2);
    expect(run(["doctor", "x"]).code).toBe(2);
  });
});
