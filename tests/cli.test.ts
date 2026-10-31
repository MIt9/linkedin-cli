import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";

const groups = ["service", "config", "extension", "doctor", "update", "post", "people", "message", "comment", "job", "notification", "invitation", "browser", "tabs", "queue"];
const run = (args: string[]) => Bun.spawnSync([process.execPath, "src/cli.ts", ...args], { stdout: "pipe", stderr: "pipe" });

describe("CLI help", () => {
  test("top-level help lists all groups as JSON", () => {
    const result = run(["--help", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(Object.keys(JSON.parse(result.stdout.toString()).groups)).toEqual(groups);
  });

  for (const group of groups.filter((g) => g !== "doctor" && g !== "update")) test(`${group} help lists its commands`, () => {
    const result = run([group, "--help", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const help = JSON.parse(result.stdout.toString());
    expect(help.group).toBe(group);
    expect(Object.keys(help.commands).length).toBeGreaterThan(0);
  });

  for (const args of [["unknown"], ["unknown", "--help"], ["post", "unknown"], ["post", "unknown", "--help"], ["post", "publish"]]) test(`rejects ${args.join(" ")}`, () => {
    const result = run(args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString().length).toBeGreaterThan(0);
    expect(result.stdout.toString()).toBe("");
  });

  test("exposes independent defaults", async () => {
    const { DEFAULT_PORT, DEFAULT_STATE_DIR } = await import("../src/cli");
    expect(DEFAULT_PORT).toBe(47851);
    expect(DEFAULT_STATE_DIR).toBe(join(homedir(), ".linkedin-cli"));
  });
});
