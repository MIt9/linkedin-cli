const TOOL_NAMES = {
  post: 'Post',
  schedule: 'Schedule',
  listScheduled: 'List scheduled',
  deleteScheduled: 'Delete scheduled',
  searchPeople: 'Search people',
  getProfile: 'Profile',
  connect: 'Connect',
  listNotifications: 'Notifications',
  searchJobs: 'Search jobs',
  getJob: 'Job',
  saveJob: 'Save job',
  jobTracker: 'Job tracker',
  searchPosts: 'Search posts',
  listInvitations: 'Invitations',
  respondInvitation: 'Answer invitation',
  withdrawInvitation: 'Withdraw invitation',
  listConversations: 'Conversations',
  readConversation: 'Read chat',
  sendMessage: 'Send message',
  listMyPosts: 'My posts',
  getComments: 'Comments',
  unansweredComments: 'Unanswered comments',
  replyComment: 'Reply to comment',
  commentPost: 'Comment',
  snapshot: 'Snapshot',
  readPage: 'Read page',
  click: 'Click',
  type: 'Type',
  listTabs: 'Tabs',
  useTab: 'Use tab',
};

const $ = (id) => document.getElementById(id);

const fmtTime = (ms) => new Date(ms).toLocaleString([], {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text; // textContent: history holds page/user text, never render as HTML
  return e;
}

function render({ cli_connected: connected = false, cli_connectedChangedAt: connectedChangedAt, cli_history: history = [],
  cli_halted: halted, cli_serverVersion: serverVersion, cli_rejected: rejected, cli_port }) {
  const extVersion = chrome.runtime.getManifest().version;
  const bad = !!rejected || (connected && serverVersion && !compatible(extVersion, serverVersion));
  $('versions').textContent = `extension ${extVersion} · server ${connected || rejected ? serverVersion || '?' : '—'}`
    + (bad ? ' · VERSION MISMATCH: update the extension or the CLI' : '');
  $('ident').textContent = `id ${chrome.runtime.id} · v${extVersion}`;
  $('versions').className =bad ? 'error' : '';
  $('halted').hidden = !halted;
  $('haltedText').textContent = halted ? `Halted: ${halted.reason} (resume from the CLI)` : '';

  $('url').textContent = wsUrl(cli_port);
  $('dot').className = `dot${connected ? ' on' : ''}`;
  $('statusText').textContent = connected ? 'Connected to CLI service' : 'Not connected';
  $('statusHint').textContent = connected
    ? `since ${fmtTime(connectedChangedAt)}`
    : `Check \`linkedin service status\`; its port must match ${wsUrl(cli_port)}. Retries every 30 s.`;
  $('reconnect').hidden = connected;

  const list = $('history');
  list.replaceChildren();
  if (!history.length) return list.append(el('li', 'empty', 'No actions yet'));

  for (const h of history) {
    const li = el('li');
    const top = el('div', 'top');
    top.append(
      el('span', h.status === 'ok' ? 'ok' : h.status === 'running' ? 'running' : 'error-icon'),
      el('span', 'tool', TOOL_NAMES[h.tool] || h.tool),
      el('span', 'time', fmtTime(h.startedAt)),
    );
    li.append(top);
    if (h.summary) li.append(el('div', 'summary', h.summary));
    if (h.result) li.append(el('div', 'result', `→ ${h.result}`));
    if (h.error) li.append(el('div', 'error', h.error));
    list.append(li);
  }
}

const refresh = async () => render(await chrome.storage.local.get(
  ['cli_connected', 'cli_connectedChangedAt', 'cli_history', 'cli_halted', 'cli_serverVersion', 'cli_rejected', 'cli_port'],
));

const bg = (tool, args) => chrome.runtime.sendMessage({ tool, args });

async function renderTabs() {
  const { result: tabs = [] } = (await bg('listTabs').catch(() => null)) || {};
  const list = $('tabs');
  list.replaceChildren();
  if (!tabs.length) return list.append(el('li', 'empty', 'No bot tabs yet; one opens on the next action'));
  for (const t of tabs) {
    const li = el('li', t.selected ? 'sel' : '');
    const title = el('span', 'title', t.title || t.url);
    title.title = t.url;
    const focus = el('button', '', 'Focus');
    focus.onclick = async () => {
      const { windowId } = await chrome.tabs.get(t.tabId);
      await chrome.windows.update(windowId, { focused: true });
      await chrome.tabs.update(t.tabId, { active: true });
    };
    const use = el('button', '', 'Use here');
    use.onclick = () => bg('useTab', { tabId: t.tabId });
    li.append(title, focus, use);
    list.append(li);
  }
}

chrome.storage.onChanged.addListener(refresh);
chrome.storage.onChanged.addListener(renderTabs);
$('showWindow').onclick = async () => {
  const { cli_botWindowId: botWindowId } = await chrome.storage.local.get('cli_botWindowId');
  const ok = botWindowId != null
    && await chrome.windows.update(botWindowId, { focused: true, state: 'normal', left: 40, top: 40 }).catch(() => null);
  if (ok) return;
  // Closed or never opened: recreate it (same geometry as newBotTab in background.js).
  const w = await chrome.windows.create({ url: 'https://www.linkedin.com/feed/', focused: true, state: 'normal', left: 40, top: 40, width: 1280, height: 900 });
  await chrome.storage.local.set({ cli_botWindowId: w.id });
};
$('clearTab').onclick = () => bg('useTab', { tabId: null });
$('clear').onclick = () => chrome.storage.local.set({ cli_history: [] });
$('reconnect').onclick = () => chrome.runtime.sendMessage('reconnect').catch(() => {});
$('portForm').onsubmit = async (e) => {
  e.preventDefault();
  const port = parsePort($('port').value);
  $('portErr').hidden = port !== null;
  if (port === null) return ($('portErr').textContent = 'Port must be an integer 1024-65535');
  await chrome.storage.local.set({ cli_port: port });
  $('port').value = '';
  chrome.runtime.sendMessage('reconnectNow').catch(() => {});
};
refresh();
renderTabs();
