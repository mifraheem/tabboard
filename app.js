const TABS = [
  { key: 'todo', name: 'To do', test: /^to ?do/i },
  { key: 'progress', name: 'In progress', test: /progress/i },
  { key: 'review', name: 'Review', test: /review|testing|staging/i },
  { key: 'blocked', name: 'Blocked', test: /blocked/i },
  { key: 'backlog', name: 'Backlog', test: /backlog|no status/i },
  { key: 'done', name: 'Done', test: /done/i },
];
const ICON_COPY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_OPEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
const ICON_OK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
const ROW_CAP = 12;
let rowTasks = [];
const $ = (s) => document.querySelector(s);
// fun-extras settings live up here: the greeting reads them during startup
const FUN_KEY = 'fun.v1';
const fun = Object.assign({ on: true, badges: {}, notesDone: 0, zeroDay: '' }, (() => { try { return JSON.parse(localStorage.getItem(FUN_KEY)); } catch { return null; } })());
const saveFun = () => { try { localStorage.setItem(FUN_KEY, JSON.stringify(fun)); } catch {} };
const funOn = () => fun.on !== false;
const avatarOf = (login, size = 60) => `https://github.com/${encodeURIComponent(login)}.png?size=${size}`;
// ---------- GitHub data
const EMPTY = { login: '', name: '', projects: [], openPRs: [], mentions: [], recent: [], at: 0 };
let data = EMPTY;
const STALE_MS = 2 * 60 * 1000; // a new tab refetches only when the last load is older than this

async function gql(token, query, variables) {
  let res;
  try {
    res = await fetch('https://api.github.com/graphql', {
      method: 'POST', headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
  } catch { throw new Error("Couldn't reach GitHub"); }
  if (res.status === 401) throw Object.assign(new Error('Token rejected'), { auth: true });
  const json = await res.json().catch(() => ({}));
  if (!json.data) throw new Error(json.errors?.[0]?.message || json.message || `GitHub error ${res.status}`);
  return json.data;
}

const ITEMS = `query($id:ID!,$first:Int,$last:Int,$c:String,$status:String!,$due:String!){node(id:$id){... on ProjectV2{items(first:$first,last:$last,after:$c){totalCount pageInfo{hasNextPage endCursor} nodes{
  id
  status: fieldValueByName(name:$status){... on ProjectV2ItemFieldSingleSelectValue{name}}
  due: fieldValueByName(name:$due){... on ProjectV2ItemFieldDateValue{date}}
  content{
    ... on Issue{title number url updatedAt state closedAt createdAt author{login} comments{totalCount} milestone{title} repository{name} labels(first:4){nodes{name color}} assignees(first:5){nodes{login}}}
    ... on PullRequest{title number url updatedAt createdAt author{login} comments{totalCount} milestone{title} repository{name} labels(first:4){nodes{name color}} assignees(first:5){nodes{login}}}
    ... on DraftIssue{title updatedAt createdAt assignees(first:5){nodes{login}}}
  }}}}}}`;
const SEARCH = `query($q:String!){search(query:$q,type:ISSUE,first:100){nodes{
  ... on PullRequest{__typename title number url isDraft updatedAt createdAt mergedAt closedAt repository{name} author{login}
    reviewDecision reviewRequests(first:5){nodes{requestedReviewer{... on User{login}}}}
    commits(last:1){nodes{commit{statusCheckRollup{state}}}}}
  ... on Issue{__typename title number url updatedAt state closedAt bodyText createdAt author{login} comments{totalCount} milestone{title dueOn}
    repository{name owner{login}} labels(first:6){nodes{name color}} assignees(first:5){nodes{login}}}}}}`;
const PROJECTS = `nodes{id number title url closed items{totalCount}}`;

// per account: which orgs (and/or your own projects) to show, and the board field names
const SETTINGS_KEY = 'settings.v1';
const allSettings = (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })();
const SETTING_DEFAULTS = { owners: null, statusField: 'Status', dueField: 'Target date', repoIssues: true, repos: [] };
// fills in defaults for keys an older saved copy doesn't have, keeping what the user chose
const settingsFor = (login) => {
  const c = (allSettings[login] ||= {});
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) if (!(k in c)) c[k] = structuredClone(v);
  return c;
};
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(allSettings)); } catch {} };

// GitHub takes seconds per 100 items and pages can't run in parallel from one end, so read from both ends at once:
// up to 200 items cost one round trip; bigger boards walk the middle while the last page is already in
async function loadBoard(token, p, cfg) {
  const vars = { id: p.id, status: cfg.statusField, due: cfg.dueField }, n = p.items?.totalCount ?? 0;
  const page = (v) => gql(token, ITEMS, { ...vars, ...v }).then((d) => d.node.items);
  const firstP = page({ first: 100 });
  const lastP = n > 100 ? page({ last: Math.min(100, n - 100) }) : null;
  const first = await firstP, middle = [];
  // the saved count may be stale: page the middle by the live total; overlaps are dropped below
  let c = first.pageInfo.endCursor, left = first.totalCount - 100 - (lastP ? Math.min(100, n - 100) : 0);
  while (left > 0 && c) { const pg = await page({ first: Math.min(100, left), c }); middle.push(...pg.nodes); left -= pg.nodes.length; c = pg.pageInfo.hasNextPage ? pg.pageInfo.endCursor : null; }
  const last = lastP ? (await lastP).nodes : [];
  // items can move between requests: keep each once
  const seen = new Set(), items = [...first.nodes, ...middle, ...last].filter((t) => !seen.has(t.id) && seen.add(t.id));
  return items.filter((t) => t.content).map((t) => ({
    title: t.content.title, number: t.content.number ?? null, url: t.content.url || p.url, repo: t.content.repository?.name ?? null,
    updatedAt: t.content.updatedAt, labels: t.content.labels?.nodes ?? [], status: t.status?.name || 'No status', due: t.due?.date ?? null,
    createdAt: t.content.createdAt,
    author: t.content.author?.login ?? null, comments: t.content.comments?.totalCount ?? 0, milestone: t.content.milestone?.title ?? null,
    state: t.content.state ?? null, closedAt: t.content.closedAt ?? null, assignees: t.content.assignees.nodes.map((a) => a.login),
  }));
}

// orgs this token can see, for the settings picker
async function listOwners(token) {
  const d = await gql(token, `{viewer{login name organizations(first:100){nodes{login name}}}}`);
  return { login: d.viewer.login, name: d.viewer.name || d.viewer.login, orgs: d.viewer.organizations.nodes.map((o) => ({ login: o.login, name: o.name || o.login })) };
}

function statusFromIssue(n) {
  if (n.state === 'CLOSED') return 'Done';
  const l = n.labels.nodes.map((x) => x.name.toLowerCase()).join(' ');
  if (/block/.test(l)) return 'Blocked';
  if (/in.?progress|\bwip\b|doing/.test(l)) return 'In progress';
  if (/review|testing|\bqa\b/.test(l)) return 'In review';
  if (/backlog|icebox|someday/.test(l)) return 'Backlog';
  return 'Todo';
}
function issueTask(n) {
  return { title: n.title, number: n.number, url: n.url, repo: n.repository.name, updatedAt: n.updatedAt, labels: n.labels.nodes,
    status: statusFromIssue(n), due: n.milestone?.dueOn?.slice(0, 10) ?? null, body: (n.bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 260),
    createdAt: n.createdAt, author: n.author?.login ?? null, comments: n.comments?.totalCount ?? 0, milestone: n.milestone?.title ?? null,
    state: n.state, closedAt: n.closedAt, assignees: n.assignees.nodes.map((a) => a.login) };
}

async function fetchAll(token, onBoards, prev) {
  // known account with saved orgs: nothing to wait for, so every request starts right away
  const known = accts.active && settingsFor(accts.active).owners ? accts.active : null;
  const whoP = listOwners(token);
  const who = known ? null : await whoP, me = known || who.login, cfg = settingsFor(me);
  if (!cfg.owners) {
    // one org: just use it; none: your own projects; several: ask
    if (who.orgs.length > 1) return { needsSetup: true, who };
    cfg.owners = who.orgs.length ? [{ login: who.orgs[0].login, type: 'org' }] : [{ login: me, type: 'user' }];
    saveSettings();
  }
  const since = (days) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const scope = cfg.owners.map((o) => `${o.type === 'org' ? 'org' : 'user'}:${o.login}`).join(' ');
  const search = async (q) => (await gql(token, SEARCH, { q: `${scope} ${q}` })).search.nodes.filter((n) => n.__typename);
  const pr = (n) => ({ kind: n.__typename, title: n.title, number: n.number, url: n.url, repo: n.repository.name, author: n.author?.login,
    updatedAt: n.updatedAt, closedAt: n.mergedAt || n.closedAt, draft: n.isDraft || false, review: n.reviewDecision || null,
    checks: n.commits?.nodes[0]?.commit.statusCheckRollup?.state || null, labels: n.labels?.nodes || [],
    reviewers: (n.reviewRequests?.nodes || []).map((r) => r.requestedReviewer?.login).filter(Boolean) });
  const listsP = Promise.all(cfg.owners.map(async (o) => {
    const d = await gql(token, o.type === 'org'
      ? `query($l:String!){owner: organization(login:$l){projectsV2(first:50){${PROJECTS}}}}`
      : `query($l:String!){owner: user(login:$l){projectsV2(first:50){${PROJECTS}}}}`, { l: o.login });
    return (d.owner?.projectsV2.nodes || []).map((p) => ({ ...p, owner: o.login, key: `${o.login}/${p.number}` }));
  }));
  // start the boards from last time's list at once; the fresh list comes in alongside and adds or drops boards
  const boardJobs = new Map(), startBoard = (p) => { if (!boardJobs.has(p.id)) boardJobs.set(p.id, loadBoard(token, p, cfg)); return boardJobs.get(p.id); };
  (prev?.projects || []).filter((p) => p.kind !== 'repo' && p.id).forEach(startBoard);
  const bySearch = async (q) => (await gql(token, SEARCH, { q })).search.nodes.filter((n) => n.__typename === 'Issue');
  const now = new Date(), cFrom = new Date(now - 70 * 864e5);
  // boards first: everything else starts at the same moment but never holds the boards back
  const boardsP = listsP.then((lists) => {
    const projects = lists.flat().filter((p) => !p.closed && !/untitled|template/i.test(p.title));
    return Promise.all(projects.map(startBoard)).then((boards) => { projects.forEach((p, i) => { p.tasks = boards[i]; }); return projects; });
  });
  const extrasP = Promise.all([
    search(`is:pr is:open updated:>=${since(60)}`),
    search(`is:open mentions:${me} updated:>=${since(30)}`),
    search(`is:issue assignee:${me} closed:>=${since(62)}`),
    search(`is:pr author:${me} is:merged merged:>=${since(62)}`),
    cfg.repoIssues ? search(`is:issue is:open assignee:${me}`) : [],
    // ponytail: first 100 open + recently closed issues per added repo; paginate if a repo outgrows that
    Promise.all(cfg.repos.map(async (r) => [...await bySearch(`repo:${r} is:issue is:open`), ...await bySearch(`repo:${r} is:issue is:closed closed:>=${since(14)}`)])),
    // the same green squares as the GitHub profile: commits, PRs, reviews and issues, private repos included
    gql(token, 'query($from:DateTime!,$to:DateTime!){viewer{contributionsCollection(from:$from,to:$to){contributionCalendar{weeks{contributionDays{date contributionCount}}}}}}', { from: cFrom.toISOString(), to: now.toISOString() })
      .then((d) => Object.fromEntries(d.viewer.contributionsCollection.contributionCalendar.weeks.flatMap((w) => w.contributionDays).map((x) => [x.date, x.contributionCount])))
      .catch(() => null),
  ]);
  const projects = await boardsP, whoNow = who || await whoP;
  onBoards?.({ login: me, name: whoNow.name, orgs: whoNow.orgs, owners: cfg.owners, projects });
  const [openPRs, mentions, closed, merged, myOpen, repoLists, contrib] = await extrasP;
  // issues that live in a repo but on no board become repo cards
  const boardTask = new Map(projects.flatMap((p) => p.tasks.map((t) => [t.url, t])));
  const repoCards = new Map();
  const cardFor = (nameWithOwner) => {
    if (!repoCards.has(nameWithOwner)) {
      const [owner, name] = nameWithOwner.split('/');
      repoCards.set(nameWithOwner, { kind: 'repo', key: `repo:${nameWithOwner}`, owner, title: name, url: `https://github.com/${nameWithOwner}/issues`, tasks: [], seen: new Set() });
    }
    return repoCards.get(nameWithOwner);
  };
  cfg.repos.forEach((r) => cardFor(r));
  // added repos keep issues that are also on a board (flagged onBoard, shown when that repo is picked);
  // the automatic cards only collect issues that are on no board at all
  const addIssue = (n, added) => {
    const b = boardTask.get(n.url);
    if (b && !added) return;
    const c = cardFor(`${n.repository.owner.login}/${n.repository.name}`);
    if (c.seen.has(n.url)) return;
    c.seen.add(n.url);
    c.tasks.push(b ? { ...issueTask(n), status: b.status, due: b.due, onBoard: true } : issueTask(n));
  };
  repoLists.flat().forEach((n) => addIssue(n, true));
  if (cfg.repoIssues) { myOpen.forEach((n) => addIssue(n)); closed.filter((n) => n.__typename === 'Issue' && n.closedAt >= since(14)).forEach((n) => addIssue(n)); }
  for (const c of repoCards.values()) { delete c.seen; c.added = cfg.repos.includes(`${c.owner}/${c.title}`); if (c.tasks.length || c.added) projects.push(c); }
  return { v: DATA_VERSION, contrib, login: me, name: whoNow.name, orgs: whoNow.orgs, owners: cfg.owners, projects, openPRs: openPRs.map(pr), mentions: mentions.map(pr), recent: [...closed, ...merged].map(pr), at: Date.now() };
}

const cacheKey = (login) => 'cache.' + login;
// bump when the shape of loaded data changes, so data saved by older code is refetched instead of shown
const DATA_VERSION = 6;
const readCache = (login) => { try { const d = JSON.parse(localStorage.getItem(cacheKey(login))); return d?.v === DATA_VERSION ? d : null; } catch { return null; } };
const writeCache = (d) => { try { localStorage.setItem(cacheKey(d.login), JSON.stringify(d)); } catch {} };

