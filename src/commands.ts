import { CliError } from "./errors";
import { needsConfirm } from "./tools";

// Single source of truth: this table drives argument parsing/validation AND --help.
// Descriptions, enums, defaults and ranges come from linkedin-ex/mcp-server/index.js.
type O = { k: "s" | "b" | "n" | "m" | "mn"; d: string; def?: string | number | boolean; as?: string; min?: number; max?: number; enum?: string[] };
const S = (d: string): O => ({ k: "s", d });
const B = (d: string, def?: boolean): O => ({ k: "b", d, def });
const M = (d: string, as?: string): O => ({ k: "m", d, as });
const N = (min: number, max: number, d: string, def?: number): O => ({ k: "n", min, max, d, def });
const E = (d: string, def: string | undefined, ...enum_: string[]): O => ({ k: "s", d, def, enum: enum_ });

type Effect = "read" | "outward" | "destructive" | "local";
type Meta = { d: string; fx: Effect; out: string; ex: string[]; notes?: string; opts?: Record<string, O> };
type Def = Meta & {
  tool?: string; pos?: string; posd?: string; posNum?: boolean; opts?: Record<string, O>; req?: string[]; fix?: (a: Record<string, any>) => Record<string, any>;
  method?: "call" | "enqueue" | "queue"; qaction?: string; alias?: string[];
};

const PV = "Without --confirm it only returns a preview ({preview: true, ...} with the exact arguments and budget state); nothing is sent.";
const BG = "Counts against the shared budget (15/h, 60/day); 20-30 s gap between outward actions; over the limit fails with RATE_LIMIT (exit 6).";
const NOBG = "Needs --confirm but does not use the action budget.";
const outward = (...more: string[]) => [PV, BG, ...more].join(" ");
const L = "linkedin";

