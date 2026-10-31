// Exit codes (documented in README.md). Success is always JSON on stdout; errors are JSON on stderr: {"error":{"code","message",...}}.
export const EXIT_CODES = {
  OK: 0,
  FAILED: 1, // extension reported an error, cancelled job, internal error, service already running
  USAGE: 2, // bad flags/arguments, validation failure (INVALID), unknown job (NOT_FOUND)
  SERVICE_UNAVAILABLE: 3, // service not running, unreachable or token rejected
  UNVERIFIED: 4, // outcome unknown: the action may have happened; check LinkedIn, do not retry blindly
  HALTED: 5, // checkpoint/captcha/login wall; fix in Chrome, then `linkedin service resume`
  RATE_LIMIT: 6, // shared budget (15/h, 60/day) or invitation cap (20/24h) exhausted; error.retryAt is epoch ms
  EXTENSION_UNAVAILABLE: 7, // extension not connected or version incompatible
  PORT_IN_USE: 8, // service port is held by another process; change it with `linkedin config set port N`
} as const;

const BY_CODE: Record<string, number> = {
  EXTENSION_ERROR: 1, CANCELLED: 1, INTERNAL: 1, ALREADY_RUNNING: 1,
  USAGE: 2, INVALID: 2, NOT_FOUND: 2,
  SERVICE_UNAVAILABLE: 3, UNAUTHORIZED: 3,
  UNVERIFIED: 4, HALTED: 5, RATE_LIMIT: 6,
  EXTENSION_NOT_CONNECTED: 7, VERSION_MISMATCH: 7, PORT_IN_USE: 8,
};

export class CliError extends Error {
  constructor(public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
  get exit() { return BY_CODE[this.code] ?? 1; }
  toJSON() { return { error: { code: this.code, message: this.message, ...this.extra } }; }
}
export const fail = (code: string, message: string, extra?: Record<string, unknown>): never => { throw new CliError(code, message, extra); };

// A normal result (stdout, JSON) that still wants a non-zero exit code, e.g. a failed `doctor`.
export class WithExit { constructor(readonly value: unknown, readonly code: number) {} }