function setData(d) {
  data = d || EMPTY;
  if (data.projects.length && (data.owners || []).length === 1) migrateBarIds();
  paintMeta(); renderLinks(); render();
}
function paintMeta() {
  $('#ago').textContent = !data.at ? '' : ago(new Date(data.at).toISOString()) === 'today'
    ? new Date(data.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ago(new Date(data.at).toISOString());
  $('#refresh').title = data.at ? `Refresh (last loaded ${new Date(data.at).toLocaleString()})` : 'Refresh';
}

// offline: a badge says what you're looking at; coming back online refreshes on its own
let offline = false;
function setOffline(on) {
  offline = on;
  const el = $('#offline');
  if (!el) return;
  el.hidden = !on;
  if (on) el.querySelector('span').textContent = data.at ? `showing data from ${new Date(data.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : 'nothing saved yet';
}
addEventListener('offline', () => setOffline(true));
addEventListener('online', () => {
  if (!offline) return;
  toast('Back online. Refreshing…');
  loadError = '';
  setTimeout(() => { loadLive(true); loadNews(true); }, 600);
});
let loading = false, reloadQueued = false;
async function loadLive(force) {
  const a = activeAcct(), token = a && tokens[a.login];
  if (!token) return;
  if (loading) { if (force) reloadQueued = true; return; }
  if (!force && data.at && Date.now() - data.at < STALE_MS) return;
  if (!navigator.onLine) { setOffline(true); if (!data.at) { loadError = "Couldn't reach GitHub. You're offline"; setData(null); } return; }
  loading = true; loadError = ''; if (!data.at) setData(null);
  $('#refresh').classList.add('spin'); $('#ago').textContent = 'Loading…';
  try {
    const d = await fetchAll(token, (b) => {
      if (accts.active !== a.login) return;
      const prev = data.login === b.login ? data : null;
      setData({ ...(prev || EMPTY), ...b, v: DATA_VERSION, at: Date.now(), extrasPending: !prev,
        projects: b.projects.concat(prev ? prev.projects.filter((p) => p.kind === 'repo') : []) });
      $('#ago').textContent = 'Updating…';
    }, data.login === a.login ? data : readCache(a.login));
    if (accts.active !== a.login) return; // switched account while loading
    if (d.needsSetup) { openSettings(d.who, true); return; }
    writeCache(d);
    a.name = d.name; saveAccts();
    paintIdentity(); setData(d); setOffline(false);
  } catch (e) {
    if (e.auth) { delete tokens[a.login]; saveTokens(); signinReason = `GitHub no longer accepts the token for @${a.login}. Paste a new one to reconnect.`; paintIdentity(); }
    else if (/reach GitHub/.test(e.message)) { if (!data.at) loadError = e.message; setOffline(true); paintMeta(); if (!data.at) setData(null); }
    else { loadError = e.message; paintMeta(); $('#ago').textContent = '⚠ ' + e.message; if (!data.at) setData(null); }
  } finally {
    loading = false; $('#refresh').classList.remove('spin');
    if (reloadQueued) { reloadQueued = false; loadLive(true); }
    if (!$('#ago').textContent.startsWith('⚠')) paintMeta();
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const load = () => { try { return JSON.parse(localStorage.getItem('prefs')) || {}; } catch { return {}; } };
const state = Object.assign({ tab: 'todo', scope: 'mine', project: null, q: '' }, load(), { q: '', expanded: {} });
const save = () => { try { localStorage.setItem('prefs', JSON.stringify({ tab: state.tab, scope: state.scope, project: state.project })); } catch {} };

const tabOf = (status) => (TABS.find((t) => t.test.test(status)) || TABS[4]).key;
const colorOf = (status) => {
  if (/staging/i.test(status)) return 'var(--staging)';
  return `var(--${tabOf(status)})`;
};
// Target date is a plain YYYY-MM-DD; compare as local calendar days
function dueChip(date, tab) {
  const [y, m, d] = date.split('-').map(Number);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(y, m - 1, d) - today) / 864e5);
  const day = new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  if (tab === 'done') return `<span class="due">${day}</span>`;
  if (days < 0) return `<span class="due late" title="Due ${day}">${-days}d overdue</span>`;
  if (days === 0) return `<span class="due soon">Due today</span>`;
  if (days === 1) return `<span class="due soon">Due tomorrow</span>`;
  if (days < 7) return `<span class="due soon" title="Due ${day}">Due ${new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short' })}</span>`;
  return `<span class="due">Due ${day}</span>`;
}

function ago(iso) {
  const d = (Date.now() - new Date(iso)) / 864e5;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 30) return `${Math.floor(d)}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

// base filter: everything except tab + project, so both can show counts
function base(forKey = state.project) {
  const q = state.q.toLowerCase();
  return data.projects.flatMap((p) => p.tasks.map((t) => ({ ...t, project: p })))
    .filter((t) => !t.onBoard || t.project.key === forKey)
    .filter((t) => state.scope === 'all' || t.assignees.includes(data.login) || (t.project.added && t.project.key === forKey))
    .filter((t) => !q || t.title.toLowerCase().includes(q) || String(t.number).includes(q) || (t.repo || '').toLowerCase().includes(q));
}


// ---------- notes: personal to-dos, kept in this browser only
const NOTES_KEY = 'notes.v1';
let notes = (() => { try { return JSON.parse(localStorage.getItem(NOTES_KEY)) || []; } catch { return []; } })();
const saveNotes = () => { try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); } catch {} };
const ICON_CAL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
let noteDue = '';
const dayOffset = (n) => { const d = startOfDay(new Date()); d.setDate(d.getDate() + n); return isoDate(d); };
function startOfDay(d) { d = new Date(d); d.setHours(0, 0, 0, 0); return d; }
function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const nextMonday = () => { const d = startOfDay(new Date()); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return isoDate(d); };
const openNotes = () => notes.filter((n) => !n.done);
const dueNow = () => openNotes().filter((n) => n.due && n.due <= isoDate(new Date()));
const sortNotes = (xs) => xs.slice().sort((a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1) || (a.due || '').localeCompare(b.due || '') || b.createdAt - a.createdAt);

// small due line under a note: colored only when it needs attention
function noteDueText(due, done) {
  const [y, m, dd] = due.split('-').map(Number), day = new Date(y, m - 1, dd);
  const days = Math.round((day - startOfDay(new Date())) / 864e5);
  const short = day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  if (done) return { text: short, cls: '' };
  if (days < 0) return { text: days === -1 ? 'Yesterday, overdue' : `${-days} days overdue`, cls: 'late' };
  if (days === 0) return { text: 'Today', cls: 'soon' };
  if (days === 1) return { text: 'Tomorrow', cls: 'soon' };
  if (days < 7) return { text: day.toLocaleDateString(undefined, { weekday: 'long' }), cls: '' };
  return { text: short, cls: '' };
}

function noteRow(n) {
  const d = n.due && noteDueText(n.due, n.done);
  return `<li class="note${n.done ? ' done' : ''}" data-note="${n.id}">
    <button type="button" class="chk" data-note-chk aria-label="${n.done ? 'Mark not done' : 'Mark done'}" aria-pressed="${!!n.done}">${ICON_OK}</button>
    <div class="nbody"><span class="ntext" data-note-edit tabindex="0" title="Click to edit">${esc(n.text)}</span>
      ${d ? `<span class="ndue ${d.cls}">${d.text}</span>` : ''}</div>
    <span class="tools">
      <button type="button" class="c-icon" data-note-cal title="${n.due ? 'Change or clear the due date' : 'Add a due date'}" aria-label="Due date">${ICON_CAL}</button>
      <button type="button" class="c-icon" data-note-del title="Delete note" aria-label="Delete note">${ICON_DEL}</button>
    </span>
    <input type="date" class="pick" data-note-pick value="${n.due || ''}" tabindex="-1" aria-hidden="true">
  </li>`;
}

function notesHTML() {
  const open = sortNotes(openNotes()), done = notes.filter((n) => n.done).sort((a, b) => b.doneAt - a.doneAt);
  const picks = [['', 'No date'], [dayOffset(0), 'Today'], [dayOffset(1), 'Tomorrow'], [nextMonday(), 'Next week']];
  const custom = noteDue && !picks.some(([v]) => v === noteDue);
  return `<section class="notes">
    <form class="note-add" autocomplete="off">
      <input name="text" placeholder="Add a note or a quick to-do" aria-label="New note" maxlength="240">
      <div class="note-opts"><span class="lbl">Due</span>
        ${picks.map(([v, l]) => `<button type="button" class="chip" data-due="${v}" aria-pressed="${noteDue === v}">${l}</button>`).join('')}
        <input type="date" data-due-custom class="${custom ? 'set' : ''}" value="${custom ? noteDue : ''}" aria-label="Pick a date">
        <button class="add" disabled>Add</button>
      </div>
    </form>
    ${open.length ? `<ul class="note-list">${open.map(noteRow).join('')}</ul>` : `<p class="notes-empty">${done.length ? 'All done.' : 'Nothing here yet.'} Notes stay in this browser and never go to GitHub.</p>`}
    ${done.length ? `<details class="done-notes"${state.notesDoneOpen ? ' open' : ''}><summary>Completed (${done.length})</summary>
      <ul class="note-list">${done.map(noteRow).join('')}</ul>
      <p><button type="button" class="txt-btn danger" data-notes-clear>Clear completed</button></p></details>` : ''}
  </section>`;
}

// notes sidebar next to the task boards; hidden on the Notes tab itself
const NOTE_CAP = 8;
function renderRail() {
  const rail = $('#rail');
  $('#work').classList.toggle('with-rail', state.tab !== 'notes');
  if (state.tab === 'notes') { rail.innerHTML = ''; return; }
  const add = document.activeElement?.closest('#rail .note-add'), typed = add?.elements.text.value;
  rail.innerHTML = notesCard() + newsCard();
  if (add) { const i = $('#rail .note-add input[name="text"]'); i.value = typed; i.focus(); }
}
function notesCard() {
  const open = sortNotes(openNotes()), shown = open.slice(0, NOTE_CAP);
  return `<section class="rail-card"><header><h2>Notes</h2><span class="n">${open.length || ''}</span>
      <a href="#" data-tab-link="notes">All notes</a></header>
    <form class="note-add mini" autocomplete="off">
      <input name="text" placeholder="Add a note, Enter to save" aria-label="New note" maxlength="240">
      ${noteDue ? `<button type="button" class="due-set" data-due="" title="Remove due date">${dueChip(noteDue, 'todo')}<span aria-hidden="true">✕</span></button>` : ''}
      <button type="button" class="c-icon" data-mini-cal title="Set a due date" aria-label="Set a due date">${ICON_CAL}</button>
      <input type="date" class="pick" data-due-custom value="${noteDue}" tabindex="-1" aria-hidden="true">
    </form>
    ${shown.length ? `<ul class="note-list flat">${shown.map(noteRow).join('')}</ul>` : '<p class="rail-empty">Quick to-dos just for you. They stay in this browser.</p>'}
    ${open.length > NOTE_CAP ? `<button class="more" data-tab-link="notes">${open.length - NOTE_CAP} more in Notes</button>` : ''}
  </section>`;
}

function focusNoteInput() { const i = $('.note-add input[name="text"]'); if (i) i.focus(); }
function openNotesAndAdd() { if (state.tab !== 'notes') { state.tab = 'notes'; render(); } focusNoteInput(); }
const findNote = (el) => notes.find((n) => n.id === el.closest('[data-note]')?.dataset.note);
function rerenderKeepFocus() { const add = document.activeElement?.closest('.note-add'); render(); if (add) focusNoteInput(); }

$('#work').addEventListener('input', (e) => { if (e.target.name === 'text') { const b = e.target.form.querySelector('.add'); if (b) b.disabled = !e.target.value.trim(); } });
$('#work').addEventListener('submit', (e) => {
  if (!e.target.classList.contains('note-add')) return;
  e.preventDefault();
  const text = e.target.elements.text.value.trim(); if (!text) return;
  notes.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, due: noteDue || null, done: false, createdAt: Date.now() });
  noteDue = ''; saveNotes(); render(); focusNoteInput();
});
$('#work').addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-tab-link]')) { e.preventDefault(); setTab(t.closest('[data-tab-link]').dataset.tabLink); return; }
  if (t.closest('[data-mini-cal]')) { const pk = t.closest('form').querySelector('.pick'); try { pk.showPicker(); } catch { pk.focus(); } return; }
  if (t.closest('[data-due]')) { const v = t.closest('[data-due]').dataset.due; noteDue = noteDue === v ? '' : v; rerenderKeepFocus(); return; }
  const n = findNote(t); if (!n && !t.closest('[data-notes-clear]')) return;
  if (t.closest('[data-note-chk]')) {
    n.done = !n.done; n.doneAt = n.done ? Date.now() : null; saveNotes();
    if (n.done) { const r = t.closest('[data-note-chk]').getBoundingClientRect(); confetti(r.left + r.width / 2, r.top); fun.notesDone++; saveFun(); }
    render();
  }
  else if (t.closest('[data-note-del]')) {
    // two-step: first click arms the button, second click within 3s deletes
    const btn = t.closest('[data-note-del]'), li = btn.closest('.note');
    if (btn.classList.contains('armed')) { notes = notes.filter((x) => x !== n); saveNotes(); render(); return; }
    btn.classList.add('armed'); li.classList.add('confirming');
    btn.innerHTML = 'Delete?'; btn.title = 'Click again to delete'; btn.setAttribute('aria-label', 'Confirm delete');
    setTimeout(() => { if (btn.isConnected) { btn.classList.remove('armed'); li.classList.remove('confirming'); btn.innerHTML = ICON_DEL; btn.title = 'Delete note'; btn.setAttribute('aria-label', 'Delete note'); } }, 3000);
  }
  else if (t.closest('[data-note-nodue]')) { n.due = null; saveNotes(); render(); }
  else if (t.closest('[data-note-cal]')) { const pick = t.closest('[data-note]').querySelector('[data-note-pick]'); try { pick.showPicker(); } catch { pick.focus(); } }
  else if (t.closest('[data-notes-clear]')) { notes = notes.filter((x) => !x.done); saveNotes(); render(); }
  else if (t.closest('[data-note-edit]')) startEdit(t.closest('[data-note-edit]'), n);
});
$('#work').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-note-edit]')) { e.preventDefault(); startEdit(e.target, findNote(e.target)); } });
$('#work').addEventListener('change', (e) => {
  if (e.target.matches('[data-due-custom]')) { noteDue = e.target.value || ''; rerenderKeepFocus(); }
  else if (e.target.matches('[data-note-pick]')) { const n = findNote(e.target); n.due = e.target.value || null; saveNotes(); render(); }
});
$('#work').addEventListener('toggle', (e) => { if (e.target.classList?.contains('done-notes')) state.notesDoneOpen = e.target.open; }, true);

function startEdit(span, n) {
  if (!n || n.done) return;
  const input = document.createElement('input');
  input.className = 'ntext-edit'; input.value = n.text; input.maxLength = 240; input.setAttribute('aria-label', 'Edit note');
  span.replaceWith(input); input.focus(); input.select();
  let finished = false;
  const finish = (keep) => { if (finished) return; finished = true; const v = input.value.trim(); if (keep && v) { n.text = v; saveNotes(); } render(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') { e.stopPropagation(); finish(false); } });
  input.addEventListener('blur', () => finish(true));
}

// only one panel open at a time: opening one closes the rest
function closePopovers(keep) {
  if (keep !== 'standup') closeStandup();
  if (keep !== 'env' && envpop.classList.contains('on')) closeEnvPop();
  if (keep !== 'acct') closeAcct();
  if (keep !== 'settings') closeSettings();
  if (keep !== 'fun') closeFun();
}

// ---------- skeletons, shown only until the first load for this account arrives
let loadError = '';
const firstLoad = () => !data.at && !loadError && !!(activeAcct() && tokens[accts.active]);
const W = [72, 58, 84, 64, 90, 52, 76, 68]; // row widths in %, fixed so the shapes don't jump
function skeletonBoards() {
  const card = (rows, o) => `<section class="project sk-card" aria-hidden="true"><header><span class="sk" style="width:${34 + o * 9}%;height:18px"></span></header><ul>
    ${Array.from({ length: rows }, (_, i) => `<li class="sk-row"><span class="sk" style="width:36px"></span><span class="sk" style="width:${W[(i + o * 3) % W.length]}%"></span><span class="sk" style="width:34px"></span></li>`).join('')}</ul></section>`;
  return `<p class="sr-only" role="status">Loading your boards from GitHub</p>${card(8, 0)}${card(6, 1)}`;
}

function paintSummary() {
  const el = $('#greet-sub');
  if (!data.at) { el.textContent = firstLoad() ? 'Loading your work…' : ''; return; }
  const mine = data.projects.flatMap((p) => p.tasks).filter((t) => !t.onBoard && t.assignees.includes(data.login)); // counted like the tabs, so the numbers match
  const n = (k) => mine.filter((t) => tabOf(t.status) === k).length, due = dueNow().length;
  const parts = [[n('todo'), 'to do'], [n('progress'), 'in progress'], [n('blocked'), 'blocked'], [due, due === 1 ? 'note due today' : 'notes due today']]
    .filter(([c], i) => c || i < 2);
  watchInboxZero(); checkBadges();
  el.innerHTML = parts.map(([c, l]) => `<b>${c}</b> ${l}`).join(', ') + funChips();
  paintFunFooter();
}

function render(animate) {
  document.documentElement.classList.toggle('loading', firstLoad());
  const all = base();
  const inTab = all.filter((t) => tabOf(t.status) === state.tab);
  const projects = data.projects.filter((p) => all.some((t) => t.project === p));
  if (state.project && !projects.some((p) => p.key === state.project)) state.project = null;
  if (state.scope === 'mine' && state.project && !barProjects().some((p) => p.id === 'board-' + state.project)) state.project = null;
  const shown = inTab.filter((t) => !state.project || t.project.key === state.project);

  renderWaiting();
  renderRail();
  paintSummary();
  // scope buttons
  document.querySelectorAll('[data-scope]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.scope === state.scope));

  // status words
  $('#statuses').innerHTML = TABS.map((t, i) => {
    const n = all.filter((x) => tabOf(x.status) === t.key && (!state.project || x.project.key === state.project)).length;
    return `<button class="st${n ? '' : ' zero'}" role="tab" data-tab="${t.key}" aria-selected="${t.key === state.tab}"
      style="--c:var(--${t.key})" title="${i + 1}">${t.name}<sup>${n}</sup></button>`;
  }).join('') + `<span class="st-sep" aria-hidden="true"></span><button class="st${openNotes().length ? '' : ' zero'}" role="tab" data-tab="notes" aria-selected="${state.tab === 'notes'}"
      style="--c:var(--staging)" title="${TABS.length + 1} · N adds a note">Notes<sup>${openNotes().length}</sup></button>` + '<span class="bar" id="bar"></span>';
  const sel = $(`.st[data-tab="${state.tab}"]`), bar = $('#bar');
  bar.style.left = sel.offsetLeft + 'px'; bar.style.width = sel.offsetWidth + 'px';
  bar.style.setProperty('--c', state.tab === 'notes' ? 'var(--staging)' : `var(--${state.tab})`);

  // project chips (counts within current tab)
  const chipCount = (p) => inTab.filter((t) => !p || t.project === p).length;
  // Mine: the projects bar up top doubles as the filter, so the chip row is hidden
  syncBarChips();
  $('#chips').innerHTML = state.tab === 'notes' || state.scope === 'mine' || projects.length < 2 ? '' :
    [`<button class="chip" data-project="" aria-pressed="${!state.project}">All projects<span>${chipCount()}</span></button>`]
      .concat(projects.filter((p) => chipCount(p) || state.project === p.key).map((p) => `<button class="chip" data-project="${esc(p.key)}" aria-pressed="${state.project === p.key}">${multiOwner() ? `<small>${esc(p.owner)}</small> ` : ''}${esc(p.title)}<span>${chipCount(p)}</span></button>`)).join('');

  // list
  const list = $('#list');
  const paint = () => {
    document.getElementById('card').classList.remove('on');
    if (state.tab === 'notes') { list.className = ''; list.innerHTML = notesHTML(); return; }
    if (!data.at) {
      list.className = loadError ? '' : 'board';
      list.innerHTML = loadError ? `<div class="empty">Couldn't load your boards: ${esc(loadError)}. <button data-retry>Try again</button></div>` : firstLoad() ? skeletonBoards() : '';
      return;
    }
    const dueCard = '';
    if (!shown.length && dueCard) { list.className = 'board single'; list.innerHTML = dueCard; return; }
    if (!shown.length) {
      const next = TABS.find((t) => all.some((x) => tabOf(x.status) === t.key && t.key !== state.tab && t.key !== 'done'));
      const tabName = TABS.find((t) => t.key === state.tab).name.toLowerCase();
      list.innerHTML = `<div class="empty">${state.q ? `No ${tabName} tasks match “${esc(state.q)}”.` : `Nothing ${state.tab === 'blocked' ? 'blocked' : 'in ' + tabName} right now.`}
        ${next ? ` <button data-tab="${next.key}">See ${next.name.toLowerCase()}</button>` : ''}</div>`;
      return;
    }
    rowTasks = [];
    const groups = projects.map((p) => [p, shown.filter((t) => t.project === p)]).filter(([, ts]) => ts.length);
    const mixedStatus = new Set(shown.map((t) => t.status)).size > 1;
    list.className = groups.length + (dueCard ? 1 : 0) === 1 ? 'board single' : 'board';
    list.innerHTML = dueCard + groups.map(([p, ts]) => {
      // dated tasks first, soonest due on top; the rest by recent activity
      ts.sort((a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1) || (a.due || '').localeCompare(b.due || '') || new Date(b.updatedAt) - new Date(a.updatedAt));
      // a label or repo on most rows says nothing; show only the exceptions
      const common = (vals) => { const c = {}; vals.forEach((v) => (c[v] = (c[v] || 0) + 1)); return new Set(Object.keys(c).filter((k) => c[k] > ts.length / 2)); };
      const commonLabels = common(ts.flatMap((t) => t.labels.map((l) => l.name)));
      const commonRepo = common(ts.map((t) => t.repo));
      const open = state.expanded[p.key];
      const rows = (open ? ts : ts.slice(0, ROW_CAP)).map((t) => {
        const i = rowTasks.push(t) - 1;
        const days = (Date.now() - new Date(t.updatedAt)) / 864e5;
        return `<li><a href="${esc(t.url)}" data-i="${i}" aria-describedby="card">
          <span class="num">${t.number ? '#' + t.number : 'draft'}</span>
          <span class="title">${esc(t.title)}</span>
          <span class="meta">
            ${t.state === 'CLOSED' && state.tab !== 'done' ? `<span class="closed-tag" title="Closed on GitHub ${fmtDate(t.closedAt)}; the board still says ${esc(t.status)}">${ICON_OK}Closed</span>` : ''}
            ${t.due ? dueChip(t.due, state.tab) : ''}
            ${mixedStatus ? `<span class="raw" style="--c:${colorOf(t.status)}">${esc(t.status)}</span>` : ''}
            ${t.labels.filter((l) => !commonLabels.has(l.name)).slice(0, 2).map((l) => `<span class="label" style="--lc:#${l.color}"><i></i>${esc(l.name)}</span>`).join('')}
            ${t.repo && !commonRepo.has(t.repo) ? `<span>${esc(t.repo)}</span>` : ''}
            <span class="${days > 30 ? 'old' : ''}" title="Updated ${new Date(t.updatedAt).toLocaleDateString()}">${ago(t.updatedAt)}</span>
            ${state.scope === 'all' ? `<span class="people">${t.assignees.map((a) => `<img src="${esc(avatarOf(a, 44))}" alt="${esc(a)}" title="${esc(a)}">`).join('')}</span>` : ''}
          </span></a></li>`;
      }).join('');
      const more = ts.length > ROW_CAP ? `<button class="more" data-expand="${esc(p.key)}">${open ? 'Show fewer' : `Show all ${ts.length}`}</button>` : '';
      return `<section class="project"><header>${multiOwner() ? `<span class="owner">${esc(p.owner)}</span>` : ''}<h2>${esc(p.title)}</h2>${p.kind === 'repo' ? '<span class="kind-tag" title="Issues from this repository that are not on a project board">repo</span>' : ''}<span class="n">${ts.length}</span>
        <a href="${esc(p.url)}">${p.kind === 'repo' ? 'Open issues' : 'Open board'}</a></header><ul>${rows}</ul>${more}</section>`;
    }).join('');
  };
  if (animate) { list.classList.add('swap'); setTimeout(() => { paint(); list.classList.remove('swap'); }, 120); }
  else paint();
  save();
}