// Order matters: groups appear in this order in `--help`.
export const DEFS: Record<string, Def> = {
  "post publish": {
    tool: "post", d: "Publish a LinkedIn post now, optionally with images or a video (drives the real Chrome UI).", fx: "outward",
    notes: outward("Text max 3000 chars. Media: up to 20 images, or exactly 1 video (not both); files must exist and images must be real images."),
    out: "Preview, or the publish result from LinkedIn.", ex: [`${L} post publish --text "Hello"`,`${L} post publish --text "Photos" --media ~/a.png --media ~/b.png --confirm`],
    opts: { text: S("Post text, 1-3000 chars. Newlines become paragraphs."), media: M("Absolute local path of an image or video. Repeat for several: up to 20 images, or exactly 1 video.") }, req: ["text"],
  },
  "post schedule": {
    tool: "schedule", d: "Schedule a post via LinkedIn's own scheduler; LinkedIn publishes it later, Chrome need not be running.", fx: "outward",
    notes: outward("Text max 3000 chars; media as in 'post publish'. LinkedIn may accept only 15-minute steps and dates up to ~3 months ahead. The result is verified against LinkedIn's scheduled list."),
    out: "Preview, or the scheduling result with verification against the scheduled list.", ex: [`${L} post schedule --text "Soon" --at 2026-11-20T09:30:00+02:00`, `${L} post schedule --text "Soon" --at 2026-11-20T09:30:00+02:00 --confirm`],
    opts: { text: S("Post text, 1-3000 chars."), at: S("Future ISO 8601 datetime, e.g. 2026-10-20T09:30:00+03:00."), media: M("Absolute local path of an image or video. Repeat: up to 20 images, or exactly 1 video.") }, req: ["text", "at"],
  },
  "post scheduled": {
    tool: "listScheduled", d: "List posts scheduled in LinkedIn.", fx: "read", out: 'Array of { when, text }; `when` is LinkedIn\'s own string, e.g. "Thu, Oct 15, 2026 at 7:45 AM".', ex: [`${L} post scheduled`],
  },
  "post delete-scheduled": {
    tool: "deleteScheduled", d: "Permanently delete one scheduled post. Cannot be undone.", fx: "destructive",
    notes: `${PV} ${NOBG} Run 'post scheduled' first and use the exact 'when' value; fails without deleting if zero or several posts match.`,
    out: "Preview, or the deletion result.", ex: [`${L} post delete-scheduled --when "Thu, Oct 15, 2026 at 7:45 AM"`],
    opts: { when: S("Exact `when` value from 'post scheduled'.") }, req: ["when"],
  },
  "post list": {
    tool: "listMyPosts", d: "List your recent posts, or posts you liked/reacted to.", fx: "read",
    out: "Array of { url, author, time, text, reactions, comments }.", ex: [`${L} post list --limit 5`, `${L} post list --feed reactions`],
    opts: { limit: N(1, 50, "How many posts to return.", 10), feed: E('"all" = your own posts, "reactions" = posts you reacted to.', "all", "all", "reactions") },
  },
  "post search": {
    tool: "searchPosts", d: "Search LinkedIn posts, e.g. hiring posts.", fx: "read",
    out: "Array of { author, profile, time, text, reactions, comments, url }; url is null in search results, contact the author via profile.",
    ex: [`${L} post search --keywords "hiring react tech lead"`, `${L} post search --keywords "шукаємо frontend" --date-posted past-week --limit 20`],
    opts: { keywords: S('Search text, e.g. "hiring react tech lead".'), "date-posted": E("Only posts from this period.", undefined, "past-24h", "past-week", "past-month"), limit: N(1, 50, "How many posts to return.", 10) }, req: ["keywords"],
  },
  "people search": {
    tool: "searchPeople", d: "Search LinkedIn people (one page of ~10 cards).", fx: "read", notes: "Give at least one of --keywords, --title, --company.",
    out: "One page of cards { name, profile, action (Connect/Message/Follow/Pending), lines (headline, location, role, mutuals) } and hasNext. Use 'people profile' to check fit before connecting.",
    ex: [`${L} people search --keywords "frontend developer react" --network 2 --network 3`, `${L} people search --title "Tech Lead" --company Acme --page 2`],
    opts: {
      keywords: S('Free text, e.g. "frontend developer react".'), title: S("Current title keyword filter."), company: S("Company name keyword filter."),
      network: { k: "mn", min: 1, max: 3, enum: ["1", "2", "3"], d: "Connection degree filter: 1, 2 or 3 (3 = 3rd+). Repeat for several." }, page: N(1, 100, "Result page number."),
    },
  },
  "people profile": {
    tool: "getProfile", pos: "profile", posd: "Profile URL, e.g. https://www.linkedin.com/in/some-slug/", d: "Read a LinkedIn profile.", fx: "read",
    notes: 'Opening a profile shows up in their "Who viewed your profile".',
    out: '{ name, top (headline, location, degree...), actions, sections: { About, Experience, Education, Skills, ..., "details:experience" } }.',
    ex: [`${L} people profile https://www.linkedin.com/in/some-slug/`, `${L} people profile https://www.linkedin.com/in/some-slug/ --no-details`],
    opts: { details: B('Also open "Show all" pages for full experience/skills lists (slower).', true), "no-details": B("Skip the \"Show all\" pages (faster). Same as --details false.") },
    fix: ({ noDetails, ...a }) => (noDetails ? { ...a, details: false } : a),
  },
  "people connect": {
    tool: "connect", pos: "profile", posd: "Profile URL from 'people search'.", d: "Send a connection invitation from the profile page, optionally with a note.", fx: "outward",
    notes: outward("Invitations are also capped at 20 per 24 h; free accounts limit personalized notes per month and allow max 200 note chars (hard max 300)."),
    out: "Preview, or { status: invited | already pending | already connected | connect not available }.",
    ex: [`${L} people connect https://www.linkedin.com/in/some-slug/ --note "Hi, let's connect"`, `${L} people connect https://www.linkedin.com/in/some-slug/ --confirm`],
    opts: { note: S("Invitation note, max 300 chars (free accounts: 200).") },
  },
  "message list": {
    tool: "listConversations", d: "List messaging conversations, newest first.", fx: "read", out: "Array of { name, time, snippet, unread }.", ex: [`${L} message list --unread-only`, `${L} message list --limit 50`],
    opts: { limit: N(1, 100, "How many conversations to return.", 20), "unread-only": B("Only unread conversations.") },
  },
  "message read": {
    tool: "readConversation", d: "Read the message history of one conversation.", fx: "read", notes: "Give exactly one of --name or --profile.",
    out: "{ messages: [{ from, date, time, text }] }, oldest first, the last --limit messages.", ex: [`${L} message read --name "Jane Doe" --limit 10`],
    opts: { name: S("Exact conversation name from 'message list'."), profile: S("Profile URL of a 1st-degree connection (opens the chat via the Message button)."), limit: N(1, 200, "How many last messages to return.", 30) },
  },
  "message send": {
    tool: "sendMessage", d: "Send a message to an existing conversation (by name) or to a 1st-degree connection (by profile).", fx: "outward",
    notes: outward("Give exactly one of --name or --profile. Text max 8000 chars. The chat header is verified against the recipient before typing. Attachment: a regular file, 1 byte to 20 MB; if it cannot be attached, nothing is sent."),
    out: "Preview, or the send result.", ex: [`${L} message send --name "Jane Doe" --text "Hi!"`, `${L} message send --profile https://www.linkedin.com/in/some-slug/ --text "CV attached" --attachment ~/cv.pdf --confirm`],
    opts: { name: S("Exact conversation name from 'message list'."), profile: S("Profile URL of a 1st-degree connection."), text: S("Message text, 1-8000 chars; newlines kept as line breaks."), attachment: S("Absolute local path of a file to attach (1 byte - 20 MB), e.g. a PDF resume.") }, req: ["text"],
  },
  "comment list": {
    tool: "getComments", pos: "post", posd: "Post URL containing urn:li:activity:..., e.g. from 'post list'.", d: "Read all comments of any post (yours or others), with collapsed replies expanded.", fx: "read",
    out: "{ me, threads: [{ id, author, profile, time, text, replies, needsReply, replyTo }] }. needsReply = someone else spoke last; replyTo = comment id for 'comment reply'.", ex: [`${L} comment list https://www.linkedin.com/feed/update/urn:li:activity:123/`],
  },
  "comment unanswered": {
    tool: "unansweredComments", d: "Scan your recent posts with comments and return threads where someone else spoke last.", fx: "read", out: "Array of { post, text, threads }.", ex: [`${L} comment unanswered`, `${L} comment unanswered --posts 10`],
    opts: { posts: N(1, 20, "How many recent posts to scan.", 5) },
  },
  "comment reply": {
    tool: "replyComment", pos: "post", posd: "Post URL.", d: "Reply to a comment on any post; LinkedIn pre-fills an @mention of the author and the text is typed after it.", fx: "outward",
    notes: outward("Reply text max 1250 chars."), out: "Preview, or the reply result.",
    ex: [`${L} comment reply POST_URL --comment-id "urn:li:comment:(...)" --text "Thanks!"`, `${L} comment reply POST_URL --comment-id "urn:li:comment:(...)" --text "Thanks!" --confirm`],
    opts: { "comment-id": S("Comment id (urn:li:comment:(...)) from 'comment list', usually a thread's replyTo."), text: S("Reply text, 1-1250 chars.") }, req: ["comment-id", "text"],
  },
  "comment like": {
    tool: "likeComment", pos: "post", posd: "Post URL.", d: "Like one comment on any post (idempotent).", fx: "outward", notes: outward(),
    out: 'Preview, or { status: "liked" | "already_liked", id }.', ex: [`${L} comment like POST_URL --comment-id "urn:li:comment:(...)" --confirm`],
    opts: { "comment-id": S("Comment id (urn:li:comment:(...)) from 'comment list'.") }, req: ["comment-id"],
  },
  "comment add": {
    tool: "commentPost", pos: "post", posd: "Post URL.", d: "Add a top-level comment to any post (yours or others).", fx: "outward",
    notes: outward("Comment text max 1250 chars."), out: "Preview, or the comment result.", ex: [`${L} comment add POST_URL --text "Great post!"`, `${L} comment add POST_URL --text "Great post!" --confirm`],
    opts: { text: S("Comment text, 1-1250 chars.") }, req: ["text"],
  },
  "job search": {
    tool: "searchJobs", d: "Search LinkedIn jobs (LinkedIn AI search: natural-language keywords work; location/remote are appended to the query).", fx: "read",
    out: "{ page, jobs: [{ id, url, title, company, location, posted, extra }] } (~25 per page). Use 'job get' for the full description.",
    ex: [`${L} job search --keywords "Tech Lead React Node.js" --remote --posted-within week`, `${L} job search --keywords "frontend" --location Germany --easy-apply --page 2`],
    opts: {
      keywords: S('Search text, e.g. "Tech Lead React Node.js".'), location: S('e.g. "European Union", "Germany", "Worldwide"; matched loosely by LinkedIn.'), remote: B("Remote jobs only."), "easy-apply": B("Easy Apply jobs only."),
      "posted-within": E("Only jobs posted within this period.", undefined, "day", "week", "month"), page: N(1, 40, "Result page number."),
    }, req: ["keywords"],
  },
  "job get": {
    tool: "getJob", pos: "job", posd: "Job id or URL.", d: "Read one job posting. Never applies.", fx: "read",
    out: '{ url, top (title, company, location, posted, applicants...), sections: { "About the job", "About the company", "People you can reach out to" }, easyApply, applyUrl, saved }.', ex: [`${L} job get 1234567890`],
  },
  "job save": {
    tool: "saveJob", pos: "job", posd: "Job id or URL.", d: "Save a job to your private Saved jobs list. Never applies.", fx: "outward",
    notes: "Changes your LinkedIn Saved jobs (private, no one else sees it). No --confirm needed and not counted in the action budget.",
    out: "Save result.", ex: [`${L} job save 1234567890`],
  },
  "job tracker": {
    tool: "jobTracker", d: "Show your job tracker (first page, ~10 jobs).", fx: "read",
    out: '{ stage, jobs: [{ id, url, title, details }] }; details like "company · location", "Applied 2w ago".', ex: [`${L} job tracker`, `${L} job tracker --stage saved`],
    opts: { stage: E("Which tracker tab.", "applied", "saved", "applied", "interview", "archived") },
  },
  "notification list": {
    tool: "listNotifications", d: "Read LinkedIn notifications.", fx: "read",
    out: "Array of { kind (reply|mention|comment|reaction|view|invite|job|post|other), text, details, time, actor, post, commentUrn }.",
    ex: [`${L} notification list --actionable-only`, `${L} notification list --limit 50`],
    opts: { limit: N(1, 100, "How many notifications to return.", 30), "actionable-only": B("Only reply/mention/comment notifications.") },
  },
  "invitation list": {
    tool: "listInvitations", d: "List connection invitations: received, or your pending sent ones.", fx: "read", out: 'Array of { name, profile, sent, lines }; sent ones have "Sent N ago".',
    ex: [`${L} invitation list`, `${L} invitation list --direction sent --limit 100`],
    opts: { direction: E("received = people who invited you; sent = your pending invites.", "received", "received", "sent"), limit: N(1, 200, "How many invitations to return.", 50) },
  },
  "invitation respond": {
    tool: "respondInvitation", pos: "profile", posd: "Profile URL from 'invitation list'.", d: "Accept or ignore a received connection invitation.", fx: "outward",
    notes: `${PV} ${NOBG}`, out: "Preview, or the response result.", ex: [`${L} invitation respond https://www.linkedin.com/in/some-slug/ --action accept --confirm`],
    opts: { action: E("What to do with the invitation.", undefined, "accept", "ignore") }, req: ["action"],
  },
  "invitation withdraw": {
    tool: "withdrawInvitation", d: "Withdraw pending sent invitations (useful for ones older than 2-3 weeks), several in one tab with human pauses.", fx: "destructive",
    notes: `${PV} ${NOBG} LinkedIn blocks re-inviting those people for ~3 weeks. 1-25 profiles per call.`,
    out: "Preview, or { withdrawn, results: [{ profile, status, error? }] }.", ex: [`${L} invitation withdraw --profile https://www.linkedin.com/in/a/ --profile https://www.linkedin.com/in/b/ --confirm`],
    opts: { profile: M("Profile URL from 'invitation list --direction sent'. Repeat 1-25 times.", "profiles") }, req: ["profile"],
  },
  "browser snapshot": { tool: "snapshot", d: "List visible buttons/links/editors on the selected tab (see 'tabs use'), else the active LinkedIn tab.", fx: "read", out: "Visible buttons, links and editors.", ex: [`${L} browser snapshot`] },
  "browser read": {
    tool: "readPage", d: "Read the URL and visible text lines of the selected tab, else the active LinkedIn tab.", fx: "read", out: "URL and visible text lines.", ex: [`${L} browser read`, `${L} browser read --max-lines 300`],
    opts: { "max-lines": N(1, 1000, "How many text lines to return.", 150) },
  },
  "browser click": {
    tool: "click", d: "Click a button/link on the selected tab (else the active LinkedIn tab) by aria-label or visible text (trusted mouse event).", fx: "outward",
    notes: `${PV} Checked against the budget, gap and pause, but not counted in the budget (the result cannot be classified). Can have real external effects.`,
    out: "Preview, or the click result.", ex: [`${L} browser click --label "Show all" --exact`],
    opts: { label: S("aria-label or visible text of the element."), exact: B("Match the label exactly instead of by substring.") }, req: ["label"],
  },
  "browser type": {
    tool: "type", d: "Type text into the focused element on the selected tab (else the active LinkedIn tab), as trusted input.", fx: "outward",
    notes: `${PV} Checked against the budget, gap and pause, but not counted in the budget. Can have real external effects.`,
    out: "Preview, or the typing result.", ex: [`${L} browser type --text "hello" --confirm`],
    opts: { text: S("Text to type.") }, req: ["text"],
  },
  "tabs list": { tool: "listTabs", d: 'List tabs of the "LinkedIn bot" tab group that actions reuse (plus the selected tab if outside it).', fx: "read", out: "Array of { tabId, url, title, active, selected }.", ex: [`${L} tabs list`] },
  "tabs use": {
    tool: "useTab", pos: "tabId", posd: "Chrome tab id from 'tabs list'.", posNum: true, d: "Run all actions in this linkedin.com tab.", fx: "local", out: "Selection result.", ex: [`${L} tabs use 123456`],
  },
  "tabs clear": { tool: "useTab", d: "Stop using a selected tab; go back to the bot tab group.", fx: "local", out: "Selection result.", ex: [`${L} tabs clear`], fix: () => ({ tabId: null }) },
  "queue enqueue": {
    method: "enqueue", pos: "tool", posd: "Internal handler name: post, schedule, connect, sendMessage, commentPost, replyComment, getProfile, ...", alias: ["add"],
    d: "Queue an action for the single background worker and return immediately.", fx: "outward",
    notes: `${PV} Same checks and limits as the direct command (15/h, 60/day, 20-30 s gap, invites 20/24 h); rate-limited jobs wait. Runs only while Chrome is connected, survives restarts. A repeated --key returns the existing job unless it failed or was cancelled. Read-only handlers need no --confirm.`,
    out: "Preview, or { jobId, status }. Inspect with 'queue get'.", ex: [`${L} queue enqueue commentPost --args '{"post":"URL","text":"Hi"}' --key c-1`, `${L} queue enqueue schedule --args '{...}' --not-before 2026-11-01T09:00:00Z --confirm`],
    opts: { args: S("JSON object with the same arguments as the matching direct command (camelCase), e.g. '{\"post\":\"URL\",\"text\":\"Hi\"}'."), "not-before": S("Earliest run time: ISO 8601 string or epoch ms."), key: S("Idempotency key.") },
  },
  "queue list": {
    method: "queue", qaction: "list", d: "List queued jobs, newest first.", fx: "read", out: "Array of jobs { id, tool, status, ... }.", ex: [`${L} queue list`, `${L} queue list --status unverified`],
    opts: { status: E("Filter by job status; unverified = may have happened, check LinkedIn.", undefined, "queued", "running", "done", "failed", "unverified", "cancelled"), limit: N(1, 500, "How many jobs to return.", 50) },
  },
  "queue get": { method: "queue", qaction: "get", pos: "id", posd: "Job id.", posNum: true, alias: ["show"], d: "Show one job with its result.", fx: "read", out: "The job with status and result.", ex: [`${L} queue get 12`] },
  "queue cancel": { method: "queue", qaction: "cancel", pos: "id", posd: "Job id.", posNum: true, d: "Cancel a queued job (a running one cannot be stopped).", fx: "local", out: "The cancelled job, or an error if it was not queued.", ex: [`${L} queue cancel 12`] },
};

