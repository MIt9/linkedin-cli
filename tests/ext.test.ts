import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { extensionId, folderState, installExtension, pinnedId, readDir } from "../src/ext";
import { fakeExt, startSvc } from "./helpers";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "lcli-ext-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const newKey = () => generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
const extSrc = (version: string, key?: string, extra: Record<string, string> = {}) => {
  const d = tmp();
  writeFileSync(join(d, "manifest.json"), JSON.stringify({ manifest_version: 3, version, ...(key ? { key } : {}) }));
  for (const [f, c] of Object.entries(extra)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), c); }
  return d;
};

describe("extension id", () => {
  test("derived from the manifest key (vector cross-checked with shasum + tr)", () => {
    const key = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqpAfL5FXQ7ENCJIpUzWmseC+rlj+PgM99tEh5I8oQKq+FRzjKuEhHxsWCMx3J54G/avaYr6n6vAQSEU0nKLmbOKcOEgYhOYoaB8woiQUo0SfB1rn+QQveoQJGyogZRhuzuHHz4w0vd3/aCqTwBKIh4fjlrMgfz+Xs9jUdAwPu2IAlDtmnSrMQSaoMPTWQrlItMnj4Z3OBETFAJKTWcYjVJWmZV9FGIUvNgAEsfP4H698BUdb2ZQsVNsZW5x+Vj9WHVHLPpCRtdA7h/aBGmeJDazKqKTF9jXxyUdnYDJILlV3IrGtzBHKShRaAMyWg25xlmMsBJwd7DGaICxVxFom6wIDAQAB";
    expect(extensionId(key)).toBe("jjaiomkoejbhkjipghimeajjpeobjodh");
    expect(extensionId(newKey())).toMatch(/^[a-p]{32}$/);
  });
  test("pinnedId reads the bundled manifest; null without a key", () => {
    const key = newKey();
    process.env.LINKEDIN_CLI_EXT_SRC = extSrc("1.0.0", key);
    expect(pinnedId()).toBe(extensionId(key));
    process.env.LINKEDIN_CLI_EXT_SRC = extSrc("1.0.0");
    expect(pinnedId()).toBeNull();
    delete process.env.LINKEDIN_CLI_EXT_SRC;
  });
});

describe("/ext origin pinning", () => {
  test("pinned: only chrome-extension://<id>; status extensionPinned true", async () => {
    const key = newKey(), id = extensionId(key);
    const svc = await startSvc({ LINKEDIN_CLI_EXT_SRC: extSrc("1.0.0", key) });
    try {
      await expect(fakeExt(svc, { origin: "chrome-extension://" + "a".repeat(32) })).rejects.toThrow();
      await expect(fakeExt(svc, { origin: "https://evil.example" })).rejects.toThrow();
      const e = await fakeExt(svc, { origin: `chrome-extension://${id}` });
      expect(await svc.status()).toMatchObject({ extensionPinned: true, expectedExtensionId: id, connected: true });
      e.close();
      expect((await svc.run("service", "status")).json).toMatchObject({ extensionPinned: true });
    } finally { await svc.stop(); }
  });
  test("no key: any chrome-extension:// origin, extensionPinned false, warning in the log", async () => {
    const svc = await startSvc();
    try {
      const e = await fakeExt(svc, { origin: "chrome-extension://" + "b".repeat(32) });
      expect(await svc.status()).toMatchObject({ extensionPinned: false, expectedExtensionId: null, connected: true });
      expect(readFileSync(join(svc.dir, "service.log"), "utf8")).toContain("no key");
      e.close();
    } finally { await svc.stop(); }
  });
});

describe("installExtension", () => {
  const f = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));
  const m = (v: string) => JSON.stringify({ version: v });
  test("fresh install writes files and .version; same files again is a no-op", () => {
    const dest = join(tmp(), "extension");
    const r = installExtension(f({ "manifest.json": m("1.0.0"), "a/b.js": "x" }), dest);
    expect(r).toMatchObject({ changed: true, backup: null, version: "1.0.0" });
    expect(readFileSync(join(dest, "a/b.js"), "utf8")).toBe("x");
    expect(readFileSync(join(dest, ".version"), "utf8").trim()).toBe("1.0.0");
    expect(installExtension(f({ "manifest.json": m("1.0.0"), "a/b.js": "x" }), dest).changed).toBe(false);
  });
  test("a different existing folder is kept as .bak (also user-edited files), then replaced", () => {
    const dest = join(tmp(), "extension");
    installExtension(f({ "manifest.json": m("1.0.0"), "bg.js": "old" }), dest);
    writeFileSync(join(dest, "bg.js"), "edited by user");
    const r = installExtension(f({ "manifest.json": m("1.1.0"), "bg.js": "new" }), dest);
    expect(r.backup).toBe(`${dest}.bak`);
    expect(readFileSync(join(`${dest}.bak`, "bg.js"), "utf8")).toBe("edited by user");
    expect(readFileSync(join(dest, "bg.js"), "utf8")).toBe("new");
    expect(readDir(dest)["bg.js"]!.toString()).toBe("new");
    expect(existsSync(`${dest}.new-${process.pid}`)).toBe(false);
  });
  test("folderState: installed / version / upToDate", () => {
    const state = tmp(), files = f({ "manifest.json": m("1.0.0"), "bg.js": "a" });
    expect(folderState(state, files)).toMatchObject({ installed: false, upToDate: false, bundledVersion: "1.0.0" });
    installExtension(files, join(state, "extension"));
    expect(folderState(state, files)).toMatchObject({ installed: true, version: "1.0.0", upToDate: true });
    expect(folderState(state, f({ "manifest.json": m("1.0.1"), "bg.js": "a" }))).toMatchObject({ version: "1.0.0", upToDate: false });
  });
});