function setTab(key) { if (key !== state.tab) { state.tab = key; render(true); } }

document.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'mode') toggleMode();
  else if ('retry' in b.dataset) loadLive(true);
  else if ('prsToggle' in b.dataset) { state.prsOpen = !state.prsOpen; renderWaiting(); }
  else if (b.dataset.tab) setTab(b.dataset.tab);
  else if (b.dataset.scope) { state.scope = b.dataset.scope; render(true); }
  else if ('project' in b.dataset) { state.project = b.dataset.project || null; render(true); }
  else if (b.dataset.expand) { state.expanded[b.dataset.expand] = !state.expanded[b.dataset.expand]; render(); }
});
$('#q').addEventListener('input', (e) => { state.q = e.target.value; render(); });
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') { if (e.key === 'Escape') { e.target.value = ''; state.q = ''; e.target.blur(); render(); } return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
  else if (e.key >= '1' && e.key <= String(TABS.length)) setTab(TABS[+e.key - 1].key);
  else if (e.key === String(TABS.length + 1)) setTab('notes');
  else if (e.key.toLowerCase() === 'n') { e.preventDefault(); openNotesAndAdd(); }
  else if (e.key.toLowerCase() === 'm') { state.scope = state.scope === 'mine' ? 'all' : 'mine'; render(true); }
});

// ---------- accounts
// tokens live in this extension's own storage; no web page can read it
const ACCT_KEY = 'accounts.v1';
const accts = Object.assign({ active: null, list: [] }, (() => { try { return JSON.parse(localStorage.getItem(ACCT_KEY)); } catch { return null; } })());
const saveAccts = () => { try { localStorage.setItem(ACCT_KEY, JSON.stringify(accts)); } catch {} };
// on the file:// test page every local file shares storage, so tokens only live for the tab session there
// the extension always keeps tokens in its own storage. The file:// test page shares storage with every
// local file, so there it's a choice: remember on this computer (default) or only for this tab.
const IS_FILE = location.protocol === 'file:';
const readTokens = (store) => { try { return JSON.parse(store.getItem('tokens.v1')) || {}; } catch { return {}; } };
const tokens = { ...readTokens(localStorage), ...(IS_FILE ? readTokens(sessionStorage) : {}) };
const tabOnly = new Set(IS_FILE ? Object.keys(readTokens(sessionStorage)) : []);
const saveTokens = () => {
  const keep = Object.fromEntries(Object.entries(tokens).filter(([k]) => !tabOnly.has(k)));
  const tab = Object.fromEntries(Object.entries(tokens).filter(([k]) => tabOnly.has(k)));
  try { localStorage.setItem('tokens.v1', JSON.stringify(keep)); if (IS_FILE) sessionStorage.setItem('tokens.v1', JSON.stringify(tab)); } catch {}
};
let signinReason = '';
const activeAcct = () => accts.list.find((a) => a.login === accts.active);
const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=read:project,repo,read:org&description=Tabboard';

function paintIdentity() {
  const a = activeAcct(), connected = a && tokens[a.login];
  $('#signin').hidden = !!connected;
  if (!connected) return paintSignin();
  const h = new Date().getHours();
  $('#hello').textContent = greetingText(a.name || a.login);
  $('#me').src = avatarOf(a.login); $('#me').alt = a.login;
}