export const SERVICE_DEFS: Record<string, Meta> = {
  "service start": { d: "Start the local background service (detached) and wait until it answers.", fx: "local", out: "Service status; alreadyRunning: true if it was already up.", ex: [`${L} service start`], notes: "State lives in ~/.linkedin-cli (LINKEDIN_CLI_DIR). Port: LINKEDIN_CLI_PORT, else 'config set port', else 47851. If another process holds the port it fails with PORT_IN_USE (exit 8)." },
  "service stop": { d: "Stop the local background service.", fx: "local", out: "{ stopped: true }, or { running: false, stopped: false } if it was not running.", ex: [`${L} service stop`] },
  "service status": { d: "Bridge health: server and extension versions, match, connection, extension pinning, extension folder, budget, halt state.", fx: "read", out: "Status object with extensionPinned (false: manifest has no key, /ext accepts any chrome-extension:// origin), expectedExtensionId, extensionFolder { path, installed, version, bundledVersion, upToDate }, port and extensionUrl (ws://127.0.0.1:<port>/ext, the value for the extension popup); configuredPort and portMismatch: true if the running port differs from the configured one; { running: false, port, extensionUrl } if the service is down (portInUse: true if a foreign process holds the port).", ex: [`${L} service status`] },
  "service resume": { d: "Clear the HALTED state after a checkpoint/captcha/login was solved manually in Chrome.", fx: "local", out: "Resume result.", ex: [`${L} service resume`] },
  "service run": { d: "Run the service in the foreground (used internally by 'service start').", fx: "local", out: "Runs until SIGTERM/SIGINT.", ex: [`${L} service run`] },
};

