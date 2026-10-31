import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, resolve } from "node:path";
import { fail } from "./errors";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".avi", ".webm", ".mkv"]);
const abs = (f: string) => resolve(f.replace(/^~(?=\/)/, homedir()));

function isImage(f: string) {
  const b = Buffer.alloc(12);
  const fd = openSync(f, "r");
  try { readSync(fd, b, 0, 12, 0); } finally { closeSync(fd); }
  const hex = b.toString("hex");
  return hex.startsWith("89504e47") || hex.startsWith("ffd8ff") || hex.startsWith("47494638")
    || (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP")
    || b.toString("latin1", 4, 8) === "ftyp" || hex.startsWith("424d");
}

export function checkMedia(media: unknown = []): string[] {
  if (!Array.isArray(media) || media.some((m) => typeof m !== "string")) fail("INVALID", "media must be a list of file paths");
  const files = (media as string[]).map(abs);
  for (const f of files) {
    if (!existsSync(f)) fail("INVALID", `File not found: ${f}`);
    const ext = extname(f).toLowerCase();
    if (!IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext)) fail("INVALID", `Unsupported media type: ${f}`);
    // A failed download saved as image-1.png makes LinkedIn drop the post silently.
    if (IMAGE_EXT.has(ext) && !isImage(f)) fail("INVALID", `Not a real image (bad file contents): ${f}`);
  }
  const videos = files.filter((f) => VIDEO_EXT.has(extname(f).toLowerCase()));
  if (videos.length && files.length > 1) fail("INVALID", "LinkedIn allows one video per post, without images");
  if (files.length > 20) fail("INVALID", "LinkedIn allows max 20 images per post");
  return files;
}

export function checkAttachment(file: string) {
  const f = abs(file);
  const st = statSync(f, { throwIfNoEntry: false });
  if (!st) fail("INVALID", `File not found: ${f}`);
  if (!st!.isFile()) fail("INVALID", `Not a regular file: ${f}`);
  if (st!.size === 0 || st!.size > 20 * 1024 * 1024) fail("INVALID", `Attachment must be 1 byte to 20 MB: ${f}`);
  return f;
}

const str = (a: any, k: string, max?: number, label = k) => {
  if (typeof a[k] !== "string" || !a[k]) fail("INVALID", `${label} required`);
  if (max && a[k].length > max) fail("INVALID", `${label} is longer than ${max} characters`);
};
const oneTarget = (a: any) => { if (!a.name === !a.profile) fail("INVALID", "Give exactly one of `name` or `profile`"); };
const intIn = (a: any, k: string, lo: number, hi: number) => {
  if (a[k] !== undefined && !(Number.isInteger(a[k]) && a[k] >= lo && a[k] <= hi)) fail("INVALID", `${k} must be an integer ${lo}..${hi}`);
};

// Per-action argument checks and normalisation; shared by direct calls and the queue. Unlisted actions pass through.
const prep: Record<string, (a: any) => any> = {
  post: (a) => { str(a, "text", 3000); return { ...a, media: checkMedia(a.media) }; },
  schedule: (a) => {
    str(a, "text", 3000);
    if (!(Date.parse(a.at) > Date.now())) fail("INVALID", "`at` must be a valid future datetime");
    return { ...a, media: checkMedia(a.media) };
  },
  deleteScheduled: (a) => { str(a, "when"); return a; },
  searchPeople: (a) => {
    if (!a.keywords && !a.title && !a.company) fail("INVALID", "Give keywords, title or company");
    intIn(a, "page", 1, 100);
    if (a.network && !(Array.isArray(a.network) && a.network.every((n: unknown) => n === 1 || n === 2 || n === 3))) fail("INVALID", "network values must be 1, 2 or 3");
    return a;
  },
  getProfile: (a) => { str(a, "profile"); return a; },
  connect: (a) => { str(a, "profile"); if (a.note !== undefined) str(a, "note", 300); return a; },
  readConversation: (a) => { oneTarget(a); intIn(a, "limit", 1, 200); return a; },
  sendMessage: (a) => {
    oneTarget(a); str(a, "text", 8000);
    return { ...a, attachment: a.attachment ? checkAttachment(a.attachment) : undefined };
  },
  getComments: (a) => { str(a, "post"); return a; },
  replyComment: (a) => { str(a, "post"); str(a, "commentId"); str(a, "text", 1250); return a; },
  likeComment: (a) => { str(a, "post"); str(a, "commentId"); return a; },
  commentPost: (a) => { str(a, "post"); str(a, "text", 1250); return a; },
  searchJobs: (a) => { str(a, "keywords"); intIn(a, "page", 1, 40); return a; },
  searchPosts: (a) => { str(a, "keywords"); intIn(a, "limit", 1, 50); return a; },
  respondInvitation: (a) => {
    str(a, "profile");
    if (a.action !== "accept" && a.action !== "ignore") fail("INVALID", "action must be accept or ignore");
    return a;
  },
  withdrawInvitation: (a) => {
    const profiles = a.profiles ?? (a.profile ? [a.profile] : []);
    if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 25) fail("INVALID", "Give 1-25 profile URLs");
    return { profiles };
  },
  click: (a) => { str(a, "label"); return a; },
  type: (a) => { if (typeof a.text !== "string") fail("INVALID", "text required"); return a; },
};
export const prepare = (tool: string, args: any) => {
  if (args === null || typeof args !== "object" || Array.isArray(args)) fail("INVALID", "args must be an object");
  return prep[tool] ? prep[tool](args) : args;
};

const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
// Schedule check: some scheduled entry starts with the first 60 chars of what we sent.
export const verifyScheduled = (args: any, list: unknown) =>
  (Array.isArray(list) ? list : []).some((e) => norm(e?.text).startsWith(norm(args.text).slice(0, 60)));