// checks a token with GitHub; returns { login, name } or throws a readable message
async function checkToken(token) {
  let res;
  try { res = await fetch('https://api.github.com/user', { headers: { Authorization: `bearer ${token}` } }); }
  catch { throw new Error("Couldn't reach GitHub. Check your connection."); }
  if (res.status === 401) throw new Error('GitHub rejected that token. Check it was copied in full and has not expired.');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}. Try again in a moment.`);
  const u = await res.json(), scopes = (res.headers.get('x-oauth-scopes') || '').split(',').map((x) => x.trim());
  const missing = ['read:project', 'repo'].filter((x) => !scopes.includes(x) && !(x === 'read:project' && scopes.includes('project')));
  return { login: u.login, name: u.name || u.login, missing: res.headers.has('x-oauth-scopes') ? missing : [] };
}

function tokenForm(id, cta) {
  return `<form class="acct-panel" data-token-form="${id}" autocomplete="off">
    <input type="password" name="token" placeholder="ghp_…" aria-label="GitHub token" required>
    ${IS_FILE ? '<label class="remember"><input type="checkbox" name="remember" checked> Remember on this computer <span>(untick to keep it for this tab only)</span></label>' : ''}
    <p class="acct-msg" role="alert"></p>
    <p>Needs a <b>classic</b> token with <b>read:project</b>, <b>repo</b> and <b>read:org</b>. <a href="${TOKEN_URL}" target="_blank" rel="noopener">Create one on GitHub</a></p>
    <div class="acct-actions">${id === 'menu' ? '<button type="button" class="btn" data-acct-back>Cancel</button>' : ''}<button class="btn primary">${cta}</button></div>
  </form>`;
}

function addAccount(u, token, { tabOnly: onlyTab = false, via }) {
  tokens[u.login] = token; if (onlyTab) tabOnly.add(u.login); else tabOnly.delete(u.login);
  saveTokens(); signinReason = '';
  const existing = accts.list.find((a) => a.login === u.login);
  if (existing) Object.assign(existing, { name: u.name, via }); else accts.list.push({ login: u.login, name: u.name, via });
  accts.active = u.login; accts.signedOut = false; saveAccts();
  closeAcct(); paintIdentity(); setData(readCache(u.login)); loadLive(true);
}

// ---------- Sign in with GitHub: OAuth device flow. Needs no client secret and no server; the extension
// talks to github.com/login directly (host permission in the manifest), so it only works inside the extension.
// Client ID of the Tabboard OAuth App (public by design). Forks register their own app and change this line.
const GITHUB_CLIENT_ID = 'Ov23li5wzkDzeSMJJ9oH';
const OAUTH_SCOPES = 'repo read:project read:org';
const canOAuth = () => !!GITHUB_CLIENT_ID && !IS_FILE;
let deviceRun = 0;

async function ghPost(url, params) {
  let r;
  try { r = await fetch(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) }); }
  catch { throw new Error("Couldn't reach GitHub. Check your connection."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.error) throw new Error(`GitHub answered ${r.status}. Try again in a moment.`);
  return j;
}
async function startDeviceFlow(box) {
  const run = ++deviceRun, wait = (s) => new Promise((ok) => setTimeout(ok, s * 1000));
  const fail = (msg) => { if (run === deviceRun) box.innerHTML = `<p class="acct-msg err">${esc(msg)}</p><button type="button" class="btn" data-gh-signin>Try again</button>`; };
  box.innerHTML = '<p class="device-wait">Asking GitHub for a sign-in code…</p>';
  try {
    const d = await ghPost('https://github.com/login/device/code', { client_id: GITHUB_CLIENT_ID, scope: OAUTH_SCOPES });
    if (d.error) return fail(d.error_description || d.error);
    if (run !== deviceRun) return;
    box.innerHTML = `<div class="device-step"><span>1. Copy this code</span>
        <button type="button" class="device-code" data-device-copy="${esc(d.user_code)}" title="Copy code">${esc(d.user_code)}</button></div>
      <div class="device-step"><span>2. Enter it on GitHub and approve</span>
        <a class="btn primary" href="${esc(d.verification_uri)}" target="_blank" rel="noopener" data-device-open="${esc(d.user_code)}">Open GitHub</a></div>
      <p class="device-wait"><span class="spinner" aria-hidden="true"></span>Waiting for you to approve on GitHub… <button type="button" class="txt-btn" data-device-cancel>Cancel</button></p>`;
    let interval = d.interval || 5;
    const until = Date.now() + (d.expires_in || 900) * 1000;
    while (Date.now() < until) {
      await wait(interval);
      if (run !== deviceRun) return;
      const t = await ghPost('https://github.com/login/oauth/access_token', { client_id: GITHUB_CLIENT_ID, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      if (t.access_token) {
        if (run !== deviceRun) return;
        box.innerHTML = '<p class="device-wait">Signed in. Loading your boards…</p>';
        const u = await checkToken(t.access_token);
        return addAccount(u, t.access_token, { via: 'oauth' });
      }
      if (t.error === 'slow_down') interval += 5;
      else if (t.error === 'access_denied') return fail('Sign-in was cancelled on GitHub.');
      else if (t.error === 'expired_token') return fail('The code expired. Start again to get a new one.');
      else if (t.error && t.error !== 'authorization_pending') return fail(t.error_description || t.error);
    }
    fail('The code expired. Start again to get a new one.');
  } catch (e) { fail(e.message); }
}
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-gh-signin]')) { e.stopPropagation(); startDeviceFlow(t.closest('.auth').querySelector('[data-device]')); }
  else if (t.closest('[data-device-cancel]')) { e.stopPropagation(); deviceRun++; t.closest('[data-device]').innerHTML = ''; }
  else if (t.closest('[data-device-copy], [data-device-open]')) {
    const el = t.closest('[data-device-copy], [data-device-open]'), code = el.dataset.deviceCopy || el.dataset.deviceOpen;
    navigator.clipboard.writeText(code).then(() => { toast(`Code ${code} copied to clipboard`); const c = el.closest('[data-device]').querySelector('.device-code'); c.classList.add('ok'); c.title = 'Copied'; }).catch(() => {});
    if (el.dataset.deviceCopy) e.stopPropagation();
  }
}, true);

// sign-in block: GitHub first when available, the token form as the fallback
function authPanel(id, cta) {
  if (!canOAuth()) return tokenForm(id, cta);
  return `<div class="auth">
    <button type="button" class="btn primary gh-signin" data-gh-signin>${ICON_GH}Sign in with GitHub</button>
    <div data-device></div>
    <details class="token-alt"><summary>Use a token instead</summary>${tokenForm(id, cta)}</details>
  </div>`;
}
// small confirmation at the bottom of the screen
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 1900);
}
const ICON_GH = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

async function submitToken(form) {
  const msg = form.querySelector('.acct-msg'), btn = form.querySelector('.btn.primary'), token = form.elements.token.value.trim();
  if (!token) return;
  btn.disabled = true; btn.textContent = 'Checking…'; msg.className = 'acct-msg'; msg.textContent = '';
  try {
    const u = await checkToken(token);
    if (u.missing.length && !form.dataset.warned) {
      form.dataset.warned = '1';
      msg.className = 'acct-msg warn'; msg.textContent = `This token is missing ${u.missing.join(' and ')}, so some boards may not load. Press again to add it anyway.`;
      btn.disabled = false; btn.textContent = 'Add anyway'; return;
    }
    addAccount(u, token, { tabOnly: form.elements.remember && !form.elements.remember.checked, via: 'token' });
  } catch (e) {
    msg.className = 'acct-msg err'; msg.textContent = e.message;
    btn.disabled = false; btn.textContent = form.dataset.tokenForm === 'menu' ? 'Add account' : 'Connect';
  }
}

const acct = $('#acct'), meBtn = $('#me-btn');
let acctView = 'main';
function paintAcct() {
  const a = activeAcct();
  if (acctView === 'add') { acct.innerHTML = `<div class="acct-label">Add another GitHub account</div>${authPanel('menu', 'Add account')}`; return (acct.querySelector('[data-gh-signin]') || acct.querySelector('input')).focus(); }
  if (acctView === 'logout') {
    const next = accts.list.find((x) => x.login !== a.login);
    acct.innerHTML = `<div class="acct-panel"><p><b>Log out of @${esc(a.login)}?</b></p>
      <p>${a.via === 'oauth' ? `You'll be signed out here. To remove Tabboard's access completely, revoke it in <a href="https://github.com/settings/applications" target="_blank" rel="noopener">GitHub → Settings → Applications</a>.`
        : "Its GitHub token is removed from this browser. To use this account here again, you'll need to paste a GitHub token again."}</p>
      <p>${next ? `You'll switch to <b>@${esc(next.login)}</b>.` : 'You have no other accounts, so you will see the connect screen.'} Your notes and project environments are kept.</p>
      <div class="acct-actions"><button type="button" class="btn" data-acct-back>Cancel</button><button type="button" class="btn red" data-acct-logout-yes>Log out</button></div></div>`;
    return acct.querySelector('[data-acct-back]').focus();
  }
  acct.innerHTML = `<div class="acct-me"><img src="${avatarOf(a.login, 80)}" alt=""><div><b>${esc(a.name || a.login)}</b><span>@${esc(a.login)}</span></div></div>
    <a class="acct-item" href="https://github.com/${esc(a.login)}" target="_blank" rel="noopener" role="menuitem">View GitHub profile<span class="end">${ICON_OPEN}</span></a>
    <div class="acct-sep"></div>
    <div class="acct-label">Accounts</div>
    ${accts.list.map((x) => `<button type="button" class="acct-item${x.login === a.login ? ' current' : ''}" data-acct-switch="${esc(x.login)}" role="menuitemradio" aria-checked="${x.login === a.login}">
      <img src="${avatarOf(x.login, 44)}" alt=""><span class="who">${esc(x.name || x.login)}<small>@${esc(x.login)}</small></span>
      <span class="end">${x.login === a.login ? ICON_OK : 'Switch'}</span></button>`).join('')}
    <button type="button" class="acct-item" data-acct-add role="menuitem">+ Add another account</button>
    <div class="acct-sep"></div>
    <button type="button" class="acct-item danger" data-acct-logout role="menuitem">Log out</button>`;
}
function openAcct() {
  closePopovers('acct');
  acctView = 'main'; paintAcct();
  const r = meBtn.getBoundingClientRect();
  acct.style.top = r.bottom + 8 + 'px'; acct.style.left = Math.max(12, r.right - acct.offsetWidth) + 'px';
  acct.classList.add('on'); meBtn.setAttribute('aria-expanded', 'true');
}
function closeAcct() { acct.classList.remove('on'); meBtn.setAttribute('aria-expanded', 'false'); }
meBtn.addEventListener('click', (e) => { e.stopPropagation(); acct.classList.contains('on') ? closeAcct() : openAcct(); });
acct.addEventListener('click', (e) => {
  e.stopPropagation();
  const t = e.target;
  if (t.closest('[data-acct-switch]')) { accts.active = t.closest('[data-acct-switch]').dataset.acctSwitch; saveAccts(); closeAcct(); paintIdentity(); setData(readCache(accts.active)); loadLive(); }
  else if (t.closest('[data-acct-add]')) { acctView = 'add'; paintAcct(); }
  else if (t.closest('[data-acct-logout]')) { acctView = 'logout'; paintAcct(); }
  else if (t.closest('[data-acct-back]')) { acctView = 'main'; paintAcct(); }
  else if (t.closest('[data-acct-logout-yes]')) {
    const gone = accts.active; delete tokens[gone]; tabOnly.delete(gone); saveTokens(); try { localStorage.removeItem(cacheKey(gone)); } catch {}
    accts.list = accts.list.filter((x) => x.login !== gone);
    accts.active = accts.list[0]?.login || null; accts.signedOut = !accts.active; saveAccts();
    closeAcct(); paintIdentity(); setData(accts.active ? readCache(accts.active) : null); loadLive();
  }
});
document.addEventListener('submit', (e) => { if (e.target.dataset.tokenForm) { e.preventDefault(); submitToken(e.target); } });
document.addEventListener('click', () => { if (acct.classList.contains('on')) closeAcct(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && acct.classList.contains('on')) { closeAcct(); meBtn.focus(); } });

function paintSignin() {
  const a = activeAcct(), others = accts.list.filter((x) => x.login !== a?.login && tokens[x.login]);
  $('#signin').innerHTML = `<div class="signin-card"><h1>${a ? `Reconnect @${esc(a.login)}` : 'Connect GitHub'}</h1>
    <p>${signinReason ? esc(signinReason) : a ? `This browser doesn't have a token for @${esc(a.login)} yet. Paste one to load its boards.`
      : canOAuth() ? 'Sign in to see your GitHub Projects tasks, pull requests and notes on every new tab.' : `Paste a GitHub token to see your GitHub Projects tasks here. ${IS_FILE ? 'It stays on this computer.' : 'It stays in this browser, inside the extension.'}`}</p>
    ${authPanel('signin', 'Connect')}
    <div class="look-pick"><div class="set-label">Pick a look <span>you can change it later in Settings</span></div>
      <div class="look-tiles">${[['brutal', 'Brutal'], ['clay', 'Clay'], ['soft', 'Soft']].map(([v, l]) => `<button type="button" class="look-tile" data-look-pick="${v}" aria-pressed="${document.documentElement.dataset.style === v}">
        <span class="lp lp-${v}" aria-hidden="true"><i></i><i></i><i></i></span><b>${l}</b></button>`).join('')}</div></div>
    ${others.length ? `<div class="others"><div class="set-label">Or switch to an account that's already connected</div>
      ${others.map((x) => `<button type="button" class="acct-item" data-signin-switch="${esc(x.login)}"><img src="${esc(avatarOf(x.login, 44))}" alt=""><span class="who">${esc(x.name || x.login)}<small>@${esc(x.login)}</small></span><span class="end">Switch</span></button>`).join('')}</div>` : ''}</div>`;
  setTimeout(() => $('#signin input')?.focus(), 0);
}

$('#signin').addEventListener('click', (e) => {
  const lk = e.target.closest('[data-look-pick]');
  if (lk) { setStyle(lk.dataset.lookPick); document.querySelectorAll('[data-look-pick]').forEach((x) => x.setAttribute('aria-pressed', x === lk)); return; }
  const b = e.target.closest('[data-signin-switch]'); if (!b) return;
  accts.active = b.dataset.signinSwitch; saveAccts(); signinReason = ''; paintIdentity(); setData(readCache(accts.active)); loadLive();
});
window.addEventListener('resize', () => render());

paintIdentity();
{ // calendar tile + full date for screen readers
  const d = new Date(), tile = $('#date-tile');
  tile.querySelector('.dt-day').textContent = d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
  tile.querySelector('.dt-num').textContent = d.getDate();
  tile.querySelector('.dt-mon').textContent = d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase();
  $('#date').textContent = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

// ---------- projects bar + environments, kept in this browser only
const ENV_KEY = 'projects.v1';
const bar = Object.assign({ added: [], hidden: [], custom: [], envs: {}, icons: {} }, (() => { try { return JSON.parse(localStorage.getItem(ENV_KEY)); } catch { return null; } })());
const saveBar = () => { try { localStorage.setItem(ENV_KEY, JSON.stringify(bar)); } catch {} };
const ICON_EDIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>';
const ICON_DEL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>';
const ICON_BOARD = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/></svg>';
const HUES = ['var(--todo)', 'var(--progress)', 'var(--review)', 'var(--staging)', 'var(--done)', 'var(--blocked)'];
const hue = (id) => HUES[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
const envColor = (name) => /prod|live/i.test(name) ? 'var(--done)' : /stag|pre/i.test(name) ? 'var(--todo)' : /dev|local/i.test(name) ? 'var(--progress)' : /qa|uat|test|demo/i.test(name) ? 'var(--review)' : 'var(--backlog)';

// only http(s); a bare host gets https://
function safeUrl(raw) {
  raw = raw.trim(); if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = 'https://' + raw;
  try { const u = new URL(raw); return /^https?:$/.test(u.protocol) && (u.hostname.includes('.') || u.hostname === 'localhost') ? u.href : null; } catch { return null; }
}

const ICON_RELOAD = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>';

// looks only on the site itself: no third-party favicon service sees internal hostnames
function probeImage(src) {
  return new Promise((done) => {
    const img = new Image(), timer = setTimeout(() => done(null), 4000);
    img.onload = () => { clearTimeout(timer); done(img.naturalWidth > 1 ? src : null); };
    img.onerror = () => { clearTimeout(timer); done(null); };
    img.src = src;
  });
}
async function findFavicon(url) {
  const o = new URL(url).origin;
  for (const path of ['/favicon.ico', '/favicon.svg', '/favicon.png', '/apple-touch-icon.png', '/icon.png']) {
    const hit = await probeImage(o + path + '?v=' + Date.now().toString(36));
    if (hit) return hit;
  }
  return null;
}
// a saved icon that stops loading falls back to the letter badge
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG') return;
  if (img.dataset.letter) { const sp = document.createElement('span'); sp.className = 'ltr'; sp.textContent = img.dataset.letter; img.replaceWith(sp); }
  else if (img.classList.contains('fav')) { const i = document.createElement('i'); img.replaceWith(i); }
}, true);

const boardKey = (p) => 'board-' + p.key;
const ICON_REPO = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.71 1.71.75.75 0 0 1-1.07 1.05A2.5 2.5 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.71A2.5 2.5 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.09a.25.25 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/></svg>';
// plain words for what a chip is: shown in its tooltip and under the popover title
function kindLine(key) {
  if (!key) return 'Custom project · links only';
  if (key.startsWith('repo:')) return `Repository · ${key.slice(5)}`;
  return `Project board · ${key.split('/')[0]}`;
}
const multiOwner = () => (data.owners || []).length > 1;
// v2 stored boards as 'board-<number>'; rename them to 'board-<owner>/<number>' once data is here
function migrateBarIds() {
  const old = /^board-(\d+)$/, rename = (id) => { const m = old.exec(id); if (!m) return id; const p = data.projects.find((x) => String(x.number) === m[1]); return p ? boardKey(p) : id; };
  let changed = false;
  for (const k of ['envs', 'icons']) for (const id of Object.keys(bar[k])) { const n = rename(id); if (n !== id) { bar[k][n] = bar[k][id]; delete bar[k][id]; changed = true; } }
  for (const k of ['added', 'hidden']) bar[k] = bar[k].map((id) => { const n = rename(id); if (n !== id) changed = true; return n; });
  if (changed) saveBar();
}
function barProjects() {
  const boards = data.projects
    // repos get a chip only when added on purpose; automatic repo cards stay in the board area
    .filter((p) => p.kind !== 'repo' || p.added)
    .filter((p) => (p.tasks.some((t) => t.assignees.includes(data.login)) || bar.added.includes(boardKey(p))) && !bar.hidden.includes(boardKey(p)))
    .map((p) => ({ id: boardKey(p), title: p.title, url: p.url, owner: p.owner, kind: p.kind }));
  const cfg = settingsFor(data.login || accts.active || '');
  const pending = cfg.repos.map((r) => 'board-repo:' + r).filter((id) => !boards.some((b) => b.id === id) && !bar.hidden.includes(id))
    .map((id) => ({ id, title: id.split('/').pop(), kind: 'repo', pending: true }));
  return boards.concat(pending, bar.custom);
}

// selected state + per-tab counts on the projects bar
function syncBarChips() {
  document.querySelectorAll('.pchip[data-proj^="board-"]').forEach((c) => {
    const n = c.dataset.proj.slice(6);
    const inTab = base(n).filter((t) => tabOf(t.status) === state.tab);
    c.setAttribute('aria-pressed', state.project === n);
    c.title = `${kindLine(n)}\n${state.project === n ? 'Showing only this one. Click to show all.' : 'Click to show only this one. Hover for links.'}`;
    c.querySelector('.cnt').textContent = inTab.filter((t) => t.project.key === n).length;
  });
}

function renderLinks() {
  if (firstLoad()) { $('#links').innerHTML = [96, 128].map((w) => `<span class="sk sk-chip" style="width:${w}px" aria-hidden="true"></span>`).join(''); return; }
  $('#links').innerHTML = barProjects().map((p) => {
    const envs = bar.envs[p.id] || [];
    return `<button type="button" class="pchip${p.pending ? ' pending' : ''}" data-proj="${esc(p.id)}" aria-haspopup="dialog" aria-expanded="false" style="--h:${hue(p.id)}">
      ${bar.icons[p.id] ? `<img class="ltr" src="${esc(bar.icons[p.id])}" alt="" data-letter="${esc(p.title[0].toUpperCase())}">` : p.kind === 'repo' ? `<span class="ltr" aria-label="Repository">${ICON_REPO}</span>` : `<span class="ltr">${esc(p.title[0].toUpperCase())}</span>`}${esc(p.title)}
      <span class="cnt"></span>
      ${envs.length ? `<span class="dots" aria-label="${envs.length} environments">${envs.slice(0, 4).map((e) => `<i style="--c:${envColor(e.name)}"></i>`).join('')}</span>` : ''}</button>`;
  }).join('') + `<button type="button" class="pchip add" data-proj="+" aria-haspopup="dialog" aria-expanded="false" title="Add a project">+ Add project</button>`;
  syncBarChips();
}

const envpop = $('#envpop');
let envAnchor = null, envEdit = false, envPinned = false, envShowT, envHideT;

function projectById(id) { return barProjects().find((p) => p.id === id); }

function paintEnvPop(err = '') {
  const id = envAnchor.dataset.proj;
  if (id === '+') {
    const shown = new Set(barProjects().map((p) => p.id));
    const rest = data.projects.filter((p) => !shown.has(boardKey(p)));
    envpop.innerHTML = `<header><b>Add a project</b></header>
      ${rest.length ? `<p class="p-label">Project boards</p><div class="p-list">${rest.map((p) => `<button type="button" data-add-board="${esc(p.key)}">${multiOwner() ? `<small>${esc(p.owner)}</small> ` : ''}${esc(p.title)}<span>${p.tasks.length} tasks</span></button>`).join('')}</div>` : ''}
      <p class="p-label">Repository <span>shows its issues, even without a board</span></p>
      <form class="p-add" data-form="repo" autocomplete="off"><input name="repo" placeholder="owner/repo or GitHub link" aria-label="Repository" required><button aria-label="Add repository">+</button></form>
      <p class="env-err" role="alert">${esc(err)}</p>
      <p class="p-label">Custom project <span>just a name to keep links under</span></p>
      <form class="p-add" data-form="custom" autocomplete="off"><input name="title" placeholder="Project name" aria-label="Project name" required maxlength="40"><button aria-label="Add">+</button></form>`;
    return;
  }
  const p = projectById(id), envs = bar.envs[id] || [];
  const addForm = `<form class="env-add" data-form="env" autocomplete="off"><input name="name" placeholder="Name, e.g. Staging" aria-label="Environment name" required maxlength="24">
    <input name="url" placeholder="staging.example.com" aria-label="Link" required><button aria-label="Add environment">+</button></form>
    <p class="env-err" role="alert">${esc(err)}</p>`;
  envpop.innerHTML = `<header><b>${esc(p.title)}<small class="kind-line">${esc(kindLine(id.startsWith('board-') ? id.slice(6) : null))}</small></b>
      ${p.url ? `<a class="c-icon" href="${esc(p.url)}" target="_blank" rel="noopener" title="Open board in new tab" aria-label="Open board">${ICON_BOARD}</a>` : ''}
      <button type="button" class="c-icon${envEdit ? ' ok' : ''}" data-env-edit title="${envEdit ? 'Done editing' : 'Edit environments'}" aria-label="Edit environments" aria-pressed="${envEdit}">${envEdit ? ICON_OK : ICON_EDIT}</button></header>
    ${envEdit
      ? envs.map((e, i) => `<div class="env-edit"><input autocomplete="off" data-env-name="${i}" value="${esc(e.name)}" aria-label="Name" maxlength="24"><input autocomplete="off" data-env-url="${i}" value="${esc(e.url)}" aria-label="Link">
          <button type="button" class="c-icon" data-env-del="${i}" title="Remove" aria-label="Remove ${esc(e.name)}">${ICON_DEL}</button></div>`).join('') + addForm +
        `<div class="env-foot"><button type="button" class="txt-btn danger" data-remove-proj>Remove from bar</button><button type="button" class="txt-btn" data-env-edit>Done</button></div>`
      : envs.length
        ? `<ul class="envs">${envs.map((e, i) => `<li><a class="env" href="${esc(e.url)}" target="_blank" rel="noopener" style="--c:${envColor(e.name)}">
            ${e.icon ? `<img class="fav" src="${esc(e.icon)}" alt="">` : '<i></i>'}<span>${esc(e.name)}</span><span class="host">${esc(new URL(e.url).host)}</span><span></span><span class="go">${ICON_OPEN}</span></a>
            <button type="button" class="c-icon set-icon${e.icon && e.icon === bar.icons[id] ? ' on' : ''}" data-set-icon="${i}"
              title="${e.icon && e.icon === bar.icons[id] ? `Project icon. Click to reload it from ${esc(new URL(e.url).host)}` : `Load this site's icon and use it for ${esc(p.title)}`}"
              aria-label="Use ${esc(e.name)} icon for the project">${ICON_RELOAD}</button></li>`).join('')}</ul>`
        : `<p class="env-empty">No environments yet. Add production, staging, or any link you open often.</p>${addForm}`}`;
}

function placeEnvPop() {
  const r = envAnchor.getBoundingClientRect();
  envpop.style.top = r.bottom + 8 + 'px';
  envpop.style.left = Math.max(12, Math.min(r.left, innerWidth - envpop.offsetWidth - 12)) + 'px';
}
function openEnvPop(chip, pinned) {
  closePopovers('env');
  clearTimeout(envHideT); clearTimeout(envShowT);
  if (envAnchor && envAnchor !== chip) envAnchor.setAttribute('aria-expanded', 'false');
  if (envAnchor !== chip) envEdit = false;
  envAnchor = chip; envPinned = envPinned || pinned;
  paintEnvPop(); placeEnvPop();
  chip.setAttribute('aria-expanded', 'true'); envpop.classList.add('on');
  // an empty project opens straight into its add form
  if (pinned) envpop.querySelector('input')?.focus();
}
function closeEnvPop() {
  envpop.classList.remove('on'); envPinned = false; envEdit = false;
  if (envAnchor) envAnchor.setAttribute('aria-expanded', 'false');
  envAnchor = null;
}
// hover closes it only when nothing inside is being typed in and it was not opened by click
function maybeCloseEnvPop() {
  envHideT = setTimeout(() => { if (!envPinned && !envpop.contains(document.activeElement)) closeEnvPop(); }, 180);
}
function refreshBar() { const id = envAnchor?.dataset.proj; renderLinks(); if (id) { envAnchor = $(`.pchip[data-proj="${CSS.escape(id)}"]`); if (envAnchor) { envAnchor.setAttribute('aria-expanded', 'true'); paintEnvPop(); placeEnvPop(); } else closeEnvPop(); } }

$('#links').addEventListener('mouseover', (e) => {
  const c = e.target.closest('.pchip'); if (!c || c === envAnchor) return clearTimeout(envHideT);
  clearTimeout(envShowT);
  if (envPinned) return;
  envShowT = setTimeout(() => openEnvPop(c, false), envpop.classList.contains('on') ? 0 : 250);
});
$('#links').addEventListener('mouseout', (e) => { if (!e.target.closest('.pchip')?.contains(e.relatedTarget) && !envpop.contains(e.relatedTarget)) { clearTimeout(envShowT); maybeCloseEnvPop(); } });
envpop.addEventListener('mouseenter', () => clearTimeout(envHideT));
envpop.addEventListener('mouseleave', (e) => { if (!envAnchor?.contains(e.relatedTarget)) maybeCloseEnvPop(); });
$('#links').addEventListener('click', (e) => {
  const c = e.target.closest('.pchip'); if (!c) return;
  e.stopPropagation();
  if (c.dataset.proj.startsWith('board-')) { const k = c.dataset.proj.slice(6); state.project = state.project === k ? null : k; render(true); return; }
  if (c === envAnchor && envPinned) closeEnvPop(); else { envPinned = true; openEnvPop(c, true); }
});
envpop.addEventListener('click', (e) => {
  e.stopPropagation();
  const id = envAnchor?.dataset.proj, t = e.target;
  if (t.closest('[data-env-edit]')) {
    // leaving edit mode keeps a filled-in add row instead of dropping it
    const f = envEdit && envpop.querySelector('.env-add');
    if (f && (f.elements.name.value.trim() || f.elements.url.value.trim()) && !commitEnvForm(f)) return;
    envEdit = !envEdit; envPinned = true; refreshBar();
  }
  else if (t.closest('[data-set-icon]')) {
    const btn = t.closest('[data-set-icon]'), env = bar.envs[id][+btn.dataset.setIcon];
    btn.classList.add('busy'); btn.disabled = true;
    findFavicon(env.url).then((icon) => {
      if (icon) { env.icon = icon; bar.icons[id] = icon; saveBar(); refreshBar(); return; }
      btn.classList.remove('busy'); btn.disabled = false;
      btn.title = `No icon found on ${new URL(env.url).host}`;
      btn.style.color = 'var(--blocked)'; btn.style.opacity = 1;
    });
  }
  else if (t.closest('[data-env-del]')) { bar.envs[id].splice(+t.closest('[data-env-del]').dataset.envDel, 1); saveBar(); refreshBar(); }
  else if (t.closest('[data-remove-proj]')) {
    if (id.startsWith('board-')) {
      bar.hidden.push(id); bar.added = bar.added.filter((x) => x !== id);
      const cfg = settingsFor(data.login), r = id.startsWith('board-repo:') && id.slice(11);
      if (r && cfg.repos.includes(r)) { cfg.repos = cfg.repos.filter((x) => x !== r); saveSettings(); loadLive(true); }
    }
    else bar.custom = bar.custom.filter((c) => c.id !== id);
    delete bar.envs[id]; saveBar(); closeEnvPop(); renderLinks();
  }
  else if (t.closest('[data-add-board]')) {
    const key = 'board-' + t.closest('[data-add-board]').dataset.addBoard;
    bar.hidden = bar.hidden.filter((x) => x !== key); if (!bar.added.includes(key)) bar.added.push(key);
    saveBar(); closeEnvPop(); renderLinks();
    openEnvPop($(`.pchip[data-proj="${key}"]`), true);
  }
});
// "owner/repo" or a github.com link; checked with GitHub before it is saved
async function addRepo(f) {
  const raw = f.elements.repo.value.trim(), m = /(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(raw);
  const fail = (msg) => { paintEnvPop(msg); const i = envpop.querySelector('[name=repo]'); i.value = raw; i.focus(); };
  if (!m) return fail('Use owner/repo, like acme/website');
  const btn = f.querySelector('button'); btn.disabled = true;
  try {
    const d = await gql(tokens[accts.active], 'query($o:String!,$n:String!){repository(owner:$o,name:$n){nameWithOwner}}', { o: m[1], n: m[2] });
    const full = d.repository?.nameWithOwner;
    if (!full) return fail(`Can't find ${m[1]}/${m[2]}, or your token can't see it`);
    const cfg = settingsFor(data.login);
    if (!cfg.repos.includes(full)) cfg.repos.push(full);
    const key = 'board-repo:' + full;
    bar.hidden = bar.hidden.filter((x) => x !== key); if (!bar.added.includes(key)) bar.added.push(key);
    saveSettings(); saveBar(); closeEnvPop(); renderLinks();
    loadLive(true);
  } catch (e) { fail(e.auth ? 'Your token was rejected' : `Can't find ${m[1]}/${m[2]}, or your token can't see it`); }
  finally { btn.disabled = false; }
}
envpop.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target, id = envAnchor.dataset.proj;
  if (f.dataset.form === 'repo') { addRepo(f); return; }
  if (f.dataset.form === 'custom') {
    const title = f.elements.title.value.trim(); if (!title) return;
    const key = 'custom-' + Date.now().toString(36);
    bar.custom.push({ id: key, title }); saveBar(); closeEnvPop(); renderLinks();
    return openEnvPop($(`.pchip[data-proj="${key}"]`), true);
  }
  if (commitEnvForm(f)) { envEdit = true; refreshBar(); envpop.querySelector('[name=name]')?.focus(); }
});
// adds what's typed in the add row; false (with a message shown) when it can't
function commitEnvForm(f) {
  const id = envAnchor.dataset.proj, rawName = f.elements.name.value.trim(), rawUrl = f.elements.url.value.trim();
  const fail = (msg, field) => { const keep = { name: rawName, url: rawUrl }; paintEnvPop(msg);
    const g = envpop.querySelector('.env-add'); g.elements.name.value = keep.name; g.elements.url.value = keep.url; g.elements[field].focus(); return false; };
  if (!rawName) return fail('Give it a name, like Staging', 'name');
  const url = safeUrl(rawUrl);
  if (!url) return fail('Use a web address, like staging.example.com', 'url');
  const env = { name: rawName, url };
  (bar.envs[id] ||= []).push(env); saveBar();
  // first icon found becomes the project avatar; later ones only decorate their row
  findFavicon(url).then((icon) => {
    if (!icon) return;
    env.icon = icon;
    if (!bar.icons[id]) bar.icons[id] = icon;
    saveBar(); refreshBar();
  });
  return true;
}
// edits in place save when the field loses focus
envpop.addEventListener('change', (e) => {
  const id = envAnchor?.dataset.proj, t = e.target, list = bar.envs[id]; if (!list) return;
  if (t.dataset.envName) { const v = t.value.trim(); if (v) list[+t.dataset.envName].name = v; else t.value = list[+t.dataset.envName].name; }
  if (t.dataset.envUrl) { const u = safeUrl(t.value); if (u) list[+t.dataset.envUrl].url = u; t.value = list[+t.dataset.envUrl].url; }
  saveBar(); renderLinks(); envAnchor = $(`.pchip[data-proj="${CSS.escape(id)}"]`); envAnchor?.setAttribute('aria-expanded', 'true');
});
document.addEventListener('click', (e) => { if (envpop.classList.contains('on') && !envpop.contains(e.target)) closeEnvPop(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && envpop.classList.contains('on')) { closeEnvPop(); document.activeElement?.blur?.(); } });

// ---------- waiting on you / open pull requests
const BOT = /^(dependabot|renovate|github-actions)/i;
const ICON_PR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4M13 3.5 10.5 6 13 8.5"/></svg>';
const ICON_AT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>';
const checksText = (c) => c === 'SUCCESS' ? ['Checks pass', 'var(--done)'] : c === 'FAILURE' || c === 'ERROR' ? ['Checks failing', 'var(--blocked)'] : c === 'PENDING' ? ['Checks running', 'var(--todo)'] : null;

function waitingItems() {
  const me = data.login;
  const prs = data.openPRs.filter((p) => !BOT.test(p.author || ''));
  if (state.scope === 'all') return prs.map((p) => ({ ...p, why: p.draft ? 'Draft' : p.review === 'APPROVED' ? 'Approved' : p.review === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Open' }));
  const seen = new Set(), out = [];
  const add = (x, why, c) => { if (!seen.has(x.url)) { seen.add(x.url); out.push({ ...x, why, whyColor: c }); } };
  prs.filter((p) => p.reviewers.includes(me)).forEach((p) => add(p, 'Review requested', 'var(--review)'));
  data.mentions.forEach((m) => add(m, 'Mentioned you', 'var(--progress)'));
  prs.filter((p) => p.author === me).forEach((p) => add(p, p.review === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Your PR', p.review === 'CHANGES_REQUESTED' ? 'var(--blocked)' : null));
  // then every other open PR in the repos behind the boards in the projects bar
  const ids = new Set(barProjects().map((p) => p.id)), repos = new Set();
  data.projects.filter((p) => ids.has(boardKey(p))).forEach((p) => p.tasks.forEach((t) => t.repo && repos.add(t.repo)));
  prs.filter((p) => repos.has(p.repo)).forEach((p) => add(p, p.draft ? 'Draft' : p.review === 'APPROVED' ? 'Approved' : 'Open', null));
  return out;
}

function renderWaiting() {
  if (data.extrasPending) { const el = $('#waiting'); el.className = 'waiting calm'; el.innerHTML = '<span class="sk" style="width:320px;height:14px" aria-hidden="true"></span>'; return; }
  if (firstLoad()) { const el = $('#waiting'); el.className = 'waiting calm'; el.innerHTML = '<span class="sk" style="width:320px;height:14px" aria-hidden="true"></span>'; return; }
  const items = waitingItems(), el = $('#waiting');
  if (!items.length) {
    el.className = 'waiting calm';
    el.innerHTML = `${ICON_OK}${state.scope === 'all' ? 'No open pull requests.' : 'No open pull requests on your projects, and nothing waiting on you.'}`;
    return;
  }
  el.className = 'waiting busy';
  const CAP = 5, shownItems = state.prsOpen ? items : items.slice(0, CAP);
  el.innerHTML = `<h3>${state.scope === 'all' ? 'Open pull requests' : 'Pull requests on your projects'}<span>${items.length}</span></h3>` + shownItems.map((x) => {
    const ck = x.kind === 'PullRequest' && checksText(x.checks);
    return `<a class="w-row" href="${esc(x.url)}" style="--c:${ck ? ck[1] : 'var(--muted)'}">
      <span class="kind">${x.kind === 'PullRequest' ? ICON_PR : ICON_AT}</span>
      <span class="title"><span class="num">${esc(x.repo)}#${x.number}</span>&nbsp;&nbsp;${esc(x.title)}</span>
      <span class="why">${x.why !== 'Open' ? `<b style="--c:${x.whyColor || 'var(--soft)'}">${x.why}</b>` : ''}${ck ? `<b>${ck[0]}</b>` : ''}<span>${ago(x.updatedAt)}</span>
        ${x.author ? `<img src="${esc(avatarOf(x.author, 40))}" alt="${esc(x.author)}" title="${esc(x.author)}">` : ''}</span></a>`;
  }).join('') + (items.length > CAP ? `<button class="more" data-prs-toggle>${state.prsOpen ? 'Show fewer' : `Show all ${items.length}`}</button>` : '');
}

// ---------- standup / updates over a date range
const DAY = 864e5;
const startOf = (d) => { d = new Date(d); d.setHours(0, 0, 0, 0); return d; };
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function lastWorkday() {
  const d = startOf(new Date());
  do d.setDate(d.getDate() - 1); while (d.getDay() === 0 || d.getDay() === 6);
  return d;
}
const su = { range: 'standup', prs: null, from: isoDay(new Date(Date.now() - 13 * DAY)), to: isoDay(new Date()) };
function rangeOf() {
  const today = startOf(new Date()), end = new Date(today.getTime() + DAY);
  const fmt = (d, o) => d.toLocaleDateString(undefined, o);
  const span = (a, b) => `${fmt(a, { day: 'numeric', month: 'short' })} to ${fmt(new Date(b - DAY), { day: 'numeric', month: 'short' })}`;
  if (su.range === 'week') { const a = new Date(today); a.setDate(a.getDate() - ((a.getDay() + 6) % 7)); return { a, b: end, title: `Weekly update, ${span(a, end)}`, done: 'Done this week' }; }
  if (su.range === '7d') { const a = new Date(today.getTime() - 6 * DAY); return { a, b: end, title: `Update, ${span(a, end)}`, done: 'Done in the last 7 days' }; }
  if (su.range === 'month') { const a = new Date(today.getFullYear(), today.getMonth(), 1); return { a, b: end, title: `Monthly update, ${fmt(a, { month: 'long' })}`, done: 'Done this month' }; }
  if (su.range === 'custom') { const a = startOf(su.from + 'T00:00'), b = new Date(startOf(su.to + 'T00:00').getTime() + DAY); return { a, b, title: `Update, ${span(a, b)}`, done: `Done ${span(a, b)}` }; }
  const a = lastWorkday();
  return { a, b: end, title: `Standup, ${fmt(today, { weekday: 'short', day: 'numeric', month: 'short' })}`, done: `Done since ${fmt(a, { weekday: 'long' })}` };
}
// repo -> board title, learned from the tasks themselves
const boardOfRepo = (repo) => data.projects.find((p) => p.tasks.some((t) => t.repo === repo))?.title;

// one model, three renderings: plain text, rich HTML for pasting (Teams, Slack, email) and the styled preview
function standupModel() {
  const me = data.login, r = rangeOf();
  const listPRs = su.prs ?? su.range === 'standup';
  const inRange = data.recent.filter((x) => { const d = new Date(x.closedAt); return d >= r.a && d < r.b; });
  const issues = inRange.filter((x) => x.kind !== 'PullRequest'), prs = inRange.filter((x) => x.kind === 'PullRequest');
  const mine = data.projects.flatMap((p) => p.tasks).filter((t) => !t.onBoard && t.assignees.includes(me) && t.state !== 'CLOSED');
  const group = (xs) => {
    const g = {};
    xs.forEach((x) => (g[boardOfRepo(x.repo) || x.repo || 'Other'] ||= []).push(x));
    return Object.entries(g).sort((a, b) => b[1].length - a[1].length);
  };
  const byTab = (k) => mine.filter((t) => tabOf(t.status) === k);
  return { title: r.title, doneLabel: r.done, issues, issueGroups: group(issues), prs, prGroups: group(prs), listPRs,
    doing: byTab('progress'), review: byTab('review'), blocked: byTab('blocked') };
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function standupText(m = standupModel()) {
  const line = (t) => `- #${t.number} ${t.title}`;
  const groups = (gs, counts) => gs.flatMap(([name, list]) => [`${name}${counts ? ` (${list.length})` : ''}`, ...list.map(line), '']);
  const out = [m.title, '', `${m.doneLabel} (${m.issues.length})`, ''];
  out.push(...(m.issues.length ? groups(m.issueGroups, true) : ['- Nothing closed', '']));
  if (m.prs.length) out.push(...(m.listPRs ? [`Merged pull requests (${m.prs.length})`, '', ...groups(m.prGroups)] : [`Also merged ${plural(m.prs.length, 'pull request')}.`, '']));
  out.push('Working on', ...(m.doing.length ? m.doing.map(line) : ['- Picking up the next To do']), '');
  if (m.review.length) out.push(`Waiting for review: ${plural(m.review.length, 'task')}`, '');
  out.push('Blocked', ...(m.blocked.length ? m.blocked.map(line) : ['- Nothing']));
  return out.join('\n');
}