const CK = "Keys: port (integer 1024-65535), update_url (https:// base of latest.json; http only for localhost).";
SERVICE_DEFS["config get"] = { d: "Show the effective configuration and where each value comes from.", fx: "read", out: "{ port: { value, source: env|config|default }, update_url: { value, source } }.", ex: [`${L} config get`, `${L} config get port`], notes: `Usage: ${L} config get [key]. ${CK} Precedence: env LINKEDIN_CLI_PORT > ~/.linkedin-cli/config.json > default 47851; update_url: env LINKEDIN_CLI_UPDATE_URL > config.json > default https://github.com/MIt9/linkedin-cli/releases/latest/download.` };
SERVICE_DEFS["config set"] = { d: "Persist a setting in ~/.linkedin-cli/config.json.", fx: "local", out: "The effective configuration (as config get) after the change.", ex: [`${L} config set port 50123`, `${L} config set update_url https://example.com/linkedin-cli`], notes: `Usage: ${L} config set <key> <value>. ${CK} Invalid key or value is USAGE (exit 2). Restart the service and enter ws://127.0.0.1:<port>/ext in the extension popup afterwards.` };
SERVICE_DEFS["config unset"] = { d: "Remove a setting from config.json (back to the default).", fx: "local", out: "The effective configuration (as config get) after the change.", ex: [`${L} config unset port`], notes: `Usage: ${L} config unset <key>. ${CK}` };

