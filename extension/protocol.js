// Pure protocol helpers. Classic script: importScripts() in the service worker, <script> in the popup,
// require() in node tests (hence the guarded module.exports; no "type":"module" anywhere in the extension).
const DEFAULT_PORT = 47851;

// Integer 1024-65535 (number or digit string), else null.
function parsePort(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1024 && n <= 65535 ? n : null;
}

const wsUrl = (port) => `ws://127.0.0.1:${parsePort(port) ?? DEFAULT_PORT}/ext`;

// Compatible = same major.minor (patch may differ).
function compatible(a, b) {
  const mm = (v) => /^(\d+)\.(\d+)(?:\.|$)/.exec(String(v ?? ''))?.slice(1, 3).join('.');
  return !!mm(a) && mm(a) === mm(b);
}

const helloMsg = (version, extensionId) => ({ type: 'hello', version, extensionId });

// What the extension must do with one message from the service. Pure: background.js applies the effects.
//   { reply?, set?, remove?, badge?, block?, dispatch? }
function onServerMessage(msg, extVersion) {
  switch (msg?.type) {
    case 'ping':
      return { reply: { type: 'pong' } };
    case 'hello': {
      const ok = compatible(extVersion, msg.version);
      return ok
        ? { set: { cli_serverVersion: msg.version }, remove: ['cli_rejected'] }
        : { set: { cli_serverVersion: msg.version, cli_rejected: { serverVersion: msg.version, at: Date.now() } }, badge: '!', block: true };
    }
    case 'reject':
      return { set: { cli_serverVersion: msg.serverVersion ?? null, cli_rejected: { reason: msg.reason, serverVersion: msg.serverVersion ?? null, at: Date.now() } }, badge: '!', block: true };
    case 'resume':
      return { remove: ['cli_halted'] };
    default:
      return { dispatch: true }; // a call: {id, tool, args}
  }
}

// The service asks the extension to reload itself ({type:'reload'}); no reply.
const shouldReload = (msg) => msg?.type === 'reload';

// Reply to a call. A HALT error carries code + reason so the service can park the queue.
function errorReply(id, e) {
  const r = { id, error: String(e?.message || e) };
  if (e?.code === 'HALT') { r.code = 'HALT'; r.reason = e.reason; }
  return r;
}

function haltError(reason) {
  return Object.assign(new Error(`HALT: ${reason}`), { code: 'HALT', reason });
}

if (typeof module !== 'undefined') module.exports = { DEFAULT_PORT, parsePort, wsUrl, compatible, helloMsg, onServerMessage, shouldReload, errorReply, haltError };