// pasted into Teams/Slack/email: headings, bullets and links survive
function standupPasteHTML(m = standupModel()) {
  const li = (t) => `<li><a href="${esc(t.url)}">#${t.number}</a> ${esc(t.title)}</li>`;
  const groups = (gs, counts) => gs.map(([name, list]) => `<p><i>${esc(name)}${counts ? ` (${list.length})` : ''}</i></p><ul>${list.map(li).join('')}</ul>`).join('');
  return `<p><b>${esc(m.title)}</b></p>
    <p><b>${esc(m.doneLabel)} (${m.issues.length})</b></p>${m.issues.length ? groups(m.issueGroups, true) : '<ul><li>Nothing closed</li></ul>'}
    ${m.prs.length ? (m.listPRs ? `<p><b>Merged pull requests (${m.prs.length})</b></p>${groups(m.prGroups)}` : `<p>Also merged ${plural(m.prs.length, 'pull request')}.</p>`) : ''}
    <p><b>Working on</b></p><ul>${m.doing.length ? m.doing.map(li).join('') : '<li>Picking up the next To do</li>'}</ul>
    ${m.review.length ? `<p><b>Waiting for review:</b> ${plural(m.review.length, 'task')}</p>` : ''}
    <p><b>Blocked</b></p><ul>${m.blocked.length ? m.blocked.map(li).join('') : '<li>Nothing</li>'}</ul>`;
}

// the preview inside the popover
function standupPreview(m = standupModel()) {
  const item = (t) => `<li><a href="${esc(t.url)}" target="_blank" rel="noopener"><span class="su-n">#${t.number}</span><span>${esc(t.title)}</span></a></li>`;
  const groups = (gs) => gs.map(([name, list]) => `<div class="su-group">${esc(name)}<span>${list.length}</span></div><ul>${list.map(item).join('')}</ul>`).join('');
  const section = (title, body, c) => `<section style="--c:${c}"><h4>${title}</h4>${body}</section>`;
  const empty = (txt) => `<p class="su-empty">${txt}</p>`;
  const stats = [[m.issues.length, 'closed', 'var(--done)'], [m.prs.length, m.prs.length === 1 ? 'PR merged' : 'PRs merged', 'var(--review)'],
    [m.doing.length, 'in progress', 'var(--progress)'], [m.blocked.length, 'blocked', 'var(--blocked)']];
  return `<div class="su-doc">
    <div class="su-title">${esc(m.title)}</div>
    <div class="su-stats">${stats.map(([n, l, c]) => `<span style="--c:${c}"><b>${n}</b>${l}</span>`).join('')}</div>
    ${section(esc(m.doneLabel), m.issues.length ? groups(m.issueGroups) : empty('Nothing closed in this range.'), 'var(--done)')}
    ${m.prs.length ? section('Merged pull requests', m.listPRs ? groups(m.prGroups) : empty(`Also merged ${plural(m.prs.length, 'pull request')}. Tick "List merged pull requests" to include them.`), 'var(--review)') : ''}
    ${section('Working on', m.doing.length ? `<ul>${m.doing.map(item).join('')}</ul>` : empty('Picking up the next To do.'), 'var(--progress)')}
    ${m.review.length ? section('Waiting for review', empty(plural(m.review.length, 'task')), 'var(--review)') : ''}
    ${section('Blocked', m.blocked.length ? `<ul>${m.blocked.map(item).join('')}</ul>` : empty('Nothing blocked.'), 'var(--blocked)')}
  </div>`;
}

const pop = $('#standup'), popBtn = $('#standup-btn');
function paintStandup() {
  const r = rangeOf(), listPRs = su.prs ?? su.range === 'standup';
  const since = lastWorkday().toLocaleDateString(undefined, { weekday: 'long' });
  const chips = [['standup', `Since ${lastWorkday().toLocaleDateString(undefined, { weekday: 'short' })}`], ['week', 'This week'], ['7d', '7 days'], ['month', 'This month'], ['custom', 'Custom']];
  pop.innerHTML = `<header><b>${su.range === 'standup' ? 'Standup' : 'Update'}</b><span>copies with formatting for Teams, Slack or email</span>
      <button type="button" class="c-icon" data-copy-standup title="Copy (C)" aria-label="Copy">${ICON_COPY}</button></header>
    <div class="su-ranges" role="group" aria-label="Date range">${chips.map(([k, l]) => `<button type="button" class="chip" data-range="${k}" aria-pressed="${su.range === k}">${l}</button>`).join('')}</div>
    ${su.range === 'custom' ? `<div class="su-custom"><label>From <input type="date" id="su-from" value="${su.from}" max="${su.to}"></label>
      <label>To <input type="date" id="su-to" value="${su.to}" min="${su.from}" max="${isoDay(new Date())}"></label></div>` : ''}
    <label class="su-toggle"><input type="checkbox" id="su-prs" ${listPRs ? 'checked' : ''}> List merged pull requests</label>
    ${standupPreview()}`;
}
function openStandup() {
  closePopovers('standup');
  paintStandup();
  const r = popBtn.getBoundingClientRect();
  pop.style.top = r.bottom + 8 + 'px';
  pop.style.left = Math.max(12, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 12)) + 'px';
  pop.classList.add('on'); popBtn.setAttribute('aria-expanded', 'true');
}
function closeStandup() { pop.classList.remove('on'); popBtn.setAttribute('aria-expanded', 'false'); }
async function copyStandup() {
  if (!pop.classList.contains('on')) openStandup();
  const btn = pop.querySelector('[data-copy-standup]');
  try {
    const m = standupModel();
    // rich + plain: apps that understand formatting keep headings, bullets and links
    try { await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([standupPasteHTML(m)], { type: 'text/html' }), 'text/plain': new Blob([standupText(m)], { type: 'text/plain' }) })]); }
    catch { await navigator.clipboard.writeText(standupText(m)); }
    toast('Standup copied to clipboard'); btn.innerHTML = ICON_OK; btn.classList.add('ok'); btn.title = 'Copied'; }
  catch { btn.title = 'Copy blocked by browser'; }
  setTimeout(() => { if (btn.isConnected) { btn.innerHTML = ICON_COPY; btn.classList.remove('ok'); btn.title = 'Copy (C)'; } }, 1600);
}
pop.addEventListener('change', (e) => {
  if (e.target.id === 'su-prs') su.prs = e.target.checked;
  if (e.target.id === 'su-from' && e.target.value) su.from = e.target.value;
  if (e.target.id === 'su-to' && e.target.value) su.to = e.target.value;
  paintStandup();
});
pop.addEventListener('click', (e) => {
  e.stopPropagation();
  const rb = e.target.closest('[data-range]');
  if (rb) { su.range = rb.dataset.range; su.prs = null; paintStandup(); }
  else if (e.target.closest('[data-copy-standup]')) copyStandup();
});
popBtn.addEventListener('click', (e) => { e.stopPropagation(); pop.classList.contains('on') ? closeStandup() : openStandup(); });
document.addEventListener('click', () => closeStandup());
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') closeStandup();
  else if (e.key.toLowerCase() === 's') { e.preventDefault(); pop.classList.contains('on') ? closeStandup() : openStandup(); }
  else if (e.key.toLowerCase() === 'c' && pop.classList.contains('on')) { e.preventDefault(); e.stopImmediatePropagation(); copyStandup(); }
});

// hover card: waits 350ms on first hover, then follows instantly between rows
const card = $('#card');
let showTimer, hideTimer, current = null, warmUntil = 0;


// plain text, pastes cleanly into Teams, Slack or a commit message
function detailsText(t) {
  const lines = [`${t.number ? '#' + t.number + ' ' : ''}${t.title}`, t.url, '',
    `Project: ${t.project.title}${t.repo ? ` (${t.repo})` : ''}`, `Status: ${t.status}`];
  if (t.due) lines.push(`Due: ${t.due}`);
  lines.push(`Assignees: ${t.assignees.join(', ') || 'none'}`);
  if (t.labels.length) lines.push(`Labels: ${t.labels.map((l) => l.name).join(', ')}`);
  if (t.milestone) lines.push(`Milestone: ${t.milestone}`);
  return lines.join('\n');
}

async function copyDetails() {
  const t = current && itemOf(current), btn = card.querySelector('[data-copy]');
  if (!t) return;
  try {
    await navigator.clipboard.writeText('news' in current.dataset ? newsText(t) : detailsText(t));
    toast('news' in current.dataset ? 'Link copied to clipboard' : 'Task details copied to clipboard');
    btn.innerHTML = ICON_OK; btn.classList.add('ok'); btn.title = 'Copied';
  } catch {
    btn.title = 'Copy blocked by browser';
  }
  setTimeout(() => { if (btn.isConnected) { btn.innerHTML = ICON_COPY; btn.classList.remove('ok'); btn.title = 'Copy details (C)'; } }, 1600);
}

// issue descriptions aren't part of the board load (they doubled its size); the hover card asks for one
const bodies = new Map();
function loadBody(t, row) {
  if (!t.url || !/\/(issues|pull)\/\d+/.test(t.url)) return;
  const show = (text) => { if (current === row && text) { const el = card.querySelector('.c-body') || card.querySelector('.c-title').insertAdjacentElement('afterend', document.createElement('p')); el.className = 'c-body'; el.textContent = text; place(row); } };
  if (bodies.has(t.url)) return show(bodies.get(t.url));
  gql(tokens[accts.active], 'query($u:URI!){resource(url:$u){... on Issue{bodyText} ... on PullRequest{bodyText}}}', { u: t.url })
    .then((d) => { const text = (d.resource?.bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 260); bodies.set(t.url, text); show(text); })
    .catch(() => {});
}
function cardHTML(t) {
  const facts = [];
  if (t.state === 'CLOSED' && tabOf(t.status) !== 'done') facts.push(['Heads up', `Closed ${fmtDate(t.closedAt)}, but the board still says ${esc(t.status)}`]);
  if (t.due) facts.push(['Due', dueChip(t.due, tabOf(t.status))]);
  facts.push(['Assignees', t.assignees.length
    ? t.assignees.map((a) => `<span><img src="${esc(avatarOf(a, 36))}" alt="">${esc(a)}</span>`).join('')
    : '<span style="color:var(--muted)">Nobody yet</span>']);
  if (t.labels.length) facts.push(['Labels', t.labels.map((l) => `<span class="label" style="--lc:#${l.color}"><i></i>${esc(l.name)}</span>`).join('')]);
  if (t.milestone) facts.push(['Milestone', esc(t.milestone)]);
  if (t.createdAt) facts.push(['Opened', `${fmtDate(t.createdAt)}${t.author ? ` by ${esc(t.author)}` : ''}`]);
  facts.push(['Updated', `${ago(t.updatedAt) === 'today' || ago(t.updatedAt) === 'yesterday' ? ago(t.updatedAt) : ago(t.updatedAt) + ' ago'}${t.comments ? `, ${t.comments} comment${t.comments > 1 ? 's' : ''}` : ''}`]);
  return `<div class="c-head"><span>${t.number ? '#' + t.number : 'Draft'}</span>${t.repo ? `<span>${esc(t.repo)}</span>` : ''}
      <span class="pill" style="--c:${colorOf(t.status)}">${esc(t.status)}</span>
      <button type="button" class="c-icon" data-copy title="Copy details (C)" aria-label="Copy details">${ICON_COPY}</button>
      <a class="c-icon" href="${esc(t.url)}" target="_blank" rel="noopener" title="Open in new tab (O)" aria-label="Open in new tab">${ICON_OPEN}</a></div>
    <p class="c-title">${esc(t.title)}</p>
    ${t.body ? `<p class="c-body">${esc(t.body)}</p>` : ''}
    <dl class="c-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
`;
}