const TEXT = B("Print a short plain-language summary instead of JSON (for people; agents should keep the JSON default). Errors stay JSON on stderr.");
const BIN = "State dir is ~/.linkedin-cli (LINKEDIN_CLI_DIR).";
SERVICE_DEFS["extension install"] = {
  d: "Copy the bundled Chrome extension to a stable folder and print the manual steps to load it unpacked.", fx: "local",
  out: "{ path, version, extensionId, changed, backup, clipboard, opened, steps[] }: path is <state dir>/extension; steps are the 3 manual Chrome steps. With --text: plain text with the path, extension ID and the 5 numbered steps (including Remove of an older extension and the final service start + doctor).",
  ex: [`${L} extension install`, `${L} extension install --open`],
  notes: `${BIN} Writes .version; a different existing folder is kept as extension.bak (never overwritten silently). Copies the path to the clipboard via pbcopy if present. Chrome cannot be scripted to load it: you do the steps once; later updates only need Reload.`,
  opts: { open: B("Also open chrome://extensions in Google Chrome (best effort, never fails)."), text: TEXT },
};
SERVICE_DEFS["extension path"] = { d: "Print the stable folder to select in Chrome 'Load unpacked'.", fx: "read", out: "{ path, installed }.", ex: [`${L} extension path`], notes: BIN };
SERVICE_DEFS.doctor = {
  d: "Diagnose the install: versions, permissions, service, port, extension connection and files, halt state, Chrome.", fx: "read",
  out: "{ ok, checks: [{ name, ok, detail, fix }] }; exit code 1 if any check fails.", ex: [`${L} doctor`],
  notes: "Read-only. Each failed check carries a concrete fix. Compatibility = same major.minor between CLI and extension. With --text: one line per check, [ok] or [FAIL] name: detail, an indented fix: line for each failure, and a verdict line (exit code is still 1 on failure).",
  opts: { text: TEXT },
};
SERVICE_DEFS.update = {
  d: "Update the binary and the extension folder from the release source (update_url), then restart the service if idle.", fx: "local",
  out: "{ current, latest, updateAvailable, updated, binary, extension, service, extensionReload } (--check: only the first three). With --text: a short sentence summary instead.",
  ex: [`${L} update --check`, `${L} update`],
  notes: `Release source: update_url, default the GitHub latest release (override: ${L} config set update_url URL, or env LINKEDIN_CLI_UPDATE_URL): a base URL serving latest.json. Downloads are verified with sha256; the previous binary stays as <binary>.old. The service is restarted, and the extension told to reload, only when no job is running; otherwise it is reported and skipped (run service stop/start later). Only works for the compiled binary.`,
  opts: { check: B("Only compare versions; change nothing."), text: TEXT },
};

