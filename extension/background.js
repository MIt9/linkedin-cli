// LinkedIn CLI Bridge — service worker.
// Talks to the local CLI service over WebSocket and drives LinkedIn through
// chrome.debugger (CDP), so every click/keystroke is a trusted browser input event.

importScripts('protocol.js');
const FEED_URL = 'https://www.linkedin.com/feed/';

// ---------- WebSocket link to CLI service ----------

let ws = null;

// Must equal the CLI package.json "version"; bump both together on every change.
const VERSION = chrome.runtime.getManifest().version;

let connecting = false;

// Port is read on every attempt, so a changed `cli_port` applies on the next (re)connect.
async function connect() {
  if (connecting || (ws && ws.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  let url;
  try {
    url = wsUrl((await chrome.storage.local.get('cli_port')).cli_port);
  } finally {
    connecting = false;
  }
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  const sock = (ws = new WebSocket(url));
  sock.onopen = () => {
    setConnected(true);
    sock.send(JSON.stringify(helloMsg(VERSION, chrome.runtime.id)));
  };
  let blocked = false; // set by reject / incompatible hello: no call is dispatched on this socket
  sock.onmessage = async ({ data }) => {
    const msg = JSON.parse(data);
    if (shouldReload(msg)) return chrome.runtime.reload();
    const fx = onServerMessage(msg, VERSION);
    if (fx.reply) return sock.send(JSON.stringify(fx.reply));
    if (fx.block) blocked = true;
    if (fx.badge || fx.set || fx.remove) {
      if ('block' in fx) mismatch = true;
      else if (msg.type === 'hello') mismatch = false;
      if (fx.set) await chrome.storage.local.set(fx.set);
      if (fx.remove) await chrome.storage.local.remove(fx.remove);
      setBadge(mismatch ? '!' : 'on');
      return;
    }
    if (blocked) return sock.send(JSON.stringify({ id: msg.id, error: 'version_mismatch' }));
    const logId = await logStart(msg.tool, msg.args || {});
    try {
      const handler = handlers[msg.tool];
      if (!handler) throw new Error(`Unknown tool: ${msg.tool}`);
      const result = await handler(msg.args || {});
      await logEnd(logId, { status: 'ok', result: summarizeResult(result) });
      sock.send(JSON.stringify({ id: msg.id, result }));
    } catch (e) {
      const reply = errorReply(msg.id, e);
      await logEnd(logId, { status: 'error', error: reply.error });
      sock.send(JSON.stringify(reply));
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    setConnected(false);
  };
}

// ---------- Status + history (shown in popup) ----------

const HISTORY_MAX = 100;

// A version mismatch (reject, or incompatible hello) keeps the '!' badge and server version across disconnects
// until a compatible hello clears cli_rejected.
let mismatch = false;
chrome.storage.local.get('cli_rejected').then(({ cli_rejected }) => { mismatch = !!cli_rejected; if (mismatch) setBadge('!'); });

function setBadge(text) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: text === '!' ? '#d93025' : text === 'on' ? '#1e8e3e' : '#9aa0a6' });
}

function setConnected(on) {
  chrome.storage.local.set({ cli_connected: on, cli_connectedChangedAt: Date.now(), ...(on || mismatch ? {} : { cli_serverVersion: null }) });
  setBadge(mismatch ? '!' : on ? 'on' : 'off');
}

// History writes are read-modify-write; serialize them so parallel tools don't drop entries.
let historyChain = Promise.resolve();
function mutateHistory(fn) {
  historyChain = historyChain.then(async () => {
    const { cli_history: history = [] } = await chrome.storage.local.get('cli_history');
    await chrome.storage.local.set({ cli_history: fn(history).slice(0, HISTORY_MAX) });
  }).catch(() => {});
  return historyChain;
}

function summarizeArgs(a) {
  const parts = [];
  if (a.text) parts.push(a.text.replace(/\s+/g, ' ').slice(0, 80));
  if (a.media?.length) parts.push(`${a.media.length} media`);
  if (a.at) parts.push(`at ${a.at}`);
  if (a.when) parts.push(a.when);
  if (a.label) parts.push(`"${[].concat(a.label).join('|')}"`);
  for (const k of ['keywords', 'title', 'company', 'profile', 'name', 'post']) if (a[k]) parts.push(a[k]);
  if (a.page > 1) parts.push(`page ${a.page}`);
  if (a.note) parts.push(`note: ${a.note.slice(0, 60)}`);
  return parts.join(' · ');
}

function summarizeResult(r) {
  if (Array.isArray(r)) return `${r.length} items`;
  if (r?.results && 'withdrawn' in r) return `withdrawn ${r.withdrawn}/${r.results.length}`;
  if (r?.results) return `${r.results.length} people`;
  if (r?.status) return `${r.status}: ${r.name || r.to || r.profile || r.id || ''}${r.noteSent ? ' (with note)' : ''}`;
  if (r?.messages) return `${r.messages.length} messages`;
  if (r?.threads) return `${r.threads.length} threads`;
  if (r?.sections) return `profile: ${r.name}`;
  if (r?.scheduledFor) return `scheduled for ${r.scheduledFor}`;
  if (r?.postedAt) return 'posted';
  if (r?.deleted) return `deleted ${r.deleted}`;
  return '';
}

async function logStart(tool, args) {
  const id = crypto.randomUUID();
  await mutateHistory((h) => [{ id, tool, summary: summarizeArgs(args), startedAt: Date.now(), status: 'running' }, ...h]);
  return id;
}

function logEnd(id, patch) {
  return mutateHistory((h) => h.map((e) => (e.id === id ? { ...e, ...patch, endedAt: Date.now() } : e)));
}

// A service worker restart kills in-flight work.
mutateHistory((h) => h.map((e) => (e.status === 'running' ? { ...e, status: 'error', error: 'Interrupted (extension restarted)' } : e)));

// ---------- CDP helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.random() * (max - min));
const cdp = (target, method, params) => chrome.debugger.sendCommand(target, method, params);

// The debugger stays attached between calls; after a tab closes or the user presses Cancel on the
// infobar, onDetach drops it and the next attach() re-attaches.
const attached = new Set();
chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));

async function attach(tabId) {
  if (attached.has(tabId)) return { tabId };
  await chrome.debugger.attach({ tabId }, '1.3');
  attached.add(tabId);
  return { tabId };
}

function nextEvent(target, method, timeout) {
  return new Promise((resolve, reject) => {
    const on = (src, m, params) => {
      if (src.tabId === target.tabId && m === method) { done(); resolve(params); }
    };
    const timer = setTimeout(() => { done(); reject(new Error(`${method} not received`)); }, timeout);
    const done = () => { clearTimeout(timer); chrome.debugger.onEvent.removeListener(on); };
    chrome.debugger.onEvent.addListener(on);
  });
}