const itemOf = (row) => 'news' in row.dataset ? newsRows[+row.dataset.news] : rowTasks[row.dataset.i];
function place(row) {
  const r = row.getBoundingClientRect(), h = card.offsetHeight, w = card.offsetWidth, gap = 6;
  // sidebar rows sit at the right edge, so their card opens to the left
  if ('news' in row.dataset) {
    card.style.top = Math.max(12, Math.min(r.top - 10, innerHeight - h - 12)) + 'px';
    card.style.left = Math.max(12, r.left - w - 10) + 'px';
    card.style.setProperty('--from', '0px'); card.style.setProperty('--origin', 'right center');
    return;
  }
  const title = row.querySelector('.title').getBoundingClientRect();
  const below = r.bottom + gap + h <= innerHeight - 12 || r.top - gap - h < 12;
  card.style.top = (below ? r.bottom + gap : r.top - gap - h) + 'px';
  card.style.left = Math.max(12, Math.min(title.left - 18, innerWidth - w - 12)) + 'px';
  card.style.setProperty('--from', below ? '4px' : '-4px');
  card.style.setProperty('--origin', below ? 'top left' : 'bottom left');
  card.style.setProperty('--bridge-top', below ? '-12px' : '100%');
}

function show(row, instant) {
  clearTimeout(hideTimer); clearTimeout(showTimer);
  const go = () => {
    current = row;
    const it = itemOf(row), isNews = 'news' in row.dataset;
    card.innerHTML = isNews ? newsHTML(it) : cardHTML(it);
    if (!isNews) loadBody(it, row);
    card.style.setProperty('--c', isNews ? SRC_COLOR[it.source] : colorOf(it.status));
    card.classList.toggle('side', isNews);
    card.classList.toggle('quick', card.classList.contains('on'));
    place(row);
    card.classList.add('on');
  };
  instant || Date.now() < warmUntil ? go() : (showTimer = setTimeout(go, 350));
}
function hide() {
  clearTimeout(showTimer);
  hideTimer = setTimeout(() => {
    if (card.classList.contains('on')) warmUntil = Date.now() + 400;
    card.classList.remove('on', 'quick'); current = null;
  }, 140);
}

$('#list').addEventListener('mouseover', (e) => { const a = e.target.closest('a[data-i]'); if (a && a !== current) show(a); });
$('#list').addEventListener('mouseout', (e) => { const a = e.target.closest('a[data-i]'); if (a && !a.contains(e.relatedTarget)) hide(); });
$('#list').addEventListener('focusin', (e) => { const a = e.target.closest('a[data-i]'); if (a) show(a, true); });
$('#list').addEventListener('focusout', (e) => { if (!card.contains(e.relatedTarget)) hide(); });
$('#rail').addEventListener('mouseover', (e) => { const a = e.target.closest('a[data-news]'); if (a && a !== current) show(a); });
$('#rail').addEventListener('mouseout', (e) => { const a = e.target.closest('a[data-news]'); if (a && !a.contains(e.relatedTarget)) hide(); });
$('#rail').addEventListener('focusin', (e) => { const a = e.target.closest('a[data-news]'); if (a) show(a, true); });
$('#rail').addEventListener('focusout', (e) => { if (!card.contains(e.relatedTarget)) hide(); });
card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
card.addEventListener('mouseleave', (e) => { if (!current || !current.contains(e.relatedTarget)) hide(); });
card.addEventListener('focusout', (e) => { if (!card.contains(e.relatedTarget) && e.relatedTarget !== current) hide(); });
card.addEventListener('click', (e) => { if (e.target.closest('[data-copy]')) copyDetails(); });
addEventListener('scroll', () => { if (current) { clearTimeout(hideTimer); card.classList.remove('on', 'quick'); current = null; } }, { passive: true });
addEventListener('keydown', (e) => {
  if (!current || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') { card.classList.remove('on'); current = null; }
  else if (e.key.toLowerCase() === 'c') { e.preventDefault(); copyDetails(); }
  else if (e.key.toLowerCase() === 'o') { e.preventDefault(); window.open(itemOf(current).url, '_blank', 'noopener'); }
});

// ---------- settings: which orgs to show, board field names (per account)
const setPop = $('#settings'), setBtn = $('#settings-btn');
let setForced = false, settingsPane = 'general';
async function openSettings(who, forced) {
  closePopovers('settings');
  const a = activeAcct(); if (!a) return;
  setForced = !!forced;
  const cfg = settingsFor(a.login);
  // the org list from the last load opens it instantly; a skeleton covers the first time
  if (!who && data.orgs && data.login === a.login) who = { login: data.login, name: data.name, orgs: data.orgs };
  if (!who) setPop.innerHTML = `<div class="set-form" aria-busy="true"><header><span class="sk" style="width:90px;height:16px"></span></header>
    <span class="sk" style="width:110px;height:10px;margin:14px 0 10px"></span>
    ${[62, 48, 55, 70].map((w) => `<div class="sk-owner"><span class="sk" style="width:14px;height:14px"></span><span class="sk" style="width:22px;height:22px;border-radius:6px"></span><span class="sk" style="width:${w}%"></span></div>`).join('')}
    <span class="sk" style="width:120px;height:10px;margin:16px 0 8px"></span>
    <div class="set-fields"><span class="sk" style="height:34px;border-radius:8px"></span><span class="sk" style="height:34px;border-radius:8px"></span></div></div>`;
  showSettings();
  if (!who) { try { who = await listOwners(tokens[a.login]); } catch (e) { setPop.innerHTML = `<div class="acct-panel"><p class="acct-msg err">${esc(e.message)}</p></div>`; return; } }
  const picked = new Set((cfg.owners || []).map((o) => o.type + ':' + o.login));
  const opt = (type, login, label, sub) => `<label class="set-owner"><input type="checkbox" name="owner" value="${type}:${esc(login)}" ${picked.has(type + ':' + login) ? 'checked' : ''}>
    <img src="${esc(avatarOf(login, 40))}" alt=""><span>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></label>`;
  const looks = [['brutal', 'Brutal'], ['clay', 'Clay'], ['soft', 'Soft']];
  const boards = `<div class="set-group"><div class="set-label">Show boards from</div>
      <div class="set-owners">${who.orgs.map((o) => opt('org', o.login, o.name, o.name !== o.login ? o.login : '')).join('')}
        ${opt('user', who.login, 'Your own projects', '@' + who.login)}</div></div>
    <div class="set-group"><label class="set-owner set-toggle"><input type="checkbox" name="repoIssues" ${cfg.repoIssues ? 'checked' : ''}><span>Include issues from repos without a board<small>Issues assigned to you that are not on any project board</small></span></label></div>
    <div class="set-group"><div class="set-label">Board field names</div>
      <div class="set-fields"><label>Status field<input name="statusField" value="${esc(cfg.statusField)}" required></label>
        <label>Due date field<input name="dueField" value="${esc(cfg.dueField)}" required></label></div>
      <p class="set-hint">These must match the field names on your GitHub Projects boards.</p></div>`;
  const panes = [
    ['general', 'General', `<div class="set-group"><div class="set-label">Look</div>
        <div class="look-tiles">${looks.map(([v, l]) => `<button type="button" class="look-tile" data-look-pick="${v}" aria-pressed="${document.documentElement.dataset.style === v}">
          <span class="lp lp-${v}" aria-hidden="true"><i></i><i></i><i></i></span><b>${l}</b></button>`).join('')}</div>
        <p class="set-hint">Light or dark follows your system; switch it with the sun/moon button.</p></div>
      <div class="set-group"><label class="set-owner set-toggle"><input type="checkbox" name="funOn" ${funOn() ? 'checked' : ''}><span>Fun extras<small>Streaks, achievements, celebrations, quips and a few surprises</small></span></label></div>`],
    ['boards', 'Boards', boards],
    ['clocks', 'Clocks', `<div class="set-group">${clocksSettingsHTML()}</div>`],
    ['news', 'News', `<div class="set-group">${newsSettingsHTML()}</div>`],
  ];
  const tab = forced ? 'boards' : settingsPane;
  // every pane stays in the form (hidden ones too) so Save reads them all
  setPop.innerHTML = `<form class="set-form${forced ? ' forced' : ''}" autocomplete="off">
    <header><b>${forced ? 'Choose what to show' : 'Settings'}</b>${forced ? '' : '<button type="button" class="c-icon" data-set-close aria-label="Close">✕</button>'}</header>
    ${forced ? `<p class="set-hint">Your token can see ${who.orgs.length} organizations. Pick one or more. You can change this later from the gear icon.</p>` : `
    <nav class="set-tabs" role="tablist">${panes.map(([k, l]) => `<button type="button" role="tab" data-set-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join('')}</nav>`}
    <div class="set-body">${panes.map(([k, , html]) => `<section class="set-pane" data-pane="${k}" role="tabpanel"${k === tab ? '' : ' hidden'}>${html}</section>`).join('')}</div>
    <footer class="set-foot"><p class="acct-msg err" role="alert"></p>
      ${forced ? '' : '<button type="button" class="btn" data-set-close>Cancel</button>'}<button class="btn primary">Save</button></footer>
  </form>`;
  placeSettings();
}
function showPane(k) {
  settingsPane = k;
  setPop.querySelectorAll('[data-set-tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.setTab === k));
  setPop.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== k; });
  setPop.querySelector('.set-body').scrollTop = 0;
}
// a required field on a hidden tab would block Save silently: open its tab first
setPop.addEventListener('invalid', (e) => { const pane = e.target.closest('[data-pane]'); if (pane?.hidden) showPane(pane.dataset.pane); }, true);
function placeSettings() {
  const r = setBtn.getBoundingClientRect();
  setPop.style.top = r.bottom + 8 + 'px';
  setPop.style.left = Math.max(12, Math.min(r.right - setPop.offsetWidth, innerWidth - setPop.offsetWidth - 12)) + 'px';
}
function showSettings() { setPop.classList.add('on'); setBtn.setAttribute('aria-expanded', 'true'); placeSettings(); }
function closeSettings() { if (setForced) return; setPop.classList.remove('on'); setBtn.setAttribute('aria-expanded', 'false'); }
setBtn.addEventListener('click', (e) => { e.stopPropagation(); setPop.classList.contains('on') ? closeSettings() : openSettings(null, false); });
setPop.addEventListener('click', (e) => {
  e.stopPropagation();
  const st = e.target.closest('[data-set-tab]');
  if (st) { showPane(st.dataset.setTab); return; }
  const look = e.target.closest('[data-look-pick]');
  // applies at once so the looks can be compared; not tied to Save
  if (look) { setStyle(look.dataset.lookPick); setPop.querySelectorAll('[data-look-pick]').forEach((b) => b.setAttribute('aria-pressed', b === look)); render(); return; }
  const tp = e.target.closest('[data-topic]');
  if (tp) { tp.setAttribute('aria-pressed', tp.getAttribute('aria-pressed') !== 'true'); return; }
  if (e.target.closest('[data-kw]')) { e.target.closest('[data-kw]').remove(); return; }
  if (e.target.closest('[data-kw-add]')) { addKeyword(e.target.closest('form')); return; }
  if (e.target.closest('[data-clock-add]')) { addClock(e.target.closest('form')); return; }
  if (e.target.closest('[data-zone-pick]')) { const f = e.target.closest('form'); f.elements.zone.value = e.target.closest('[data-zone-pick]').dataset.zonePick; addClock(f); return; }
  if (e.target.closest('[data-clock]')) { const f = e.target.closest('form'); e.target.closest('[data-clock]').remove(); f.querySelector('[data-zone-results]').innerHTML = zoneResultsFor(f, f.elements.zone.value); return; }
  if (e.target.closest('[data-set-close]')) closeSettings();
});
// Enter in the keyword box adds it instead of saving the form
setPop.addEventListener('input', (e) => { if (e.target.name === 'zone') e.target.form.querySelector('[data-zone-results]').innerHTML = zoneResultsFor(e.target.form, e.target.value); });
setPop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.name === 'kw') { e.preventDefault(); addKeyword(e.target.form); }
  if (e.key === 'Enter' && e.target.name === 'zone') { e.preventDefault(); addClock(e.target.form); }
});
setPop.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target, a = activeAcct(), cfg = settingsFor(a.login);
  const owners = [...f.querySelectorAll('[name=owner]:checked')].map((x) => { const [type, ...l] = x.value.split(':'); return { type, login: l.join(':') }; });
  if (!owners.length) { f.querySelector('.acct-msg').textContent = 'Pick at least one.'; return; }
  const next = { owners, statusField: f.elements.statusField.value.trim(), dueField: f.elements.dueField.value.trim(), repoIssues: f.elements.repoIssues.checked };
  const changed = JSON.stringify(next) !== JSON.stringify({ owners: cfg.owners, statusField: cfg.statusField, dueField: cfg.dueField, repoIssues: cfg.repoIssues });
  const nextClocks = [...f.querySelectorAll('[data-clock]')].map((b) => ({ tz: b.dataset.clock }));
  if (JSON.stringify(nextClocks) !== JSON.stringify(clocks.map((c) => ({ tz: c.tz })))) { clocks = nextClocks; saveClocks(); renderClocks(); }
  if (f.elements.funOn && f.elements.funOn.checked !== funOn()) { fun.on = f.elements.funOn.checked; saveFun(); paintIdentity(); render(); }
  const nextNews = readNewsSettings(f), newsChanged = JSON.stringify(nextNews) !== JSON.stringify({ show: newsPrefs.show, topics: newsPrefs.topics, custom: newsPrefs.custom, sources: newsPrefs.sources });
  if (newsChanged) { Object.assign(newsPrefs, nextNews); saveNewsPrefs(); newsView.filter = 'all'; renderRail(); loadNews(true); }
  Object.assign(cfg, next); saveSettings();
  setForced = false; closeSettings();
  if (changed) { state.project = null; try { localStorage.removeItem(cacheKey(a.login)); } catch {} setData(null); loadLive(true); }
});
document.addEventListener('click', () => { if (setPop.classList.contains('on')) closeSettings(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && setPop.classList.contains('on')) closeSettings(); });


// ---------- world clocks (local + zones you add in Settings)
const CLOCKS_KEY = 'clocks.v1';
let clocks = (() => { try { return JSON.parse(localStorage.getItem(CLOCKS_KEY)) || []; } catch { return []; } })();
const saveClocks = () => { try { localStorage.setItem(CLOCKS_KEY, JSON.stringify(clocks)); } catch {} };
const ALL_ZONES = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return []; } })();
const cityOf = (tz) => tz.split('/').pop().replace(/_/g, ' ');
// accepts "America/New_York", "new york", "karachi"; null when it isn't a real zone
function resolveZone(raw) {
  const v = raw.trim(); if (!v) return null;
  const hit = ALL_ZONES.find((z) => z.toLowerCase() === v.toLowerCase() || cityOf(z).toLowerCase() === v.toLowerCase());
  if (hit) return hit;
  try { new Intl.DateTimeFormat(undefined, { timeZone: v }); return v; } catch { return null; }
}
function zoneTime(tz, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(now).map((p) => [p.type, p.value]));
  const wall = (z) => new Date(now.toLocaleString('en-US', { timeZone: z }));
  const diffH = Math.round(((wall(tz) - wall(undefined)) / 36e5) * 2) / 2; // half-hour zones exist
  const day = (z) => now.toLocaleDateString('en-CA', { timeZone: z });
  const dayShift = day(tz) === day(undefined) ? 0 : day(tz) > day(undefined) ? 1 : -1;
  const hour24 = +new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now);
  return { time: `${parts.hour}:${parts.minute}`, ampm: parts.dayPeriod, diffH, dayShift, working: hour24 >= 9 && hour24 < 18 };
}
function renderClocks() {
  const el = $('#clocks'); if (!el) return;
  const local = zoneTime(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const tile = (label, z, extra = '', cls = '', title = '') => `<div class="clock ${cls}" title="${esc(title)}">
      <span class="cl-l">${extra}${esc(label)}</span><span class="cl-t">${z.time}<small>${z.ampm}</small>${z.dayShift ? `<sup>${z.dayShift > 0 ? '+1' : '−1'}</sup>` : ''}</span></div>`;
  el.innerHTML = tile('Local', local, '', 'local', `Your time · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`) + clocks.map((c) => {
    const z = zoneTime(c.tz), d = z.diffH === 0 ? 'same time' : `${z.diffH > 0 ? '+' : '−'}${Math.abs(z.diffH)}h`;
    return tile(c.label || zoneLabel(c.tz), z, `<i class="dot${z.working ? ' on' : ''}"></i>`, '', `${c.tz} · ${d} from you · ${z.working ? 'working hours' : 'outside 9 AM–6 PM'}${z.dayShift ? (z.dayShift > 0 ? ' · tomorrow there' : ' · yesterday there') : ''}`)
      .replace('</span><span class="cl-t">', ` <em>${d}</em></span><span class="cl-t">`);
  }).join('');
}

const SUGGESTED_ZONES = ['America/New_York', 'America/Los_Angeles', 'America/Chicago', 'America/Toronto', 'Europe/London', 'Europe/Berlin',
  'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'].filter((z) => resolveZone(z));
const ZONE_LABEL = { 'America/Los_Angeles': 'San Francisco', 'Asia/Kolkata': 'India', 'Asia/Calcutta': 'India' };
// common abbreviations people search by; Intl only knows a few of these (e.g. it calls Karachi "GMT+5")
const ZONE_ABBR = {
  PKT: 'Asia/Karachi', IST: 'Asia/Kolkata', NPT: 'Asia/Kathmandu', BDT: 'Asia/Dhaka', GST: 'Asia/Dubai', AST: 'Asia/Riyadh', MSK: 'Europe/Moscow', TRT: 'Europe/Istanbul',
  SGT: 'Asia/Singapore', HKT: 'Asia/Hong_Kong', PHT: 'Asia/Manila', WIB: 'Asia/Jakarta', ICT: 'Asia/Bangkok', CST8: 'Asia/Shanghai', JST: 'Asia/Tokyo', KST: 'Asia/Seoul',
  AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney', AWST: 'Australia/Perth', NZST: 'Pacific/Auckland', NZDT: 'Pacific/Auckland',
  GMT: 'Europe/London', BST: 'Europe/London', UTC: 'UTC', WET: 'Europe/Lisbon', CET: 'Europe/Berlin', CEST: 'Europe/Berlin', EET: 'Europe/Helsinki', EEST: 'Europe/Helsinki',
  SAST: 'Africa/Johannesburg', WAT: 'Africa/Lagos', EAT: 'Africa/Nairobi', CAT: 'Africa/Maputo',
  EST: 'America/New_York', EDT: 'America/New_York', ET: 'America/New_York', CST: 'America/Chicago', CDT: 'America/Chicago', CT: 'America/Chicago',
  MST: 'America/Denver', MDT: 'America/Denver', MT: 'America/Denver', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PT: 'America/Los_Angeles',
  AKST: 'America/Anchorage', HST: 'Pacific/Honolulu', BRT: 'America/Sao_Paulo', ART: 'America/Argentina/Buenos_Aires',
};
// big cities that share another city's zone
const CITY_ZONE = {
  lahore: 'Asia/Karachi', islamabad: 'Asia/Karachi', rawalpindi: 'Asia/Karachi', faisalabad: 'Asia/Karachi', peshawar: 'Asia/Karachi', multan: 'Asia/Karachi',
  mumbai: 'Asia/Kolkata', delhi: 'Asia/Kolkata', 'new delhi': 'Asia/Kolkata', bangalore: 'Asia/Kolkata', bengaluru: 'Asia/Kolkata', hyderabad: 'Asia/Kolkata', chennai: 'Asia/Kolkata', pune: 'Asia/Kolkata',
  'san francisco': 'America/Los_Angeles', seattle: 'America/Los_Angeles', 'silicon valley': 'America/Los_Angeles', 'san diego': 'America/Los_Angeles',
  boston: 'America/New_York', miami: 'America/New_York', atlanta: 'America/New_York', washington: 'America/New_York', philadelphia: 'America/New_York',
  austin: 'America/Chicago', dallas: 'America/Chicago', houston: 'America/Chicago', 'abu dhabi': 'Asia/Dubai', sharjah: 'Asia/Dubai', jeddah: 'Asia/Riyadh',
  beijing: 'Asia/Shanghai', shenzhen: 'Asia/Shanghai', munich: 'Europe/Berlin', frankfurt: 'Europe/Berlin', hamburg: 'Europe/Berlin', manchester: 'Europe/London', edinburgh: 'Europe/London',
  barcelona: 'Europe/Madrid', milan: 'Europe/Rome', krakow: 'Europe/Warsaw', 'st petersburg': 'Europe/Moscow', osaka: 'Asia/Tokyo', 'ho chi minh': 'Asia/Ho_Chi_Minh', canberra: 'Australia/Sydney',
};
const abbrOf = (tz) => { const hit = Object.entries(ZONE_ABBR).find(([, z]) => z === tz || resolveZone(z) === tz); return hit && !/\d/.test(hit[0]) ? hit[0] : null; };
// built on first search: long name ("Pakistan Standard Time") and current offset ("GMT+5") per zone
let zoneIndex = null;
function buildZoneIndex() {
  const now = new Date(), name = (tz, style) => { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: style }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value || ''; } catch { return ''; } };
  return ALL_ZONES.map((z) => ({ z, label: zoneLabel(z), long: name(z, 'long'), offset: name(z, 'shortOffset'), abbr: abbrOf(z) }));
}
// "utc+5", "gmt-4", "+5:30" -> "GMT+5" style, to compare with shortOffset
function offsetQuery(q) {
  const m = /^(?:utc|gmt)?\s*([+-−])\s*(\d{1,2})(?::?(\d{2}))?$/.exec(q);
  if (!m) return null;
  const sign = m[1] === '+' ? '+' : '-', h = +m[2], min = m[3] && +m[3] ? ':' + m[3] : '';
  return h === 0 && !min ? 'GMT' : `GMT${sign}${h}${min}`;
}
const zoneLabel = (tz) => ZONE_LABEL[tz] || cityOf(tz);
function clocksSettingsHTML() {
  return `<div class="set-label">Clocks</div>
    <div class="news-topics" data-clock-list>${clocks.map((c) => `<button type="button" class="chip" data-clock="${esc(c.tz)}" aria-pressed="true" title="Click to remove">${esc(c.label || zoneLabel(c.tz))} ✕</button>`).join('')}</div>
    <div class="p-add kw-add"><input name="zone" placeholder="Search a city or timezone" aria-label="Search a timezone" autocomplete="off"><button type="button" data-clock-add aria-label="Add timezone">+</button></div>
    <div class="zone-results" data-zone-results>${zoneResults('')}</div>
    <p class="acct-msg err" data-clock-err></p>`;
}
// empty query: suggested zones as chips; otherwise matching zones with their time right now
const zoneResultsFor = (form, q) => zoneResults(q, new Set([...form.querySelectorAll('[data-clock]')].map((b) => b.dataset.clock)));
function zoneResults(q, taken = new Set(clocks.map((c) => c.tz))) {
  q = q.trim().toLowerCase();
  if (!q) {
    const list = SUGGESTED_ZONES.filter((z) => !taken.has(z));
    return list.length ? `<div class="set-hint">Suggested</div><div class="zone-chips">${list.map((z) => `<button type="button" class="chip" data-zone-pick="${z}">${esc(zoneLabel(z))}</button>`).join('')}</div>` : '';
  }
  zoneIndex ||= buildZoneIndex();
  const qU = q.toUpperCase(), abbrHit = ZONE_ABBR[qU] && resolveZone(ZONE_ABBR[qU]), cityHit = CITY_ZONE[q] && resolveZone(CITY_ZONE[q]), off = offsetQuery(q);
  // names match at the start of a word, so "est" finds Eastern but not West
  const word = new RegExp('(^|[\\s/(_-])' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const match = (e) => word.test(e.z.replace(/_/g, ' ')) || word.test(e.label) || word.test(e.long) || (off && e.offset === off);
  // well-known zones (ones with a common abbreviation) rank ahead of the rest
  const ranked = zoneIndex.filter(match).sort((a, b) => (b.abbr ? 1 : 0) - (a.abbr ? 1 : 0)).map((e) => e.z);
  const hits = [...new Set([abbrHit, cityHit, ...ranked].filter(Boolean))].slice(0, 8);
  if (!hits.length) return '<div class="set-hint">No timezone matches that. Try a bigger city nearby.</div>';
  return `<div class="zone-list">${hits.map((z) => {
    const t = zoneTime(z), d = t.diffH === 0 ? 'same time' : `${t.diffH > 0 ? '+' : '−'}${Math.abs(t.diffH)}h`;
    const e = zoneIndex.find((x) => x.z === z) || { long: new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'long' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value, abbr: abbrOf(z) };
    const badge = abbrHit === z && !/\d/.test(qU) ? qU : e.abbr;
    return `<button type="button" class="zone-row" data-zone-pick="${z}"${taken.has(z) ? ' disabled' : ''}><b>${esc(zoneLabel(z))}${badge ? ` <small>${badge}</small>` : ''}</b>
      <span>${esc(e.long || z)}</span><em>${t.time} ${t.ampm} · ${d}</em></button>`;
  }).join('')}</div>`;
}
function addClock(form) {
  const input = form.elements.zone, tz = resolveZone(input.value), err = form.querySelector('[data-clock-err]');
  if (!tz) { err.textContent = input.value.trim() ? `"${input.value.trim()}" isn't a timezone. Try a city like Berlin, or pick from the list.` : ''; return; }
  err.textContent = '';
  if (![...form.querySelectorAll('[data-clock]')].some((b) => b.dataset.clock === tz)) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.dataset.clock = tz; b.title = 'Click to remove'; b.textContent = zoneLabel(tz) + ' ✕'; b.setAttribute('aria-pressed', 'true');
    form.querySelector('[data-clock-list]').append(b);
  }
  input.value = ''; input.focus();
  form.querySelector('[data-zone-results]').innerHTML = zoneResultsFor(form, '');
}

// ---------- tech news & trending (sidebar card under Notes)
// sources need no keys: Hacker News (Algolia), Simon Willison's Atom feed, Hugging Face, GitHub (your token)
const NEWS_TTL = 30 * 60 * 1000;
const TOPICS = {
  ai: { label: 'AI models', ai: true, kws: ['model', 'LLM', 'GPT', 'Claude', 'Gemini', 'Llama'], gh: 'llm', sw: ['ai', 'llms', 'generative-ai'] },
  agents: { label: 'LLMs & agents', ai: true, kws: ['agent', 'agents', 'MCP', 'RAG'], gh: 'ai-agents', sw: ['ai-agents', 'agents', 'model-context-protocol'] },
  oss: { label: 'Open-source AI', ai: true, kws: ['open-weights', 'Llama', 'Qwen', 'Mistral', 'local LLM'], gh: 'local-llm', sw: ['local-llms', 'open-source'] },
  web: { label: 'Web dev', kws: ['JavaScript', 'TypeScript', 'React', 'CSS', 'browser'], gh: 'react', sw: ['javascript', 'css', 'web'] },
  devops: { label: 'DevOps & cloud', kws: ['Kubernetes', 'Docker', 'AWS', 'Terraform', 'Linux'], gh: 'devops', sw: ['docker', 'kubernetes'] },
  security: { label: 'Security', kws: ['security', 'vulnerability', 'CVE', 'breach'], gh: 'security', sw: ['security', 'prompt-injection'] },
  mobile: { label: 'Mobile', kws: ['iOS', 'Android', 'Swift', 'Flutter'], gh: 'flutter', sw: ['ios', 'android'] },
  langs: { label: 'Languages', kws: ['Rust', 'Go', 'Python', 'Zig'], gh: 'rust', sw: ['rust', 'python', 'go'] },
  industry: { label: 'Startups & industry', kws: ['startup', 'funding', 'acquisition', 'layoffs'], gh: null, sw: [] },
};
const NEWS_DEFAULT = { show: true, topics: ['ai', 'web'], custom: [], sources: { hn: true, simon: true, github: true, hf: true } };
const newsPrefs = (() => { let p = null; try { p = JSON.parse(localStorage.getItem('news.prefs')); } catch {} return { ...structuredClone(NEWS_DEFAULT), ...(p || {}), sources: { ...NEWS_DEFAULT.sources, ...(p?.sources || {}) } }; })();
const saveNewsPrefs = () => { try { localStorage.setItem('news.prefs', JSON.stringify(newsPrefs)); } catch {} };
const newsView = { tab: 'news', filter: 'all' };
let news = (() => { try { return JSON.parse(localStorage.getItem('news.cache')); } catch { return null; } })(), newsLoading = false, newsError = '';

function activeTopics() {
  return newsPrefs.topics.filter((id) => TOPICS[id]).map((id) => ({ id, ...TOPICS[id] }))
    .concat(newsPrefs.custom.map((k) => ({ id: 'kw:' + k, label: k, kws: [k], gh: null, custom: true, sw: [k.toLowerCase()] })));
}
const newsKey = () => JSON.stringify([newsPrefs.topics, newsPrefs.custom, newsPrefs.sources, accts.active]);

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}
const hoursAgo = (ms) => (Date.now() - ms) / 36e5;