export const GROUP_DESC: Record<string, string> = {
  service: "Control the local background service (queue, budget, link to the Chrome extension).",
  config: "Persistent CLI settings (service port, update_url).",
  extension: "Install the bundled Chrome extension into a stable folder.",
  doctor: "Check that everything is installed and connected.",
  update: "Update the binary and extension from the release source.",
  post: "Publish, schedule, list and search LinkedIn posts.",
  people: "Search people, read profiles, send connection invitations.",
  message: "Read and send LinkedIn messages.",
  comment: "Read, add, reply to and like comments.",
  job: "Search jobs, read postings, save them, view the job tracker.",
  notification: "Read LinkedIn notifications.",
  invitation: "List, answer and withdraw connection invitations.",
  browser: "Low-level control of the selected LinkedIn tab.",
  tabs: "Choose which Chrome tab actions run in.",
  queue: "Background action queue: enqueue, inspect, cancel.",
};

export const GROUPS: Record<string, string[]> = {};
// Single-word commands (doctor, update) are their own group with no subcommands.
export const SINGLE = new Set<string>();
for (const k of Object.keys(SERVICE_DEFS)) { const [g, c] = k.split(" ") as [string, string | undefined]; if (c) (GROUPS[g] ??= []).push(c); else { SINGLE.add(g); GROUPS[g] = []; } }
for (const k of Object.keys(DEFS)) { const [g, c] = k.split(" ") as [string, string]; (GROUPS[g] ??= []).push(c); }
// Aliases resolve but are not advertised.
const ALIASES: Record<string, string> = {};
for (const [k, d] of Object.entries(DEFS)) for (const a of d.alias ?? []) ALIASES[`${k.split(" ")[0]} ${a}`] = k;

