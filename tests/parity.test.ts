import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fakeExt, startSvc, type Svc } from "./helpers";

const d = mkdtempSync(join(tmpdir(), "p-"));
const IMG = join(d, "a.png"); writeFileSync(IMG, Buffer.concat([Buffer.from("89504e47", "hex"), Buffer.alloc(16)]));
const DOC = join(d, "cv.pdf"); writeFileSync(DOC, "pdf");
const U = "https://www.linkedin.com/in/x/";
const P = "https://www.linkedin.com/feed/update/urn:li:activity:1/";
const AT = new Date(Date.now() + 86400e3).toISOString();

// [argv, internal action, args sent to the extension]
const table: [string[], string, object][] = [
  [["post", "publish", "--text", "hi", "--media", IMG, "--confirm"], "post", { text: "hi", media: [resolve(IMG)] }],
  [["post", "schedule", "--text", "t", "--at", AT, "--confirm"], "schedule", { text: "t", at: AT, media: [] }],
  [["post", "scheduled"], "listScheduled", {}],
  [["post", "delete-scheduled", "--when", "W", "--confirm"], "deleteScheduled", { when: "W" }],
  [["people", "search", "--keywords", "k", "--title", "t", "--company", "c", "--network", "1", "--network", "2", "--page", "2"], "searchPeople", { keywords: "k", title: "t", company: "c", network: [1, 2], page: 2 }],
  [["people", "profile", U, "--no-details"], "getProfile", { profile: U, details: false }],
  [["people", "profile", U], "getProfile", { profile: U }],
  [["people", "connect", U, "--note", "n", "--confirm"], "connect", { profile: U, note: "n" }],
  [["message", "list", "--limit", "5", "--unread-only"], "listConversations", { limit: 5, unreadOnly: true }],
  [["message", "read", "--name", "N", "--limit", "3"], "readConversation", { name: "N", limit: 3 }],
  [["message", "send", "--profile", U, "--text", "t", "--attachment", DOC, "--confirm"], "sendMessage", { profile: U, text: "t", attachment: resolve(DOC) }],
  [["post", "list", "--limit", "3", "--feed", "reactions"], "listMyPosts", { limit: 3, feed: "reactions" }],
  [["comment", "list", P], "getComments", { post: P }],
  [["comment", "unanswered", "--posts", "3"], "unansweredComments", { posts: 3 }],
  [["comment", "reply", P, "--comment-id", "C", "--text", "t", "--confirm"], "replyComment", { post: P, commentId: "C", text: "t" }],
  [["comment", "like", P, "--comment-id", "C", "--confirm"], "likeComment", { post: P, commentId: "C" }],
  [["comment", "add", P, "--text", "t", "--confirm"], "commentPost", { post: P, text: "t" }],
  [["job", "search", "--keywords", "k", "--location", "L", "--remote", "--easy-apply", "--posted-within", "week", "--page", "2"], "searchJobs", { keywords: "k", location: "L", remote: true, easyApply: true, postedWithin: "week", page: 2 }],
  [["job", "get", "J"], "getJob", { job: "J" }],
  [["job", "save", "J"], "saveJob", { job: "J" }],
  [["job", "tracker", "--stage", "saved"], "jobTracker", { stage: "saved" }],
  [["post", "search", "--keywords", "k", "--date-posted", "past-week", "--limit", "5"], "searchPosts", { keywords: "k", datePosted: "past-week", limit: 5 }],
  [["notification", "list", "--limit", "5", "--actionable-only"], "listNotifications", { limit: 5, actionableOnly: true }],
  [["invitation", "list", "--direction", "sent", "--limit", "5"], "listInvitations", { direction: "sent", limit: 5 }],
  [["invitation", "respond", U, "--action", "accept", "--confirm"], "respondInvitation", { profile: U, action: "accept" }],
  [["invitation", "withdraw", "--profile", "A", "--profile", "B", "--confirm"], "withdrawInvitation", { profiles: ["A", "B"] }],
  [["browser", "snapshot"], "snapshot", {}],
  [["browser", "read", "--max-lines", "10"], "readPage", { maxLines: 10 }],
  [["browser", "click", "--label", "L", "--exact", "--confirm"], "click", { label: "L", exact: true }],
  [["browser", "type", "--text", "t", "--confirm"], "type", { text: "t" }],
  [["tabs", "list"], "listTabs", {}],
  [["tabs", "use", "5"], "useTab", { tabId: 5 }],
  [["tabs", "clear"], "useTab", { tabId: null }],
];

describe("COMMANDS.md parity with fake extension", () => {
  let svc: Svc;
  let ext: Awaited<ReturnType<typeof fakeExt>>;
  beforeAll(async () => { svc = await startSvc(); ext = await fakeExt(svc, { handler: () => ({ ok: true, verified: true }) }); });
  afterAll(async () => { ext.close(); await svc.stop(); });

  for (const [argv, tool, args] of table) test(argv.join(" ").replace(d, "").slice(0, 70), async () => {
    const before = ext.calls.length;
    const r = await svc.run(...argv);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(ext.calls.length).toBe(before + 1);
    expect(ext.calls.at(-1)).toMatchObject({ tool, args });
  });

  test("outward commands without --confirm preview and do not call the extension", async () => {
    const before = ext.calls.length;
    for (const argv of table.filter(([a]) => a.includes("--confirm"))) {
      const r = await svc.run(...argv[0].filter((x) => x !== "--confirm"));
      expect(r.json).toMatchObject({ preview: true, tool: argv[1] });
    }
    expect(ext.calls.length).toBe(before);
  });
});