// Runs inside the page. Walks the DOM including shadow roots.
// spec: { label: string|string[], exact?: bool } -> buttons/links by aria-label or text
//       { editor: true }                         -> post text editor (ProseMirror role=textbox)
//       { input: 'Date' }                        -> form control of the <label> with that text
//       { selector: 'svg#x' }                    -> nearest clickable ancestor of a CSS match
//       { list: true }                           -> snapshot of visible interactive elements
//       { scheduled: true }                      -> [{ when, text }] from the "Scheduled (N)" list
//       { scheduledMenu: 'Thu, Oct 15, 2026 at 7:45 AM' } -> the "⋯" button of exactly that post
//       { people: true }                         -> people search result cards
//       { profile: true }                        -> { name, top, actions, sections, details } of a profile page
//       { text: true }                           -> cleaned lines of <main> (details pages)
//       { scroll: true }                         -> { atBottom, height } of the page
//       { field: true }                          -> last visible textarea/text input
// Modifiers: dialog: true -> only inside the topmost dialog; first: true -> first match instead of last.
function pageFind(spec) {
  let all = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); }
  };
  walk(document);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const name = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || '').trim();
  const clickable = (el) => el.matches('button,a,[role=button],[role=menuitem],[role=option],[role=tab]');
  const isEditor = (el) => el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox';
  // LinkedIn repeats text in visually-hidden spans, so drop adjacent duplicate lines.
  const lines = (el) => el.innerText.split('\n').map((l) => l.trim()).filter((l, i, a) => l && l !== a[i - 1]);
  const profilePath = (a) => {
    // Malformed hrefs (and SVG <a>, whose href isn't a string) throw in new URL; skip them.
    const m = URL.parse?.(String(a.getAttribute('href') || ''), location.href)?.pathname.match(/^\/in\/[^/]+\/?$/);
    return m && m[0].replace(/\/?$/, '/');
  };

  let dlg = null;
  if (spec.dialog) {
    dlg = all.filter((el) => el.matches('[role=dialog],[role=alertdialog],dialog') && visible(el)).at(-1);
    if (!dlg) return null;
    all = all.filter((el) => dlg.contains(el));
  }

  // Security check / restriction / limit notices. Only dialogs, headings and short (interstitial)
  // pages are scanned, so a post that merely mentions these words doesn't trip it.
  if (spec.danger) {
    const DANGER = /quick security check|let'?s (do a quick|confirm it'?s you)|verify (that )?you'?re (a )?human|unusual activity|restricted your account|account (has been |is )?(temporarily )?restricted|reached the weekly invitation limit|weekly invitation limit|you'?ve reached the limit|sign in to (continue|linkedin)|join linkedin/i;
    // Normal pages carry a hidden 0x0 reCAPTCHA iframe; only a shown challenge counts.
    if (all.some((el) => el.tagName === 'IFRAME' && /captcha|challenge|arkose/i.test(el.src || '') && visible(el)
      && el.getBoundingClientRect().width >= 100 && el.getBoundingClientRect().height >= 50)) return 'captcha challenge';
    const sources = [
      ...all.filter((el) => el.matches('[role=dialog],[role=alertdialog],dialog,h1,h2,[role=alert]') && visible(el)),
      ...(document.body.innerText.length < 3000 ? [document.body] : []),
    ];
    for (const el of sources) {
      const m = (el.innerText || '').match(DANGER);
      if (m) return m[0];
    }
    return null;
  }

  if (spec.scroll) {
    const s = document.scrollingElement;
    return { atBottom: s.scrollTop + innerHeight >= s.scrollHeight - 5, height: s.scrollHeight };
  }

  if (spec.text) return lines(dlg || document.querySelector('main') || document.body);

  if (spec.people) {
    // Card = widest ancestor of an action button that holds only that one button; profile = its first /in/ link.
    // Buttons are matched by visible text: aria-labels vary ("Send a message to X", "Invite X to connect"),
    // and mutual-connection links are /in/ links too, so links alone can't delimit cards.
    const main = document.querySelector('main') || document.body;
    const ACTION = /^(Connect|Message|Follow|Following|Pending)$/;
    const actions = all.filter((el) => main.contains(el) && clickable(el) && visible(el) && ACTION.test((el.innerText || '').trim()));
    const count = (el) => actions.filter((b) => el.contains(b)).length;
    const seen = new Set();
    return actions.map((btn) => {
      let card = btn;
      // Stop at the list item, else a single result swallows the whole page (footer included).
      while (card.parentElement && card.parentElement !== main && !card.matches('li,[role=listitem]')
        && count(card.parentElement) === 1) card = card.parentElement;
      const path = [...card.querySelectorAll('a')].map(profilePath).find(Boolean);
      if (!path || seen.has(path)) return null;
      seen.add(path);
      const text = lines(card);
      return {
        name: text[0]?.split('•')[0].trim(),
        profile: `https://www.linkedin.com${path}`,
        action: btn.innerText.trim(),
        lines: text.filter((l) => !ACTION.test(l)),
      };
    }).filter(Boolean);
  }

  if (spec.profile) {
    const main = document.querySelector('main') || document.body;
    const secs = [...main.querySelectorAll('section')]
      .map((s) => ({ s, h: (s.querySelector('h1,h2')?.innerText || '').trim() }))
      .filter((x) => x.h);
    if (!secs.length) return null;
    const top = secs[0];
    const skip = /^(People you may know|You might like|More profiles|People also viewed|Ad Options|Don’t want to see this|Activity|Connected apps)/;
    const sections = {};
    const details = [];
    for (const { s, h } of secs.slice(1)) {
      if (h === top.h || skip.test(h) || sections[h]) continue;
      sections[h] = lines(s).slice(1);
      for (const a of s.querySelectorAll('a[href*="/details/"]')) details.push(new URL(a.href).pathname);
    }
    return {
      name: top.h,
      top: lines(top.s),
      actions: [...top.s.querySelectorAll('button,a')].filter(visible).map(name).filter(Boolean),
      sections,
      details: [...new Set(details)],
    };
  }

  if (spec.profileAction) {
    // The sticky header repeats Message/Follow/More (hidden under the nav bar), so take the button
    // closest to the visible top-card name heading. Matched by visible text: aria-labels vary.
    const want = spec.profileAction.toLowerCase();
    const main = document.querySelector('main') || document.body;
    const heading = [...main.querySelectorAll('h1,h2')].find(visible);
    let el = null;
    for (let p = heading?.parentElement; p && p !== main.parentElement && !el; p = p.parentElement) {
      el = [...p.querySelectorAll('button,a,[role=button]')]
        .find((b) => visible(b) && [b.innerText, b.getAttribute('aria-label')].some((t) => (t || '').trim().toLowerCase() === want));
    }
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }

  const center = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  };
  const txt = (root, sel) => (root.querySelector(sel)?.innerText || '').replace(/\s+/g, ' ').trim();
  const textBox = (el) => (el.querySelector('[data-testid=expandable-text-box]')?.innerText || '').trim();
  const timeOf = (el) => ([...el.querySelectorAll('*')]
    .find((e) => e.childElementCount === 0 && /^(now|\d+(s|m|h|d|w|mo|y))\b/.test((e.innerText || '').trim()))?.innerText || '').trim();
  const isComment = (el) => el.id?.startsWith('replaceableComment_urn:li:comment:');

  // Messaging list (/messaging/). { conversations: true } -> items; { conversation: 'Name' } -> click target.
  if (spec.conversations || spec.conversation) {
    // Virtualized list: off-screen items are empty "--occluded" shells.
    const items = all.filter((el) => el.matches('li.msg-conversation-listitem') && visible(el)
      && !el.matches('.msg-conversation-card--occluded') && el.innerText.trim()).map((li) => ({
      li,
      name: txt(li, '.msg-conversation-listitem__participant-names'),
      time: txt(li, 'time'),
      snippet: txt(li, '.msg-conversation-card__message-snippet'),
      unread: /unread/.test(li.className) || !!li.querySelector('[class*="--unread"]'),
    }));
    if (spec.conversations) {
      // Wheel over the list's scroll container: the last rendered item is usually below the fold.
      let box = items.at(-1)?.li;
      while (box && !(box.scrollHeight > box.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(box).overflowY))) {
        box = box.parentElement;
      }
      if (!items.length) return null; // keeps waitFor polling until the list renders
      return { items: items.map(({ li, ...rest }) => rest), wheel: box ? center(box) : null };
    }
    const hits = items.filter((i) => i.name.toLowerCase() === spec.conversation.toLowerCase());
    if (hits.length > 1) return { error: `${hits.length} conversations named "${spec.conversation}"` };
    if (!hits.length) return null;
    const link = hits[0].li.querySelector('.msg-conversation-listitem__link') || hits[0].li;
    link.scrollIntoView({ block: 'center' });
    return center(link);
  }

  // Open chat (full /messaging/ page or the overlay bubble, which lives in a shadow root).
  // Sender/time are printed only on the first message of a group, so carry them forward.
  if (spec.chat) {
    const editor = all.filter((el) => el.matches('.msg-form__contenteditable') && visible(el)).at(-1);
    if (!editor) return null;
    let box = editor;
    while (box && !box.querySelector?.('.msg-s-message-list')) box = box.parentElement;
    if (!box) return null;
    const list = box.querySelector('.msg-s-message-list');
    let from = '';
    let date = '';
    let time = '';
    const messages = [];
    for (const ev of box.querySelectorAll('.msg-s-message-list__event')) {
      date = txt(ev, '.msg-s-message-list__time-heading') || date; // day heading sits inside the event
      from = txt(ev, '.msg-s-message-group__name') || from;
      time = txt(ev, '.msg-s-message-group__timestamp') || time;
      const bodies = [...ev.querySelectorAll('.msg-s-event-listitem__body')].map((b) => b.innerText.trim());
      const text = bodies.join('\n') || (ev.querySelector('.msg-s-event-listitem__attachment-item, img, a[download]') ? '[attachment]' : '');
      if (text) messages.push({ from, date, time, text });
    }
    const send = [...box.querySelectorAll('button')].find((b) => visible(b) && /^send$/i.test(b.innerText.trim()) && !b.disabled);
    // Header with the other person's name sits beside the list, a few levels up.
    let title = '';
    for (let p = box, i = 0; p && !title && i < 6; p = p.parentElement, i++) {
      title = txt(p, '.msg-entity-lockup__entity-title, .msg-overlay-bubble-header__title, h2');
    }
    return {
      title,
      messages,
      editor: center(editor),
      editorText: editor.innerText.trim(),
      formText: (editor.closest('form') || box).innerText, // composer incl. attachment chip
      uploading: !!(editor.closest('form') || box).querySelector('[role=progressbar], progress'),
      wheel: center(list),
      atTop: list.scrollTop <= 0,
      send: send ? center(send) : null,
    };
  }

  // Invitation manager. { invitations: true } -> cards; { invitationAction: { profile, label } } -> its button.
  // Card = widest ancestor of its primary button (Accept on Received, Withdraw on Sent) holding only that one.
  if (spec.invitations || spec.invitationAction) {
    const main = document.querySelector('main') || document.body;
    const vtext = (el) => (el.innerText || '').trim();
    const primary = all.filter((el) => main.contains(el) && clickable(el) && visible(el) && /^(Accept|Withdraw)$/.test(vtext(el)));
    const count = (el) => primary.filter((b) => el.contains(b)).length;
    const cards = primary.map((btn) => {
      let card = btn;
      while (card.parentElement && card.parentElement !== main && count(card.parentElement) === 1) card = card.parentElement;
      const path = [...card.querySelectorAll('a')].map(profilePath).find(Boolean);
      return path && { card, path };
    }).filter(Boolean);
    if (spec.invitations) {
      return cards.map(({ card, path }) => {
        const text = lines(card).filter((l) => !/^(Accept|Ignore|Withdraw)$/.test(l));
        return {
          name: text[0],
          profile: `https://www.linkedin.com${path}`,
          sent: text.find((l) => /^Sent /.test(l)) || null,
          lines: text.slice(1).filter((l) => !/^Sent /.test(l)),
        };
      });
    }
    const { profile, label } = spec.invitationAction;
    const hit = cards.find((c) => c.path === new URL(profile, location.href).pathname.replace(/\/?$/, '/'));
    if (!hit) return null;
    const b = [...hit.card.querySelectorAll('button,a,[role=button]')].find((x) => visible(x) && vtext(x) === label);
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    return center(b);
  }

  // Jobs search list: cards delimited by dismiss buttons, data-(occludable-)job-id, or /jobs/view/ links.
  if (spec.jobs) {
    const main = document.querySelector('main') || document.body;
    const candidates = all.filter((el) => main.contains(el) && (
      (el.tagName === 'BUTTON' && /^Dismiss .+ job$/.test(el.getAttribute('aria-label') || ''))
      || el.hasAttribute('data-occludable-job-id')
      || el.hasAttribute('data-job-id')
      || (el.matches('li, [role=listitem]') && el.querySelector('a[href*="/jobs/view/"]'))
    ));
    const raw = candidates.length ? candidates : all.filter((el) => main.contains(el) && el.tagName === 'A' && (el.href || '').includes('/jobs/view/'));
    const count = (el) => raw.filter((d) => el.contains(d)).length;
    let box = raw.at(-1);
    while (box && !(box.scrollHeight > box.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    const seen = new Set();
    const items = raw.map((b) => {
      let card = b.closest('li, [role=listitem], [data-occludable-job-id], [data-job-id]');
      if (!card) {
        card = b;
        while (card.parentElement && card.parentElement !== main && count(card.parentElement) === 1) card = card.parentElement;
      }
      const id = [card, ...card.querySelectorAll('[data-job-id],[data-occludable-job-id],[componentkey],a[href*="/jobs/view/"]')]
        .map((e) => (e.getAttribute('data-job-id') || e.getAttribute('data-occludable-job-id') || e.getAttribute('componentkey') || e.href)?.match(/(?:jobs\/view\/|job-card-component-ref-|^)(\d{6,})/)?.[1])
        .find(Boolean);
      if (!id || seen.has(id)) return null;
      seen.add(id);
      const text = lines(card).filter((l) => !/^(Selected, )?.+\(Verified job\)$/.test(l));
      return {
        id,
        url: `https://www.linkedin.com/jobs/view/${id}/`,
        title: text[0],
        company: text[1],
        location: text[2],
        posted: text.find((l) => /^Posted /.test(l))?.replace(/^Posted /, '') || null,
        extra: text.slice(3).filter((l) => !/^Posted |ago$|^·$/.test(l)),
      };
    }).filter(Boolean);
    if (items.length) return { items, wheel: box ? center(box) : null };
    const empty = /no (matching )?jobs|\b0 results|\b0 jobs|no (exact )?match|no results|(couldn|didn)'?t find any jobs|try (searching|clearing|different|removing)|check the spelling|search other jobs/i.test(main.innerText);
    return empty ? { items: [], wheel: null } : null; // null keeps waitFor polling
  }

  // Job tracker (/jobs-tracker/?stage=...): one card per /jobs/view/ link. null while loading, [] when empty.
  if (spec.tracker) {
    const main = document.querySelector('main') || document.body;
    const links = [...main.querySelectorAll('a[href*="/jobs/view/"]')];
    const idOf = (a) => a.href.match(/jobs\/view\/(\d+)/)?.[1];
    if (!links.length) return /No jobs here/.test(main.innerText) ? [] : null;
    const seen = new Set();
    return links.map((a) => {
      const id = idOf(a);
      if (!id || seen.has(id)) return null;
      seen.add(id);
      let card = a;
      while (card.parentElement && card.parentElement !== main
        && !links.some((x) => idOf(x) !== id && card.parentElement.contains(x))) card = card.parentElement;
      // Tracker cards are inline spans (innerText has no line breaks), so read each element's own text nodes.
      const text = [...card.querySelectorAll('*')]
        .map((e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim())
        .filter((l, i, a) => l && l !== a[i - 1] && !/^(Notes|Add note|Did you hear back\?|Yes|No|\+\d+|·)$/.test(l));
      return { id, url: `https://www.linkedin.com/jobs/view/${id}/`, title: text[0], details: text.slice(1) };
    }).filter(Boolean);
  }

  // Job page: top card lines, every h2 section (About the job is the full description), save/apply state.
  if (spec.job) {
    const main = document.querySelector('main') || document.body;
    const sections = {};
    for (const h of main.querySelectorAll('h2')) {
      const title = h.innerText.trim();
      if (!/^(About the (job|company)|People you can reach out to)$/i.test(title)) continue;
      let sec = h.parentElement;
      while (sec && sec !== main && lines(sec).length < 3) sec = sec.parentElement;
      sections[title] = lines(sec).slice(1).join('\n');
    }
    const btn = (re) => [...main.querySelectorAll('button,a')].find((b) => visible(b) && re.test((b.innerText || '').trim()));
    const apply = btn(/^(Easy Apply|Apply)$/);
    const saveBtn = btn(/^(Save|Saved|Unsave)$/);
    return {
      top: lines(main).slice(0, 12),
      sections,
      easyApply: /easy apply/i.test(apply?.innerText || ''),
      applyUrl: apply?.tagName === 'A' ? apply.href : null,
      saved: saveBtn ? /^(Saved|Unsave)$/.test(saveBtn.innerText.trim()) : null,
      save: saveBtn && saveBtn.innerText.trim() === 'Save' ? center(saveBtn) : null,
    };
  }

  // Notifications page: each notification has its own "More options" button.
  if (spec.notifications) {
    const main = document.querySelector('main') || document.body;
    const menus = all.filter((el) => main.contains(el) && el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'More options');
    const count = (el) => menus.filter((m) => el.contains(m)).length;
    const KINDS = [
      ['reply', /replied to/i], ['mention', /mentioned you/i], ['comment', /commented on/i],
      ['reaction', /reacted|liked|loves|celebrat|support/i], ['view', /viewed your profile|appeared in/i],
      ['invite', /invit|accepted/i], ['job', /job|opportunit|hiring/i], ['post', /posted|shared|reposted/i],
    ];
    return menus.map((b) => {
      let card = b;
      while (card.parentElement && card.parentElement !== main && count(card.parentElement) === 1) card = card.parentElement;
      const text = lines(card);
      const links = [...card.querySelectorAll('a')].map((a) => new URL(a.href, location.href));
      // Post link is either a /feed/update|/posts path, or /feed/?highlightedUpdateUrn=... (reply notifications).
      const post = links.find((u) => /urn:li:(activity|ugcPost|share)|\/posts\//.test(u.pathname) || u.searchParams.has('highlightedUpdateUrn'));
      const hl = post?.searchParams.get('highlightedUpdateUrn');
      const actor = links.map((u) => u.pathname.match(/^\/in\/[^/]+\//)?.[0]).find(Boolean);
      return {
        kind: (KINDS.find(([, re]) => re.test(text[0] || '')) || ['other'])[0],
        text: text[0],
        details: text.slice(1, 4),
        time: timeOf(card),
        actor: actor ? `https://www.linkedin.com${actor}` : null,
        post: hl ? `https://www.linkedin.com/feed/update/${hl}/` : post ? `https://www.linkedin.com${post.pathname}` : null,
        commentUrn: post?.searchParams.get('replyUrn') || post?.searchParams.get('commentUrn') || null,
      };
    });
  }

  // ---- Posts & comments (new obfuscated UI: rely on ids, aria-labels, data-testid) ----

  // Activity feed cards: { posts: true } -> [{ url, text, time, reactions, comments }]
  if (spec.posts) {
    // English posts have no translatable-commentary id; React props keep the urn in stateKey values
    // like "reactionsCount-urn:li:ugcPost:N". Works because we evaluate in the page world via CDP.
    // ponytail: depends on React internals; replace if LinkedIn exposes the urn in the DOM again.
    const fiberUrn = (card) => {
      for (const el of card.querySelectorAll('span, a')) {
        const k = Object.keys(el).find((x) => x.startsWith('__reactFiber'));
        for (let f = k && el[k], i = 0; f && i < 4; f = f.child, i++) {
          const m = String(f.pendingProps?.stateKey || '').match(/urn:li:(?:activity|share|ugcPost):\d+/);
          if (m) return m[0];
        }
      }
      return null;
    };
    const main = document.querySelector('main') || document.body;
    const ctl = all.filter((el) => main.contains(el) && /^Open control menu for post/.test(el.getAttribute('aria-label') || ''));
    const count = (el) => ctl.filter((c) => el.contains(c)).length;
    const seen = new Set();
    return ctl.map((b) => {
      let card = b;
      while (card.parentElement && card.parentElement !== main && count(card.parentElement) === 1) card = card.parentElement;
      // Reactions feed has no activity links; the post id sits in the translatable-commentary id.
      const tr = card.querySelector('[id^="translatable-commentary"]')?.id || '';
      const urn = [...card.querySelectorAll('a')].map((a) => a.href.match(/urn:li:activity:\d+/)?.[0]).find(Boolean)
        || tr.match(/shareId=(\d+)/)?.[1]?.replace(/^/, 'urn:li:share:')
        || tr.match(/userGeneratedContentId=(\d+)/)?.[1]?.replace(/^/, 'urn:li:ugcPost:')
        || fiberUrn(card);
      // Content search cards carry no post id at all: url stays null, dedupe by text.
      const key = urn || textBox(card).slice(0, 200);
      if (!key || seen.has(key)) return null;
      seen.add(key);
      const num = (re) => Number(([...card.querySelectorAll('button')].find((x) => re.test(x.getAttribute('aria-label') || ''))
        ?.innerText.replace(/\D/g, '')) || 0);
      const link = [...card.querySelectorAll('a')].find(profilePath);
      return {
        url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null,
        author: (b.getAttribute('aria-label') || '').replace(/^Open control menu for post by /, ''),
        profile: link ? profilePath(link) : null,
        time: timeOf(card),
        text: textBox(card).slice(0, 1500),
        reactions: num(/^Reaction button state/),
        comments: num(/^Comment$/),
      };
    }).filter(Boolean);
  }

  // Comments on an open post, grouped into threads. Replies are not nested in the DOM; they are only
  // indented, so a comment whose avatar sits right of the leftmost one is a reply to the thread above.
  // ponytail: indentation heuristic; switch to a structural marker if LinkedIn adds one.
  if (spec.comments) {
    const items = all.filter((el) => isComment(el) && visible(el));
    const avatarX = (c) => (c.querySelector('img')?.getBoundingClientRect().x ?? 0);
    const minX = Math.min(...items.map(avatarX));
    const threads = [];
    for (const c of items) {
      const link = [...c.querySelectorAll('a')].find(profilePath);
      const head = lines(c)[0] || '';
      const item = {
        id: c.id.replace('replaceableComment_', ''),
        author: head.replace(/\s+(Verified|Premium)\s+Profile.*$/, '').replace(/\s*•?\s*(1st|2nd|3rd\+?|Author)$/, '').trim(),
        profile: link ? profilePath(link) : null,
        time: timeOf(c),
        text: textBox(c),
      };
      if (avatarX(c) > minX + 10 && threads.length) threads.at(-1).replies.push(item);
      else threads.push({ ...item, replies: [] });
    }
    return threads;
  }

  // "See previous replies" / "Load more comments" style expanders.
  if (spec.expander) {
    const el = all.find((e) => clickable(e) && visible(e)
      && /^(See previous replies|Load more comments|See more comments|Show more comments|Load more replies|Load previous replies|\d+ (more )?repl(y|ies))$/i
        .test((e.innerText || '').trim()));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    return center(el);
  }

  // Post's own comment box: the comment editor that comes before every comment (reply boxes follow theirs).
  if (spec.postEditor) {
    const firstComment = all.find(isComment);
    const ed = all.find((e) => visible(e) && isEditor(e) && /creating comment/i.test(e.getAttribute('aria-label') || '')
      && (!firstComment || (e.compareDocumentPosition(firstComment) & Node.DOCUMENT_POSITION_FOLLOWING)));
    if (!ed) return null;
    let submit = null;
    for (let p = ed.parentElement; p && !submit; p = p.parentElement) {
      submit = [...p.querySelectorAll('button')].find((x) => visible(x) && (x.innerText || '').trim() === 'Comment');
    }
    ed.scrollIntoView({ block: 'center' });
    return { editor: center(ed), text: ed.innerText.trim(), submit: submit && !submit.disabled ? center(submit) : null };
  }

  // Reply action inside one comment, the reply editor that follows it, and that editor's submit button.
  if (spec.commentReply || spec.replyEditor) {
    const c = all.find((el) => isComment(el) && el.id === `replaceableComment_${spec.commentReply || spec.replyEditor}`);
    if (!c) return null;
    if (spec.commentReply) {
      const b = [...c.querySelectorAll('button')].find((x) => visible(x) && (x.getAttribute('aria-label') || '').trim() === 'Reply');
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      return center(b);
    }
    const ed = all.find((e) => visible(e) && isEditor(e) && /creating comment|reply/i.test(e.getAttribute('aria-label') || '')
      && (c.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (!ed) return null;
    let submit = null;
    for (let p = ed.parentElement; p && !submit; p = p.parentElement) {
      submit = [...p.querySelectorAll('button')].find((x) => visible(x) && (x.innerText || '').trim() === 'Reply');
    }
    ed.scrollIntoView({ block: 'center' });
    return { editor: center(ed), text: ed.innerText.trim(), submit: submit && !submit.disabled ? center(submit) : null };
  }

  // The comment's OWN Like/Reaction button (searched inside that comment element only) and whether it is already set.
  if (spec.commentLike) {
    const c = all.find((el) => isComment(el) && el.id === `replaceableComment_${spec.commentLike}`);
    if (!c) return null;
    const re = /^(?:React\s+)?(Like|Unlike|Celebrate|Support|Love|Insightful|Funny)$/i;
    const lab = (x) => (x.getAttribute('aria-label') || x.innerText || '').trim();
    const b = [...c.querySelectorAll('button')].find((x) => visible(x) && re.test(lab(x)));
    if (!b) return null;
    const word = re.exec(lab(b))[1];
    b.scrollIntoView({ block: 'center' });
    return { ...center(b), liked: b.getAttribute('aria-pressed') === 'true' || !/^like$/i.test(word) };
  }

  if (spec.field) {
    const el = all.filter((e) => e.matches('textarea,input[type=text],input:not([type])') && visible(e)).at(-1);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }

  if (spec.list) {
    return all
      .filter((el) => visible(el) && (clickable(el) || isEditor(el) || el.matches('input,textarea')))
      .map((el) => `${el.tagName.toLowerCase()}${isEditor(el) ? '[editor]' : ''}: ${name(el).replace(/\s+/g, ' ').slice(0, 60)}`)
      .filter((s, i, a) => !s.endsWith(': ') && a.indexOf(s) === i)
      .slice(0, 300);
  }

  // Each scheduled post is an <a> holding a leaf "Posting <when>", "Feed post", the text and a "⋯" button.
  const postingLeaf = (a) => [...a.querySelectorAll('*')]
    .find((c) => c.childElementCount === 0 && c.textContent.trim().startsWith('Posting '));
  const scheduledItems = () => all.filter((el) => el.tagName === 'A' && visible(el) && postingLeaf(el));
  const whenOf = (a) => postingLeaf(a).textContent.trim().slice('Posting '.length);

  if (spec.scheduledCount) {
    // Count + center of the last item (wheel target) without scrolling anything.
    const items = scheduledItems();
    // Wheel over the list's scroll container: the last item itself is often clipped below it.
    let box = items.at(-1);
    while (box && !(box.scrollHeight > box.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(box).overflowY))) {
      box = box.parentElement;
    }
    const r = (box || items.at(-1))?.getBoundingClientRect();
    const tabText = all
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .find((t) => /^Scheduled ?\(\d+\)$/.test(t));
    return {
      count: items.length,
      total: tabText ? Number(tabText.match(/\d+/)[0]) : null,
      x: r ? r.left + r.width / 2 : 0,
      y: r ? Math.min(r.top + r.height / 2, innerHeight - 40) : 0, // pointer must be on screen
    };
  }

  if (spec.scheduled) {
    return scheduledItems().map((a) => ({
      when: whenOf(a),
      text: a.innerText.replace(postingLeaf(a).textContent, '').replace('Feed post', '').trim().slice(0, 200),
    }));
  }

  let matches;
  if (spec.scheduledMenu) {
    const items = scheduledItems().filter((a) => whenOf(a) === spec.scheduledMenu);
    if (items.length > 1) return { error: `${items.length} scheduled posts at "${spec.scheduledMenu}"` };
    matches = items
      .map((a) => [...a.querySelectorAll('[role=button],button')].find((b) => b.querySelector('svg#overflow-web-ios-small')))
      .filter(Boolean);
  } else
  if (spec.editor) {
    matches = all.filter((el) => visible(el) && isEditor(el));
  } else if (spec.input) {
    matches = all
      .filter((el) => el.tagName === 'LABEL' && el.innerText.replace('*', '').trim() === spec.input)
      // LinkedIn's labels have no `for`, so fall back to the nearest input in the label's container.
      .map((l) => {
        if (l.control) return l.control;
        for (let p = l.parentElement; p; p = p.parentElement) {
          const i = p.querySelector('input,textarea');
          if (i) return i;
        }
        return null;
      })
      .filter((el) => el && visible(el));
  } else if (spec.selector) {
    matches = all
      .filter((el) => el.matches(spec.selector))
      .map((el) => el.closest('button,a,[role=button]'))
      .filter((el) => el && visible(el));
  } else {
    const labels = [].concat(spec.label).map((l) => l.toLowerCase());
    matches = all.filter((el) => {
      if (!visible(el) || !clickable(el)) return false;
      if (spec.menuitem && el.getAttribute('role') !== 'menuitem') return false;
      const n = name(el).toLowerCase();
      return labels.some((l) => (spec.exact ? n === l : n.includes(l)));
    });
  }
  const el = spec.first ? matches[0] : matches.at(-1); // dialogs render last in the DOM
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return {
    label: name(el),
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    w: r.width,
    h: r.height,
    disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
  };
}

async function find(target, spec) {
  const { result, exceptionDetails } = await cdp(target, 'Runtime.evaluate', {
    expression: `(${pageFind})(${JSON.stringify(spec)})`,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'evaluate failed');
  return result.value;
}

async function waitFor(target, spec, timeout, { enabled = false } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const hit = await find(target, spec);
    if (hit && !(enabled && hit.disabled)) return hit;
    await sleep(500);
  }
  await assertSafe(target); // a missing element is often a security check page; report that instead
  throw new Error(`Element not found: ${JSON.stringify(spec)}`);
}

async function waitGone(target, spec, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (!(await find(target, spec))) return;
    await sleep(500);
  }
  throw new Error(`Element still visible: ${JSON.stringify(spec)}`);
}

const rand = (min, max) => min + Math.random() * (max - min);
const mousePos = new Map(); // tabId -> last {x, y}

// Moves the pointer along a curved, eased path instead of teleporting.
async function moveMouse(target, x, y) {
  const from = mousePos.get(target.tabId) || { x: rand(200, 600), y: rand(100, 400) };
  const dist = Math.hypot(x - from.x, y - from.y);
  const steps = Math.max(8, Math.min(40, Math.round(dist / 25)));
  // Control point off the straight line gives a slight arc.
  const cx = (from.x + x) / 2 + rand(-0.25, 0.25) * dist;
  const cy = (from.y + y) / 2 + rand(-0.25, 0.25) * dist;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in-out
    const px = (1 - e) ** 2 * from.x + 2 * (1 - e) * e * cx + e ** 2 * x;
    const py = (1 - e) ** 2 * from.y + 2 * (1 - e) * e * cy + e ** 2 * y;
    await cdp(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
    await sleep(rand(6, 18));
  }
  mousePos.set(target.tabId, { x, y });
}

async function click(target, el) {
  // Random point near the center, not the exact middle.
  const x = el.x + (el.w ? rand(-0.3, 0.3) * el.w / 2 : 0);
  const y = el.y + (el.h ? rand(-0.3, 0.3) * el.h / 2 : 0);
  await moveMouse(target, x, y);
  await jitter(60, 160);
  await cdp(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await jitter(40, 110);
  await cdp(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await jitter(300, 700);
}

// shift: Shift+Enter = line break in chats, where plain Enter sends.
async function pressEnter(target, { shift = false } = {}) {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: shift ? 8 : 0 };
  await cdp(target, 'Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key });
  await cdp(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

async function typeText(target, text, { shiftNewlines = false } = {}) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // ponytail: trailing space closes #hashtag/@mention typeahead so Enter doesn't pick a suggestion.
    if (/(^|\s)[#@]\S+$/.test(line)) line += ' ';
    for (const ch of line) await typeChar(target, ch);
    if (i < lines.length - 1) await pressEnter(target, { shift: shiftNewlines });
    await jitter(150, 400);
  }
}

// One keystroke per character with human-ish rhythm.
// ponytail: ~75 ms/char, so 3000 chars ≈ 4-5 min; server timeout is 20 min.
async function typeChar(target, ch) {
  if (ch.length > 1) {
    // Emoji / astral chars: no single key produces them, insert like an emoji picker would.
    await cdp(target, 'Input.insertText', { text: ch });
  } else {
    await cdp(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    await cdp(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
  await sleep(rand(30, 120));
  if (/[\s.,!?]/.test(ch) && Math.random() < 0.15) await sleep(rand(200, 600)); // occasional thinking pause
}

async function fillInput(target, spec, value) {
  await click(target, await waitFor(target, spec, 10000));
  await cdp(target, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'],
  });
  await cdp(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  for (const ch of value) await typeChar(target, ch);
  await jitter(200, 400);
}

// LinkedIn's schedule dialog wants "mm/dd/yyyy" and "h:mm AM" in the browser's local time.
function linkedinDateTime(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  const h = d.getHours() % 12 || 12;
  return {
    date: `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`,
    time: `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`,
  };
}

async function setSchedule(target, at) {
  const { date, time } = linkedinDateTime(at);
  await click(target, await waitFor(target, { selector: 'svg#clock-medium' }, 10000));
  await fillInput(target, { input: 'Date' }, date);
  await fillInput(target, { input: 'Time' }, time);
  await click(target, await waitFor(target, { label: 'Confirm', exact: true }, 10000, { enabled: true }));
  await sleep(1000);
  if (await find(target, { input: 'Date' })) throw new Error(`LinkedIn rejected schedule ${date} ${time}`);
}

async function waitTabLoaded(tabId, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await chrome.tabs.get(tabId)).status === 'complete') return;
    await sleep(300);
  }
  throw new Error('Tab load timeout');
}

// ---------- Tabs ----------
// Actions reuse tabs of the "LinkedIn CLI bot" group (tabs dragged into it count too), or the tab chosen
// with linkedin_use_tab. Tabs are never closed. New tabs open in a dedicated unfocused window (botWindowId).

const GROUP_TITLE = 'LinkedIn CLI bot';
const isLinkedin = (url) => /^https:\/\/([\w-]+\.)*linkedin\.com\//.test(url || '');

async function selectedTab() {
  const { cli_selectedTab: id } = await chrome.storage.local.get('cli_selectedTab');
  const tab = id != null && await chrome.tabs.get(id).catch(() => null);
  return tab && isLinkedin(tab.url) ? tab : null;
}

// Stored id first; group ids change on browser restart, so fall back to the title.
async function botGroupId() {
  const { cli_groupId: groupId } = await chrome.storage.local.get('cli_groupId');
  if (groupId != null && await chrome.tabGroups.get(groupId).catch(() => null)) return groupId;
  const [g] = await chrome.tabGroups.query({ title: GROUP_TITLE });
  await chrome.storage.local.set({ cli_groupId: g?.id ?? null });
  return g?.id ?? null;
}

async function groupTabs() {
  const groupId = await botGroupId();
  return groupId == null ? [] : chrome.tabs.query({ groupId });
}

async function addToGroup(tabId) {
  const groupId = await botGroupId();
  // Grouping moves the tab into the group's window, so reuse the group only if it's already in the tab's window.
  const { windowId } = await chrome.tabs.get(tabId);
  const group = groupId != null && await chrome.tabGroups.get(groupId).catch(() => null);
  if (group?.windowId === windowId) return chrome.tabs.group({ tabIds: tabId, groupId });
  const id = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId } });
  await chrome.tabGroups.update(id, { title: GROUP_TITLE, color: 'blue' });
  await chrome.storage.local.set({ cli_groupId: id });
}

// New tab in the dedicated bot window (recreated if closed). Explicit left/top: Chrome may reuse an off-screen spot.
async function newBotTab(url) {
  const { cli_botWindowId: botWindowId } = await chrome.storage.local.get('cli_botWindowId');
  if (botWindowId != null && await chrome.windows.get(botWindowId).catch(() => null)) {
    return chrome.tabs.create({ windowId: botWindowId, url, active: true });
  }
  const w = await chrome.windows.create({ url, focused: false, state: 'normal', left: 40, top: 40, width: 1280, height: 900 });
  await chrome.storage.local.set({ cli_botWindowId: w.id });
  return w.tabs[0];
}

// Clear botWindowId when the bot window is closed so newBotTab recreates it.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { cli_botWindowId: botWindowId } = await chrome.storage.local.get('cli_botWindowId');
  if (windowId === botWindowId) await chrome.storage.local.remove('cli_botWindowId');
});

// Window ids restart with the browser, so a stored id can point at a user's window; onRemoved doesn't fire on quit.
const forgetBotWindow = () => chrome.storage.local.remove('cli_botWindowId');
chrome.runtime.onStartup.addListener(forgetBotWindow);
chrome.runtime.onInstalled.addListener(forgetBotWindow);

// ponytail: calls are serialized, so any group tab is idle; track busy tabs if handlers ever run in parallel.
async function botTab(url) {
  // Only reuse group tabs inside the bot window; older groups may sit in the user's window.
  const { cli_botWindowId: botWindowId } = await chrome.storage.local.get('cli_botWindowId');
  const tab = (await selectedTab()) || (await groupTabs()).find((t) => t.windowId === botWindowId);
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true }); // active in its own window so it renders; window focus untouched
    await loadUrl(tab.id, url);
    return tab.id;
  }
  const { id } = await newBotTab(url);
  await addToGroup(id);
  await waitTabLoaded(id);
  return id;
}

async function linkedinTab() {
  const sel = await selectedTab();
  if (sel) return attach(sel.id);
  // Prefer tabs inside the dedicated bot window so we don't touch the user's windows.
  const { cli_botWindowId: botWindowId } = await chrome.storage.local.get('cli_botWindowId');
  if (botWindowId != null) {
    const botTabs = await chrome.tabs.query({ url: 'https://*.linkedin.com/*', windowId: botWindowId });
    if (botTabs.length) return attach((botTabs.find((t) => t.active) || botTabs[0]).id);
  }
  // Fall back: active LinkedIn tab in the last-focused window, then any LinkedIn tab.
  const [tab] = (await chrome.tabs.query({ url: 'https://*.linkedin.com/*', active: true, lastFocusedWindow: true }))
    .concat(await chrome.tabs.query({ url: 'https://*.linkedin.com/*', active: true }));
  const any = tab || (await chrome.tabs.query({ url: 'https://*.linkedin.com/*' }))[0];
  if (!any) throw new Error('No LinkedIn tab open');
  return attach(any.id);
}

// ---------- Posting ----------

async function attachMedia(target, files) {
  await cdp(target, 'Page.enable');
  await cdp(target, 'DOM.enable');
  await cdp(target, 'Page.setInterceptFileChooserDialog', { enabled: true });
  try {
    let chooser = nextEvent(target, 'Page.fileChooserOpened', 5000);
    await click(target, await waitFor(target, { label: ['Media', 'Add media', 'Add a photo', 'Add a video'] }, 15000));
    let opened = await chooser.catch(() => null);
    if (!opened) {
      // Some composer versions open a media dialog first.
      chooser = nextEvent(target, 'Page.fileChooserOpened', 10000);
      await click(target, await waitFor(target, { label: ['Upload from computer', 'Select files to begin'] }, 10000));
      opened = await chooser;
    }
    await cdp(target, 'DOM.setFileInputFiles', { files, backendNodeId: opened.backendNodeId });
  } finally {
    await cdp(target, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
  // Media editor step: "Next"/"Done" becomes enabled once upload finishes (video can take minutes).
  await click(target, await waitFor(target, { label: ['Next', 'Done'], exact: true }, 5 * 60000, { enabled: true }));
}

// Opens url in a bot tab (see botTab) and runs fn there. The tab stays open either way.
async function inTab(url, fn) {
  const target = await attach(await botTab(url));
  try {
    await cdp(target, 'Page.bringToFront');
    await jitter(1500, 3000);
    await assertSafe(target);
    return await fn(target);
  } catch (e) {
    throw new Error(`${e.message} (tab ${target.tabId} left as is for inspection)`);
  }
}

function inComposer(fn) {
  return inTab(FEED_URL, async (target) => {
    await click(target, await waitFor(target, { label: 'Start a post' }, 30000));
    return fn(target);
  });
}

const normText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function publish({ text, media = [], at }) {
  return inComposer(async (target) => {
    await click(target, await waitFor(target, { editor: true }, 30000));
    if (media.length) await attachMedia(target, media);
    await click(target, await waitFor(target, { editor: true }, 30000));
    await typeText(target, text);
    if (at) await setSchedule(target, at);
    // Scheduling must end on the "Schedule" button: a "Post" button here means the date did not stick and would publish now.
    const postBtn = await waitFor(target, { label: at ? 'Schedule' : 'Post', exact: true }, 5 * 60000, { enabled: true });
    await jitter(800, 1600);
    await click(target, postBtn);
    await waitGone(target, { editor: true }, 60000);
    if (!at) return { ok: true, postedAt: new Date().toISOString() };
    // Confirm the post landed: re-read the scheduled list in this same tab (read-only, never Post/Schedule).
    const want = normText(text).slice(0, 60);
    let verified = false;
    await sleep(3000);
    for (const end = Date.now() + 30000; !verified && Date.now() < end; await sleep(3000)) {
      try {
        await click(target, await waitFor(target, { label: 'Start a post' }, 30000));
        await openScheduled(target);
        verified = (await find(target, { scheduled: true })).some((e) => normText(e?.text).startsWith(want));
        await click(target, await waitFor(target, { dialog: true, label: ['Dismiss', 'Cancel'], exact: true }, 5000)).catch(() => {});
      } catch { /* retry until deadline */ }
    }
    return { ok: true, scheduledFor: new Date(at).toISOString(), verified };
  });
}

// Composer > clock > "Scheduled (N)" tab, then wheel-scroll until the lazy list stops growing.
async function openScheduled(target) {
  await click(target, await waitFor(target, { selector: 'svg#clock-medium' }, 30000));
  await click(target, await waitFor(target, { label: 'Scheduled' }, 10000));
  await sleep(2000);
  // Stop when all N from the "Scheduled (N)" tab are loaded, or the count stops growing.
  let prev = -1;
  for (let stable = 0; stable < 3; ) {
    const { count, total, x, y } = await find(target, { scheduledCount: true });
    if (!count || (total != null && count >= total)) return; // unknown total: rely on "stopped growing"
    stable = count === prev ? stable + 1 : 0;
    prev = count;
    await moveMouse(target, x, y);
    await cdp(target, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: rand(300, 500) });
    await sleep(rand(700, 1200));
  }
}

function listScheduled() {
  return inComposer(async (target) => {
    await openScheduled(target);
    return find(target, { scheduled: true });
  });
}

// `when` must be the exact string from listScheduled, e.g. "Thu, Oct 15, 2026 at 7:45 AM".
function deleteScheduled({ when }) {
  return inComposer(async (target) => {
    await openScheduled(target);
    const dots = await find(target, { scheduledMenu: when });
    if (!dots) throw new Error(`No scheduled post at "${when}"`);
    if (dots.error) throw new Error(dots.error);
    await click(target, dots);
    // Re-find right before each click: a closed menu must never turn into a click on another post.
    // Menu item "Delete post" and confirm button "Delete Post" match the same (case-insensitive) label.
    await click(target, await waitFor(target, { label: 'Delete post', exact: true }, 5000));
    await sleep(800); // let the menu close so only the confirm dialog's button is left
    await click(target, await waitFor(target, { label: 'Delete Post', exact: true }, 5000));
    await sleep(2000);
    if ((await find(target, { scheduled: true })).some((p) => p.when === when)) {
      throw new Error(`Post at "${when}" still listed after delete`);
    }
    return { ok: true, deleted: when };
  });
}

// ---------- People ----------

async function loadUrl(tabId, url) {
  const before = (await chrome.tabs.get(tabId)).url;
  await chrome.tabs.update(tabId, { url });
  // The old page still reports "complete" for a moment; wait until the tab is actually on a new URL.
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'loading' || (t.url !== before && t.status === 'complete')) break;
    await sleep(100);
  }
  await waitTabLoaded(tabId);
}