export const resolve = (group: string, cmd: string) => { const k = ALIASES[`${group} ${cmd}`] ?? `${group} ${cmd}`; return Object.hasOwn(DEFS, k) ? { key: k, def: DEFS[k]! } : undefined; };

const usage = (m: string): never => { throw new CliError("USAGE", m); };
const camel = (s: string) => s.replace(/-(\w)/g, (_, c) => c.toUpperCase());

const hasConfirm = (def: Def) => (def.tool ? needsConfirm(def.tool) : def.method === "enqueue");

export function parseOptions(def: Def) {
  const opts: Record<string, any> = {};
  for (const [f, o] of Object.entries(def.opts ?? {})) opts[f] = { type: o.k === "b" ? "boolean" : "string", ...(o.k === "m" || o.k === "mn" ? { multiple: true } : {}) };
  if (hasConfirm(def)) opts.confirm = { type: "boolean" };
  return opts;
}

const range = (o: O) => (o.min !== undefined && o.max !== undefined ? ` ${o.min}..${o.max}` : "");
const num = (f: string, v: string, o: O) => {
  const n = Number(v);
  if (v.trim() === "" || !Number.isInteger(n) || n < (o.min ?? -Infinity) || n > (o.max ?? Infinity)) usage(`--${f} must be an integer${range(o)}`);
  return n;
};

