import { describe, expect, test } from "bun:test";
import { EXIT_CODES } from "../src/errors";
import { cli, freePort } from "./helpers";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dead = async () => ({ LINKEDIN_CLI_DIR: mkdtempSync(join(tmpdir(), "lcli-")), LINKEDIN_CLI_PORT: String(await freePort()) });

describe("output contract", () => {
  test("exit codes are documented in one table", () => {
    expect(EXIT_CODES).toMatchObject({ OK: 0, FAILED: 1, USAGE: 2, SERVICE_UNAVAILABLE: 3, UNVERIFIED: 4, HALTED: 5, RATE_LIMIT: 6, EXTENSION_UNAVAILABLE: 7 });
  });
  test("service down: stderr JSON error, code 3, empty stdout", async () => {
    const r = await cli(["queue", "list"], await dead());
    expect(r.code).toBe(3);
    expect(r.out).toBe("");
    expect(r.errJson.error.code).toBe("SERVICE_UNAVAILABLE");
  });
  test("usage error: code 2, stderr JSON", async () => {
    const r = await cli(["people", "connect"], await dead());
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.errJson.error.code).toBe("USAGE");
  });
  test("unknown flag is a usage error", async () => {
    const r = await cli(["post", "scheduled", "--bogus"], await dead());
    expect(r.code).toBe(2);
  });
  test("service status when down reports running:false with exit 0", async () => {
    const r = await cli(["service", "status"], await dead());
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ running: false, extensionUrl: expect.stringMatching(/^ws:\/\/127.0.0.1:\d+\/ext$/) });
  });
  test("range violation is a usage error", async () => {
    const r = await cli(["message", "list", "--limit", "101"], await dead());
    expect(r.code).toBe(2);
  });
});