async function navigate(target, url) {
  await loadUrl(target.tabId, url);
  await jitter(1500, 3000);
  await assertSafe(target);
}

// Wheel down like a reader until the page stops growing (lazy sections, result cards).
async function scrollToBottom(target, maxSteps = 25) {
  for (let i = 0, stable = 0; i < maxSteps && stable < 2; i++) {
    const { atBottom, height } = await find(target, { scroll: true });
    const x = rand(400, 700);
    const y = rand(300, 500);
    await moveMouse(target, x, y);
    await cdp(target, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: rand(400, 800) });
    await sleep(rand(600, 1300));
    const after = await find(target, { scroll: true });
    stable = atBottom && after.height === height ? stable + 1 : 0;
  }
}

const NETWORK = { 1: 'F', 2: 'S', 3: 'O' };

function searchPeople({ keywords, title, company, network, page = 1 }) {
  const u = new URL('https://www.linkedin.com/search/results/people/');
  if (keywords) u.searchParams.set('keywords', keywords);
  if (title) u.searchParams.set('titleFreeText', title);
  if (company) u.searchParams.set('company', company);
  if (network?.length) u.searchParams.set('network', JSON.stringify(network.map((n) => NETWORK[n])));
  if (page > 1) u.searchParams.set('page', String(page));
  return inTab(u.href, async (target) => {
    await scrollToBottom(target, 8);
    const results = await find(target, { people: true });
    const next = await find(target, { label: 'Next', exact: true });
    return { page, results, hasNext: !!next && !next.disabled };
  });
}

