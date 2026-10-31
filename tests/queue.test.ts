import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fakeExt, sleep, startSvc, type Svc } from "./helpers";

describe("queue", () => {
  let svc: Svc;
  beforeAll(async () => { svc = await startSvc(); });
  afterAll(() => svc.stop());

  test("enqueue without confirm previews an outward job", async () => {
    const r = await svc.run("queue", "enqueue", "post", "--args", '{"text":"x"}');
    expect(r.json).toMatchObject({ preview: true, tool: "post" });
    expect((await svc.run("queue", "list")).json).toEqual([]);
  });
  test("unknown action and bad args JSON are rejected", async () => {
    expect((await svc.run("queue", "enqueue", "nuke", "--confirm")).code).toBe(2);
    expect((await svc.run("queue", "enqueue", "post", "--args", "{", "--confirm")).code).toBe(2);
  });
  test("queued while extension is away; survives restart; runs when it connects; key dedupes", async () => {
    const a = await svc.run("queue", "add", "post", "--args", '{"text":"later"}', "--key", "k1", "--confirm");
    expect(a.json).toMatchObject({ status: "queued" });
    const dup = await svc.run("queue", "enqueue", "post", "--args", '{"text":"later"}', "--key", "k1", "--confirm");
    expect(dup.json.jobId).toBe(a.json.jobId);
    await svc.run("service", "stop");
    await svc.run("service", "start");
    expect((await svc.run("queue", "show", String(a.json.jobId))).json).toMatchObject({ state: "queued", tool: "post" });
    const e = await fakeExt(svc, { handler: () => ({ ok: true }) });
    for (let i = 0; i < 50 && e.calls.length === 0; i++) await sleep(20);
    expect(e.calls[0]).toMatchObject({ tool: "post", args: { text: "later", media: [] } });
    await sleep(100);
    expect((await svc.run("queue", "get", String(a.json.jobId))).json).toMatchObject({ state: "done", result: { ok: true } });
    expect((await svc.run("queue", "list", "--status", "done")).json[0]).toMatchObject({ id: a.json.jobId, hasResult: true });
    expect((await svc.run("queue", "cancel", String(a.json.jobId))).code).toBe(2);
    e.close();
  });
  test("not-before holds a job; cancel works on queued", async () => {
    const e = await fakeExt(svc);
    const future = new Date(Date.now() + 3600e3).toISOString();
    const j = (await svc.run("queue", "enqueue", "searchPeople", "--args", '{"keywords":"a"}', "--not-before", future)).json;
    await sleep(100);
    expect((await svc.run("queue", "get", String(j.jobId))).json.state).toBe("queued");
    expect((await svc.run("queue", "cancel", String(j.jobId))).json.state).toBe("cancelled");
    e.close();
  });
  test("queued outward jobs get the same validation as direct calls", async () => {
    expect((await svc.run("queue", "enqueue", "post", "--args", '{"text":"x","media":["/nope.png"]}', "--confirm")).code).toBe(2);
  });
});

describe("crash recovery", () => {
  test("running outward job becomes unverified after kill -9 and is never re-sent", async () => {
    const svc = await startSvc();
    const e = await fakeExt(svc, { handler: () => new Promise(() => {}) });
    const j = (await svc.run("queue", "enqueue", "post", "--args", '{"text":"x"}', "--confirm")).json;
    for (let i = 0; i < 50 && e.calls.length === 0; i++) await sleep(20);
    expect((await svc.run("queue", "get", String(j.jobId))).json.state).toBe("running");
    const pid = Number((await Bun.file(`${svc.dir}/service.pid`).text()).trim());
    process.kill(pid, "SIGKILL");
    e.close();
    await sleep(100);
    expect((await svc.run("service", "start")).code).toBe(0);
    const e2 = await fakeExt(svc);
    await sleep(200);
    expect(e2.calls).toEqual([]);
    expect((await svc.run("queue", "get", String(j.jobId))).json).toMatchObject({ state: "unverified" });
    e2.close();
    await svc.stop();
  });
  test("extension timeout on an outward action is unverified (exit 4)", async () => {
    const svc = await startSvc({ LINKEDIN_CLI_CALL_TIMEOUT_MS: "200" });
    const e = await fakeExt(svc, { handler: () => new Promise(() => {}) });
    const r = await svc.run("comment", "add", "https://www.linkedin.com/feed/update/urn:li:activity:1/", "--text", "t", "--confirm");
    expect(r.code).toBe(4);
    expect(r.errJson.error.code).toBe("UNVERIFIED");
    e.close();
    await svc.stop();
  });
  test("schedule not found in LinkedIn's list is unverified", async () => {
    const svc = await startSvc();
    const e = await fakeExt(svc, { handler: (tool) => (tool === "listScheduled" ? [] : { ok: true }) });
    const at = new Date(Date.now() + 86400e3).toISOString();
    expect((await svc.run("post", "schedule", "--text", "hello", "--at", at, "--confirm")).code).toBe(4);
    e.close();
    await svc.stop();
  });
});
