// Internal action names = extension handler names (identical to linkedin-ex).
export const READ_ONLY = new Set([
  "listScheduled", "searchPeople", "getProfile", "listNotifications", "searchJobs", "getJob", "jobTracker",
  "searchPosts", "listInvitations", "listConversations", "readConversation", "listMyPosts", "getComments",
  "unansweredComments", "snapshot", "readPage", "listTabs", "useTab",
]);
// Count against the shared budget (15/h, 60/day) and the 20-30 s gap.
export const BUDGET = new Set(["post", "schedule", "connect", "sendMessage", "replyComment", "commentPost", "likeComment"]);
// Need --confirm and honour the budget/gap but cannot be classified, so they are checked, never counted.
export const CHECK_ONLY = new Set(["click", "type"]);
export const CONFIRM_ONLY = new Set(["deleteScheduled", "respondInvitation", "withdrawInvitation", ...CHECK_ONLY]);
export const HANDLERS = new Set([...READ_ONLY, "saveJob", ...BUDGET, ...CONFIRM_ONLY]);
export const needsConfirm = (t: string) => BUDGET.has(t) || CONFIRM_ONLY.has(t);
export const isOutward = (t: string) => !READ_ONLY.has(t); // state semantics: never auto-retried
export const DID_OUTWARD = (r: any) => r?.ok === true || ["invited", "sent", "replied", "commented", "liked"].includes(r?.status);