const profileUrl = (p) => {
  const u = new URL(p, 'https://www.linkedin.com');
  if (u.hostname !== 'www.linkedin.com' || !/^\/in\/[^/]+\/?$/.test(u.pathname)) throw new Error(`Not a profile URL: ${p}`);
  return `https://www.linkedin.com${u.pathname.replace(/\/?$/, '/')}`;
};

async function readProfile(target, { details = true } = {}) {
  await scrollToBottom(target);
  const p = await find(target, { profile: true });
  if (!p) throw new Error('Profile did not load');
  if (details) {
    // "Show all" pages hold the full experience/education/skills lists.
    for (const path of p.details) {
      await navigate(target, `https://www.linkedin.com${path}`);
      await scrollToBottom(target, 10);
      const section = path.match(/\/details\/([^/]+)/)[1];
      p.sections[`details:${section}`] = await find(target, { text: true });
    }
  }
  delete p.details;
  return p;
}

function getProfile({ profile, details }) {
  return inTab(profileUrl(profile), (target) => readProfile(target, { details }));
}

async function connectPerson({ profile, note }) {
  return inTab(profileUrl(profile), async (target) => {
    const p = await waitFor(target, { profile: true }, 20000);
    const invite = `Invite ${p.name} to connect`;
    if (p.actions.some((a) => /^Pending|withdraw/i.test(a))) return { status: 'already pending', name: p.name };

    let btn = await find(target, { label: invite, exact: true });
    if (!btn) {
      // Connect is hidden under "More" when Follow is the primary action.
      const more = await find(target, { profileAction: 'More' });
      if (more) {
        await click(target, more);
        // Menu item is <a role=menuitem>Connect</a>; its aria-label sits on a non-clickable child.
        btn = await waitFor(target, { label: [invite, 'Connect'], exact: true, menuitem: true }, 5000).catch(() => null);
      }
    }
    if (!btn) {
      if (p.top.some((l) => /·\s*1st|• 1st/.test(l))) return { status: 'already connected', name: p.name };
      throw new Error(`Connect not found for ${p.name}, neither on the profile nor under More`); // keeps tab open
    }
    await click(target, btn);

    // Either the invite dialog opens or LinkedIn sends right away.
    let state = null;
    for (const end = Date.now() + 10000; !state && Date.now() < end; await sleep(500)) {
      if (await find(target, { dialog: true, label: ['Add a note', 'Send without a note', 'Send'], exact: true })) state = 'dialog';
      else if (await find(target, { label: 'Pending' })) state = 'pending';
    }
    if (!state) throw new Error('Neither invite dialog nor Pending appeared after Connect');
    let noteSent = false;
    if (state === 'dialog') {
      if (/email/i.test((await find(target, { dialog: true, text: true })).join(' '))) {
        await click(target, await waitFor(target, { dialog: true, label: ['Dismiss', 'Cancel'], exact: true }, 5000));
        throw new Error('LinkedIn requires their email to connect');
      }
      if (note) {
        await click(target, await waitFor(target, { dialog: true, label: 'Add a note', exact: true }, 5000));
        const field = await waitFor(target, { dialog: true, field: true }, 5000).catch(() => null);
        if (!field) {
          await click(target, await waitFor(target, { dialog: true, label: ['Dismiss', 'Cancel'], exact: true }, 5000));
          throw new Error('No note field (free personalized-note limit used?). Nothing sent; retry without note.');
        }
        await click(target, field);
        await typeText(target, note.replace(/\s*\n\s*/g, ' '));
        await click(target, await waitFor(target, { dialog: true, label: ['Send', 'Send invitation'], exact: true }, 5000, { enabled: true }));
        noteSent = true;
      } else {
        await click(target, await waitFor(target, { dialog: true, label: ['Send without a note', 'Send'], exact: true }, 5000, { enabled: true }));
      }
    }
    await waitFor(target, { label: 'Pending' }, 10000);
    return { status: 'invited', name: p.name, noteSent };
  });
}

