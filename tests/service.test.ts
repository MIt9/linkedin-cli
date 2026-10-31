import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync, truncateSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { VERSION, PATCH, NEXT_MINOR, fakeExt, halt, sleep, startSvc, type Svc } from "./helpers";

const POST = "https://www.linkedin.com/feed/update/urn:li:activity:1/";

describe("service lifecycle and security", () => {
  let svc: Svc;
  beforeAll(async () => { svc = await startSvc(); });
  afterAll(() => svc.stop());

  test("status reports running service, version, no extension", async () => {
    const r = await svc.run("service", "status");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ running: true, server: VERSION, connected: false, extension: null, halted: null, port: svc.port });
  });
  test("second start is idempotent; second foreground run refuses", async () => {
    const again = await svc.run("service", "start");
    expect(again.json).toMatchObject({ running: true, alreadyRunning: true });
    const run = await svc.run("service", "run");
    expect(run.code).toBe(1);
    expect(run.errJson.error.code).toBe("ALREADY_RUNNING");
  });
  test("token file is mode 600 and RPC requires it", async () => {
    expect(statSync(join(svc.dir, "token")).mode & 0o777).toBe(0o600);
    const url = `http://127.0.0.1:${svc.port}/rpc`;
    expect((await fetch(url, { method: "POST", body: JSON.stringify({ method: "status" }) })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" })).status).toBe(401);
    const token = readFileSync(join(svc.dir, "token"), "utf8").trim();
    const web = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" }, body: JSON.stringify({ method: "status" }) });
    expect(web.status).toBe(403);
  });
  test("/ext refuses connections without a chrome-extension origin", async () => {
    await expect(fakeExt(svc, { origin: "https://evil.example" })).rejects.toThrow();
  });
});

describe("extension protocol", () => {
  let svc: Svc;
  beforeAll(async () => { svc = await startSvc(); });
  afterAll(() => svc.stop());

  test("hello accepted: service replies hello with its version", async () => {
    const e = await fakeExt(svc);
    expect(e.received.find((m) => m.type === "hello")).toEqual({ type: "hello", version: VERSION });
    expect(await svc.status()).toMatchObject({ connected: true, extension: VERSION, match: true, extensionId: "fake-id" });
    e.close();
  });
  test("patch difference is compatible (same major.minor)", async () => {
    const e = await fakeExt(svc, { version: PATCH });
    expect(await svc.status()).toMatchObject({ extension: PATCH, match: true });
    expect((await svc.call("searchPeople", { keywords: "x" })).ok).toBe(true);
    e.close();
  });
  test("minor mismatch: reject, no dispatch, exit 7 VERSION_MISMATCH", async () => {
    const e = await fakeExt(svc, { version: NEXT_MINOR });
    expect(e.received.find((m) => m.type === "reject")).toEqual({ type: "reject", reason: "version_mismatch", serverVersion: VERSION });
    expect(await svc.status()).toMatchObject({ match: false });
    const r = await svc.run("people", "search", "--keywords", "x");
    expect(r.code).toBe(7);
    expect(r.errJson.error.code).toBe("VERSION_MISMATCH");
    expect(e.calls).toEqual([]);
    e.close();
  });
  test("extension without hello is treated as too old", async () => {
    const e = await fakeExt(svc, { version: null });
    const r = await svc.run("people", "search", "--keywords", "x");
    expect(r.code).toBe(7);
    expect(r.errJson.error.code).toBe("VERSION_MISMATCH");
    e.close();
  });
  test("not connected: exit 7 EXTENSION_NOT_CONNECTED", async () => {
    await sleep(100);
    const r = await svc.run("post", "scheduled");
    expect(r.code).toBe(7);
    expect(r.errJson.error.code).toBe("EXTENSION_NOT_CONNECTED");
  });
  test("call wire shape: {id, tool, args}; result forwarded", async () => {
    const e = await fakeExt(svc, { handler: () => [{ name: "A" }] });
    const r = await svc.run("people", "search", "--keywords", "x");
    expect(r.json).toEqual([{ name: "A" }]);
    expect(e.calls[0]).toMatchObject({ tool: "searchPeople", args: { keywords: "x" } });
    expect(typeof e.calls[0]!.id).toBe("number");
    e.close();
  });
  test("extension error text is returned as EXTENSION_ERROR, exit 1", async () => {
    const e = await fakeExt(svc, { handler: () => { throw new Error("Profile not found"); } });
    const r = await svc.run("people", "profile", "https://www.linkedin.com/in/x/");
    expect(r.code).toBe(1);
    expect(r.errJson.error).toMatchObject({ code: "EXTENSION_ERROR", message: "Profile not found" });
    e.close();
  });
});

describe("halt and resume", () => {
  let svc: Svc;
  beforeAll(async () => { svc = await startSvc(); });
  afterAll(() => svc.stop());

  test("HALT reply halts the service; everything refused until resume, which tells the extension", async () => {
    let n = 0;
    const e = await fakeExt(svc, { handler: () => { if (n++ === 0) throw halt("captcha challenge"); return { status: "commented" }; } });
    const add = ["comment", "add", POST, "--text", "hi", "--confirm"];
    const first = await svc.run(...add);
    expect(first.code).toBe(5);
    expect(first.errJson.error.code).toBe("HALTED");
    expect((await svc.status()).halted).toMatchObject({ reason: "captcha challenge" });
    const callsBefore = e.calls.length;
    for (const args of [add, ["post", "scheduled"], ["queue", "enqueue", "post", "--args", '{"text":"x"}', "--confirm"]]) {
      expect((await svc.run(...args)).code).toBe(5);
    }
    expect(e.calls.length).toBe(callsBefore);
    const res = await svc.run("service", "resume");
    expect(res.code).toBe(0);
    expect(res.json).toMatchObject({ halted: null, resumed: true });
    await sleep(50);
    expect(e.received).toContainEqual({ type: "resume" });
    expect((await svc.run("post", "scheduled")).code).toBe(0);
    e.close();
  });
  test("halt survives a service restart", async () => {
    const e = await fakeExt(svc, { handler: () => { throw halt("login wall"); } });
    await svc.run("post", "scheduled");
    e.close();
    await svc.run("service", "stop");
    await svc.run("service", "start");
    expect((await svc.status()).halted).toMatchObject({ reason: "login wall" });
  });
});