// Flags -> {method, params}. Deep validation (files, lengths, targets) is the service's job.
export function build(def: Def, values: Record<string, any>, positionals: string[]): { method: string; params: object } {
  if (def.pos ? positionals.length !== 1 : positionals.length) usage(def.pos ? `Expected exactly one ${def.pos.toUpperCase()} argument` : `Unexpected argument: ${positionals[0]}`);
  for (const r of def.req ?? []) if (values[r] === undefined) usage(`--${r} is required`);
  const args: Record<string, any> = {};
  for (const [f, o] of Object.entries(def.opts ?? {})) {
    const v = values[f];
    if (v === undefined || (o.k === "b" && v === false)) continue;
    if (o.enum) for (const x of Array.isArray(v) ? v : [v]) if (!o.enum.includes(x)) usage(`--${f} must be one of ${o.enum.join("|")}`);
    args[o.as ?? camel(f)] = o.k === "n" ? num(f, v, o) : o.k === "mn" ? (v as string[]).map((x) => num(f, x, o)) : v;
  }
  if (def.pos) args[def.pos === "tool" || def.pos === "id" ? "_pos" : def.pos] = def.posNum ? num(def.pos, positionals[0]!, { k: "n", d: "" }) : positionals[0];
  const confirm = !!values.confirm;
  if (def.method === "enqueue") {
    let a: unknown = {};
    try { a = values.args === undefined ? {} : JSON.parse(values.args); } catch { usage("--args must be valid JSON"); }
    return { method: "enqueue", params: { tool: args._pos, args: a, notBefore: values["not-before"], key: values.key, confirm } };
  }
  if (def.method === "queue") return { method: "queue", params: { action: def.qaction, id: args._pos, status: args.status, limit: args.limit } };
  const final = def.fix ? def.fix(args) : args;
  return { method: "call", params: { tool: def.tool, args: final, confirm } };
}

// ---- Help data (derived from the same table) ----
export type OptSpec = { type: "string" | "number" | "boolean" | "enum"; required: boolean; repeatable: boolean; description: string; default?: string | number | boolean; min?: number; max?: number; values?: string[] };
export type Spec = {
  description: string; sideEffect: Effect; notes?: string; output: string; examples: string[]; aliases?: string[];
  positional?: OptSpec & { name: string }; options: Record<string, OptSpec>;
};

const optSpec = (o: O, required: boolean): OptSpec => ({
  type: o.enum ? "enum" : o.k === "b" ? "boolean" : o.k === "n" || o.k === "mn" ? "number" : "string",
  required, repeatable: o.k === "m" || o.k === "mn", description: o.d,
  ...(o.def !== undefined && { default: o.def }), ...(o.k === "n" && { min: o.min, max: o.max }), ...(o.enum && { values: o.enum }),
});

export function spec(key: string): Spec {
  const def = DEFS[key];
  if (!def) { const m = SERVICE_DEFS[key]!; return { description: m.d, sideEffect: m.fx, notes: m.notes, output: m.out, examples: m.ex, options: Object.fromEntries(Object.entries(m.opts ?? {}).map(([f, o]) => [f, optSpec(o, false)])) }; }
  const options: Record<string, OptSpec> = {};
  for (const [f, o] of Object.entries(def.opts ?? {})) options[f] = optSpec(o, !!def.req?.includes(f));
  if (hasConfirm(def)) options.confirm = { type: "boolean", required: false, repeatable: false, description: "Actually perform the action. Without it only a preview is returned." };
  return {
    description: def.d, sideEffect: def.fx, notes: def.notes, output: def.out, examples: def.ex, ...(def.alias && { aliases: def.alias }),
    ...(def.pos && { positional: { name: def.pos.toUpperCase(), ...optSpec({ k: def.posNum ? "n" : "s", d: def.posd ?? "" }, true) } }), options,
  };
}

export const allCommands = (): [string, Spec][] => [...Object.keys(SERVICE_DEFS), ...Object.keys(DEFS)].map((k) => [k, spec(k)]);