// ---------- Jobs ----------

const POSTED = { day: 'r86400', week: 'r604800', month: 'r2592000' };

// LinkedIn's AI job search (/jobs/search-results/) ignores location and f_WT, so they also go into the query text.
function searchJobs({ keywords, location, remote, easyApply, postedWithin, page = 1 }) {
  const u = new URL('https://www.linkedin.com/jobs/search-results/');
  u.searchParams.set('keywords', [keywords, remote && 'remote', location && `in ${location}`].filter(Boolean).join(' '));
  if (location) u.searchParams.set('location', location);
  if (remote) u.searchParams.set('f_WT', '2');
  if (easyApply) u.searchParams.set('f_AL', 'true');
  if (postedWithin) u.searchParams.set('f_TPR', POSTED[postedWithin]);
  if (page > 1) u.searchParams.set('start', String((page - 1) * 25));
  return inTab(u.href, async (target) => {
    let res = await waitFor(target, { jobs: true }, 20000);
    const seen = new Map();
    for (let stable = 0; stable < 2; ) {
      const before = seen.size;
      for (const j of res.items) if (!seen.has(j.id)) seen.set(j.id, j);
      stable = seen.size === before ? stable + 1 : 0;
      if (!res.wheel) break;
      await wheel(target, res.wheel, rand(600, 1000));
      res = (await find(target, { jobs: true })) || { items: [], wheel: null };
    }
    return { page, jobs: [...seen.values()] };
  });
}