describe("outward safety", () => {
  let svc: Svc;
  beforeAll(async () => { svc = await startSvc({ LINKEDIN_CLI_LIMIT_HOUR: "3", LINKEDIN_CLI_LIMIT_DAY: "5" }); });
  afterAll(() => svc.stop());

  test("preview by default: nothing reaches the extension", async () => {
    const e = await fakeExt(svc);
    const r = await svc.run("post", "publish", "--text", "hello");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ preview: true, tool: "post", args: { text: "hello", media: [] } });
    expect(r.json.budget.hour).toEqual({ used: 0, limit: 3 });
    expect(e.calls).toEqual([]);
    expect((await svc.run("post", "publish", "--text", "hello", "--confirm")).code).toBe(0);
    expect(e.calls.map((c) => c.tool)).toEqual(["post"]);
    e.close();
  });
  test("action log row written, budget counted", async () => {
    const db = new Database(join(svc.dir, "state.db"), { readonly: true });
    const row = db.query("select tool, state, counted from actions").get() as any;
    db.close();
    expect(row).toEqual({ tool: "post", state: "done", counted: 1 });
    expect((await svc.status()).budget.hour.used).toBe(1);
  });
  test("hourly budget enforced in the service, then RATE_LIMIT exit 6 with retryAt", async () => {
    const e = await fakeExt(svc, { handler: () => ({ status: "commented" }) });
    for (let i = 0; i < 2; i++) expect((await svc.run("comment", "add", POST, "--text", `c${i}`, "--confirm")).code).toBe(0);
    const r = await svc.run("comment", "add", POST, "--text", "over", "--confirm");
    expect(r.code).toBe(6);
    expect(r.errJson.error.code).toBe("RATE_LIMIT");
    expect(r.errJson.error.retryAt).toBeGreaterThan(Date.now());
    expect(e.calls.length).toBe(2);
    expect((await svc.run("post", "scheduled")).code).toBe(0); // reads are not budgeted
    e.close();
  });
  test("media validation: missing, bad contents, bad type, video mixed with image", async () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    const fake = join(d, "a.png"); writeFileSync(fake, "Too many requests");
    const png = join(d, "b.png"); writeFileSync(png, Buffer.concat([Buffer.from("89504e47", "hex"), Buffer.alloc(16)]));
    const mp4 = join(d, "c.mp4"); writeFileSync(mp4, "x");
    const bad = join(d, "d.txt"); writeFileSync(bad, "x");
    for (const media of [[join(d, "nope.png")], [fake], [bad], [mp4, png]]) {
      const r = await svc.run("post", "publish", "--text", "t", ...media.flatMap((m) => ["--media", m]), "--confirm");
      expect(r.code).toBe(2);
      expect(r.errJson.error.code).toBe("INVALID");
    }
    expect((await svc.run("post", "publish", "--text", "t", "--media", png)).code).toBe(0); // preview ok
  });
  test("attachment validation: missing, empty, >20MB, directory", async () => {
    const d = mkdtempSync(join(tmpdir(), "a-"));
    const empty = join(d, "e.pdf"); writeFileSync(empty, "");
    const big = join(d, "b.pdf"); writeFileSync(big, ""); truncateSync(big, 21 * 1024 * 1024);
    for (const f of [join(d, "none.pdf"), empty, big, d]) {
      const r = await svc.run("message", "send", "--name", "Bob", "--text", "hi", "--attachment", f, "--confirm");
      expect(r.code).toBe(2);
    }
  });
  test("message target must be exactly one of name/profile", async () => {
    expect((await svc.run("message", "send", "--text", "hi", "--confirm")).code).toBe(2);
    expect((await svc.run("message", "send", "--name", "a", "--profile", "https://x", "--text", "hi", "--confirm")).code).toBe(2);
  });
  test("schedule needs a future time", async () => {
    expect((await svc.run("post", "schedule", "--text", "t", "--at", "2020-01-01T00:00:00Z", "--confirm")).code).toBe(2);
  });
});

describe("gap and invites", () => {
  test("gap is enforced between outward actions (shortened for the test)", async () => {
    const svc = await startSvc({ LINKEDIN_CLI_GAP_MIN_MS: "300", LINKEDIN_CLI_GAP_MAX_MS: "300" });
    const times: number[] = [];
    const e = await fakeExt(svc, { handler: () => { times.push(Date.now()); return { status: "commented" }; } });
    await svc.call("commentPost", { post: POST, text: "1" });
    await svc.call("commentPost", { post: POST, text: "2" });
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(290);
    e.close();
    await svc.stop();
  });
  test("invites capped at 20 per 24h", async () => {
    const svc = await startSvc();
    const e = await fakeExt(svc, { handler: () => ({ status: "invited" }) });
    for (let i = 0; i < 20; i++) await svc.call("connect", { profile: `https://www.linkedin.com/in/p${i}/` });
    const r = await svc.run("people", "connect", "https://www.linkedin.com/in/p21/", "--confirm");
    expect(r.code).toBe(6);
    expect(r.errJson.error.message).toContain("invitations");
    expect(e.calls.length).toBe(20);
    e.close();
    await svc.stop();
  });
});