async function fromHN(t) {
  const since = Math.floor(Date.now() / 1000) - 3 * 86400;
  const q = new URLSearchParams({ query: t.kws.join(' '), optionalWords: t.kws.join(' '), tags: 'story', numericFilters: `created_at_i>${since},points>40`, hitsPerPage: '12' });
  const d = await getJSON('https://hn.algolia.com/api/v1/search?' + q);
  return d.hits.map((h) => ({ kind: 'story', source: 'Hacker News', title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    discuss: `https://news.ycombinator.com/item?id=${h.objectID}`, points: h.points, comments: h.num_comments, at: h.created_at_i * 1000, topics: [t.id] }));
}
async function fromSimon(topics) {
  const r = await fetch('https://simonwillison.net/atom/everything/');
  if (!r.ok) throw new Error(`simonwillison.net answered ${r.status}`);
  const doc = new DOMParser().parseFromString(await r.text(), 'application/xml');
  return [...doc.querySelectorAll('entry')].slice(0, 30).map((e) => {
    const title = e.querySelector('title')?.textContent || '', tags = [...e.querySelectorAll('category')].map((c) => c.getAttribute('term'));
    const text = (title + ' ' + tags.join(' ')).toLowerCase();
    const hit = topics.filter((t) => t.sw.some((s) => tags.includes(s) || text.includes(s)) || (t.custom && text.includes(t.label.toLowerCase())));
    return hit.length && { kind: 'story', source: 'Simon Willison', title, url: e.querySelector('link')?.getAttribute('href'), at: Date.parse(e.querySelector('updated')?.textContent), topics: hit.map((t) => t.id) };
  }).filter((x) => x && Date.now() - x.at < 7 * 864e5);
}
async function fromGitHub(t, token) {
  const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const q = t.gh ? `topic:${t.gh} created:>${since} stars:>150 sort:stars` : `${t.label} in:name,description created:>${since} stars:>50 sort:stars`;
  const d = await gql(token, 'query($q:String!){search(query:$q,type:REPOSITORY,first:8){nodes{... on Repository{nameWithOwner url description stargazerCount createdAt primaryLanguage{name}}}}}', { q });
  return d.search.nodes.map((n) => ({ kind: 'repo', source: 'GitHub', title: n.nameWithOwner, url: n.url, desc: n.description, stars: n.stargazerCount, lang: n.primaryLanguage?.name, at: Date.parse(n.createdAt), topics: [t.id] }));
}
async function fromHF() {
  const d = await getJSON('https://huggingface.co/api/models?sort=trendingScore&limit=20');
  return d.filter((m) => !/uncensored|abliterated|nsfw/i.test(m.id) && m.likes >= 50).slice(0, 10)
    .map((m) => ({ kind: 'model', source: 'Hugging Face', title: m.id, url: `https://huggingface.co/${m.id}`, likes: m.likes, task: m.pipeline_tag, at: Date.parse(m.createdAt), topics: ['ai'] }));
}

async function loadNews(force) {
  if (!navigator.onLine) return;
  if (!newsPrefs.show || newsLoading) return;
  if (!force && news && news.key === newsKey() && Date.now() - news.at < NEWS_TTL) return;
  const topics = activeTopics(), src = newsPrefs.sources, token = tokens[accts.active];
  if (!topics.length) { news = { key: newsKey(), at: Date.now(), stories: [], trending: [] }; return renderRail(); }
  newsLoading = true; newsError = ''; renderRail();
  const jobs = [];
  if (src.hn) topics.forEach((t) => jobs.push(fromHN(t)));
  if (src.simon) jobs.push(fromSimon(topics));
  if (src.github && token) topics.filter((t) => t.gh || t.custom).slice(0, 3).forEach((t) => jobs.push(fromGitHub(t, token)));
  if (src.hf && topics.some((t) => t.ai)) jobs.push(fromHF());
  const res = await Promise.allSettled(jobs);
  const all = res.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
  // one row per link; a story matching two topics keeps both
  const byUrl = new Map();
  for (const it of all) { const had = byUrl.get(it.url); if (had) had.topics = [...new Set([...had.topics, ...it.topics])]; else byUrl.set(it.url, it); }
  const items = [...byUrl.values()];
  // HN-style gravity: points fade with age; blog posts count as a steady 60
  const score = (it) => (it.points ?? 60) / Math.pow(hoursAgo(it.at) + 2, 0.8);
  const stories = items.filter((i) => i.kind === 'story').sort((a, b) => score(b) - score(a)).slice(0, 30);
  const trending = items.filter((i) => i.kind !== 'story').sort((a, b) => (b.stars ?? b.likes * 2) - (a.stars ?? a.likes * 2)).slice(0, 24);
  const failed = res.filter((r) => r.status === 'rejected');
  if (!items.length && failed.length) newsError = failed[0].reason?.message || 'News sources did not answer';
  else { news = { key: newsKey(), at: Date.now(), stories, trending }; try { localStorage.setItem('news.cache', JSON.stringify(news)); } catch {} }
  newsLoading = false; renderRail();
}

let newsRows = [];
// small source mark: GitHub uses the repo owner's avatar, the rest a colored badge (no extra requests)
function srcBadge(i) {
  if (i.kind === 'repo') return `<img class="src" src="${esc(avatarOf(i.title.split('/')[0], 36))}" alt="" title="GitHub">`;
  const [cls, txt] = i.source === 'Hacker News' ? ['hn', 'Y'] : i.source === 'Hugging Face' ? ['hf', 'HF'] : ['sw', 'S'];
  return `<span class="src ${cls}" title="${esc(i.source)}" aria-hidden="true">${txt}</span>`;
}
const newsStat = (i) => i.kind === 'repo' ? '★ ' + fmtNum(i.stars) : i.kind === 'model' ? '♥ ' + fmtNum(i.likes) : i.points != null ? fmtNum(i.points) : ago(new Date(i.at).toISOString());
const SRC_COLOR = { 'Hacker News': '#ff6600', 'Simon Willison': 'var(--progress)', GitHub: 'var(--text)', 'Hugging Face': '#ffcc4d' };
function newsHTML(i) {
  const host = (() => { try { return new URL(i.url).host.replace(/^www\./, ''); } catch { return ''; } })();
  const facts = [];
  if (i.kind === 'story' && i.points != null) facts.push(['Points', fmtNum(i.points)]);
  if (i.discuss) facts.push(['Discussion', `<a href="${esc(i.discuss)}" target="_blank" rel="noopener">${i.comments || 0} comments on Hacker News</a>`]);
  if (i.kind === 'repo') facts.push(['Stars', '★ ' + fmtNum(i.stars)], ...(i.lang ? [['Language', esc(i.lang)]] : []));
  if (i.kind === 'model') facts.push(['Likes', '♥ ' + fmtNum(i.likes)], ...(i.task ? [['Type', esc(i.task)]] : []));
  const labels = activeTopics().filter((t) => i.topics.includes(t.id)).map((t) => esc(t.label));
  if (labels.length) facts.push(['Topic', labels.join(', ')]);
  facts.push([i.kind === 'story' ? 'Posted' : 'Created', `${fmtDate(new Date(i.at).toISOString())} (${ago(new Date(i.at).toISOString())})`]);
  if (host) facts.push(['Site', esc(host)]);
  return `<div class="c-head">${srcBadge(i)}<span>${esc(i.source)}</span><span class="c-sp"></span>
      <button type="button" class="c-icon" data-copy title="Copy link (C)" aria-label="Copy link">${ICON_COPY}</button>
      <a class="c-icon" href="${esc(i.url)}" target="_blank" rel="noopener" title="Open in new tab (O)" aria-label="Open in new tab">${ICON_OPEN}</a></div>
    <p class="c-title">${esc(i.title)}</p>${i.desc ? `<p class="c-body">${esc(i.desc)}</p>` : ''}
    <dl class="c-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}
const newsText = (i) => [i.title, i.url, ...(i.discuss ? [`Discussion: ${i.discuss}`] : [])].join('\n');
const fmtNum = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
const NEWS_ROWS = 7;
function newsCard() {
  if (!newsPrefs.show) return '';
  const topics = activeTopics();
  const list = (newsView.tab === 'news' ? news?.stories : news?.trending) || [];
  const shown = list.filter((i) => newsView.filter === 'all' || i.topics.includes(newsView.filter)).slice(0, NEWS_ROWS);
  newsRows = shown;
  const row = (i, idx) => `<li><a class="news-item" href="${esc(i.url)}" data-news="${idx}" target="_blank" rel="noopener" aria-describedby="card">
      ${srcBadge(i)}<span class="nt">${esc(i.title)}</span><span class="ns">${esc(newsStat(i))}</span></a></li>`;
  const body = newsError && !news ? `<p class="rail-empty">Couldn't load news: ${esc(newsError)}. <button class="txt-btn" data-news-retry>Try again</button></p>`
    : !news && newsLoading ? `<ul class="news-list" aria-hidden="true">${[80, 64, 72, 58, 76].map((w) => `<li class="news-sk"><span class="sk" style="width:${w}%"></span><span class="sk" style="width:40%;height:9px"></span></li>`).join('')}</ul>`
    : !topics.length ? '<p class="rail-empty">Pick some topics in Settings to see news here.</p>'
    : shown.length ? `<ul class="news-list">${shown.map((i, idx) => row(i, idx)).join('')}</ul>`
    : `<p class="rail-empty">Nothing ${newsView.tab === 'news' ? 'new' : 'trending'} for this topic yet.</p>`;
  return `<section class="rail-card news-card"><header><h2>Tech</h2>
      <div class="scope news-tabs" role="tablist" aria-label="News view">${[['news', 'News'], ['trending', 'Trending']].map(([k, l]) => `<button type="button" role="tab" data-news-tab="${k}" aria-pressed="${newsView.tab === k}">${l}</button>`).join('')}</div></header>
    ${topics.length > 1 ? `<div class="news-chips">${[{ id: 'all', label: 'All' }, ...topics].map((t) => `<button type="button" class="chip" data-news-filter="${esc(t.id)}" aria-pressed="${newsView.filter === t.id}">${esc(t.label)}</button>`).join('')}</div>` : ''}
    ${body}
    <footer class="news-foot"><span>${news ? `Updated ${ago(new Date(news.at).toISOString()) === 'today' ? new Date(news.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ago(new Date(news.at).toISOString())}` : ''}${newsLoading && news ? ' · refreshing…' : ''}</span>
      <button type="button" class="c-icon" data-news-retry title="Refresh news" aria-label="Refresh news">${ICON_RELOAD}</button></footer>
  </section>`;
}
$('#rail').addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-news-tab]')) { newsView.tab = t.closest('[data-news-tab]').dataset.newsTab; renderRail(); }
  else if (t.closest('[data-news-filter]')) { newsView.filter = t.closest('[data-news-filter]').dataset.newsFilter; renderRail(); }
  else if (t.closest('[data-news-retry]')) loadNews(true);
});