const jobUrl = (j) => {
  const id = String(j).match(/(?:jobs\/view\/|currentJobId=|^)(\d{6,})/)?.[1];
  if (!id) throw new Error(`Not a job id/URL: ${j}`);
  return `https://www.linkedin.com/jobs/view/${id}/`;
};

function getJob({ job }) {
  return inTab(jobUrl(job), async (target) => {
    const j = await waitFor(target, { job: true }, 20000);
    delete j.save;
    return { url: jobUrl(job), ...j };
  });
}

// ponytail: first page of the tracker only; add scrolling/paging when a stage holds more than ~10 jobs that matter.
function jobTracker({ stage = 'applied' }) {
  if (!['saved', 'applied', 'interview', 'archived'].includes(stage)) throw new Error(`Unknown stage: ${stage}`);
  return inTab(`https://www.linkedin.com/jobs-tracker/?stage=${stage}`, async (target) =>
    ({ stage, jobs: await waitFor(target, { tracker: true }, 20000) }));
}

// Saving is private (only you see Saved jobs), so it is not counted as an outward action.
function saveJob({ job }) {
  return inTab(jobUrl(job), async (target) => {
    const j = await waitFor(target, { job: true }, 20000);
    if (j.saved) return { status: 'already saved', url: jobUrl(job) };
    if (!j.save) throw new Error('Save button not found');
    await click(target, j.save);
    await sleep(1500);
    if (!(await find(target, { job: true })).saved) throw new Error('Save did not take effect');
    return { status: 'saved', url: jobUrl(job) };
  });
}

// ---------- Notifications ----------

const ACTIONABLE = new Set(['reply', 'mention', 'comment']);

function listNotifications({ limit = 30, actionableOnly = false }) {
  return inTab('https://www.linkedin.com/notifications/', async (target) => {
    const seen = new Map();
    for (let stable = 0; seen.size < limit && stable < 2; ) {
      const before = seen.size;
      for (const n of await find(target, { notifications: true })) {
        const key = `${n.text}|${n.time}`;
        if (!seen.has(key)) seen.set(key, n);
      }
      stable = seen.size === before ? stable + 1 : 0;
      if (seen.size < limit) await wheel(target, { x: rand(500, 800), y: rand(300, 500) }, rand(600, 1000));
    }
    return [...seen.values()].filter((n) => !actionableOnly || ACTIONABLE.has(n.kind)).slice(0, limit);
  });
}

// ---------- Invitations ----------

const INVITES_URL = (dir) => `https://www.linkedin.com/mynetwork/invitation-manager/${dir}/`;

function listInvitations({ direction = 'received', limit = 50 }) {
  return inTab(INVITES_URL(direction), async (target) => {
    const seen = new Map();
    for (let stable = 0; seen.size < limit && stable < 2; ) {
      const before = seen.size;
      for (const i of await find(target, { invitations: true })) if (!seen.has(i.profile)) seen.set(i.profile, i);
      stable = seen.size === before ? stable + 1 : 0;
      if (seen.size < limit) await wheel(target, { x: rand(500, 800), y: rand(300, 500) }, rand(600, 1000));
    }
    return [...seen.values()].slice(0, limit);
  });
}

// Scrolls the invitation list until the card for `profile` shows its `label` button.
async function findInvitation(target, profile, label) {
  for (let i = 0; i < 15; i++) {
    const hit = await find(target, { invitationAction: { profile, label } });
    if (hit) return hit;
    await wheel(target, { x: rand(500, 800), y: rand(300, 500) }, rand(600, 1000));
  }
  throw new Error(`No invitation with "${label}" for ${profile}`);
}

function respondInvitation({ profile, action }) {
  const label = action === 'accept' ? 'Accept' : 'Ignore';
  return inTab(INVITES_URL('received'), async (target) => {
    await click(target, await findInvitation(target, profileUrl(profile), label));
    await sleep(2000);
    if (await find(target, { invitationAction: { profile: profileUrl(profile), label } })) throw new Error(`${label} did not take effect`);
    return { status: action === 'accept' ? 'accepted' : 'ignored', profile };
  });
}

// LinkedIn won't let you re-invite a withdrawn person for ~3 weeks.
// Several profiles are handled in one tab with human pauses; per-profile failures don't stop the batch.
function withdrawInvitations({ profiles }) {
  return inTab(INVITES_URL('sent'), async (target) => {
    const results = [];
    for (const [i, raw] of profiles.entries()) {
      const profile = profileUrl(raw);
      try {
        await click(target, await findInvitation(target, profile, 'Withdraw'));
        // Confirmation dialog: "Withdraw invitation?" -> Withdraw.
        const confirm = await waitFor(target, { dialog: true, label: 'Withdraw', exact: true }, 5000).catch(() => null);
        if (confirm) await click(target, confirm);
        await sleep(2000);
        if (await find(target, { invitationAction: { profile, label: 'Withdraw' } })) throw new Error('did not take effect');
        results.push({ profile, status: 'withdrawn' });
      } catch (e) {
        if (e.code === 'HALT') throw e; // security check: abort the whole batch
        results.push({ profile, status: 'failed', error: e.message });
        await assertSafe(target);
      }
      if (i < profiles.length - 1) await sleep(rand(6000, 14000));
    }
    return { withdrawn: results.filter((r) => r.status === 'withdrawn').length, results };
  });
}

// ---------- Messaging ----------

const MESSAGING_URL = 'https://www.linkedin.com/messaging/';

async function wheel(target, { x, y }, deltaY) {
  await moveMouse(target, x, y);
  await cdp(target, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  await sleep(rand(700, 1300));
}

// Wheel the conversation list, collecting items as they render (scrolled-past ones get emptied again),
// until `limit` are collected or nothing new shows up.
async function loadConversations(target, limit) {
  const seen = new Map();
  let res = await waitFor(target, { conversations: true }, 20000);
  for (let stable = 0; ; ) {
    const before = seen.size;
    for (const c of res.items) if (!seen.has(c.name + c.time)) seen.set(c.name + c.time, c);
    stable = seen.size === before ? stable + 1 : 0;
    if (seen.size >= limit || stable >= 2 || !res.wheel) break;
    await wheel(target, res.wheel, rand(500, 900));
    res = (await find(target, { conversations: true })) || { items: [], wheel: null };
  }
  return [...seen.values()];
}

function listConversations({ limit = 20, unreadOnly = false }) {
  return inTab(MESSAGING_URL, async (target) => {
    const items = await loadConversations(target, limit);
    return items.filter((c) => !unreadOnly || c.unread).slice(0, limit);
  });
}

// Opens a chat by profile (top-card "Message", works for any 1st-degree connection)
// or by exact conversation name from the messaging list.
async function openChat(target, { name, profile }) {
  let expected = name;
  if (profile) {
    expected = (await waitFor(target, { profile: true }, 20000)).name;
    const btn = await waitFor(target, { profileAction: 'Message' }, 20000)
      .catch(() => { throw new Error('No "Message" button on this profile (not a connection?)'); });
    await click(target, btn);
  } else {
    let hit = null;
    for (let tries = 0, prev = -1; !hit && tries < 15; tries++) {
      hit = await find(target, { conversation: name });
      if (hit?.error) throw new Error(hit.error);
      if (hit) break;
      const { items, wheel: w } = await waitFor(target, { conversations: true }, 20000);
      if (items.length === prev || !w) break;
      prev = items.length;
      await wheel(target, w, rand(500, 900));
    }
    if (!hit) throw new Error(`No conversation named "${name}". Use the person's profile URL instead.`);
    await click(target, hit);
  }
  // /messaging/ auto-opens the latest chat; never act until the header shows the right person.
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const chat = await find(target, { chat: true });
    if (chat && chat.title.toLowerCase().includes(expected.toLowerCase())) return chat;
    await sleep(500);
  }
  throw new Error(`Chat with "${expected}" did not open`);
}

const chatUrl = ({ name, profile }) => {
  if (!name === !profile) throw new Error('Give exactly one of `name` or `profile`');
  return profile ? profileUrl(profile) : MESSAGING_URL;
};

function readConversation({ name, profile, limit = 30 }) {
  return inTab(chatUrl({ name, profile }), async (target) => {
    let chat = await openChat(target, { name, profile });
    // Older messages load when scrolling up.
    for (let stable = 0; chat.messages.length < limit && !chat.atTop && stable < 2; ) {
      await wheel(target, chat.wheel, -rand(500, 900));
      const next = await find(target, { chat: true });
      stable = next.messages.length === chat.messages.length ? stable + 1 : 0;
      chat = next;
    }
    return { messages: chat.messages.slice(-limit) };
  });
}