// settings section for news; read back on Save
function newsSettingsHTML() {
  return `<div class="set-label">Tech news</div>
    <label class="set-owner set-toggle"><input type="checkbox" name="newsShow" ${newsPrefs.show ? 'checked' : ''}><span>Show news and trending in the sidebar</span></label>
    <div class="set-hint">Topics</div>
    <div class="news-topics">${Object.entries(TOPICS).map(([id, t]) => `<button type="button" class="chip" data-topic="${id}" aria-pressed="${newsPrefs.topics.includes(id)}">${esc(t.label)}</button>`).join('')}
      ${newsPrefs.custom.map((k) => `<button type="button" class="chip" data-kw="${esc(k)}" aria-pressed="true" title="Click to remove">${esc(k)} ✕</button>`).join('')}</div>
    <div class="p-add kw-add"><input name="kw" placeholder="Add your own, like Postgres or Next.js" aria-label="Add a topic keyword" maxlength="30"><button type="button" data-kw-add aria-label="Add keyword">+</button></div>
    <div class="set-hint">Sources</div>
    <div class="news-sources">${[['hn', 'Hacker News'], ['simon', 'Simon Willison'], ['github', 'GitHub trending'], ['hf', 'Hugging Face']].map(([k, l]) => `<label><input type="checkbox" name="src-${k}" ${newsPrefs.sources[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>`;
}
function readNewsSettings(f) {
  return {
    show: f.elements.newsShow.checked,
    topics: [...f.querySelectorAll('[data-topic][aria-pressed="true"]')].map((b) => b.dataset.topic),
    custom: [...f.querySelectorAll('[data-kw]')].map((b) => b.dataset.kw),
    sources: Object.fromEntries(['hn', 'simon', 'github', 'hf'].map((k) => [k, f.elements['src-' + k].checked])),
  };
}
function addKeyword(form) {
  const input = form.elements.kw, k = input.value.trim().replace(/\s+/g, ' ');
  if (!k || [...form.querySelectorAll('[data-kw]')].some((b) => b.dataset.kw.toLowerCase() === k.toLowerCase())) { input.value = ''; return; }
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'chip'; b.dataset.kw = k; b.setAttribute('aria-pressed', 'true'); b.title = 'Click to remove'; b.textContent = k + ' ✕';
  form.querySelector('.news-topics').append(b); input.value = ''; input.focus();
}

// ---------- fun extras: streak, celebrations, week in code, greetings, quips, achievements, easter eggs
// all local, computed from data already loaded; one switch in Settings turns everything off
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const dayKey = (d) => isoDate(new Date(d));

// 1. streak: consecutive workdays with something closed or merged; today counts once it happens, weekends never break it
function activeDays() {
  if (data.contrib) return new Set(Object.entries(data.contrib).filter(([, n]) => n > 0).map(([d]) => d));
  return new Set((data.recent || []).filter((r) => r.closedAt).map((r) => dayKey(r.closedAt)));
}
function shipStreak() {
  const days = activeDays();
  const d = startOfDay(new Date());
  if (!days.has(isoDate(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  for (let i = 0; i < 62; i++, d.setDate(d.getDate() - 1)) {
    const weekend = d.getDay() === 0 || d.getDay() === 6, hit = days.has(isoDate(d));
    if (hit) n++; else if (!weekend) break;
  }
  return n;
}

// 3. week in code: Monday to now
function weekStats() {
  const mon = startOfDay(new Date()); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  const wk = (data.recent || []).filter((r) => r.closedAt && new Date(r.closedAt) >= mon);
  const issues = wk.filter((r) => r.kind !== 'PullRequest'), prs = wk.filter((r) => r.kind === 'PullRequest');
  const byDay = {}; wk.forEach((r) => { const k = new Date(r.closedAt).toLocaleDateString(undefined, { weekday: 'long' }); byDay[k] = (byDay[k] || 0) + 1; });
  const busiest = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
  const repos = {}; wk.forEach((r) => { const k = boardOfRepo(r.repo) || r.repo; repos[k] = (repos[k] || 0) + 1; });
  const top = Object.entries(repos).sort((a, b) => b[1] - a[1])[0];
  const bugs = issues.filter((r) => (r.labels || []).some((l) => /bug/i.test(l.name))).length;
  const streak = shipStreak();
  const title = bugs >= 3 ? ['Bug Exterminator', 'Nothing crawls past you.'] : prs.length >= 5 ? ['PR Machine', 'Merge button, meet your match.']
    : issues.length >= 10 ? ['Ship-It Captain', 'The backlog fears you.'] : streak >= 5 ? ['Metronome', 'Something shipped every single day.']
    : wk.length ? ['Steady Shipper', 'Small steps, real progress.'] : ['Recharging', 'Quiet weeks count too.'];
  return { issues: issues.length, prs: prs.length, busiest, top, streak, title, since: mon };
}
const showWeekChip = () => { const d = new Date(); return d.getDay() === 0 || d.getDay() === 6 || (d.getDay() === 5 && d.getHours() >= 15); };

// 6. achievements: checked against current data; once earned they stay
const BADGES = [
  ['streak5', '🔥', 'On a roll', 'A 5-workday contribution streak', () => shipStreak() >= 5],
  ['night', '🦉', 'Night Owl', 'Closed or merged something between midnight and 4 AM', () => (data.recent || []).some((r) => r.closedAt && new Date(r.closedAt).getHours() < 4)],
  ['early', '🐦', 'Early Bird', 'Shipped something before 8 AM', () => (data.recent || []).some((r) => { const h = r.closedAt && new Date(r.closedAt).getHours(); return h >= 4 && h < 8; })],
  ['bugs', '🪲', 'Bug Squasher', 'Closed 10 issues labeled bug', () => (data.recent || []).filter((r) => r.kind !== 'PullRequest' && (r.labels || []).some((l) => /bug/i.test(l.name))).length >= 10],
  ['prs', '🚢', 'PR Machine', 'Merged 10 pull requests in two months', () => (data.recent || []).filter((r) => r.kind === 'PullRequest').length >= 10],
  ['weekend', '🏖️', 'Weekend Warrior', 'Shipped something on a weekend', () => (data.recent || []).some((r) => r.closedAt && [0, 6].includes(new Date(r.closedAt).getDay()))],
  ['zero', '🧘', 'Inbox Zero', 'Emptied your To do', () => !!fun.zeroDay],
  ['unblocked', '🔓', 'Unblocked', 'Nothing of yours blocked', () => data.at && myCount('blocked') === 0],
  ['notes', '📝', 'Note Taker', 'Finished 10 notes', () => fun.notesDone >= 10],
];
function myCount(tab) { return data.projects.flatMap((p) => p.tasks).filter((t) => !t.onBoard && t.assignees.includes(data.login) && tabOf(t.status) === tab).length; }
let badgesChecked = false;
function checkBadges() {
  if (!funOn() || !data.at) return;
  const fresh = BADGES.filter(([id, , , , test]) => !fun.badges[id] && test());
  fresh.forEach(([id]) => { fun.badges[id] = isoDate(new Date()); });
  if (fresh.length) saveFun();
  // first check after install only records; later unlocks get a toast
  if (badgesChecked && fresh.length) toast(`Achievement unlocked: ${fresh[0][1]} ${fresh[0][2]}`);
  badgesChecked = true;
}

// 2. celebrations
function confetti(x = innerWidth / 2, y = innerHeight / 3) {
  if (!funOn() || reducedMotion()) return;
  const c = document.createElement('canvas'), ctx = c.getContext('2d'), dpr = devicePixelRatio || 1;
  c.className = 'confetti'; c.width = innerWidth * dpr; c.height = innerHeight * dpr; ctx.scale(dpr, dpr); document.body.append(c);
  const cs = getComputedStyle(document.documentElement), colors = ['--todo', '--progress', '--review', '--done', '--blocked', '--staging'].map((v) => cs.getPropertyValue(v).trim());
  const bits = Array.from({ length: 70 }, () => ({ x, y, vx: (Math.random() - .5) * 9, vy: -Math.random() * 9 - 3, s: 4 + Math.random() * 5, r: Math.random() * 6, vr: (Math.random() - .5) * .3, c: colors[Math.floor(Math.random() * colors.length)] }));
  const start = performance.now();
  (function frame(t) {
    const k = (t - start) / 1100; ctx.clearRect(0, 0, innerWidth, innerHeight);
    bits.forEach((b) => { b.vy += .32; b.x += b.vx; b.y += b.vy; b.r += b.vr; ctx.save(); ctx.globalAlpha = Math.max(0, 1 - k); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2); ctx.restore(); });
    k < 1 ? requestAnimationFrame(frame) : c.remove();
  })(start);
}
// To do reaching zero: celebrate once a day
let lastTodo = null;
function watchInboxZero() {
  if (!funOn() || !data.at) return;
  const n = myCount('todo');
  if (lastTodo > 0 && n === 0 && fun.zeroDay !== isoDate(new Date())) { fun.zeroDay = isoDate(new Date()); saveFun(); confetti(); toast('Inbox zero. Go touch grass. 🌱'); checkBadges(); }
  lastTodo = n;
}

// 4. greetings that notice the moment
function greetingText(name) {
  const d = new Date(), h = d.getHours(), wd = d.getDay(), base = `Good ${h < 5 ? 'evening' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}, ${name}`;
  if (!funOn()) return base;
  if (h >= 23 || h < 4) return `Still up, ${name}?`;
  if (wd === 5 && h >= 15) return `Happy Friday, ${name}`;
  if (wd === 1 && h < 12) return `Fresh week, ${name}`;
  if (wd === 0 || wd === 6) return `Weekend mode, ${name}`;
  return base;
}

// 5. quip: the moment first, otherwise a dev one-liner that changes daily
const QUIPS = [
  '"It works on my machine" is not a deployment strategy.', 'There are two hard things: cache invalidation, naming things, and off-by-one errors.',
  'A good commit message is a love letter to future you.', 'Weeks of coding can save you hours of planning.', 'The best code is the code you never had to write.',
  '99 little bugs in the code. Take one down, patch it around. 127 little bugs in the code.', 'Git blame is just archaeology with a grudge.',
  'Any sufficiently advanced bug is indistinguishable from a feature.', 'Deleted code is debugged code.', "It's not a bug, it's an undocumented feature.",
  'Real programmers count from 0.', 'Rubber duck debugging: 100% success rate, 0% credit to the duck.', 'TODO: write a better TODO.',
  'Your future self will thank you for that test. Or curse you for skipping it.', 'Measure twice, `rm -rf` once.', 'First, solve the problem. Then, write the code.',
  'Simplicity is prerequisite for reliability.', 'Nothing is more permanent than a temporary fix.', "Documentation is a love letter you write to your team's future.",
  'Premature optimization is the root of all evil. Premature deployment is a close second.', 'Code never lies. Comments sometimes do.',
  'A clean build on the first try is a sign from the universe. Do not question it.', 'Every senior developer was once a junior who refused to give up.',
  'Estimate. Double it. Add a sprint.', 'The cloud is just someone else\'s computer having a bad day.', 'Naming a variable `data2` is a cry for help.',
];
function quip() {
  const d = new Date(), h = d.getHours(), wd = d.getDay();
  if (wd === 5 && h >= 15) return 'Friday afternoon. Step away from `git push --force`.';
  if (h >= 23 || h < 4) return 'Your bugs will still be here tomorrow. Fewer of them after sleep.';
  if (wd === 1 && h < 12) return 'Coffee first. Then the backlog.';
  if (data.at) {
    const w = weekStats();
    if (w.issues + w.prs >= 10) return `${w.issues + w.prs} things shipped this week. Absolute legend.`;
    if (myCount('blocked') >= 3) return 'Three things blocked. Time to go unblock someone (maybe yourself).';
  }
  const n = Math.floor(startOfDay(d) / 864e5);
  return QUIPS[n % QUIPS.length];
}

// chips under the greeting: streak, achievements, week in code
function funChips() {
  if (!funOn() || !data.at) return '';
  const s = shipStreak(), earned = BADGES.filter(([id]) => fun.badges[id]).length;
  const today = activeDays().has(isoDate(new Date()));
  const tip = `Workdays in a row with GitHub contributions (commits, PRs, reviews, issues). Weekends don't break it.${today ? '' : ' Contribute today to keep it going.'}`;
  return `<span class="fun-chips">${s >= 1 ? `<button type="button" class="fun-chip" data-fun="streak" title="${tip}">🔥 ${s}-day streak</button>` : ''}
    <button type="button" class="fun-chip" data-fun="badges" title="Achievements">🏅 ${earned}</button>
    ${showWeekChip() ? '<button type="button" class="fun-chip" data-fun="week" title="Your week in code (W)">🎁 Your week</button>' : ''}</span>`;
}
function paintFunFooter() {
  const q = $('#quip'), duck = $('#duck');
  if (q) q.textContent = funOn() ? quip() : '';
  if (duck) duck.hidden = !funOn();
}

// small panel for achievements and the week card
const funPop = $('#fun-pop');
function openFun(kind, anchor) {
  closePopovers('fun');
  if (kind === 'week') {
    const w = weekStats();
    funPop.innerHTML = `<div class="wk"><div class="wk-kicker">Your week in code · since ${w.since.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
      <div class="wk-title">${w.title[0]}</div><div class="wk-sub">${w.title[1]}</div>
      <div class="wk-grid"><div><b>${w.issues}</b><span>issues closed</span></div><div><b>${w.prs}</b><span>PRs merged</span></div>
        <div><b>${w.streak}</b><span>day streak</span></div><div><b class="wk-word">${w.busiest ? esc(w.busiest[0].slice(0, 3)) : '–'}</b><span>busiest day</span></div></div>
      ${w.top ? `<p class="wk-top">Most of it in <b>${esc(w.top[0])}</b> (${w.top[1]})</p>` : ''}
      <button type="button" class="btn primary" data-fun-copy>Copy to share</button></div>`;
  } else {
    funPop.innerHTML = `<div class="bdg-head"><b>Achievements</b><span>${BADGES.filter(([id]) => fun.badges[id]).length} of ${BADGES.length}</span></div>
      <div class="bdg-grid">${BADGES.map(([id, ic, name, desc]) => `<div class="bdg${fun.badges[id] ? '' : ' locked'}" title="${esc(desc)}${fun.badges[id] ? ` · earned ${fun.badges[id]}` : ''}">
        <span class="bdg-ic">${fun.badges[id] ? ic : '🔒'}</span><b>${esc(name)}</b><small>${esc(desc)}</small></div>`).join('')}</div>`;
  }
  const r = (anchor || $('#hello')).getBoundingClientRect();
  funPop.style.top = r.bottom + 8 + 'px'; funPop.style.left = Math.max(12, Math.min(r.left, innerWidth - 372)) + 'px';
  funPop.classList.add('on');
}
function closeFun() { funPop.classList.remove('on'); }
document.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-fun]');
  if (chip) { e.stopPropagation(); const k = chip.dataset.fun === 'streak' ? 'week' : chip.dataset.fun; funPop.classList.contains('on') && funPop.dataset.kind === k ? closeFun() : (funPop.dataset.kind = k, openFun(k, chip)); return; }
  if (e.target.closest('[data-fun-copy]')) {
    const w = weekStats();
    navigator.clipboard.writeText(`My week in code: ${w.title[0]}. ${w.issues} issues closed, ${w.prs} PRs merged, ${w.streak}-day streak${w.busiest ? `, busiest on ${w.busiest[0]}` : ''}. (via Tabboard)`).then(() => toast('Week copied to clipboard')).catch(() => {});
    return;
  }
  if (funPop.classList.contains('on') && !funPop.contains(e.target)) closeFun();
});

// 7. easter eggs
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
let konami = 0, retroTimer;
addEventListener('keydown', (e) => {
  if (!funOn() || e.target.tagName === 'INPUT') return;
  konami = e.key === KONAMI[konami] || e.key.toLowerCase() === KONAMI[konami] ? konami + 1 : e.key === KONAMI[0] ? 1 : 0;
  if (konami === KONAMI.length) {
    konami = 0; document.documentElement.classList.add('retro'); toast('Retro mode for 60 seconds. >_');
    clearTimeout(retroTimer); retroTimer = setTimeout(() => document.documentElement.classList.remove('retro'), 60000);
  }
  if (e.key.toLowerCase() === 'w' && !e.metaKey && !e.ctrlKey && !e.altKey && data.at) openFun('week');
});
$('#q').addEventListener('input', (e) => { if (funOn() && e.target.value.trim().toLowerCase() === 'sudo') toast('Nice try. 🔒 This dashboard runs as you.'); });
const DUCK_LINES = ['Quack. Explain it to me line by line.', 'Quack? What did you expect it to do?', 'Quack. Have you tried reading the error message?',
  'Quack. Is it plugged in? Is the env var set?', 'Quack. Print it out. What is it actually?', 'Quack. When did it last work?', 'Quack quack. (That means check the cache.)'];
let duckN = 0;
function quack() {
  toast(`🦆 ${DUCK_LINES[duckN++ % DUCK_LINES.length]}`);
  try {
    const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(520, a.currentTime); o.frequency.exponentialRampToValueAtTime(260, a.currentTime + .18);
    g.gain.setValueAtTime(.06, a.currentTime); g.gain.exponentialRampToValueAtTime(.001, a.currentTime + .2);
    o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + .21); o.onended = () => a.close();
  } catch {}
}
$('#duck')?.addEventListener('click', quack);

// switch to Chrome's own new tab page; the toolbar icon or Alt+Shift+T brings Tabboard back
if (window.chrome?.tabs && window.chrome?.storage) {
  const b = $('#to-chrome');
  b.hidden = false;
  b.addEventListener('click', () => {
    chrome.storage.local.set({ ntmode: 'chrome' });
    toast('Switching to Chrome’s new tab. Click Tabboard’s toolbar icon or press Alt+Shift+T to come back.');
    setTimeout(() => chrome.tabs.update({ url: 'chrome://new-tab-page/' }), 1100);
  });
}

// boot: paint the last load instantly, then refresh from GitHub if it is stale
// boot only when new tabs are Tabboard's (in Chrome mode the page is already moving on)
window.tabboardMode.then((mode) => {
  if (mode === 'chrome') return;
  $('#refresh').addEventListener('click', () => loadLive(true));
  setData(activeAcct() ? readCache(accts.active) : null);
  document.fonts.ready.then(() => render());
  // clocks start once everything above is defined, then tick on the minute
  renderClocks();
  setTimeout(function tick() { renderClocks(); setTimeout(tick, 60000 - (Date.now() % 60000) + 50); }, 60000 - (Date.now() % 60000) + 50);
  loadLive();
  loadNews();
});