// Attaches a local file via the composer's paperclip; waits until its chip shows and the upload is done.
async function attachToChat(target, file) {
  await cdp(target, 'Page.enable');
  await cdp(target, 'DOM.enable');
  await cdp(target, 'Page.setInterceptFileChooserDialog', { enabled: true });
  try {
    const chooser = nextEvent(target, 'Page.fileChooserOpened', 10000);
    await click(target, await waitFor(target, { label: 'Attach a file' }, 15000));
    const opened = await chooser;
    await cdp(target, 'DOM.setFileInputFiles', { files: [file], backendNodeId: opened.backendNodeId });
  } finally {
    await cdp(target, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
  const base = file.split('/').pop();
  const end = Date.now() + 2 * 60000;
  while (Date.now() < end) {
    const c = await find(target, { chat: true });
    if (c?.formText.includes(base) && !c.uploading) return;
    await sleep(500);
  }
  throw new Error(`Attachment "${base}" did not finish uploading`);
}

function sendMessage({ name, profile, text, attachment }) {
  return inTab(chatUrl({ name, profile }), async (target) => {
    const chat = await openChat(target, { name, profile });
    if (chat.editorText) throw new Error('Chat box already has a draft; not overwriting it');
    if (attachment) {
      // Fails before any text is typed, so nothing is ever sent without the file.
      await attachToChat(target, attachment).catch((e) => { throw new Error(`Attachment failed, nothing sent: ${e.message}`); });
    }
    await click(target, attachment ? (await find(target, { chat: true })).editor : chat.editor);
    await typeText(target, text, { shiftNewlines: true });
    await jitter(600, 1400);
    const ready = await find(target, { chat: true });
    if (ready.send) await click(target, ready.send);
    else await pressEnter(target); // "Press Enter to Send" mode has no Send button
    // Sent = editor emptied and the last message is ours.
    const probe = text.replace(/\s+/g, ' ').trim().slice(0, 40);
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const c = await find(target, { chat: true });
      const last = c?.messages.at(-1);
      if (c && !c.editorText && last?.text.replace(/\s+/g, ' ').includes(probe)) return { status: 'sent', to: name || profile };
      await sleep(500);
    }
    throw new Error('Message not confirmed as sent');
  });
}

// ---------- Posts & comments ----------

// Own profile path, e.g. "/in/some-slug/". /in/me/ redirects to it.
async function myProfile(target) {
  const { cli_me: me } = await chrome.storage.local.get('cli_me');
  if (me) return me;
  await navigate(target, 'https://www.linkedin.com/in/me/');
  const path = new URL((await chrome.tabs.get(target.tabId)).url).pathname.match(/^\/in\/[^/]+\//)?.[0];
  if (!path || path === '/in/me/') throw new Error('Could not resolve own profile');
  await chrome.storage.local.set({ cli_me: path });
  return path;
}

// Accepts /feed/update/urn:li:activity:N/ and share links like /posts/name_slug-activity-N-xxxx/ (or ugcPost-N).
const postUrl = (p) => {
  const s = decodeURIComponent(String(p));
  const m = s.match(/urn:li:(activity|ugcPost|share):(\d+)/) || s.match(/[-_](activity|ugcPost|share)-(\d+)/);
  if (!m) throw new Error(`Not a post URL: ${p}`);
  return `https://www.linkedin.com/feed/update/urn:li:${m[1]}:${m[2]}/`;
};

// feed: 'all' = own posts, 'reactions' = posts you liked/reacted to.
async function loadMyPosts(target, limit, feed = 'all') {
  const me = await myProfile(target);
  await navigate(target, `https://www.linkedin.com${me}recent-activity/${feed}/`);
  return collectPosts(target, limit);
}

async function collectPosts(target, limit) {
  const seen = new Map();
  for (let stable = 0; seen.size < limit && stable < 2; ) {
    const before = seen.size;
    for (const p of await find(target, { posts: true })) {
      const key = p.url || `${p.author}|${p.text.slice(0, 200)}`;
      if (!seen.has(key)) seen.set(key, p);
    }
    stable = seen.size === before ? stable + 1 : 0;
    if (seen.size < limit) await wheel(target, { x: rand(500, 800), y: rand(300, 500) }, rand(600, 1000));
  }
  return [...seen.values()].slice(0, limit);
}

// Post search, e.g. hiring posts. Search cards carry no post id, so url is null; profile points to the author.
function searchPosts({ keywords, datePosted, limit = 10 }) {
  const u = new URL('https://www.linkedin.com/search/results/content/');
  u.searchParams.set('keywords', keywords);
  if (datePosted) u.searchParams.set('datePosted', `"${datePosted}"`);
  return inTab(u.href, async (target) => {
    for (let i = 0; i < 40 && !(await find(target, { posts: true })).length; i++) await sleep(500);
    return collectPosts(target, limit);
  });
}

function listMyPosts({ limit = 10, feed = 'all' }) {
  if (!['all', 'reactions'].includes(feed)) throw new Error(`Unknown feed: ${feed}`);
  return inTab(FEED_URL, (target) => loadMyPosts(target, limit, feed));
}

// Opens a post, expands every collapsed reply/comment list, returns threads with needsReply flags.
async function readComments(target, url, me) {
  await navigate(target, url);
  // On the post's own page comments load as you scroll; collapsed replies need their expander clicked.
  for (let i = 0; i < 20; i++) {
    await scrollToBottom(target);
    const more = await find(target, { expander: true });
    if (!more) break;
    await click(target, more);
    await sleep(rand(1000, 1800));
  }
  const threads = await find(target, { comments: true });
  for (const t of threads) {
    const last = t.replies.at(-1) || t;
    t.needsReply = last.profile !== me; // someone else spoke last in this thread
    t.involved = [t, ...t.replies].some((c) => c.profile === me); // on others' posts, only these concern you
    t.replyTo = last.id; // Reply under the last comment pre-mentions its author
  }
  return threads;
}

function getComments({ post }) {
  return inTab(FEED_URL, async (target) => {
    const me = await myProfile(target);
    return { me, threads: await readComments(target, postUrl(post), me) };
  });
}

// Scans own recent posts that have comments and returns threads where someone else spoke last.
function unansweredComments({ posts = 5 }) {
  return inTab(FEED_URL, async (target) => {
    const me = await myProfile(target);
    const out = [];
    for (const p of (await loadMyPosts(target, posts)).filter((x) => x.comments > 0)) {
      const threads = (await readComments(target, p.url, me)).filter((t) => t.needsReply);
      if (threads.length) out.push({ post: p.url, text: p.text.slice(0, 120), threads });
    }
    return out;
  });
}

const commentIds = async (target) => new Set((await find(target, { comments: true }))
  .flatMap((t) => [t, ...t.replies]).map((c) => c.id));

// Waits until a NEW comment of ours (id not in `before`) containing `text` appears on the page.
// `before` matters: short texts like "Thanks!" also match our earlier comments.
async function confirmMyComment(target, me, text, before) {
  const probe = text.replace(/\s+/g, ' ').trim().slice(0, 40);
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const threads = await find(target, { comments: true });
    const mine = threads.flatMap((t) => [t, ...t.replies])
      .find((c) => !before.has(c.id) && c.profile === me && c.text.replace(/\s+/g, ' ').includes(probe));
    if (mine) return mine.id;
    await sleep(700);
  }
  throw new Error('Comment not confirmed (check the post)');
}

// Tab is opened on the post itself; myProfile may detour to /in/me/ once (then cached), so come back.
async function meOnPost(target, url) {
  const me = await myProfile(target);
  if ((await chrome.tabs.get(target.tabId)).url.split('?')[0] !== url) await navigate(target, url);
  return me;
}

function commentPost({ post, text }) {
  return inTab(postUrl(post), async (target) => {
    const me = await meOnPost(target, postUrl(post));
    const box = await waitFor(target, { postEditor: true }, 20000);
    if (box.text) throw new Error('Comment box already has a draft; not overwriting it');
    await click(target, box.editor);
    await typeText(target, text, { shiftNewlines: true });
    const ready = await waitFor(target, { postEditor: true }, 5000);
    if (!ready.submit) throw new Error('Comment button not found or disabled');
    const before = await commentIds(target);
    await jitter(600, 1400);
    await click(target, ready.submit);
    return { status: 'commented', id: await confirmMyComment(target, me, text, before) };
  });
}

function replyComment({ post, commentId, text }) {
  return inTab(postUrl(post), async (target) => {
    const me = await meOnPost(target, postUrl(post));
    for (let i = 0; i < 15 && !(await find(target, { commentReply: commentId })); i++) {
      const more = await find(target, { expander: true });
      if (more) await click(target, more);
      else await wheel(target, { x: rand(500, 800), y: rand(300, 500) }, rand(500, 900));
      await sleep(rand(800, 1500));
    }
    const btn = await find(target, { commentReply: commentId });
    if (!btn) throw new Error(`Comment ${commentId} not found on the post`);
    await click(target, btn);
    const box = await waitFor(target, { replyEditor: commentId }, 10000);
    await click(target, box.editor);
    // Keep LinkedIn's @mention of the author; type after it.
    await cdp(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', commands: ['moveToEndOfDocument'] });
    await cdp(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End' });
    await typeText(target, text, { shiftNewlines: true });
    const ready = await waitFor(target, { replyEditor: commentId }, 5000);
    if (!ready.submit) throw new Error('Reply button not found or disabled');
    const before = await commentIds(target);
    await jitter(600, 1400);
    await click(target, ready.submit);
    return { status: 'replied', id: await confirmMyComment(target, me, text, before) };
  });
}

function likeComment({ post, commentId }) {
  return inTab(postUrl(post), async (target) => {
    for (let i = 0; i < 15 && !(await find(target, { commentLike: commentId })); i++) {
      const more = await find(target, { expander: true });
      if (more) await click(target, more);
      else await wheel(target, { x: rand(500, 800), y: rand(300, 500) }, rand(500, 900));
      await sleep(rand(800, 1500));
    }
    const btn = await find(target, { commentLike: commentId });
    if (!btn) throw new Error(`Like button of comment ${commentId} not found on the post`);
    if (btn.liked) return { status: 'already_liked', id: commentId };
    await jitter(600, 1400);
    await click(target, btn);
    for (let i = 0; i < 4; i++) {
      await sleep(rand(500, 900));
      if ((await find(target, { commentLike: commentId }))?.liked) return { status: 'liked', id: commentId };
    }
    // Ends in "timed out" so the server queue records `unverified` (may have happened), not `failed`.
    throw new Error('Like state did not change after the click; timed out');
  });
}

// ---------- Safety ----------

// Security checks, logouts and restriction notices: stop everything instead of clicking on.
const DANGER_PATH = /^\/(checkpoint|authwall|uas\/login|login|signup)\b/;

async function assertSafe(target) {
  const { url } = await chrome.tabs.get(target.tabId);
  const path = new URL(url).pathname;
  let reason = DANGER_PATH.test(path) ? `LinkedIn redirected to ${path} (login or security check)` : null;
  if (!reason) {
    const said = await find(target, { danger: true }).catch(() => null);
    if (said) reason = `LinkedIn says: "${said}"`;
  }
  if (!reason) return;
  await chrome.storage.local.set({ cli_halted: { reason, at: Date.now() } });
  throw haltError(reason);
}

// Rate limits live in the service. The extension only refuses outward actions while halted;
// the service clears the halt with {type:'resume'}.
async function outward(fn) {
  const { cli_halted: halted } = await chrome.storage.local.get('cli_halted');
  if (halted) throw haltError(halted.reason);
  return fn();
}

// One composer at a time.
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

// ---------- Tool handlers ----------

const handlers = {
  post: (args) => serial(() => outward(() => publish(args))),

  schedule(args) {
    if (!(Date.parse(args.at) > Date.now())) throw new Error('`at` must be a future datetime');
    return serial(() => outward(() => publish(args)));
  },

  listScheduled: () => serial(listScheduled),

  deleteScheduled: (args) => serial(() => deleteScheduled(args)),

  searchPeople: (args) => serial(() => searchPeople(args)),

  getProfile: (args) => serial(() => getProfile(args)),

  connect: (args) => serial(() => outward(() => connectPerson(args))),

  listNotifications: (args) => serial(() => listNotifications(args)),

  searchJobs: (args) => serial(() => searchJobs(args)),

  getJob: (args) => serial(() => getJob(args)),

  saveJob: (args) => serial(() => saveJob(args)),

  jobTracker: (args) => serial(() => jobTracker(args)),

  searchPosts: (args) => serial(() => searchPosts(args)),

  listInvitations: (args) => serial(() => listInvitations(args)),

  respondInvitation: (args) => serial(() => respondInvitation(args)),

  withdrawInvitation: (args) => serial(() => withdrawInvitations({ profiles: args.profiles || [args.profile] })),

  listConversations: (args) => serial(() => listConversations(args)),

  readConversation: (args) => serial(() => readConversation(args)),

  sendMessage: (args) => serial(() => outward(() => sendMessage(args))),

  listMyPosts: (args) => serial(() => listMyPosts(args)),

  getComments: (args) => serial(() => getComments(args)),

  unansweredComments: (args) => serial(() => unansweredComments(args)),

  replyComment: (args) => serial(() => outward(() => replyComment(args))),

  commentPost: (args) => serial(() => outward(() => commentPost(args))),

  likeComment: (args) => serial(() => outward(() => likeComment(args))),

  snapshot: async () => find(await linkedinTab(), { list: true }),

  async readPage({ maxLines = 150 }) {
    const target = await linkedinTab();
    const { url } = await chrome.tabs.get(target.tabId);
    return { url, lines: (await find(target, { text: true })).slice(0, maxLines) };
  },

  async click({ label, exact = false }) {
    const target = await linkedinTab();
    await click(target, await waitFor(target, { label, exact }, 10000));
    return { ok: true };
  },

  async type({ text }) {
    await typeText(await linkedinTab(), text);
    return { ok: true };
  },

  // Group tabs, plus the selected tab if it lives outside the group.
  async listTabs() {
    const sel = await selectedTab();
    const tabs = await groupTabs();
    if (sel && !tabs.some((t) => t.id === sel.id)) tabs.push(sel);
    return tabs.map((t) => ({ tabId: t.id, url: t.url, title: t.title, active: t.active, selected: t.id === sel?.id }));
  },

  async useTab({ tabId }) {
    if (tabId == null) {
      await chrome.storage.local.remove('cli_selectedTab');
      return { ok: true, selected: null };
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!isLinkedin(tab?.url)) throw new Error(`Tab ${tabId} is not an open linkedin.com tab`);
    await chrome.storage.local.set({ cli_selectedTab: tabId });
    return { ok: true, selected: tabId };
  },
};

// ---------- Boot ----------

// Keep the MV3 service worker alive while connected
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    chrome.runtime.getPlatformInfo(() => {});
  }
}, 10000);

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg === 'reconnect') return connect();
  if (msg === 'reconnectNow') { // port changed: drop the current socket, connect with the new URL
    const old = ws;
    ws = null;
    old?.close();
    connect();
    return;
  }
  // Popup: tab list and "Use here" share the tool handlers.
  if (msg?.tool === 'listTabs' || msg?.tool === 'useTab') {
    handlers[msg.tool](msg.args || {}).then((result) => reply({ result }), (e) => reply({ error: e.message }));
    return true;
  }
});
setConnected(false);
connect();
