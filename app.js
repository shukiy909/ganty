'use strict';
/*
 * Ganty — a light Gantt board.
 * Data lives in this browser (for speed) and in a "Ganty" folder in Google Drive.
 * Tasks of the Google Tasks list "משימות לגנט" (filled by Tasky) arrive in the task pool.
 */

const CFG = window.GANTY_CONFIG || {};
const SCOPES = 'https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/drive.file'
  + ' https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events';
const GANTT_LIST = 'משימות לגנט';
const PROJECT_TAG = '#פרויקט:';
const COLORS = ['#4F7A63', '#1E6FD9', '#6750A4', '#0E8C80', '#D9822B', '#C2410C', '#B4235A', '#64748B'];
const ZOOM = { day: 36, week: 16, month: 5 };
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const DAY_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const LS_DATA = 'ganty-data';
const LS_UI = 'ganty-ui';
const LS_TOKEN = 'ganty-token';

// ---------------------------------------------------------------- dates
// Dates are 'YYYY-MM-DD' strings; day numbers count days since 1970 (UTC, no time zones).
const dayNum = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
const isoOf = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const todayIso = () => { const d = new Date(); return isoOf(Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5)); };
const addDays = (iso, n) => isoOf(dayNum(iso) + n);
const weekday = (n) => new Date(n * 864e5).getUTCDay(); // 0 = Sunday
const short = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d}.${m}`; };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- state
function emptyData() {
  return { version: 1, updatedAt: 0, dirty: false, projects: [], tasks: [] };
}
let data = (() => { try { return JSON.parse(localStorage.getItem(LS_DATA)) || emptyData(); } catch { return emptyData(); } })();
let ui = (() => { try { return Object.assign({ projectId: null, dw: ZOOM.week, poolFilter: 'all', collapsed: {} }, JSON.parse(localStorage.getItem(LS_UI))); } catch { return { projectId: null, dw: ZOOM.week, poolFilter: 'all', collapsed: {} }; } })();

const project = (id) => data.projects.find((p) => p.id === id);
const task = (id) => data.tasks.find((t) => t.id === id);
const current = () => project(ui.projectId) || data.projects[0] || null;

function saveUi() { localStorage.setItem(LS_UI, JSON.stringify(ui)); }

/** Every change goes through here: kept on the device now, sent to Google a moment later. */
function commit() {
  applyConstraints();
  data.updatedAt = Date.now();
  data.dirty = true;
  localStorage.setItem(LS_DATA, JSON.stringify(data));
  render();
  scheduleSync();
}

// ---------------------------------------------------------------- scheduling: dependencies, manual finish, critical path
const DEP_TYPES = {
  FS: { he: 'סיום ← התחלה', text: 'המשימה מתחילה רק אחרי שהקודמת נגמרת' },
  SS: { he: 'התחלה ← התחלה', text: 'המשימה מתחילה רק אחרי שהקודמת התחילה' },
  FF: { he: 'סיום ← סיום', text: 'המשימה נגמרת רק אחרי שהקודמת נגמרת' },
};
const depTip = (d) => `${d.type || 'FS'} · ${DEP_TYPES[d.type || 'FS'].he}: ${DEP_TYPES[d.type || 'FS'].text}${d.lag ? ` · ${d.lag} ימי המתנה` : ''}`;
const depLabel = (d) => `${d.type || 'FS'}${d.lag ? (d.lag > 0 ? '+' : '') + d.lag : ''}`;

/** Where a task really ends: a "manual finish" task that is late keeps growing until it is marked done. */
function effEnd(t) {
  const e = dayNum(t.end);
  if (!t.manualFinish || t.done || t.milestone) return e;
  const p = project(t.projectId);
  // A frozen project's clock stops on the day it was frozen.
  const now = p && p.frozen ? Math.min(dayNum(todayIso()), dayNum(p.frozen.since)) : dayNum(todayIso());
  return Math.max(e, now);
}

/** Tasks in an order where every task comes after the ones it depends on. */
function topo(list) {
  const ids = new Set(list.map((t) => t.id));
  const indeg = new Map(list.map((t) => [t.id, 0]));
  const next = new Map(list.map((t) => [t.id, []]));
  for (const t of list) for (const d of t.deps || []) {
    if (!ids.has(d.from)) continue;
    indeg.set(t.id, indeg.get(t.id) + 1);
    next.get(d.from).push(t.id);
  }
  const queue = list.filter((t) => indeg.get(t.id) === 0).map((t) => t.id), out = [];
  while (queue.length) {
    const id = queue.shift();
    out.push(id);
    for (const n of next.get(id)) { indeg.set(n, indeg.get(n) - 1); if (indeg.get(n) === 0) queue.push(n); }
  }
  for (const t of list) if (!out.includes(t.id)) out.push(t.id); // a loop, just in case
  return out.map(task);
}

/**
 * Keeps the rules: a task never starts (or ends) before what it depends on allows.
 * Late tasks push the ones after them forward; nothing is ever pulled back.
 */
function applyConstraints() {
  let changed = false;
  const sched = data.tasks.filter((t) => t.scheduled && !t.deleted);
  const ids = new Set(sched.map((t) => t.id));
  for (const t of topo(sched)) {
    if (!t.deps || !t.deps.length || t.done) continue;
    const tp = project(t.projectId);
    if (tp && tp.frozen) continue; // nothing moves while the project is frozen
    let minStart = -Infinity, minEnd = -Infinity;
    for (const d of t.deps) {
      if (!ids.has(d.from)) continue;
      const p = task(d.from), lag = d.lag || 0;
      if (d.type === 'SS') minStart = Math.max(minStart, dayNum(p.start) + lag);
      else if (d.type === 'FF') minEnd = Math.max(minEnd, effEnd(p) + lag);
      else minStart = Math.max(minStart, effEnd(p) + 1 + lag);
    }
    const s = dayNum(t.start), e = dayNum(t.end);
    let shift = 0;
    if (s < minStart) shift = minStart - s;
    if (e + shift < minEnd) shift = minEnd - e;
    if (shift > 0) {
      t.start = isoOf(s + shift); t.end = isoOf(e + shift);
      markGoogle(t);
      changed = true;
    }
  }
  return changed;
}

/** Does [a] wait (directly or through others) for task [id]? Used to refuse loops. */
function dependsOn(a, id, seen = new Set()) {
  for (const d of (a && a.deps) || []) {
    if (d.from === id) return true;
    if (seen.has(d.from)) continue;
    seen.add(d.from);
    if (dependsOn(task(d.from), id, seen)) return true;
  }
  return false;
}

/** The tasks that set the project's end date: any delay in them delays the whole project. */
function criticalSet(list) {
  const set = new Set();
  if (!list.length) return set;
  const ids = new Set(list.map((t) => t.id));
  const order = topo(list);
  const succ = new Map(list.map((t) => [t.id, []]));
  for (const t of list) for (const d of t.deps || []) if (ids.has(d.from)) succ.get(d.from).push({ t, d });
  const end = Math.max(...list.map(effEnd));
  const LF = new Map();
  const dur = (t) => effEnd(t) - dayNum(t.start);
  for (const t of order.reverse()) {
    const ss = succ.get(t.id);
    let lf = end;
    for (const { t: n, d } of ss) {
      const lag = d.lag || 0, lfN = LF.get(n.id), lsN = lfN - dur(n);
      if (d.type === 'SS') lf = Math.min(lf, lsN - lag + dur(t));
      else if (d.type === 'FF') lf = Math.min(lf, lfN - lag);
      else lf = Math.min(lf, lsN - 1 - lag);
    }
    LF.set(t.id, lf);
    if (lf - effEnd(t) <= 0) set.add(t.id);
  }
  return set;
}

// ---------------------------------------------------------------- task details: status, priority, tags, costs
const STATUS = { todo: 'לא התחיל', doing: 'בעבודה', waiting: '⏸ ממתין', blocked: '⛔ חסום' };
const PRIORITY = { high: 'גבוהה', normal: 'רגילה', low: 'נמוכה' };
const KINDS = { person: 'אדם / ספק', material: 'חומר / ציוד', money: 'כסף' };
const money = (n) => `₪${Math.round(n || 0).toLocaleString('he-IL')}`;
function allTags() {
  const set = new Set();
  data.tasks.forEach((t) => (t.tags || []).forEach((g) => set.add(g)));
  return [...set].sort();
}
const parseTags = (txt) => [...new Set((txt || '').split(/[\s,]+/).map((x) => x.replace(/^#+/, '').trim()).filter(Boolean))];
function costs(list) {
  let plan = 0, act = 0;
  for (const t of list) for (const r of t.resources || []) { plan += +r.costPlan || 0; act += +r.costAct || 0; }
  return { plan, act };
}

// ---------------------------------------------------------------- who is responsible
const WHO_BASE = ['אני', 'Claude', 'סוכן AI'];
function initials(name) {
  if (name === 'אני') return 'אני';
  if (name === 'Claude') return 'CL';
  if (name === 'סוכן AI') return 'AI';
  const w = name.trim().split(/\s+/);
  return (w.length > 1 ? w[0][0] + w[1][0] : name.trim().slice(0, 2)).toUpperCase();
}
function whoColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ['#7C3AED', '#0EA5E9', '#D97706', '#DB2777', '#059669', '#4B5563'][h % 6];
}
function allWho() {
  const names = new Set(WHO_BASE);
  data.tasks.forEach((t) => t.assignee && names.add(t.assignee));
  return [...names];
}

/** Progress (weighted by length), first and last day, and whether it will miss its target date. */
function projectStats(p) {
  const ts = data.tasks.filter((t) => t.scheduled && !t.deleted && t.projectId === p.id);
  if (!ts.length) return { pct: 0, start: null, end: null, count: 0, late: false, tasks: ts };
  let w = 0, sum = 0;
  for (const t of ts) {
    if (t.milestone) continue;
    const d = effEnd(t) - dayNum(t.start) + 1;
    w += d; sum += d * (t.done ? 100 : (t.progress || 0));
  }
  const pct = w ? Math.round(sum / w) : (ts.every((t) => t.done) ? 100 : 0);
  const start = Math.min(...ts.map((t) => dayNum(t.start))), end = Math.max(...ts.map(effEnd));
  return { pct, start, end, count: ts.length, late: !!p.target && end > dayNum(p.target), tasks: ts };
}

function freezeProject(p, why) {
  p.frozen = { since: todayIso(), why: why || '' };
  (p.freezeLog = p.freezeLog || []).unshift({ type: 'freeze', date: todayIso(), why: why || '' });
  commit();
}

/**
 * Thaw: what hadn't started moves forward by the frozen days;
 * what had started keeps its start and only its end moves (the bar grows: the work was cut in the middle).
 */
function thawProject(p) {
  if (!p.frozen) return;
  const since = dayNum(p.frozen.since), days = Math.max(0, dayNum(todayIso()) - since);
  if (days > 0) {
    for (const t of data.tasks) {
      if (t.projectId !== p.id || !t.scheduled || t.deleted || t.done) continue;
      const s = dayNum(t.start), e = dayNum(t.end);
      if (s >= since) { t.start = isoOf(s + days); t.end = isoOf(e + days); }
      else t.end = isoOf(Math.max(e, since) + days);
      markGoogle(t);
    }
  }
  (p.freezeLog = p.freezeLog || []).unshift({ type: 'thaw', date: todayIso(), days });
  p.frozen = null;
  commit();
}

function newProject(name, color) {
  const p = { id: uid(), name: name.trim() || 'פרויקט', color: color || COLORS[data.projects.length % COLORS.length], stages: [{ id: uid(), name: 'כללי' }] };
  data.projects.push(p);
  ui.projectId = p.id;
  saveUi();
  return p;
}

// ---------------------------------------------------------------- render
function render() {
  renderHeader();
  renderPool();
  renderBoard();
}

function renderHeader() {
  const sel = $('#projectSelect');
  const cur = current();
  // With no projects yet, a placeholder is selected, so choosing "＋ פרויקט חדש" counts as a change.
  const all = ui.view === 'all' && data.projects.length;
  sel.innerHTML = (cur ? '' : '<option value="" selected disabled>אין פרויקטים</option>')
    + (data.projects.length > 1 || all ? `<option value="__all" ${all ? 'selected' : ''}>📊 כל הפרויקטים</option>` : '')
    + data.projects.map((p) => `<option value="${p.id}" ${!all && cur && p.id === cur.id ? 'selected' : ''}>${p.frozen ? '❄️ ' : ''}${esc(p.name)}</option>`).join('')
    + `<option value="__new">＋ פרויקט חדש</option>`;
  const af = $('#allFilter');
  af.hidden = !all;
  af.value = ui.allFilter || 'active';
  $('#projectMenuBtn').disabled = !cur || all;
  const wf = $('#whoFilter');
  wf.innerHTML = `<option value="all">כל האחראים</option><option value="none">ללא אחראי</option>`
    + allWho().map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  wf.value = ui.assignee || 'all';
  const tf = $('#tagFilter');
  const tags = allTags();
  tf.innerHTML = `<option value="all">כל התגיות</option>` + tags.map((g) => `<option value="${esc(g)}">#${esc(g)}</option>`).join('');
  if (ui.tag !== 'all' && !tags.includes(ui.tag)) ui.tag = 'all';
  tf.value = ui.tag || 'all';
  tf.hidden = !tags.length;
  $('#critBtn').classList.toggle('on', !!ui.critical);
  const mode = ui.dw >= 28 ? 'day' : ui.dw >= 9 ? 'week' : 'month';
  document.querySelectorAll('.zoom button').forEach((b) => b.classList.toggle('on', b.dataset.zoom === mode));
}

function poolTasks() {
  return data.tasks.filter((t) => !t.scheduled && !t.deleted).filter((t) => {
    if (ui.poolFilter === 'all') return true;
    if (ui.poolFilter === 'none') return !t.projectId;
    return t.projectId === ui.poolFilter;
  }).sort((a, b) => (a.done - b.done) || ((a.due || '9999') < (b.due || '9999') ? -1 : 1));
}

function renderPool() {
  const f = $('#poolFilter');
  f.innerHTML = `<option value="all">כל המשימות</option><option value="none">ללא פרויקט</option>`
    + data.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  if (![...f.options].some((o) => o.value === ui.poolFilter)) ui.poolFilter = 'all';
  f.value = ui.poolFilter;
  const list = poolTasks();
  const open = data.tasks.filter((t) => !t.scheduled && !t.deleted && !t.done).length;
  $('#poolCount').textContent = open ? `(${open})` : '';
  $('#poolFabCount').textContent = open ? `(${open})` : '';
  $('#poolList').innerHTML = list.length ? list.map((t) => {
    const p = project(t.projectId);
    const meta = [p ? p.name : 'ללא פרויקט', t.due ? `יעד ${short(t.due)}` : null, t.gid ? 'מ-Tasky' : null].filter(Boolean).join(' · ');
    return `<div class="pool-item ${t.done ? 'done' : ''}" data-id="${t.id}" style="border-inline-start-color:${p ? p.color : 'var(--line)'}">
      <div class="t">${esc(t.title || '(ללא כותרת)')}</div><div class="m">${esc(meta)}</div></div>`;
  }).join('') : `<div class="pool-empty">אין כאן משימות. הוסף משימה, או שייך משימה ל"משימות לגנט" ב-Tasky.</div>`;
}

/** The board's date range: a little before the first task (or today) to well after the last. */
function range(tasks, extraDays = []) {
  const t0 = dayNum(todayIso());
  let a = t0 - 14, b = t0 + 75;
  for (const t of tasks) {
    if (t.start) a = Math.min(a, dayNum(t.start) - 10);
    if (t.end) b = Math.max(b, effEnd(t) + 30);
  }
  for (const d of extraDays) { a = Math.min(a, d - 10); b = Math.max(b, d + 20); }
  a -= weekday(a); // start on a Sunday
  return { a, b, days: b - a + 1 };
}

let R = { a: 0, b: 0, days: 0 }; // current range
const labelWidth = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--label-w')) || 220;

function renderBoard() {
  const g = $('#gantt');
  const cur = current();
  const keepLeft = g.scrollLeft, keepTop = g.scrollTop;
  const hint = $('#emptyHint'), note = $('#boardNote');
  note.hidden = true;
  g.classList.remove('is-frozen');
  if (!cur) {
    g.innerHTML = '';
    hint.hidden = false;
    hint.innerHTML = 'אין עדיין פרויקטים.<br><button type="button" class="primary" id="firstProject">＋ צור פרויקט ראשון</button>';
    $('#firstProject').onclick = () => openProjectDialog(null);
    return;
  }
  const all = ui.view === 'all';
  const filter = ui.allFilter || 'active';
  const projects = all ? data.projects.filter((p) => filter === 'all' || (filter === 'frozen' ? !!p.frozen : !p.frozen)) : [cur];
  const tasks = data.tasks.filter((t) => t.scheduled && !t.deleted && projects.some((p) => p.id === t.projectId));
  R = range(tasks, projects.map((p) => p.target).filter(Boolean).map(dayNum));
  const dw = ui.dw, W = R.days * dw, LW = labelWidth();
  const today = dayNum(todayIso());

  // Scale: two rows that change with the zoom.
  const top = [], bot = [];
  const mode = dw >= 28 ? 'day' : dw >= 9 ? 'week' : 'month';
  const cell = (cls, n, text, len) => `<div class="cell ${cls}" style="left:${(n - R.a) * dw}px;${len ? `width:${len * dw}px` : ''}">${esc(text)}</div>`;
  if (mode === 'month') {
    for (let n = R.a; n <= R.b; n++) {
      const d = new Date(n * 864e5);
      if (n === R.a || d.getUTCDate() === 1) {
        if (n === R.a || d.getUTCMonth() === 0) top.push(cell('top-row', n, `${d.getUTCFullYear()}`));
        bot.push(cell('bot-row', n, MONTHS[d.getUTCMonth()], new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
      }
    }
  } else {
    for (let n = R.a; n <= R.b; n++) {
      const d = new Date(n * 864e5);
      if (n === R.a || d.getUTCDate() === 1) top.push(cell('top-row', n, `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`));
      if (mode === 'day') bot.push(cell('bot-row' + (weekday(n) === 6 || weekday(n) === 5 ? ' weekend' : ''), n, `${DAY_LETTERS[weekday(n)]} ${d.getUTCDate()}`, 1));
      else if (weekday(n) === 0) bot.push(cell('bot-row', n, short(isoOf(n)), 7));
    }
  }

  // Grid lines: one per day (or week / month when zoomed out).
  const step = mode === 'day' ? dw : mode === 'week' ? dw * 7 : dw * 30.44;
  const grid = `background-image: repeating-linear-gradient(to right, var(--line-soft) 0 1px, transparent 1px ${step}px);`;

  const crit = new Set();
  if (ui.critical) for (const p of projects) criticalSet(tasks.filter((t) => t.projectId === p.id)).forEach((id) => crit.add(id));
  const dimmed = (t) => (ui.critical && !crit.has(t.id))
    || (ui.assignee && ui.assignee !== 'all' && (t.assignee || '') !== (ui.assignee === 'none' ? '' : ui.assignee))
    || (ui.tag && ui.tag !== 'all' && !(t.tags || []).includes(ui.tag));

  /** One task row: a bar (or a ◆ milestone) and the ⚬ dot for making dependencies. */
  const taskRow = (t, p, stageId) => {
    const s0 = dayNum(t.start), left = (s0 - R.a) * dw;
    const cls = [t.done ? 'done' : '', crit.has(t.id) ? 'crit' : '', dimmed(t) ? 'dim' : '', t.manualFinish ? 'manual' : ''].join(' ');
    const marks = `${t.priority === 'high' ? '<span class="prio" title="עדיפות גבוהה"></span>' : ''}${(t.files || []).length ? `<span class="clip" title="${t.files.length} קבצים">📎${t.files.length}</span>` : ''}`;
    const flag = !t.done && t.status === 'blocked' ? '⛔ ' : !t.done && t.status === 'waiting' ? '⏸ ' : '';
    const who = t.assignee ? `<span class="who" style="background:${whoColor(t.assignee)}" title="אחראי: ${esc(t.assignee)}">${esc(initials(t.assignee))}</span>` : '';
    const name = `${t.milestone ? '◆ ' : ''}${esc(t.title || '(ללא כותרת)')}`;
    let shape, right;
    if (t.milestone) {
      shape = `<div class="ms ${cls}" data-bar="${t.id}" style="left:${left + dw / 2 - 9}px;--c:${p.color}" title="◆ ${esc(t.title)} · ${short(t.start)}${t.assignee ? ` · ${esc(t.assignee)}` : ''}">
        <i></i>${who}<span class="ms-txt">${flag}${esc(t.title)}</span>${marks}</div>`;
      right = left + dw / 2 + 10;
    } else {
      const ee = effEnd(t), width = (ee - s0 + 1) * dw, planned = (dayNum(t.end) - s0 + 1) * dw;
      const pct = t.done ? 100 : (t.progress || 0);
      const late = ee > dayNum(t.end) ? `<div class="late" style="left:${planned}px"></div>` : '';
      const tip = `${esc(t.title)} · ${short(t.start)}–${short(isoOf(ee))} · ${pct}%${t.assignee ? ` · ${esc(t.assignee)}` : ''}${t.manualFinish ? (t.done ? ' · סיום ידני' : ' · סיום ידני: מחכה לסימון "בוצע"') : ''}`;
      shape = `<div class="bar ${cls}" data-bar="${t.id}" style="left:${left}px;width:${width}px;--c:${p.color}" title="${tip}">
          <div class="fill" style="width:${pct}%"></div>${late}${who}
          <div class="txt">${flag}${t.manualFinish && !t.done ? '✋ ' : ''}${esc(t.title)}${width > 90 ? ` · ${pct}%` : ''}</div>${marks}
          <div class="h l" data-edge="l"></div><div class="h r" data-edge="r"></div>
        </div>`;
      right = left + width;
    }
    return `<div class="g-row ${p.frozen ? 'frozen' : ''}" data-project="${p.id}" data-stage="${stageId}" data-task="${t.id}">
      <div class="g-label"><span class="name" data-open="${t.id}">${name}</span></div>
      <div class="g-track" style="width:${W}px;${grid}">${shape}
        <div class="link-dot" data-link="${t.id}" style="left:${right + 3}px" title="גרור לפס אחר כדי ליצור תלות"></div></div></div>`;
  };

  const rows = [];
  if (!all) {
    // One project: a row per stage, then its tasks (sorted by start).
    for (const st of cur.stages) {
      const items = tasks.filter((t) => (t.stageId || cur.stages[0].id) === st.id).sort((x, y) => (x.start < y.start ? -1 : 1));
      const collapsed = !!ui.collapsed[st.id];
      let span = '';
      if (items.length) {
        const s = Math.min(...items.map((t) => dayNum(t.start))), e = Math.max(...items.map(effEnd));
        span = `<div class="stage-span" style="left:${(s - R.a) * dw}px;width:${(e - s + 1) * dw}px;background:${cur.color}"></div>`;
      }
      rows.push(`<div class="g-row stage" data-project="${cur.id}" data-stage="${st.id}">
        <div class="g-label" data-stage-toggle="${st.id}">${collapsed ? '◂' : '▾'} ${esc(st.name)} <span class="count">(${items.length})</span></div>
        <div class="g-track" style="width:${W}px;${grid}">${span}</div></div>`);
      if (collapsed) continue;
      for (const t of items) rows.push(taskRow(t, cur, st.id));
    }
    for (let i = 0; i < 3; i++) {
      rows.push(`<div class="g-row" data-project="${cur.id}" data-stage="${cur.stages[cur.stages.length - 1].id}"><div class="g-label"></div><div class="g-track" style="width:${W}px;${grid}"></div></div>`);
    }
  } else {
    // All projects: a summary bar per project; tap to open its tasks right here.
    ui.expanded = ui.expanded || {};
    for (const p of projects) {
      const st = projectStats(p), open = !!ui.expanded[p.id];
      let track = '';
      if (st.count) {
        const left = (st.start - R.a) * dw, width = (st.end - st.start + 1) * dw;
        track += `<div class="sum-bar" style="left:${left}px;width:${width}px;--c:${p.color}" title="${esc(p.name)} · ${short(isoOf(st.start))}–${short(isoOf(st.end))} · ${st.pct}%">
          <div class="fill" style="width:${st.pct}%"></div><div class="txt">${esc(p.name)} · ${st.pct}%</div></div>`;
        for (const m of st.tasks.filter((t) => t.milestone)) {
          track += `<div class="sum-ms" style="left:${(dayNum(m.start) - R.a) * dw + dw / 2 - 6}px;--c:${p.color}" title="◆ ${esc(m.title)} · ${short(m.start)}"></div>`;
        }
      }
      if (p.target) track += `<div class="target-tick" style="left:${(dayNum(p.target) - R.a + 1) * dw}px" title="יעד: ${short(p.target)}"></div>`;
      rows.push(`<div class="g-row projrow ${p.frozen ? 'frozen' : ''}" data-project="${p.id}" data-stage="${p.stages[0].id}">
        <div class="g-label"><span class="pdot" style="background:${p.color}"></span>
          <span class="name" data-toggle-proj="${p.id}">${open ? '▾' : '◂'} ${esc(p.name)}</span>
          <span class="count">${st.pct}%</span>${st.late ? '<span title="צפוי להסתיים אחרי היעד">⚠️</span>' : ''}${p.frozen ? '<span title="מוקפא">❄️</span>' : ''}
          <button type="button" class="mini-open" data-open-proj="${p.id}">פתח</button></div>
        <div class="g-track" style="width:${W}px;${grid}">${track}</div></div>`);
      if (!open) continue;
      const order = new Map(p.stages.map((x, i) => [x.id, i]));
      st.tasks.slice().sort((x, y) => ((order.get(x.stageId) ?? 0) - (order.get(y.stageId) ?? 0)) || (x.start < y.start ? -1 : 1))
        .forEach((t) => rows.push(taskRow(t, p, t.stageId || p.stages[0].id)));
    }
  }

  // Corner: the project's numbers (or how many projects are shown).
  let corner;
  if (all) {
    corner = `<div>כל הפרויקטים</div><div class="cost-sum">${projects.length} פרויקטים</div>`;
  } else {
    const st = projectStats(cur), c = costs(data.tasks.filter((t) => t.projectId === cur.id && !t.deleted));
    corner = `<div>${cur.frozen ? '❄️ ' : ''}${esc(cur.name)}</div>`
      + (st.count || cur.target ? `<div class="cost-sum ${st.late ? 'over' : ''}">${st.count ? `${st.pct}% · סיום ${short(isoOf(st.end))}` : ''}${cur.target ? ` · יעד ${short(cur.target)}${st.late ? ' ⚠️' : ''}` : ''}</div>` : '')
      + (c.plan || c.act ? `<div class="cost-sum ${c.act > c.plan ? 'over' : ''}" title="עלות מתוכננת מול בפועל">${money(c.act)} מתוך ${money(c.plan)}</div>` : '');
  }

  const target = !all && cur.target ? `<div class="g-target" style="left:${LW + (dayNum(cur.target) - R.a + 1) * dw}px" title="יעד הפרויקט: ${short(cur.target)}"></div>` : '';
  g.innerHTML = `<div class="g-inner" style="width:${LW + W}px">
    <div class="g-head"><div class="g-corner"><div>${corner}</div></div><div class="g-scale" style="width:${W}px">${top.join('')}${bot.join('')}</div></div>
    <div class="g-body">${rows.join('')}</div>
    <div class="g-today" style="left:${LW + (today - R.a) * dw + dw / 2}px"></div>${target}
  </div>`;

  const inner = g.querySelector('.g-inner'), head = g.querySelector('.g-head');
  inner.style.setProperty('--head-h', `${head.offsetHeight}px`); // the "היום" / "יעד" tags sit just under the header
  drawArrows(tasks);
  if (!all && cur.frozen) {
    g.classList.add('is-frozen');
    note.hidden = false;
    note.textContent = `❄️ מוקפא מ-${short(cur.frozen.since)}${cur.frozen.why ? ` · ${cur.frozen.why}` : ''} · ⋮ ← "הפשר" כדי להמשיך`;
  }
  if (all) {
    hint.hidden = projects.length > 0;
    hint.innerHTML = filter === 'frozen' ? 'אין פרויקטים מוקפאים.' : 'אין פרויקטים פעילים.';
  } else {
    hint.hidden = tasks.length > 0;
    hint.innerHTML = 'הלוח ריק.<br>גרור לכאן משימה מהמאגר, או לחץ על משימה במאגר ובחר "שבץ בלוח".';
  }

  if (renderBoard.first !== false) {
    renderBoard.first = false;
    scrollToToday();
  } else {
    g.scrollLeft = keepLeft;
    g.scrollTop = keepTop;
  }
}

/** Draws the dependency arrows (and their FS / SS / FF tags) over the board. */
function drawArrows(tasks) {
  const inner = document.querySelector('.g-inner');
  if (!inner) return;
  const box = inner.getBoundingClientRect();
  const pos = {};
  inner.querySelectorAll('[data-bar]').forEach((el) => {
    const shape = el.classList.contains('ms') ? el.querySelector('i') : el;
    const r = shape.getBoundingClientRect();
    pos[el.dataset.bar] = { l: r.left - box.left, r: r.right - box.left, y: r.top - box.top + r.height / 2 };
  });
  const rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 38;
  let paths = '', tags = '';
  for (const t of tasks) for (const d of t.deps || []) {
    const a = pos[d.from], b = pos[t.id];
    if (!a || !b) continue;
    const type = d.type || 'FS';
    const x1 = type === 'SS' ? a.l : a.r, x2 = type === 'FF' ? b.r : b.l, y1 = a.y, y2 = b.y;
    let path, tx, ty = (y1 + y2) / 2;
    if (type === 'FS') {
      if (x2 - x1 >= 18) { path = `M${x1} ${y1} H${x1 + 9} V${y2} H${x2 - 1}`; tx = x1 + 9; }
      else {
        const ym = y1 + (y2 > y1 ? 1 : -1) * rowH / 2;
        path = `M${x1} ${y1} H${x1 + 9} V${ym} H${x2 - 11} V${y2} H${x2 - 1}`; tx = (x1 + x2) / 2; ty = ym;
      }
    } else if (type === 'SS') {
      const xm = Math.min(x1, x2) - 11; path = `M${x1} ${y1} H${xm} V${y2} H${x2 - 1}`; tx = xm;
    } else {
      const xm = Math.max(x1, x2) + 11; path = `M${x1} ${y1} H${xm} V${y2} H${x2 + 1}`; tx = xm;
    }
    const key = `${t.id}|${d.from}`;
    paths += `<path class="dep" d="${path}" marker-end="url(#ah)"/><path class="hit" data-dep="${key}" d="${path}"><title>${esc(depTip(d))}</title></path>`;
    tags += `<div class="dep-tag" data-dep="${key}" style="left:${tx}px;top:${ty}px" title="${esc(depTip(d))} · לחץ לעריכה">${depLabel(d)}</div>`;
  }
  inner.insertAdjacentHTML('beforeend', `<svg class="g-arrows" width="${inner.scrollWidth}" height="${inner.scrollHeight}">
    <defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" class="ah"/></marker></defs>${paths}</svg>${tags}`);
}

function scrollToToday() {
  const g = $('#gantt');
  const x = (dayNum(todayIso()) - R.a) * ui.dw;
  g.scrollLeft = Math.max(0, x - (g.clientWidth - labelWidth()) * 0.3);
}

/** Zoom keeping the day under [clientX] in place. */
function setZoom(dw, clientX) {
  const g = $('#gantt');
  const rect = g.getBoundingClientRect();
  const px = (clientX ?? rect.left + labelWidth() + (rect.width - labelWidth()) / 2) - rect.left - labelWidth();
  const day = (g.scrollLeft + px) / ui.dw;
  ui.dw = Math.max(2, Math.min(64, dw));
  saveUi();
  renderHeader();
  renderBoard();
  g.scrollLeft = Math.max(0, day * ui.dw - px);
}

// ---------------------------------------------------------------- dragging bars
// Mouse: drag at once. Touch: hold ~½ second, then drag (so scrolling stays easy).
let drag = null;

function dayAtClientX(clientX) {
  const track = document.querySelector('.g-track');
  if (!track) return null;
  return R.a + Math.floor((clientX - track.getBoundingClientRect().left) / ui.dw);
}

function stageAtPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  const row = el && el.closest('.g-row');
  return row ? row.dataset.stage : null;
}

$('#gantt').addEventListener('pointerdown', (e) => {
  const dot = e.target.closest('.link-dot');
  if (dot) {
    e.preventDefault();
    drag = { kind: 'link', from: dot.dataset.link, x0: e.clientX, y0: e.clientY, active: true, moved: false };
    return;
  }
  const barEl = e.target.closest('.bar, .ms');
  if (!barEl) return;
  const t = task(barEl.dataset.bar);
  if (!t) return;
  const rect = barEl.getBoundingClientRect();
  const edgeZone = e.pointerType === 'touch' ? 18 : 8;
  let mode = 'move';
  if (barEl.classList.contains('ms')) mode = 'move';
  else if (e.clientX - rect.left < edgeZone) mode = 'l';
  else if (rect.right - e.clientX < edgeZone) mode = 'r';
  drag = { kind: 'bar', id: t.id, el: barEl, mode, x0: e.clientX, y0: e.clientY, start: t.start, end: t.end, active: e.pointerType !== 'touch', moved: false, pointerId: e.pointerId };
  if (e.pointerType === 'touch') {
    drag.timer = setTimeout(() => {
      if (!drag) return;
      drag.active = true;
      barEl.classList.add('armed');
      navigator.vibrate && navigator.vibrate(20);
    }, 450);
  } else {
    barEl.setPointerCapture(e.pointerId);
  }
});

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  if (!drag.active) {
    const far = Math.hypot(dx, dy);
    if (drag.begin) { if (far > 6) drag.begin(); else return; } // mouse drag from the pool
    else { if (far > 8) { clearTimeout(drag.timer); drag = null; } return; } // a touch that scrolls
  }
  if (drag.kind === 'pool') return movePoolGhost(e);
  if (drag.kind === 'link') return moveLink(e);
  const d = Math.round(dx / ui.dw);
  if (Math.abs(dx) > 3) drag.moved = true;
  let s = dayNum(drag.start), en = dayNum(drag.end);
  if (drag.mode === 'move') { s += d; en += d; }
  if (drag.mode === 'l') s = Math.min(s + d, en);
  if (drag.mode === 'r') en = Math.max(en + d, s);
  drag.newStart = isoOf(s); drag.newEnd = isoOf(en);
  drag.el.classList.add('dragging');
  if (drag.el.classList.contains('ms')) {
    drag.newEnd = drag.newStart;
    drag.el.style.left = `${(s - R.a) * ui.dw + ui.dw / 2 - 9}px`;
    drag.el.querySelector('.ms-txt').textContent = short(drag.newStart);
    return;
  }
  drag.el.style.left = `${(s - R.a) * ui.dw}px`;
  drag.el.style.width = `${(en - s + 1) * ui.dw}px`;
  drag.el.title = `${short(drag.newStart)}–${short(drag.newEnd)}`;
  drag.el.querySelector('.txt').textContent = `${short(drag.newStart)} – ${short(drag.newEnd)}`;
});

// While a touch drag is on, stop the page from scrolling.
document.addEventListener('touchmove', (e) => { if (drag && drag.active) e.preventDefault(); }, { passive: false });

window.addEventListener('pointerup', (e) => {
  if (!drag) return;
  clearTimeout(drag.timer);
  const d = drag;
  drag = null;
  if (d.kind === 'pool') return dropPool(d, e);
  if (d.kind === 'link') return dropLink(d, e);
  d.el.classList.remove('armed', 'dragging');
  const t = task(d.id);
  if (!t) return;
  if (!d.moved) return openTaskEditor(t);
  t.start = d.newStart; t.end = d.newEnd;
  if (d.mode === 'move') {
    const st = stageAtPoint(e.clientX, e.clientY), tp = project(t.projectId);
    if (st && tp && tp.stages.some((s) => s.id === st)) t.stageId = st;
  }
  markGoogle(t);
  commit();
});
window.addEventListener('pointercancel', () => { if (drag) { clearTimeout(drag.timer); if (drag.ghost) drag.ghost.remove(); drag = null; render(); } });

/** Dragging from a bar's ⚬ dot: a line follows the pointer. */
function moveLink(e) {
  const inner = document.querySelector('.g-inner');
  const src = document.querySelector(`[data-bar="${drag.from}"]`);
  if (!inner || !src) return;
  const box = inner.getBoundingClientRect(), r = (src.classList.contains('ms') ? src.querySelector('i') : src).getBoundingClientRect();
  let svg = document.getElementById('linkTmp');
  if (!svg) {
    inner.insertAdjacentHTML('beforeend', `<svg id="linkTmp" class="g-arrows" width="${inner.scrollWidth}" height="${inner.scrollHeight}"><path class="dep tmp"/></svg>`);
    svg = document.getElementById('linkTmp');
  }
  drag.moved = true;
  svg.querySelector('path').setAttribute('d', `M${r.right - box.left} ${r.top - box.top + r.height / 2} L${e.clientX - box.left} ${e.clientY - box.top}`);
  document.querySelectorAll('.link-target').forEach((x) => x.classList.remove('link-target'));
  const over = document.elementFromPoint(e.clientX, e.clientY);
  const tgt = over && over.closest('[data-bar]');
  if (tgt && tgt.dataset.bar !== drag.from) tgt.classList.add('link-target');
}

function dropLink(d, e) {
  const tmp = document.getElementById('linkTmp');
  if (tmp) tmp.remove();
  const over = document.elementFromPoint(e.clientX, e.clientY);
  const tgt = over && over.closest('[data-bar]');
  document.querySelectorAll('.link-target').forEach((x) => x.classList.remove('link-target'));
  if (!tgt || tgt.dataset.bar === d.from) return;
  addDep(task(tgt.dataset.bar), d.from, 'FS', 0);
}

/** [succ] will wait for [fromId]. Refuses loops (A waits for B that waits for A). */
function addDep(succ, fromId, type, lag) {
  if (!succ || succ.id === fromId) return false;
  if (dependsOn(task(fromId), succ.id)) { alert('אי אפשר: זה יוצר מעגל, כי המשימה השנייה כבר תלויה בזו.'); return false; }
  succ.deps = (succ.deps || []).filter((x) => x.from !== fromId);
  succ.deps.push({ from: fromId, type: type || 'FS', lag: lag || 0 });
  commit();
  return true;
}

/** An arrow (or its tag) was clicked: type, waiting days, delete. */
function openDepDialog(succId, fromId) {
  const t = task(succId), p = task(fromId);
  const d = t && (t.deps || []).find((x) => x.from === fromId);
  if (!d) return;
  showDialog(`
    <h3>תלות</h3>
    <p class="dep-names"><b>${esc(p.title)}</b> ← <b>${esc(t.title)}</b></p>
    <label>סוג התלות <a class="info" href="help.html" target="_blank" rel="noopener">ℹ️ הסבר ודוגמאות</a>
      <select name="type">${Object.entries(DEP_TYPES).map(([k, v]) => `<option value="${k}" ${k === (d.type || 'FS') ? 'selected' : ''}>${k} · ${v.he}</option>`).join('')}</select></label>
    <p class="note" id="depExplain"></p>
    <label>ימי המתנה (מרווח)<input type="number" name="lag" value="${d.lag || 0}" step="1"></label>
    <div class="actions">
      <button value="save" class="primary">שמור</button>
      <span class="grow"></span>
      <button value="delete" class="danger" formnovalidate>מחק תלות</button>
      <button value="cancel" class="ghost" formnovalidate>ביטול</button>
    </div>`, (action, fd) => {
    if (action === 'delete') { t.deps = t.deps.filter((x) => x !== d); return commit(); }
    d.type = fd.get('type');
    d.lag = Math.trunc(Number(fd.get('lag')) || 0);
    commit();
  }, (f) => {
    const say = () => { f.querySelector('#depExplain').textContent = DEP_TYPES[f.type.value].text + '.'; };
    f.type.onchange = say;
    say();
  });
}

// Clicks: task names open the editor, stage rows fold, arrows open their settings.
$('#gantt').addEventListener('click', (e) => {
  const dep = e.target.closest('[data-dep]');
  if (dep) { const [succ, from] = dep.getAttribute('data-dep').split('|'); return openDepDialog(succ, from); }
  const open = e.target.closest('[data-open]');
  if (open) return openTaskEditor(task(open.dataset.open));
  const tp = e.target.closest('[data-toggle-proj]');
  if (tp) { ui.expanded = ui.expanded || {}; ui.expanded[tp.dataset.toggleProj] = !ui.expanded[tp.dataset.toggleProj]; saveUi(); return renderBoard(); }
  const op = e.target.closest('[data-open-proj]');
  if (op) { ui.view = 'project'; ui.projectId = op.dataset.openProj; saveUi(); renderBoard.first = true; return render(); }
  const tog = e.target.closest('[data-stage-toggle]');
  if (tog) { const id = tog.dataset.stageToggle; ui.collapsed[id] = !ui.collapsed[id]; saveUi(); renderBoard(); }
});

// Zoom: Ctrl + mouse wheel, or pinch with two fingers.
$('#gantt').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(ui.dw * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX);
}, { passive: false });

let pinch = null;
$('#gantt').addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    const [a, b] = e.touches;
    pinch = { dist: Math.abs(a.clientX - b.clientX) || 1, dw: ui.dw, cx: (a.clientX + b.clientX) / 2 };
    if (drag) { clearTimeout(drag.timer); drag = null; }
  }
}, { passive: true });
$('#gantt').addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const [a, b] = e.touches;
  const dist = Math.abs(a.clientX - b.clientX) || 1;
  const target = pinch.dw * dist / pinch.dist;
  if (Math.abs(target - ui.dw) / ui.dw > 0.06) setZoom(target, pinch.cx);
}, { passive: false });
$('#gantt').addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });

// ---------------------------------------------------------------- dragging from the pool
$('#poolList').addEventListener('pointerdown', (e) => {
  const item = e.target.closest('.pool-item');
  if (!item) return;
  const t = task(item.dataset.id);
  drag = { kind: 'pool', id: t.id, x0: e.clientX, y0: e.clientY, active: false, moved: false };
  const begin = () => {
    if (!drag) return;
    drag.active = true;
    drag.ghost = document.createElement('div');
    drag.ghost.className = 'ghost-drag';
    drag.ghost.innerHTML = `<div>${esc(t.title)}</div><div class="d"></div>`;
    document.body.appendChild(drag.ghost);
    $('#pool').classList.add('dragging-out'); // phone: get the sheet out of the way
    navigator.vibrate && navigator.vibrate(20);
  };
  if (e.pointerType === 'touch') drag.timer = setTimeout(begin, 450);
  else drag.begin = begin;
});

function movePoolGhost(e) {
  drag.moved = true;
  drag.ghost.style.left = `${e.clientX + 12}px`;
  drag.ghost.style.top = `${e.clientY + 12}px`;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const overBoard = under && under.closest('.g-track');
  $('#gantt').classList.toggle('drop-ok', !!overBoard);
  const day = overBoard ? dayAtClientX(e.clientX) : null;
  drag.ghost.querySelector('.d').textContent = day != null ? `התחלה: ${short(isoOf(day))}` : '';
}


function dropPool(d, e) {
  $('#gantt').classList.remove('drop-ok');
  $('#pool').classList.remove('dragging-out');
  if (d.ghost) d.ghost.remove();
  const t = task(d.id);
  if (!t) return;
  if (!d.active || !d.moved) return openPoolTask(t);
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || !el.closest('.g-track')) return;
  const row = el.closest('.g-row');
  const cur = (row && project(row.dataset.project)) || current() || newProject('פרויקט חדש');
  const day = dayAtClientX(e.clientX);
  const st = stageAtPoint(e.clientX, e.clientY);
  schedule(t, cur, cur.stages.some((s) => s.id === st) ? st : cur.stages[0].id, isoOf(day));
  $('#pool').classList.remove('open');
}

/** Puts a pool task on the board. Default length: 3 days, or up to its due date from Tasky. */
function schedule(t, p, stageId, start, end) {
  t.projectId = p.id;
  t.stageId = stageId;
  t.start = start;
  let e = end || (t.due && t.due >= start ? t.due : addDays(start, 2));
  t.end = e;
  t.scheduled = true;
  t.progress = t.progress || 0;
  markGoogle(t);
  commit();
}

// ---------------------------------------------------------------- dialogs
const dlg = $('#dlg'), form = $('#dlgForm');
function showDialog(html, onSubmit, init) {
  form.innerHTML = html;
  form.onsubmit = (e) => {
    const action = e.submitter && e.submitter.value;
    if (action === 'cancel') return;
    const r = onSubmit(action, new FormData(form));
    if (r === false) e.preventDefault();
  };
  init && init(form);
  dlg.showModal();
}

function stageOptions(p, sel) {
  return p.stages.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
}

/** A bar was tapped: edit everything about it, in tabs. */
function openTaskEditor(t) {
  if (!t) return;
  const p = project(t.projectId) || current();
  const draft = {
    deps: JSON.parse(JSON.stringify(t.deps || [])),
    steps: JSON.parse(JSON.stringify(t.steps || [])),
    files: JSON.parse(JSON.stringify(t.files || [])),
    resources: JSON.parse(JSON.stringify(t.resources || [])),
    log: JSON.parse(JSON.stringify(t.log || [])),
  };
  const others = data.tasks.filter((x) => x.scheduled && !x.deleted && x.projectId === p.id && x.id !== t.id);
  const who = allWho();
  const typeOpts = (sel) => Object.entries(DEP_TYPES).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${k} · ${v.he}</option>`).join('');
  const opts = (obj, sel) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
  const tabs = [['main', 'פרטים'], ['steps', 'צעדים'], ['files', 'קבצים'], ['res', 'משאבים'], ['log', 'יומן']];
  showDialog(`
    <h3>${t.milestone ? 'אבן דרך' : 'משימה'}: ${esc(t.title)}</h3>
    <div class="tabs" role="tablist">${tabs.map(([k, v], i) => `<button type="button" class="tab ${i ? '' : 'on'}" data-tab="${k}">${v}<span class="tab-n" id="n-${k}"></span></button>`).join('')}</div>

    <section class="pane" data-pane="main">
      <label>כותרת<input type="text" name="title" value="${esc(t.title)}" required></label>
      <label>תיאור<textarea name="desc" rows="3" placeholder="מה צריך לעשות, פרטים חשובים…">${esc(t.desc || '')}</textarea></label>
      <div class="row2">
        <label>סטטוס<select name="status">${opts(STATUS, t.status || 'todo')}</select></label>
        <label>עדיפות<select name="priority">${opts(PRIORITY, t.priority || 'normal')}</select></label>
      </div>
      <label id="whyBox">למה?<input type="text" name="why" value="${esc(t.statusWhy || '')}" placeholder="למשל: מחכה לאישור מהלקוח"></label>
      <div class="row2">
        <label>שלב<select name="stage">${stageOptions(p, t.stageId)}</select></label>
        <label>אחראי<select name="who"><option value="">ללא</option>${who.map((n) => `<option ${n === t.assignee ? 'selected' : ''}>${esc(n)}</option>`).join('')}<option value="__other">אחר…</option></select></label>
      </div>
      <label id="otherWho" hidden>שם האחראי<input type="text" name="whoName" placeholder="למשל: דני כהן"></label>
      <label>תגיות<input type="text" name="tags" value="${esc((t.tags || []).map((g) => '#' + g).join(' '))}" placeholder="#עיצוב #ספק" list="tagList">
        <datalist id="tagList">${allTags().map((g) => `<option value="#${esc(g)}">`).join('')}</datalist></label>
      <label class="check"><input type="checkbox" name="milestone" ${t.milestone ? 'checked' : ''}> אבן דרך ◆ (יום אחד)</label>
      <div id="calBox" class="cal-box">
        <label class="check"><input type="checkbox" name="cal" ${t.calId ? 'checked' : ''}> 📅 שמור ביומן</label>
        <select name="calId" id="calSel"><option value="${esc(t.calId || data.lastCalId || 'primary')}">${esc(t.calName || data.lastCalName || 'היומן הראשי')}</option></select>
      </div>
      <p class="note" id="calNote" hidden></p>
      <div class="row2">
        <label>התחלה<input type="date" name="start" value="${t.start}" required></label>
        <label id="endBox">סיום<input type="date" name="end" value="${t.end}"></label>
      </div>
      <div id="workBox">
        <div class="row2">
          <label>שעות (הערכה)<input type="number" name="hEst" min="0" step="0.5" value="${t.hoursEst ?? ''}"></label>
          <label>שעות (בפועל)<input type="number" name="hAct" min="0" step="0.5" value="${t.hoursAct ?? ''}" id="hAct"></label>
        </div>
        <label>התקדמות: <output id="pv">${t.progress || 0}%</output><span class="note" id="pvNote"></span>
          <input type="range" name="progress" min="0" max="100" step="5" value="${t.progress || 0}"></label>
        <label class="check"><input type="checkbox" name="manual" ${t.manualFinish ? 'checked' : ''}> ✋ סיום ידני: המשך הוא הערכה, ומה שאחריה מחכה לסימון "בוצע"</label>
      </div>
      <label class="check"><input type="checkbox" name="done" ${t.done ? 'checked' : ''}> בוצע</label>
      <fieldset class="deps">
        <legend>מתחילה אחרי <a class="info" href="help.html" target="_blank" rel="noopener" title="FS · SS · FF: הסבר ודוגמאות">ℹ️</a></legend>
        <div id="depList"></div>
        ${others.length ? `<div class="dep-add">
          <select name="depFrom"><option value="">בחר משימה…</option>${others.map((o) => `<option value="${o.id}">${o.milestone ? '◆ ' : ''}${esc(o.title)}</option>`).join('')}</select>
          <select name="depType" title="סוג התלות">${typeOpts('FS')}</select>
          <input type="number" name="depLag" value="0" step="1" title="ימי המתנה">
          <button type="button" class="small" id="depAdd">＋</button>
        </div><p class="note">המספר הוא ימי המתנה (מרווח) אחרי המשימה הקודמת.</p>` : '<p class="note">אין עוד משימות בפרויקט שאפשר לחכות להן.</p>'}
      </fieldset>
      ${t.gid ? '<p class="note">מקושרת ל-Tasky: הכותרת, תאריך הסיום ו"בוצע" מתעדכנים גם שם.</p>' : ''}
    </section>

    <section class="pane" data-pane="steps" hidden>
      <p class="note">צעדים קטנים בתוך המשימה. אם יש צעדים, ההתקדמות % מחושבת מהם לבד.</p>
      <div id="stepList" class="list"></div>
      <div class="add-row"><input type="text" id="stepNew" placeholder="צעד חדש…"><button type="button" class="small" id="stepAdd">＋</button></div>
    </section>

    <section class="pane" data-pane="files" hidden>
      <div class="file-btns">
        <label class="btn-file">⬆ העלה קבצים<input type="file" id="fileIn" multiple hidden></label>
        <label class="btn-file">📷 צלם<input type="file" id="camIn" accept="image/*" capture="environment" hidden></label>
      </div>
      <p class="note" id="fileNote">${token ? 'הקבצים נשמרים בתיקייה Ganty/' + esc(p.name) + ' ב-Drive שלך.' : 'כדי להעלות קבצים צריך להתחבר ל-Google. קישורים אפשר להוסיף גם בלי.'}</p>
      <div id="fileList" class="files"></div>
      <div class="add-row"><input type="url" id="linkUrl" placeholder="הדבק קישור (Drive, אתר, שיחה עם Claude…)"><input type="text" id="linkName" placeholder="שם"><button type="button" class="small" id="linkAdd">＋</button></div>
    </section>

    <section class="pane" data-pane="res" hidden>
      <div id="resList" class="res-list"></div>
      <button type="button" class="ghost small" id="resAdd">＋ משאב</button>
      <p class="cost-line" id="resSum"></p>
    </section>

    <section class="pane" data-pane="log" hidden>
      <div class="add-row"><textarea id="logNew" rows="2" placeholder="מה התקדם? למשל: הספק אישר את ההצעה"></textarea><button type="button" class="small" id="logAdd">הוסף</button></div>
      <div id="logList" class="log"></div>
    </section>

    <div class="actions">
      <button value="save" class="primary">שמור</button>
      <button value="unschedule" class="ghost" formnovalidate>החזר למאגר</button>
      <button type="button" class="ghost" id="toClaude" title="מעתיק תיאור מסודר של המשימה, להדבקה בשיחה עם Claude">🤖 העתק ל-Claude</button>
      <span class="grow"></span>
      <button value="delete" class="danger" formnovalidate>מחק</button>
      <button value="cancel" class="ghost" formnovalidate>ביטול</button>
    </div>`, (action, fd) => {
    if (action === 'delete') {
      if (!confirm('למחוק את המשימה? אם היא מקושרת, היא תימחק גם מ-Tasky. קבצים שהועלו נשארים ב-Drive.')) return false;
      t.deleted = true; markGoogle(t);
      data.tasks.forEach((x) => { if (x.deps) x.deps = x.deps.filter((d) => d.from !== t.id); });
      return commit();
    }
    if (action === 'unschedule') { t.scheduled = false; return commit(); }
    readRes();
    const start = fd.get('start'), end = fd.get('end') || start;
    const wasDone = !!t.done;
    t.title = fd.get('title').trim();
    t.desc = fd.get('desc').trim();
    t.status = fd.get('status');
    t.statusWhy = ['waiting', 'blocked'].includes(t.status) ? fd.get('why').trim() : '';
    t.priority = fd.get('priority');
    t.tags = parseTags(fd.get('tags'));
    t.stageId = fd.get('stage');
    const w = fd.get('who');
    t.assignee = w === '__other' ? (fd.get('whoName') || '').trim() || null : w || null;
    t.milestone = fd.get('milestone') === 'on';
    // "שמור ביומן": a milestone gets an all-day event in the chosen Google calendar.
    if (t.milestone && fd.get('cal') === 'on') {
      const sel = form.querySelector('#calSel');
      t.calId = fd.get('calId') || 'primary';
      t.calName = sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : null;
      data.lastCalId = t.calId; data.lastCalName = t.calName;
    } else {
      t.calId = null; t.calName = null;
    }
    t.start = start;
    t.end = t.milestone ? start : (end < start ? start : end);
    const num = (v) => (v === '' || v == null ? null : Math.max(0, Number(v)));
    t.hoursEst = num(fd.get('hEst'));
    t.hoursAct = num(fd.get('hAct'));
    t.manualFinish = !t.milestone && fd.get('manual') === 'on';
    t.steps = draft.steps.filter((x) => x.text.trim());
    t.progress = t.steps.length ? Math.round(100 * t.steps.filter((x) => x.done).length / t.steps.length) : Number(fd.get('progress') || 0);
    t.done = fd.get('done') === 'on';
    if (t.done) {
      t.progress = 100;
      t.status = 'doing' === t.status ? 'doing' : t.status;
      if (!wasDone) {
        t.doneOn = todayIso();
        if (t.manualFinish && t.doneOn > t.end) t.end = t.doneOn; // a manual task finished late really ended today
      }
    } else if (t.status === 'todo' && t.progress > 0) t.status = 'doing';
    t.deps = draft.deps;
    t.files = draft.files;
    t.resources = draft.resources.filter((r) => r.name.trim());
    t.log = draft.log;
    markGoogle(t);
    commit();
  }, (f) => {
    // tabs
    const show = (k) => {
      f.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
      f.querySelectorAll('.pane').forEach((x) => { x.hidden = x.dataset.pane !== k; });
    };
    f.querySelector('.tabs').onclick = (e) => { const b = e.target.closest('.tab'); if (b) show(b.dataset.tab); };
    const counts = () => {
      const set = (k, n) => { f.querySelector(`#n-${k}`).textContent = n ? ` ${n}` : ''; };
      set('steps', draft.steps.length ? `${draft.steps.filter((x) => x.done).length}/${draft.steps.length}` : '');
      set('files', draft.files.length); set('res', draft.resources.length); set('log', draft.log.length);
    };

    // details
    f.progress.oninput = () => { f.querySelector('#pv').textContent = `${f.progress.value}%`; };
    const shape = () => {
      const ms = f.milestone.checked;
      f.querySelector('#calBox').hidden = !ms;
      f.querySelector('#calNote').hidden = !ms || !f.querySelector('#calNote').textContent;
      f.querySelector('#calSel').disabled = !f.cal.checked;
      f.querySelector('#endBox').hidden = ms;
      f.querySelector('#workBox').hidden = ms;
      f.querySelector('#whyBox').hidden = !['waiting', 'blocked'].includes(f.status.value);
    };
    f.milestone.onchange = shape; f.status.onchange = shape; f.cal.onchange = shape; shape();
    fillCalendars(f, t, shape);
    f.who.onchange = () => { f.querySelector('#otherWho').hidden = f.who.value !== '__other'; };
    const hoursColor = () => {
      const est = Number(f.hEst.value), act = Number(f.hAct.value);
      f.querySelector('#hAct').classList.toggle('over', est > 0 && act > est);
    };
    f.hEst.oninput = hoursColor; f.hAct.oninput = hoursColor; hoursColor();

    const list = f.querySelector('#depList');
    const drawDeps = () => {
      list.innerHTML = draft.deps.length ? draft.deps.map((d, i) => {
        const o = task(d.from);
        return `<div class="dep-row" title="${esc(depTip(d))}"><span>${esc(o ? o.title : '(נמחקה)')}</span>
          <span class="dep-tag static">${depLabel(d)}</span><span class="note">${DEP_TYPES[d.type || 'FS'].he}</span>
          <button type="button" class="icon" data-rm="${i}" aria-label="הסר תלות">✕</button></div>`;
      }).join('') : '<p class="note">לא תלויה בשום משימה.</p>';
    };
    list.onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { draft.deps.splice(+b.dataset.rm, 1); drawDeps(); } };
    const add = f.querySelector('#depAdd');
    if (add) add.onclick = () => {
      const from = f.depFrom.value;
      if (!from) return;
      if (dependsOn(task(from), t.id)) { alert('אי אפשר: זה יוצר מעגל, כי המשימה השנייה כבר תלויה בזו.'); return; }
      const i = draft.deps.findIndex((d) => d.from === from);
      const d = { from, type: f.depType.value, lag: Math.trunc(Number(f.depLag.value) || 0) };
      if (i >= 0) draft.deps[i] = d; else draft.deps.push(d);
      f.depFrom.value = '';
      drawDeps();
    };
    drawDeps();

    // steps
    const stepBox = f.querySelector('#stepList');
    const progressFromSteps = () => {
      const note = f.querySelector('#pvNote');
      if (!draft.steps.length) { f.progress.disabled = false; note.textContent = ''; return; }
      const pct = Math.round(100 * draft.steps.filter((x) => x.done).length / draft.steps.length);
      f.progress.value = pct; f.progress.disabled = true;
      f.querySelector('#pv').textContent = `${pct}%`;
      note.textContent = ' (לפי הצעדים)';
    };
    const drawSteps = () => {
      stepBox.innerHTML = draft.steps.length ? draft.steps.map((x, i) => `<div class="step ${x.done ? 'done' : ''}">
        <input type="checkbox" data-sdone="${i}" ${x.done ? 'checked' : ''} aria-label="בוצע">
        <input type="text" data-stext="${i}" value="${esc(x.text)}">
        <button type="button" class="icon" data-sup="${i}" aria-label="למעלה">↑</button>
        <button type="button" class="icon" data-srm="${i}" aria-label="מחק">✕</button></div>`).join('') : '<p class="note">אין צעדים עדיין.</p>';
      progressFromSteps(); counts();
    };
    stepBox.onchange = (e) => {
      const i = e.target.dataset.sdone ?? e.target.dataset.stext;
      if (i == null) return;
      if (e.target.dataset.sdone != null) draft.steps[+i].done = e.target.checked;
      else draft.steps[+i].text = e.target.value;
      drawSteps();
    };
    stepBox.onclick = (e) => {
      const up = e.target.closest('[data-sup]'), rm = e.target.closest('[data-srm]');
      if (up && +up.dataset.sup > 0) { const i = +up.dataset.sup; [draft.steps[i - 1], draft.steps[i]] = [draft.steps[i], draft.steps[i - 1]]; drawSteps(); }
      if (rm) { draft.steps.splice(+rm.dataset.srm, 1); drawSteps(); }
    };
    const stepNew = f.querySelector('#stepNew');
    const addStep = () => { const v = stepNew.value.trim(); if (!v) return; draft.steps.push({ id: uid(), text: v, done: false }); stepNew.value = ''; drawSteps(); stepNew.focus(); };
    f.querySelector('#stepAdd').onclick = addStep;
    stepNew.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addStep(); } };
    drawSteps();

    // files
    const fileBox = f.querySelector('#fileList'), fileNote = f.querySelector('#fileNote');
    const drawFiles = () => {
      fileBox.innerHTML = draft.files.length ? draft.files.map((x, i) => `<div class="file">
        <a href="${esc(x.url)}" target="_blank" rel="noopener">${x.thumb ? `<img src="${x.thumb}" alt="">` : `<span class="ficon">${fileIcon(x)}</span>`}<span class="fname">${esc(x.name)}</span></a>
        <button type="button" class="icon" data-frm="${i}" aria-label="הסר">✕</button></div>`).join('') : '<p class="note">אין קבצים עדיין.</p>';
      counts();
    };
    fileBox.onclick = (e) => { const b = e.target.closest('[data-frm]'); if (b) { draft.files.splice(+b.dataset.frm, 1); drawFiles(); } };
    const upload = async (input) => {
      const files = [...input.files];
      input.value = '';
      if (!files.length) return;
      if (!token) { alert('כדי להעלות קבצים, התחבר קודם ל-Google (הכפתור בראש המסך).'); return; }
      for (const file of files) {
        fileNote.textContent = `מעלה את "${file.name}"…`;
        try {
          const x = await uploadToDrive(file, p);
          if (/^image\//.test(file.type)) x.thumb = await thumbnail(file);
          draft.files.push(x);
          drawFiles();
        } catch (err) {
          alert(`ההעלאה של "${file.name}" נכשלה (${err.message}). נסה שוב.`);
        }
      }
      fileNote.textContent = `הקבצים נשמרים בתיקייה Ganty/${p.name} ב-Drive שלך. זכור ללחוץ "שמור".`;
    };
    f.querySelector('#fileIn').onchange = (e) => upload(e.target);
    f.querySelector('#camIn').onchange = (e) => upload(e.target);
    f.querySelector('#linkAdd').onclick = () => {
      let url = f.querySelector('#linkUrl').value.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      const name = f.querySelector('#linkName').value.trim() || url.replace(/^https?:\/\//, '').slice(0, 40);
      draft.files.push({ id: uid(), name, url, mime: /claude\.ai/.test(url) ? 'claude' : '' });
      f.querySelector('#linkUrl').value = ''; f.querySelector('#linkName').value = '';
      drawFiles();
    };
    drawFiles();

    // resources
    const resBox = f.querySelector('#resList');
    const readRes = () => {
      resBox.querySelectorAll('.res').forEach((row) => {
        const r = draft.resources[+row.dataset.i];
        row.querySelectorAll('[data-k]').forEach((inp) => { r[inp.dataset.k] = inp.value; });
      });
    };
    const sum = () => {
      readRes();
      const c = costs([{ resources: draft.resources }]);
      f.querySelector('#resSum').innerHTML = c.plan || c.act ? `סה"כ: <b class="${c.act > c.plan ? 'over' : ''}">${money(c.act)}</b> בפועל, מתוך ${money(c.plan)} מתוכנן` : '';
    };
    const drawRes = () => {
      resBox.innerHTML = draft.resources.length ? draft.resources.map((r, i) => `<div class="res" data-i="${i}">
        <label class="mini wide">שם<input type="text" data-k="name" value="${esc(r.name)}" placeholder="חשמלאי, צבע, פרסום…"></label>
        <button type="button" class="icon" data-rrm="${i}" aria-label="מחק משאב">✕</button>
        <label class="mini">סוג<select data-k="kind">${opts(KINDS, r.kind || 'person')}</select></label>
        <label class="mini">כמות<input type="number" data-k="qty" value="${esc(r.qty ?? '')}" step="any"></label>
        <label class="mini">יחידה<input type="text" data-k="unit" value="${esc(r.unit || '')}" placeholder="שעות, ליטר…"></label>
        <label class="mini">עלות מתוכננת ₪<input type="number" data-k="costPlan" value="${esc(r.costPlan ?? '')}" step="any"></label>
        <label class="mini">עלות בפועל ₪<input type="number" data-k="costAct" value="${esc(r.costAct ?? '')}" step="any"></label>
        <label class="mini" ${r.kind && r.kind !== 'person' ? 'hidden' : ''}>טלפון<input type="tel" data-k="phone" value="${esc(r.phone || '')}"></label>
        </div>`).join('') : '<p class="note">אין משאבים עדיין.</p>';
      sum(); counts();
    };
    resBox.oninput = sum;
    resBox.onchange = (e) => { if (e.target.dataset.k === 'kind') { readRes(); drawRes(); } };
    resBox.onclick = (e) => { const b = e.target.closest('[data-rrm]'); if (b) { readRes(); draft.resources.splice(+b.dataset.rrm, 1); drawRes(); } };
    f.querySelector('#resAdd').onclick = () => { readRes(); draft.resources.push({ id: uid(), name: '', kind: 'person' }); drawRes(); resBox.querySelector('.res:last-child input').focus(); };
    drawRes();

    // log
    const logBox = f.querySelector('#logList');
    const drawLog = () => {
      logBox.innerHTML = draft.log.length ? draft.log.map((x, i) => `<div class="log-item"><span class="log-date">${short(x.date)}</span>
        <span class="log-text">${esc(x.text)}</span><button type="button" class="icon" data-lrm="${i}" aria-label="מחק">✕</button></div>`).join('') : '<p class="note">אין עדכונים עדיין.</p>';
      counts();
    };
    logBox.onclick = (e) => { const b = e.target.closest('[data-lrm]'); if (b) { draft.log.splice(+b.dataset.lrm, 1); drawLog(); } };
    f.querySelector('#logAdd').onclick = () => {
      const el = f.querySelector('#logNew'), v = el.value.trim();
      if (!v) return;
      draft.log.unshift({ date: todayIso(), text: v });
      el.value = '';
      drawLog();
    };
    drawLog();
    // readRes is used by the save handler above
    openTaskEditor.readRes = readRes;
    f.querySelector('#toClaude').onclick = () => copyText(taskForClaude(t), 'הועתק. הדבק בשיחה עם Claude.');
  });
  function readRes() { openTaskEditor.readRes && openTaskEditor.readRes(); }
}

/** A pool task was tapped: schedule it (or edit / delete it). */
function openPoolTask(t, isNew) {
  const cur = current();
  const pid = t.projectId && project(t.projectId) ? t.projectId : cur ? cur.id : '';
  const start = todayIso();
  const end = t.due && t.due >= start ? t.due : addDays(start, 2);
  const projOpts = data.projects.map((p) => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  showDialog(`
    <h3>${isNew ? 'משימה חדשה' : 'משימה במאגר'}</h3>
    <label>כותרת<input type="text" name="title" value="${esc(t.title)}" required ${isNew ? 'autofocus' : ''}></label>
    <label>פרויקט<select name="project"><option value="">ללא פרויקט</option>${projOpts}</select></label>
    <label>שלב<select name="stage"></select></label>
    <div class="row2">
      <label>התחלה<input type="date" name="start" value="${start}"></label>
      <label>סיום<input type="date" name="end" value="${end}"></label>
    </div>
    <div class="actions">
      <button value="schedule" class="primary">שבץ בלוח</button>
      <button value="save" class="ghost">${isNew ? 'הוסף למאגר' : 'שמור במאגר'}</button>
      <span class="grow"></span>
      ${isNew ? '' : '<button value="delete" class="danger" formnovalidate>מחק</button>'}
      <button value="cancel" class="ghost" formnovalidate>ביטול</button>
    </div>`, (action, fd) => {
    if (action === 'delete') {
      if (!confirm('למחוק את המשימה? אם היא מקושרת, היא תימחק גם מ-Tasky.')) return false;
      t.deleted = true; markGoogle(t); return commit();
    }
    t.title = fd.get('title').trim();
    const p = project(fd.get('project'));
    if ((t.projectId || null) !== (p ? p.id : null)) t.projectChanged = true;
    t.projectId = p ? p.id : null;
    if (isNew) data.tasks.push(t);
    if (action === 'schedule') {
      if (!p) { alert('כדי לשבץ בלוח, בחר פרויקט.'); if (isNew) data.tasks.pop(); return false; }
      const s = fd.get('start') || todayIso();
      ui.projectId = p.id; saveUi();
      return schedule(t, p, fd.get('stage') || p.stages[0].id, s, fd.get('end') && fd.get('end') >= s ? fd.get('end') : null);
    }
    markGoogle(t);
    commit();
  }, (f) => {
    const fill = () => {
      const p = project(f.project.value);
      f.stage.innerHTML = p ? stageOptions(p, p.stages[0].id) : '<option value="">—</option>';
      f.stage.disabled = !p;
    };
    f.project.onchange = fill;
    fill();
  });
}

/** New / rename / color / stages / delete. */
function openProjectDialog(p) {
  const isNew = !p;
  const draft = p ? JSON.parse(JSON.stringify(p)) : { name: '', color: COLORS[data.projects.length % COLORS.length], stages: [{ id: uid(), name: 'כללי' }] };
  const stagesHtml = () => draft.stages.map((s, i) => `<div class="st" data-i="${i}">
      <input type="text" value="${esc(s.name)}" data-stage-name="${i}">
      <button type="button" class="icon" data-up="${i}" aria-label="למעלה">↑</button>
      <button type="button" class="icon" data-del="${i}" aria-label="מחק שלב">✕</button></div>`).join('');
  showDialog(`
    <h3>${isNew ? 'פרויקט חדש' : 'הגדרות פרויקט'}</h3>
    ${isNew && (data.templates || []).length ? `<fieldset class="deps"><legend>📋 מתבנית (לא חובה)</legend>
      <div class="row2">
        <label>תבנית<select name="tpl"><option value="">פרויקט ריק</option>${data.templates.map((x) => `<option value="${x.id}">${esc(x.name)} (${x.tasks.length} משימות)</option>`).join('')}</select></label>
        <label>תאריך התחלה<input type="date" name="tplStart" value="${todayIso()}"></label>
      </div>
      <div class="tpl-list">${data.templates.map((x) => `<span class="tpl-chip">${esc(x.name)}<button type="button" class="icon" data-tpl-rm="${x.id}" aria-label="מחק תבנית">✕</button></span>`).join('')}</div>
    </fieldset>` : ''}
    <label>שם<input type="text" name="name" value="${esc(draft.name)}" ${isNew && (data.templates || []).length ? '' : 'required'} placeholder="למשל: אתר לעסק"></label>
    <label>צבע<div class="swatches">${COLORS.map((c) => `<button type="button" class="swatch ${c === draft.color ? 'on' : ''}" data-color="${c}" style="background:${c}" aria-label="צבע"></button>`).join('')}</div></label>
    <label>שלבים<div class="stages-edit" id="stagesEdit">${stagesHtml()}</div></label>
    <button type="button" class="ghost small" id="addStage">＋ שלב</button>
    <label>תאריך יעד (לא חובה)<input type="date" name="target" value="${draft.target || ''}"></label>
    <p class="note">היעד מופיע על הלוח כקו אדום. אם הסיום הצפוי אחריו, יופיע ⚠️.</p>
    ${isNew ? '' : `<fieldset class="deps">
      <legend>${p.frozen ? '❄️ הפרויקט מוקפא' : 'הקפאה'}</legend>
      ${p.frozen ? `<p class="note">מוקפא מ-${short(p.frozen.since)}${p.frozen.why ? ` · ${esc(p.frozen.why)}` : ''}. בהפשרה, מה שלא התחיל יזוז קדימה ${Math.max(0, dayNum(todayIso()) - dayNum(p.frozen.since))} ימים, ומשימות שהתחילו יתארכו באותו מספר ימים.</p>
        <button value="thaw" class="primary small" formnovalidate>☀️ הפשר והמשך מהיום</button>`
      : `<label>למה מקפיאים? (לא חובה)<input type="text" name="why" placeholder="למשל: מחכה לתקציב"></label>
        <button value="freeze" class="ghost small" formnovalidate>❄️ הקפא פרויקט</button>`}
      ${(p.freezeLog || []).length ? `<div class="log">${p.freezeLog.map((x) => `<div class="log-item"><span class="log-date">${short(x.date)}</span>
        <span class="log-text">${x.type === 'freeze' ? `❄️ הוקפא${x.why ? `: ${esc(x.why)}` : ''}` : `☀️ הופשר אחרי ${x.days} ימים`}</span></div>`).join('')}</div>` : ''}
    </fieldset>`}
    <div class="actions">
      <button value="save" class="primary">${isNew ? 'צור' : 'שמור'}</button>
      <span class="grow"></span>
      ${isNew ? '' : '<button value="tpl" class="ghost" formnovalidate>📋 שמור כתבנית</button>'}
      ${isNew ? '' : '<button value="delete" class="danger" formnovalidate>מחק פרויקט</button>'}
      <button value="cancel" class="ghost" formnovalidate>ביטול</button>
    </div>`, (action, fd) => {
    if (action === 'delete') {
      if (!confirm(`למחוק את "${p.name}"? המשימות שלו יחזרו למאגר.`)) return false;
      data.tasks.filter((t) => t.projectId === p.id).forEach((t) => { t.projectId = null; t.scheduled = false; t.projectChanged = true; markGoogle(t); });
      data.projects = data.projects.filter((x) => x.id !== p.id);
      ui.projectId = data.projects[0] ? data.projects[0].id : null; saveUi();
      return commit();
    }
    if (action === 'tpl') { setTimeout(() => saveTemplateDialog(p), 0); return; }
    if (isNew && fd.get('tpl')) {
      const tp = (data.templates || []).find((x) => x.id === fd.get('tpl'));
      if (tp) { projectFromTemplate(tp, fd.get('name').trim() || tp.name, fd.get('tplStart') || todayIso(), draft.color); return; }
    }
    if (!fd.get('name').trim()) { alert('תן לפרויקט שם.'); return false; }
    if (action === 'freeze') return freezeProject(p, (fd.get('why') || '').trim());
    if (action === 'thaw') return thawProject(p);
    readStages();
    draft.target = fd.get('target') || null;
    draft.name = fd.get('name').trim() || 'פרויקט';
    draft.stages = draft.stages.filter((s) => s.name.trim());
    if (!draft.stages.length) draft.stages = [{ id: uid(), name: 'כללי' }];
    if (isNew) {
      const np = newProject(draft.name, draft.color);
      np.stages = draft.stages;
      np.target = draft.target;
      ui.view = 'project'; saveUi();
    } else {
      const renamed = p.name !== draft.name;
      Object.assign(p, { name: draft.name, color: draft.color, stages: draft.stages, target: draft.target });
      const ids = new Set(p.stages.map((s) => s.id));
      data.tasks.forEach((t) => {
        if (t.projectId !== p.id) return;
        if (!ids.has(t.stageId)) t.stageId = p.stages[0].id;
        if (renamed) { t.projectChanged = true; markGoogle(t); }
      });
    }
    commit();
  }, (f) => {
    f.querySelectorAll('[data-tpl-rm]').forEach((b) => b.onclick = () => {
      const x = data.templates.find((y) => y.id === b.dataset.tplRm);
      if (!x || !confirm(`למחוק את התבנית "${x.name}"?`)) return;
      data.templates = data.templates.filter((y) => y !== x);
      if (x.builtin) data.builtinRemoved = true;
      b.closest('.tpl-chip').remove();
      const opt = f.tpl && [...f.tpl.options].find((o) => o.value === x.id);
      if (opt) opt.remove();
      commit();
    });
    if (f.tpl) f.tpl.onchange = () => { if (!f.name.value.trim() && f.tpl.value) f.name.placeholder = f.tpl.selectedOptions[0].textContent.replace(/ \(.*$/, ''); };
    f.querySelectorAll('[data-color]').forEach((b) => b.onclick = () => {
      draft.color = b.dataset.color;
      f.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b));
    });
    const box = f.querySelector('#stagesEdit');
    box.onclick = (e) => {
      readStages();
      const up = e.target.closest('[data-up]'), del = e.target.closest('[data-del]');
      if (up) { const i = +up.dataset.up; if (i > 0) [draft.stages[i - 1], draft.stages[i]] = [draft.stages[i], draft.stages[i - 1]]; }
      if (del) { if (draft.stages.length > 1) draft.stages.splice(+del.dataset.del, 1); }
      box.innerHTML = stagesHtml();
    };
    f.querySelector('#addStage').onclick = () => { readStages(); draft.stages.push({ id: uid(), name: '' }); box.innerHTML = stagesHtml(); box.querySelector('.st:last-child input').focus(); };
  });
  function readStages() {
    form.querySelectorAll('[data-stage-name]').forEach((inp) => { draft.stages[+inp.dataset.stageName].name = inp.value; });
  }
}

// ---------------------------------------------------------------- header & pool controls
$('#projectSelect').onchange = (e) => {
  if (e.target.value === '__new') { renderHeader(); return openProjectDialog(null); }
  if (e.target.value === '__all') ui.view = 'all';
  else { ui.view = 'project'; ui.projectId = e.target.value; }
  saveUi(); renderBoard.first = true; render();
};
$('#allFilter').onchange = (e) => { ui.allFilter = e.target.value; saveUi(); renderBoard(); };
$('#projectMenuBtn').onclick = () => current() && openProjectDialog(current());
document.querySelectorAll('.zoom button').forEach((b) => b.onclick = () => setZoom(ZOOM[b.dataset.zoom]));
$('#todayBtn').onclick = scrollToToday;
$('#exportBtn').onclick = () => openExportDialog();
$('#weeklyBtn').onclick = () => openWeekly();
$('#claudeBtn').onclick = () => openClaudeList();
$('#whoFilter').onchange = (e) => { ui.assignee = e.target.value; saveUi(); renderBoard(); };
$('#tagFilter').onchange = (e) => { ui.tag = e.target.value; saveUi(); renderBoard(); };
$('#critBtn').onclick = () => { ui.critical = !ui.critical; saveUi(); renderHeader(); renderBoard(); };
$('#poolFilter').onchange = (e) => { ui.poolFilter = e.target.value; saveUi(); renderPool(); };
$('#newTaskBtn').onclick = () => openPoolTask({ id: uid(), title: '', projectId: ui.poolFilter !== 'all' && ui.poolFilter !== 'none' ? ui.poolFilter : (current() && current().id), scheduled: false, done: false, progress: 0, gDirty: true }, true);
$('#poolFab').onclick = () => $('#pool').classList.add('open');
$('#poolClose').onclick = () => $('#pool').classList.remove('open');

// ---------------------------------------------------------------- Google sign-in
let token = (() => { try { const t = JSON.parse(localStorage.getItem(LS_TOKEN)); return t && t.exp > Date.now() + 60e3 ? t.value : null; } catch { return null; } })();
let tokenClient = null;

function setStatus(text) { $('#status').textContent = text; }

function initGoogle() {
  if (!CFG.clientId) {
    $('#signInBtn').hidden = true;
    setStatus('נשמר במכשיר הזה');
    showBanner('מצב מקומי: ההתחברות ל-Google עוד לא הוגדרה. הכול נשמר בינתיים רק במכשיר הזה.');
    return;
  }
  if (!window.google || !google.accounts || !google.accounts.oauth2) return setTimeout(initGoogle, 300);
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.clientId,
    scope: SCOPES,
    callback: (r) => {
      if (r.error) { setStatus('ההתחברות לא הושלמה'); return; }
      token = r.access_token;
      localStorage.setItem(LS_TOKEN, JSON.stringify({ value: token, exp: Date.now() + (r.expires_in - 60) * 1000 }));
      localStorage.setItem('ganty-signed', '1');
      updateSignIn();
      syncNow();
    },
  });
  updateSignIn();
  if (token) syncNow();
}

function updateSignIn() {
  const b = $('#signInBtn');
  b.hidden = !!token;
  b.textContent = localStorage.getItem('ganty-signed') ? 'התחבר מחדש' : 'התחבר ל-Google';
  if (!token) setStatus(localStorage.getItem('ganty-signed') ? 'החיבור פג. לחץ "התחבר מחדש"' : 'לא מחובר: נשמר במכשיר בלבד');
}

$('#signInBtn').onclick = () => tokenClient && tokenClient.requestAccessToken({ prompt: localStorage.getItem('ganty-signed') ? '' : 'consent' });

function showBanner(text) { const b = $('#banner'); b.textContent = text; b.hidden = !text; b.onclick = null; b.style.cursor = ''; }

async function api(method, url, body, raw) {
  if (!token) throw new Error('no-token');
  const res = await fetch(url, {
    method,
    headers: Object.assign({ Authorization: `Bearer ${token}` }, body && !raw ? { 'Content-Type': 'application/json' } : {}, raw ? { 'Content-Type': raw } : {}),
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  if (res.status === 401) {
    token = null; localStorage.removeItem(LS_TOKEN); updateSignIn();
    throw new Error('expired');
  }
  if (!res.ok) throw new Error(`${res.status}`);
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

// ---------------------------------------------------------------- Google Tasks
const TASKS = 'https://tasks.googleapis.com/tasks/v1';

/** A changed task waits to be sent to Google Tasks. */
function markGoogle(t) { t.gDirty = true; }

function notesWithProject(notes, name) {
  const lines = (notes || '').split('\n').filter((l) => !l.trim().startsWith(PROJECT_TAG));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (name) { if (lines.length) lines.push(''); lines.push(`${PROJECT_TAG} ${name}`); }
  return lines.join('\n');
}

async function ganttListId() {
  if (data.listId) return data.listId;
  const res = await api('GET', `${TASKS}/users/@me/lists?maxResults=100`);
  let list = (res.items || []).find((l) => l.title === GANTT_LIST);
  if (!list) list = await api('POST', `${TASKS}/users/@me/lists`, { title: GANTT_LIST });
  data.listId = list.id;
  return list.id;
}

async function syncTasks() {
  const listId = await ganttListId();
  // 1. Bring in what Tasky (or Google) changed.
  let items = [], pageToken = '';
  do {
    const res = await api('GET', `${TASKS}/lists/${listId}/tasks?maxResults=100&showCompleted=true&showHidden=true${pageToken ? `&pageToken=${pageToken}` : ''}`);
    items = items.concat(res.items || []);
    pageToken = res.nextPageToken || '';
  } while (pageToken);
  const remote = new Map(items.filter((r) => !r.deleted && !r.parent).map((r) => [r.id, r]));

  for (const t of data.tasks) {
    if (!t.gid || t.gDirty) continue;
    const r = remote.get(t.gid);
    if (!r) { // deleted in Tasky / Google
      if (t.scheduled) t.gid = null; else t.deleted = true;
      continue;
    }
    t.title = r.title || '';
    t.gNotes = r.notes || '';
    t.due = r.due ? r.due.slice(0, 10) : null;
    const done = r.status === 'completed';
    if (done && !t.done) {
      t.progress = 100;
      t.doneOn = todayIso();
      if (t.scheduled && t.manualFinish && t.doneOn > t.end) t.end = t.doneOn;
    }
    t.done = done;
    const pname = projectNameFromNotes(r.notes);
    if (pname && !t.scheduled) t.projectId = projectByName(pname).id;
  }
  const known = new Set(data.tasks.map((t) => t.gid).filter(Boolean));
  for (const r of remote.values()) {
    if (known.has(r.id)) continue;
    const pname = projectNameFromNotes(r.notes);
    data.tasks.push({
      id: uid(), gid: r.id, title: r.title || '', gNotes: r.notes || '', due: r.due ? r.due.slice(0, 10) : null,
      done: r.status === 'completed', progress: r.status === 'completed' ? 100 : 0,
      projectId: pname ? projectByName(pname).id : null, scheduled: false,
    });
  }

  // 2. Send what changed here.
  for (const t of data.tasks.filter((x) => x.gDirty)) {
    const p = project(t.projectId);
    if (t.deleted) {
      if (t.gid) await api('DELETE', `${TASKS}/lists/${listId}/tasks/${t.gid}`).catch(() => {});
      t.gDirty = false;
      continue;
    }
    const due = t.scheduled ? t.end : t.due;
    const body = {
      title: t.title,
      status: t.done ? 'completed' : 'needsAction',
      due: due ? `${due}T00:00:00.000Z` : null,
    };
    if (!t.gid || t.projectChanged) body.notes = notesWithProject(t.gNotes, p ? p.name : null);
    if (!t.done) body.completed = null;
    if (t.gid) {
      await api('PATCH', `${TASKS}/lists/${listId}/tasks/${t.gid}`, body);
    } else {
      const created = await api('POST', `${TASKS}/lists/${listId}/tasks`, body);
      t.gid = created.id;
    }
    if (body.notes !== undefined) t.gNotes = body.notes;
    if (due) t.due = due;
    t.gDirty = false;
    t.projectChanged = false;
  }
  // Deleted tasks are gone for good once Google knows.
  data.tasks = data.tasks.filter((t) => !(t.deleted && !t.gDirty));
  applyConstraints(); // a task finished (or not) in Tasky may move the ones after it
}

function projectNameFromNotes(notes) {
  const line = (notes || '').split('\n').find((l) => l.trim().startsWith(PROJECT_TAG));
  return line ? line.trim().slice(PROJECT_TAG.length).trim() || null : null;
}

function projectByName(name) {
  let p = data.projects.find((x) => x.name.trim() === name.trim());
  if (!p) {
    p = { id: uid(), name: name.trim(), color: COLORS[data.projects.length % COLORS.length], stages: [{ id: uid(), name: 'כללי' }] };
    data.projects.push(p);
    if (!ui.projectId) { ui.projectId = p.id; saveUi(); }
  }
  return p;
}

// ---------------------------------------------------------------- Google Drive ("Ganty" folder)
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FILE_NAME = 'ganty-data.json';

/** "Ganty/<project name>" in Drive, for the project's files. */
async function projectFolderId(p) {
  if (p.folderId) return p.folderId;
  const parent = await driveFolderId();
  const name = p.name.replace(/'/g, "\\'");
  const q = encodeURIComponent(`name='${name}' and '${parent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const res = await api('GET', `${DRIVE}/files?q=${q}&fields=files(id)&spaces=drive`);
  const f = (res.files || [])[0] || await api('POST', `${DRIVE}/files?fields=id`, { name: p.name, parents: [parent], mimeType: 'application/vnd.google-apps.folder' });
  p.folderId = f.id;
  return f.id;
}

/** Uploads one file (any size) to the project's folder. Returns { id, name, mime, url }. */
async function uploadToDrive(file, p) {
  if (!token) throw new Error('no-token');
  const folder = await projectFolderId(p);
  const start = await fetch(`${UPLOAD}/files?uploadType=resumable&fields=id,name,mimeType,webViewLink`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': file.type || 'application/octet-stream' },
    body: JSON.stringify({ name: file.name, parents: [folder] }),
  });
  if (!start.ok) throw new Error(`${start.status}`);
  const res = await fetch(start.headers.get('Location'), { method: 'PUT', body: file });
  if (!res.ok) throw new Error(`${res.status}`);
  const f = await res.json();
  return { id: uid(), driveId: f.id, name: f.name, mime: f.mimeType, url: f.webViewLink };
}

/** A small preview of a picture, kept with the task (so it shows on every device). */
async function thumbnail(file) {
  try {
    const img = await createImageBitmap(file);
    const k = Math.min(1, 220 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  } catch { return null; }
}

function fileIcon(f) {
  const m = (f.mime || '') + ' ' + (f.name || '');
  if (/image/.test(m)) return '🖼️';
  if (/pdf/i.test(m)) return '📕';
  if (/word|document|\.docx?/i.test(m)) return '📘';
  if (/sheet|excel|\.xlsx?|csv/i.test(m)) return '📗';
  if (/presentation|powerpoint|\.pptx?/i.test(m)) return '📙';
  if (!f.driveId) return '🔗';
  return '📄';
}

async function driveFolderId() {
  if (data.folderId) return data.folderId;
  const q = encodeURIComponent("name='Ganty' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const res = await api('GET', `${DRIVE}/files?q=${q}&fields=files(id)&spaces=drive`);
  const f = (res.files || [])[0] || await api('POST', `${DRIVE}/files?fields=id`, { name: 'Ganty', mimeType: 'application/vnd.google-apps.folder' });
  data.folderId = f.id;
  return f.id;
}

async function driveFileId(folderId) {
  if (data.fileId) return data.fileId;
  const q = encodeURIComponent(`name='${FILE_NAME}' and '${folderId}' in parents and trashed=false`);
  const res = await api('GET', `${DRIVE}/files?q=${q}&fields=files(id)&spaces=drive`);
  data.fileId = (res.files || [])[0]?.id || null;
  return data.fileId;
}

/** What is saved in Drive: everything except this device's bookkeeping. */
function forDrive() {
  const { dirty, folderId, fileId, listId, ...rest } = data;
  return JSON.stringify(rest);
}

async function syncDrive() {
  const firstTime = !data.fileId; // this device never synced before
  const folderId = await driveFolderId();
  if (!data.readmeDone) {
    // A short explanation for AI agents that can read this folder.
    try {
      const q = encodeURIComponent(`name='Ganty-README.md' and '${folderId}' in parents and trashed=false`);
      const res = await api('GET', `${DRIVE}/files?q=${q}&fields=files(id)&spaces=drive`);
      if (!(res.files || []).length) {
        const boundary = 'ganty' + uid();
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: 'Ganty-README.md', parents: [folderId], mimeType: 'text/markdown' })}\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${README}\r\n--${boundary}--`;
        await api('POST', `${UPLOAD}/files?uploadType=multipart&fields=id`, body, `multipart/related; boundary=${boundary}`);
      }
      data.readmeDone = true;
    } catch (e) { /* next time */ }
  }
  const fileId = await driveFileId(folderId);
  if (fileId && (firstTime || !data.dirty)) {
    const remote = await api('GET', `${DRIVE}/files/${fileId}?alt=media`);
    const r = typeof remote === 'string' ? JSON.parse(remote) : remote;
    const keep = { folderId, fileId, listId: data.listId };
    if (r && firstTime && data.dirty) {
      // Work done here before signing in: add it to what is already in Drive.
      const merged = Object.assign(emptyData(), r, keep);
      const pids = new Set(merged.projects.map((x) => x.id)), tids = new Set(merged.tasks.map((x) => x.id));
      merged.projects.push(...data.projects.filter((x) => !pids.has(x.id)));
      merged.tasks.push(...data.tasks.filter((x) => !tids.has(x.id)));
      data = Object.assign(merged, { updatedAt: Date.now(), dirty: true });
    } else {
      if (r && r.updatedAt > data.updatedAt) data = Object.assign(emptyData(), r, keep, { dirty: false });
      return;
    }
  }
  if (!fileId) {
    const boundary = 'ganty' + uid();
    const meta = JSON.stringify({ name: FILE_NAME, parents: [folderId], mimeType: 'application/json' });
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${forDrive()}\r\n--${boundary}--`;
    const created = await api('POST', `${UPLOAD}/files?uploadType=multipart&fields=id`, body, `multipart/related; boundary=${boundary}`);
    data.fileId = created.id;
  } else {
    await api('PATCH', `${UPLOAD}/files/${fileId}?uploadType=media`, forDrive(), 'application/json');
  }
  data.dirty = false;
}

// ---------------------------------------------------------------- Google Calendar: milestones
const CAL = 'https://www.googleapis.com/calendar/v3';
let calendars = null; // [{id, name}] once loaded

/** Fills the calendar choice in the task editor (the user's calendars he can write to). */
async function fillCalendars(f, t, shape) {
  const sel = f.querySelector('#calSel'), note = f.querySelector('#calNote');
  const say = (html) => { note.innerHTML = html; shape(); };
  if (!token) return say('כדי לשמור ביומן צריך להתחבר ל-Google.');
  try {
    if (!calendars) {
      const r = await api('GET', `${CAL}/users/me/calendarList?minAccessRole=writer&fields=items(id,summary,summaryOverride,primary)`);
      calendars = (r.items || []).map((c) => ({ id: c.primary ? 'primary' : c.id, name: c.summaryOverride || c.summary || c.id }))
        .sort((a, b) => (a.id === 'primary' ? -1 : b.id === 'primary' ? 1 : 0));
    }
    const want = t.calId || data.lastCalId || 'primary';
    sel.innerHTML = calendars.map((c) => `<option value="${esc(c.id)}" ${c.id === want ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    say('');
  } catch (e) {
    if (e.message === '403') say('אין עדיין גישה ליומן. <button type="button" class="small" id="calAllow">אשר גישה ליומן</button>');
    else say('לא הצלחתי לטעון את היומנים. אפשר לשמור, והאירוע ייכנס ליומן שנבחר.');
    const b = note.querySelector('#calAllow');
    if (b) b.onclick = () => tokenClient && tokenClient.requestAccessToken({ prompt: 'consent' });
  }
}

const calUrl = (calId, eventId) => `${CAL}/calendars/${encodeURIComponent(calId)}/events${eventId ? '/' + encodeURIComponent(eventId) : ''}`;
async function calDelete(calId, eventId) {
  try { await api('DELETE', calUrl(calId, eventId)); } catch (e) { if (!['404', '410'].includes(e.message)) throw e; }
}

/** The event a milestone should have: all day, on its date. */
function calBody(t) {
  const p = project(t.projectId);
  return {
    // Project first, so it shows even when the calendar cuts a long title.
    summary: `${t.done ? '✅ ' : ''}◆ ${p ? p.name + ': ' : ''}${t.title || '(ללא כותרת)'}`,
    description: `אבן דרך ב-Ganty\nפרויקט: ${p ? p.name : '—'}\nאבן דרך: ${t.title || ''}\nhttps://shukiy909.github.io/ganty`,
    start: { date: t.start },
    end: { date: addDays(t.start, 1) },
    transparency: 'transparent',
  };
}

/**
 * Keeps the calendar in step with the board: creates, moves or removes the events of milestones marked "שמור ביומן".
 * Untick / not a milestone / back to the pool / deleted → the event is removed.
 */
async function syncCalendar() {
  let changed = false;
  for (const t of data.tasks) {
    const want = !t.deleted && t.milestone && t.calId && t.scheduled && t.projectId && t.start;
    if (t.calEventId && (!want || t.calEventCal !== t.calId)) {
      await calDelete(t.calEventCal || 'primary', t.calEventId);
      t.calEventId = null; t.calEventCal = null; t.calStamp = null; changed = true;
    }
    if (!want) continue;
    const body = calBody(t), stamp = JSON.stringify(body);
    if (t.calEventId && t.calStamp === stamp) continue;
    if (t.calEventId) {
      try { await api('PUT', calUrl(t.calId, t.calEventId), body); } catch (e) {
        if (['404', '410'].includes(e.message)) t.calEventId = null; else throw e;
      }
    }
    if (!t.calEventId) {
      const ev = await api('POST', calUrl(t.calId), body);
      t.calEventId = ev.id; t.calEventCal = t.calId;
    }
    t.calStamp = stamp; changed = true;
  }
  if (changed) { data.updatedAt = Date.now(); data.dirty = true; }
}

/** The calendar needs a permission the user didn't give yet: a banner he can tap. */
function showCalBanner(text) {
  const b = $('#banner');
  b.textContent = text; b.hidden = false; b.style.cursor = 'pointer';
  b.onclick = () => { b.onclick = null; b.style.cursor = ''; tokenClient && tokenClient.requestAccessToken({ prompt: 'consent' }); };
}

// ---------------------------------------------------------------- sync
let syncTimer = null, syncing = false, again = false;
function scheduleSync() {
  if (!token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 1500);
}

async function syncNow() {
  if (!token) return;
  if (syncing) { again = true; return; }
  syncing = true;
  setStatus('מסנכרן…');
  try {
    await syncDrive(); // first: maybe a newer copy from another device
    // Calendar before Google Tasks: deleted milestones still need their event removed.
    let calProblem = '';
    if (data.tasks.some((t) => t.calId || t.calEventId)) {
      try { await syncCalendar(); } catch (e) {
        if (e.message === 'expired' || e.message === 'no-token') throw e;
        calProblem = e.message === '403'
          ? '📅 כדי לשמור אבני דרך ביומן צריך לאשר גישה ל-Google Calendar. לחץ כאן.'
          : '📅 העדכון ביומן נכשל, ננסה שוב בסנכרון הבא.';
      }
    }
    const before = JSON.stringify(data.tasks);
    await syncTasks();
    if (JSON.stringify(data.tasks) !== before) { data.updatedAt = Date.now(); data.dirty = true; }
    if (data.dirty) await syncDrive();
    localStorage.setItem(LS_DATA, JSON.stringify(data));
    setStatus(`נשמר ב-Drive ✓ ${new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`);
    if (calProblem.includes('לחץ כאן')) showCalBanner(calProblem); else showBanner(calProblem);
    render();
  } catch (e) {
    if (e.message === 'expired' || e.message === 'no-token') updateSignIn();
    else if (e.message === '403') { setStatus('אין הרשאה'); showBanner('Google סירב לגישה. ודא שהפעלת את Google Tasks API ו-Google Drive API בפרויקט, ושאישרת את כל ההרשאות בהתחברות.'); }
    else setStatus('הסנכרון נכשל, ננסה שוב');
    localStorage.setItem(LS_DATA, JSON.stringify(data));
  } finally {
    syncing = false;
    if (again) { again = false; scheduleSync(); }
  }
}

// Check for changes from Tasky every 2 minutes, and when coming back to the window.
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 120e3);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });

// ---------------------------------------------------------------- copy helper
function copyText(text, okMsg) {
  const done = () => setStatus(okMsg || 'הועתק');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallback());
  else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch { prompt('העתק את הטקסט:', text); }
    ta.remove();
  }
}

// ---------------------------------------------------------------- 🤖 AI helpers
/** A task written out for Claude: everything it needs to help, in plain Hebrew. */
function taskForClaude(t) {
  const p = project(t.projectId);
  const st = p && p.stages.find((x) => x.id === t.stageId);
  const lines = [`משימה: ${t.title}`];
  if (p) lines.push(`פרויקט: ${p.name}${st ? ` · שלב: ${st.name}` : ''}`);
  if (t.scheduled) lines.push(`תאריכים: ${short(t.start)}–${short(t.end)} · התקדמות ${t.done ? 100 : t.progress || 0}%${t.done ? ' · בוצע' : ''}`);
  if (t.status && t.status !== 'todo') lines.push(`סטטוס: ${STATUS[t.status]}${t.statusWhy ? ` (${t.statusWhy})` : ''}`);
  if (t.priority === 'high') lines.push('עדיפות: גבוהה');
  if (t.desc) lines.push('', 'תיאור:', t.desc);
  if ((t.steps || []).length) { lines.push('', 'צעדים:'); t.steps.forEach((x) => lines.push(`- [${x.done ? 'x' : ' '}] ${x.text}`)); }
  if ((t.deps || []).length) {
    lines.push('', 'תלויה ב:');
    t.deps.forEach((d) => { const o = task(d.from); if (o) lines.push(`- ${o.title} (${depTip(d)})${o.done ? ' – בוצע' : ''}`); });
  }
  if ((t.files || []).length) { lines.push('', 'קבצים וקישורים:'); t.files.forEach((x) => lines.push(`- ${x.name}: ${x.url}`)); }
  if ((t.resources || []).length) { lines.push('', 'משאבים:'); t.resources.forEach((r) => lines.push(`- ${r.name} (${KINDS[r.kind] || ''})${r.costPlan ? ` · ${money(r.costPlan)}` : ''}`)); }
  if ((t.log || []).length) { lines.push('', 'עדכונים אחרונים:'); t.log.slice(0, 5).forEach((x) => lines.push(`- ${short(x.date)}: ${x.text}`)); }
  lines.push('', 'מה אני צריך ממך:', '');
  return lines.join('\n');
}

/** All open tasks Claude is responsible for, in every project. */
function openClaudeList() {
  const list = data.tasks.filter((t) => !t.deleted && !t.done && t.assignee === 'Claude')
    .sort((a, b) => ((a.start || a.due || '9') < (b.start || b.due || '9') ? -1 : 1));
  showDialog(`
    <h3>🤖 המשימות של Claude <span class="note">(${list.length})</span></h3>
    ${list.length ? `<div class="claude-list">${list.map((t) => {
      const p = project(t.projectId);
      return `<div class="claude-item"><div><b>${esc(t.title)}</b><div class="note">${esc(p ? p.name : 'ללא פרויקט')}${t.start ? ` · ${short(t.start)}–${short(t.end)}` : ''}${t.status === 'blocked' ? ' · ⛔ חסום' : ''}</div></div>
        <button type="button" class="small" data-copy="${t.id}">העתק</button></div>`;
    }).join('')}</div>` : '<p class="note">אין משימות פתוחות שבהן Claude אחראי. בוחרים אחראי בטופס המשימה.</p>'}
    <p class="note">מעתיקים משימה ומדביקים אותה בשיחה עם Claude. בתיקייה Ganty ב-Drive יש גם קובץ הסבר (Ganty-README.md) לסוכני AI עם גישה ל-Drive.</p>
    <div class="actions">
      ${list.length ? '<button type="button" class="primary" id="copyAll">העתק הכול ל-Claude</button>' : ''}
      <span class="grow"></span><button value="cancel" class="ghost" formnovalidate>סגור</button>
    </div>`, () => {}, (f) => {
    f.querySelectorAll('[data-copy]').forEach((b) => b.onclick = () => copyText(taskForClaude(task(b.dataset.copy)), 'הועתק. הדבק בשיחה עם Claude.'));
    const all = f.querySelector('#copyAll');
    if (all) all.onclick = () => copyText(`אלה המשימות שלך בפרויקטים שלי (${list.length}):\n\n` + list.map(taskForClaude).join('\n---\n\n'), 'הכול הועתק.');
  });
}

/** Explains ganty-data.json to AI agents that can read the Drive folder. */
const README = `# Ganty – מבנה הנתונים (לסוכני AI)

הקובץ ganty-data.json בתיקייה הזו מחזיק את כל הפרויקטים של לוח הגאנט Ganty.
תאריכים בפורמט YYYY-MM-DD. אחרי כל שינוי, עדכנו את updatedAt (מילישניות) כדי ש-Ganty יטען את הגרסה החדשה.

## שדות עיקריים
- projects[]: id, name, color, stages[] (id, name), target (תאריך יעד), frozen ({since, why} או null), freezeLog[]
- tasks[]: id, title, projectId, stageId, scheduled (בלוח או במאגר), start, end, progress (0–100), done, doneOn,
  milestone, manualFinish, assignee ("אני" / "Claude" / "סוכן AI" / שם), status (todo/doing/waiting/blocked), statusWhy,
  priority (high/normal/low), tags[], desc, steps[] (text, done), deps[] (from = id של משימה קודמת, type = FS/SS/FF, lag = ימי המתנה),
  files[] (name, url), resources[] (name, kind = person/material/money, qty, unit, costPlan, costAct, phone), log[] (date, text),
  hoursEst, hoursAct, gid (מזהה ב-Google Tasks, ברשימה "משימות לגנט")
- templates[]: תבניות פרויקט (משימות עם offset ו-dur בימים, deps לפי key)

## כללים
- משימה תלויה (FS) מתחילה אחרי effEnd של הקודמת + 1 + lag. משימה עם manualFinish שלא בוצעה מסתיימת לכל המוקדם היום.
- אל תמחקו משימות עם gid: סמנו done או deleted, וגאנטי יסנכרן ל-Google Tasks.
`;

// ---------------------------------------------------------------- 📋 project templates
const BUILTIN_TPL = () => ({
  id: 'tpl-claude', builtin: true, name: 'פרויקט Claude טיפוסי', color: '#6750A4',
  stages: ['אפיון', 'בנייה', 'בדיקות', 'השקה'],
  tasks: [
    { key: 'a1', title: 'הגדרת מטרות ודרישות', stage: 0, offset: 0, dur: 2, assignee: 'אני' },
    { key: 'a2', title: 'אפיון עם Claude', stage: 0, offset: 2, dur: 2, assignee: 'Claude', deps: [{ from: 'a1', type: 'FS', lag: 0 }] },
    { key: 'a3', title: 'אפיון מאושר', stage: 0, offset: 4, dur: 1, milestone: true, deps: [{ from: 'a2', type: 'FS', lag: 0 }] },
    { key: 'b1', title: 'בניית גרסה ראשונה', stage: 1, offset: 5, dur: 5, assignee: 'Claude', manualFinish: true, deps: [{ from: 'a3', type: 'FS', lag: 0 }] },
    { key: 'b2', title: 'בדיקה והערות', stage: 1, offset: 10, dur: 2, assignee: 'אני', deps: [{ from: 'b1', type: 'FS', lag: 0 }] },
    { key: 'b3', title: 'תיקונים', stage: 1, offset: 12, dur: 3, assignee: 'Claude', deps: [{ from: 'b2', type: 'FS', lag: 0 }] },
    { key: 'c1', title: 'בדיקה מלאה במכשיר', stage: 2, offset: 15, dur: 2, assignee: 'אני', deps: [{ from: 'b3', type: 'FS', lag: 0 }] },
    { key: 'c2', title: 'תיקוני באגים', stage: 2, offset: 17, dur: 2, assignee: 'Claude', deps: [{ from: 'c1', type: 'FS', lag: 0 }] },
    { key: 'd1', title: 'פרסום / העלאה', stage: 3, offset: 19, dur: 1, assignee: 'אני', deps: [{ from: 'c2', type: 'FS', lag: 0 }] },
    { key: 'd2', title: 'השקה', stage: 3, offset: 20, dur: 1, milestone: true, deps: [{ from: 'd1', type: 'FS', lag: 0 }] },
  ],
});
function ensureBuiltinTemplate() {
  data.templates = data.templates || [];
  if (!data.builtinRemoved && !data.templates.some((x) => x.id === 'tpl-claude')) data.templates.push(BUILTIN_TPL());
}

/** A project → a template: lengths and gaps between tasks, counted from its first day. */
function saveTemplateDialog(p) {
  showDialog(`
    <h3>📋 שמירה כתבנית</h3>
    <label>שם התבנית<input type="text" name="tname" value="${esc(p.name)}" required></label>
    <p class="note">נשמרים השלבים, המשימות עם המשכים והמרווחים ביניהן, התלויות, הצעדים, המשאבים (בלי עלות בפועל), האחראים ואבני הדרך. התאריכים לא נשמרים.</p>
    <div class="actions"><button value="save" class="primary">שמור תבנית</button><span class="grow"></span><button value="cancel" class="ghost" formnovalidate>ביטול</button></div>`, (action, fd) => {
    const ts = data.tasks.filter((t) => t.projectId === p.id && t.scheduled && !t.deleted);
    const base = ts.length ? Math.min(...ts.map((t) => dayNum(t.start))) : dayNum(todayIso());
    const stageIdx = new Map(p.stages.map((x, i) => [x.id, i]));
    const tpl = {
      id: uid(), name: fd.get('tname').trim() || p.name, color: p.color, stages: p.stages.map((x) => x.name),
      tasks: ts.map((t) => ({
        key: t.id, title: t.title, stage: stageIdx.get(t.stageId) ?? 0,
        offset: dayNum(t.start) - base, dur: dayNum(t.end) - dayNum(t.start) + 1,
        milestone: !!t.milestone, manualFinish: !!t.manualFinish, assignee: t.assignee || null,
        desc: t.desc || '', priority: t.priority || 'normal', tags: t.tags || [],
        steps: (t.steps || []).map((x) => ({ text: x.text })),
        resources: (t.resources || []).map(({ name, kind, qty, unit, costPlan, phone }) => ({ name, kind, qty, unit, costPlan, phone })),
        deps: (t.deps || []).filter((d) => ts.some((o) => o.id === d.from)),
      })),
    };
    data.templates = (data.templates || []).filter((x) => x.name !== tpl.name).concat(tpl);
    commit();
    setStatus(`התבנית "${tpl.name}" נשמרה`);
  });
}

/** A new project from a template, starting on [start]. */
function projectFromTemplate(tpl, name, start, color) {
  const p = newProject(name, color || tpl.color);
  p.stages = tpl.stages.map((n) => ({ id: uid(), name: n }));
  const ids = new Map(tpl.tasks.map((x) => [x.key, uid()]));
  const s0 = dayNum(start);
  for (const x of tpl.tasks) {
    const a = s0 + (x.offset || 0);
    data.tasks.push({
      id: ids.get(x.key), title: x.title, projectId: p.id, stageId: (p.stages[x.stage] || p.stages[0]).id,
      scheduled: true, start: isoOf(a), end: isoOf(x.milestone ? a : a + Math.max(1, x.dur || 1) - 1), progress: 0,
      milestone: !!x.milestone, manualFinish: !!x.manualFinish, assignee: x.assignee || null,
      desc: x.desc || '', priority: x.priority || 'normal', tags: x.tags || [],
      steps: (x.steps || []).map((y) => ({ id: uid(), text: y.text, done: false })),
      resources: (x.resources || []).map((r) => Object.assign({ id: uid() }, r)),
      deps: (x.deps || []).filter((d) => ids.has(d.from)).map((d) => ({ from: ids.get(d.from), type: d.type || 'FS', lag: d.lag || 0 })),
      gDirty: true,
    });
  }
  ui.view = 'project'; saveUi();
  renderBoard.first = true;
  commit();
}

// ---------------------------------------------------------------- 🗓️ weekly summary
const weekKey = () => { const n = dayNum(todayIso()); return n - weekday(n); }; // the Sunday of this week

function weeklyData(projectIds) {
  const today = dayNum(todayIso());
  const inScope = data.tasks.filter((t) => !t.deleted && t.scheduled && projectIds.includes(t.projectId));
  const pname = (t) => (projectIds.length > 1 ? ` (${project(t.projectId).name})` : '');
  return {
    done: inScope.filter((t) => t.done && t.doneOn && dayNum(t.doneOn) > today - 7).map((t) => `${t.title}${pname(t)}`),
    late: inScope.filter((t) => !t.done && !project(t.projectId).frozen && (effEnd(t) < today || (t.manualFinish && effEnd(t) > dayNum(t.end)) || ['blocked', 'waiting'].includes(t.status)))
      .map((t) => `${t.status === 'blocked' ? '⛔ ' : t.status === 'waiting' ? '⏸ ' : ''}${t.title}${pname(t)} – ${effEnd(t) < today || effEnd(t) > dayNum(t.end) ? `היה אמור להסתיים ב-${short(t.end)}` : (t.statusWhy || STATUS[t.status])}`),
    starting: inScope.filter((t) => !t.done && !t.milestone && dayNum(t.start) >= today && dayNum(t.start) < today + 7)
      .sort((a, b) => (a.start < b.start ? -1 : 1)).map((t) => `${short(t.start)} · ${t.title}${pname(t)}${t.assignee ? ` · ${t.assignee}` : ''}`),
    milestones: inScope.filter((t) => t.milestone && !t.done && dayNum(t.start) >= today && dayNum(t.start) < today + 14)
      .sort((a, b) => (a.start < b.start ? -1 : 1)).map((t) => `${short(t.start)} · ◆ ${t.title}${pname(t)}`),
    frozen: data.projects.filter((p) => projectIds.includes(p.id) && p.frozen).map((p) => `❄️ ${p.name} מוקפא מ-${short(p.frozen.since)}`),
  };
}

function weeklyText(w, title) {
  const part = (head, items) => (items.length ? `${head}\n${items.map((x) => `• ${x}`).join('\n')}\n` : '');
  return [`🗓️ ${title}`, '',
    part('✅ הושלם השבוע:', w.done), part('⚠️ מתעכב:', w.late), part('▶️ מתחיל השבוע:', w.starting),
    part('◆ אבני דרך בשבועיים הקרובים:', w.milestones), part('', w.frozen)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function openWeekly(auto) {
  if (!data.projects.length) return;
  let scope = ui.view === 'all' ? 'all' : 'project';
  const ids = () => (scope === 'all' ? data.projects.map((p) => p.id) : [current().id]);
  const sec = (head, items, empty) => `<div class="wk"><h4>${head}</h4>${items.length ? `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="note">${empty}</p>`}</div>`;
  const body = () => {
    const w = weeklyData(ids());
    return sec('✅ מה הושלם בשבוע האחרון', w.done, 'שום דבר עוד לא סומן כבוצע השבוע.')
      + sec('⚠️ מה מתעכב', w.late, 'אין עיכובים. 👍')
      + sec('▶️ מה מתחיל השבוע', w.starting, 'אין משימות שמתחילות השבוע.')
      + sec('◆ אבני דרך בשבועיים הקרובים', w.milestones, 'אין אבני דרך קרובות.')
      + (w.frozen.length ? sec('❄️ מוקפאים', w.frozen, '') : '');
  };
  const title = () => `סיכום שבועי · ${scope === 'all' ? 'כל הפרויקטים' : current().name} · ${short(todayIso())}`;
  showDialog(`
    <h3>🗓️ סיכום שבועי</h3>
    ${data.projects.length > 1 ? `<div class="zoom wk-scope"><button type="button" data-scope="project" class="${scope === 'project' ? 'on' : ''}">${esc(current().name)}</button><button type="button" data-scope="all" class="${scope === 'all' ? 'on' : ''}">כל הפרויקטים</button></div>` : ''}
    <div id="wkBody" class="wk-body">${body()}</div>
    <label class="check"><input type="checkbox" id="wkAuto" ${ui.weeklyAuto !== false ? 'checked' : ''}> לפתוח את הסיכום לבד בכניסה הראשונה בכל שבוע</label>
    <div class="actions">
      <button type="button" class="primary" id="wkWa">שלח בוואטסאפ</button>
      <button type="button" class="ghost" id="wkCopy">העתק</button>
      <span class="grow"></span><button value="cancel" class="ghost" formnovalidate>סגור</button>
    </div>`, () => {}, (f) => {
    f.querySelectorAll('[data-scope]').forEach((b) => b.onclick = () => {
      scope = b.dataset.scope;
      f.querySelectorAll('[data-scope]').forEach((x) => x.classList.toggle('on', x === b));
      f.querySelector('#wkBody').innerHTML = body();
    });
    f.querySelector('#wkAuto').onchange = (e) => { ui.weeklyAuto = e.target.checked; saveUi(); };
    f.querySelector('#wkCopy').onclick = () => copyText(weeklyText(weeklyData(ids()), title()), 'הסיכום הועתק');
    f.querySelector('#wkWa').onclick = () => window.open(`https://wa.me/?text=${encodeURIComponent(weeklyText(weeklyData(ids()), title()))}`, '_blank');
  });
  if (auto) { ui.weeklySeen = weekKey(); saveUi(); }
}

// ---------------------------------------------------------------- 📄 export to PDF (print)
const PAPER = { a4: { w: 277, h: 190 }, a3: { w: 410, h: 277 } }; // printable area in mm

function openExportDialog() {
  const cur = current();
  if (!cur) return;
  showDialog(`
    <h3>📄 ייצוא ל-PDF</h3>
    ${data.projects.length > 1 ? `<label>מה לייצא<select name="what"><option value="project" ${ui.view !== 'all' ? 'selected' : ''}>${esc(cur.name)}</option><option value="all" ${ui.view === 'all' ? 'selected' : ''}>כל הפרויקטים</option></select></label>` : ''}
    <label>גודל<select name="size">
      <option value="a4">דף A4 אחד (לרוחב)</option>
      <option value="a3">שני דפי A4 שמתחברים לגודל A3</option>
    </select></label>
    <p class="note" id="sizeNote"></p>
    <label class="check"><input type="checkbox" name="table" checked> לכלול טבלת משימות (בדפים נוספים)</label>
    <p class="note">בחלון ההדפסה בחר <b>"שמירה כ-PDF"</b> כדי לקבל קובץ, או מדפסת כדי להדפיס.</p>
    <div class="actions"><button value="print" class="primary">הכן להדפסה</button><span class="grow"></span><button value="cancel" class="ghost" formnovalidate>ביטול</button></div>`, (action, fd) => {
    const what = fd.get('what') || 'project';
    const projects = what === 'all' ? data.projects : [cur];
    setTimeout(() => printChart(projects, what === 'all', fd.get('size'), fd.get('table') === 'on'), 50);
  }, (f) => {
    const say = () => { f.querySelector('#sizeNote').textContent = f.size.value === 'a3' ? 'הגאנט מודפס בגודל A3 ומחולק לשני דפי A4 לעומד. מדביקים אותם זה לצד זה לפי הסימון בשוליים: דף 1 משמאל, דף 2 מימין.' : 'כל הגאנט נכנס לדף אחד.'; };
    f.size.onchange = say; say();
  });
}

/** Builds the chart as SVG pages (mm units) for the paper size, splitting rows over pages when needed. */
function chartSvgPages(projects, allMode, paper) {
  const W = paper.w, H = paper.h, today = dayNum(todayIso());
  const rows = [];
  for (const p of projects) {
    const ts = data.tasks.filter((t) => t.projectId === p.id && t.scheduled && !t.deleted);
    if (allMode) {
      const st = projectStats(p);
      rows.push({ kind: 'proj', p, st });
      continue;
    }
    for (const sg of p.stages) {
      const items = ts.filter((t) => (t.stageId || p.stages[0].id) === sg.id).sort((a, b) => (a.start < b.start ? -1 : 1));
      if (!items.length) continue;
      rows.push({ kind: 'stage', p, name: sg.name, items });
      items.forEach((t) => rows.push({ kind: 'task', p, t }));
    }
  }
  const all = data.tasks.filter((t) => t.scheduled && !t.deleted && projects.some((p) => p.id === t.projectId));
  let a = Math.min(today, ...all.map((t) => dayNum(t.start))) - 2;
  let b = Math.max(today, ...all.map(effEnd), ...projects.filter((p) => p.target).map((p) => dayNum(p.target))) + 3;
  if (!all.length) { a = today - 3; b = today + 30; }
  const days = b - a + 1;
  const titleH = 14, scaleH = 9, labelW = allMode ? 60 : 55;
  const dw = (W - labelW) / days;
  const avail = H - titleH - scaleH;
  const rowH = Math.max(4.2, Math.min(8, avail / Math.max(1, rows.length)));
  const perPage = Math.max(1, Math.floor(avail / rowH));
  const x = (n) => labelW + (n - a) * dw;
  const fs = Math.min(3.2, rowH * 0.42);

  // Scale (months on top; days, weeks or months below, by space)
  let scale = '';
  for (let n = a; n <= b; n++) {
    const d = new Date(n * 864e5);
    const firstShort = n === a && new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) / 864e5 - n < 10; // no room before the next month's name
    if ((n === a && !firstShort) || d.getUTCDate() === 1) {
      scale += `<line x1="${x(n)}" y1="${titleH}" x2="${x(n)}" y2="${titleH + scaleH}" class="gl"/><text x="${x(n) + 1}" y="${titleH + 3.6}" class="sc b">${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}</text>`;
    }
    if (dw >= 3.2) scale += `<text x="${x(n) + dw / 2}" y="${titleH + 7.8}" class="sc" text-anchor="middle">${d.getUTCDate()}</text>`;
    else if (dw >= 0.9 && weekday(n) === 0) scale += `<text x="${x(n) + 0.5}" y="${titleH + 7.8}" class="sc">${short(isoOf(n))}</text>`;
  }
  const grid = (y0, y1) => {
    let g = '';
    for (let n = a; n <= b; n++) {
      const d = new Date(n * 864e5);
      if ((dw >= 3.2) || (dw >= 0.9 && weekday(n) === 0) || d.getUTCDate() === 1) g += `<line x1="${x(n)}" y1="${y0}" x2="${x(n)}" y2="${y1}" class="${d.getUTCDate() === 1 ? 'gm' : 'gl'}"/>`;
    }
    return g;
  };

  const pages = [];
  for (let i = 0; i < rows.length || (i === 0 && !rows.length); i += perPage) {
    const chunk = rows.slice(i, i + perPage);
    const y0 = titleH + scaleH;
    let body = '';
    const pos = {};
    chunk.forEach((r, k) => {
      const y = y0 + k * rowH, cy = y + rowH / 2;
      if (r.kind === 'stage') {
        body += `<rect x="0" y="${y}" width="${W}" height="${rowH}" class="stg"/><text x="${labelW - 2}" y="${cy + fs * 0.35}" class="lb b" text-anchor="end">${esc(r.name)}</text>`;
        return;
      }
      if (r.kind === 'proj') {
        const st = r.st;
        body += `<text x="${labelW - 2}" y="${cy + fs * 0.35}" class="lb b" text-anchor="end">${esc(r.p.name)} · ${st.pct}%${st.late ? ' ⚠' : ''}${r.p.frozen ? ' ❄' : ''}</text>`;
        if (st.count) {
          const bx = x(st.start), bw = (st.end - st.start + 1) * dw, bh = rowH * 0.62;
          body += `<rect x="${bx}" y="${cy - bh / 2}" width="${bw}" height="${bh}" rx="1.2" fill="${r.p.color}" opacity=".4"/><rect x="${bx}" y="${cy - bh / 2}" width="${bw * st.pct / 100}" height="${bh}" rx="1.2" fill="${r.p.color}"/>`;
          st.tasks.filter((t) => t.milestone).forEach((m) => { const mx = x(dayNum(m.start)) + dw / 2, s2 = bh * 0.5; body += `<path d="M${mx} ${cy - s2} L${mx + s2} ${cy} L${mx} ${cy + s2} L${mx - s2} ${cy} Z" fill="#fff" stroke="${r.p.color}" stroke-width=".4"/>`; });
        }
        if (r.p.target) body += `<line x1="${x(dayNum(r.p.target) + 1)}" y1="${y + 0.5}" x2="${x(dayNum(r.p.target) + 1)}" y2="${y + rowH - 0.5}" class="tg"/>`;
        return;
      }
      const t = r.t, s = dayNum(t.start), e = effEnd(t);
      const name = `${t.milestone ? '◆ ' : ''}${t.title}${t.assignee ? ` · ${t.assignee}` : ''}`;
      body += `<text x="${labelW - 2}" y="${cy + fs * 0.35}" class="lb" text-anchor="end">${esc(name.length > 34 ? name.slice(0, 33) + '…' : name)}</text>`;
      if (t.milestone) {
        const mx = x(s) + dw / 2, s2 = rowH * 0.32;
        body += `<path d="M${mx} ${cy - s2} L${mx + s2} ${cy} L${mx} ${cy + s2} L${mx - s2} ${cy} Z" fill="${r.p.color}"/>`;
        pos[t.id] = { l: mx - s2, r: mx + s2, y: cy };
      } else {
        const bx = x(s), bw = (e - s + 1) * dw, bh = rowH * 0.62, pct = t.done ? 100 : t.progress || 0;
        body += `<rect x="${bx}" y="${cy - bh / 2}" width="${bw}" height="${bh}" rx="1" fill="${r.p.color}" opacity=".4"/>`
          + `<rect x="${bx}" y="${cy - bh / 2}" width="${bw * pct / 100}" height="${bh}" rx="1" fill="${r.p.color}"/>`;
        if (e > dayNum(t.end)) body += `<rect x="${x(dayNum(t.end) + 1)}" y="${cy - bh / 2}" width="${(e - dayNum(t.end)) * dw}" height="${bh}" fill="url(#hatch)"/>`;
        const label = `${pct}%${t.status === 'blocked' && !t.done ? ' ⛔' : ''}`;
        body += `<text x="${bx + bw + 0.8}" y="${cy + fs * 0.33}" class="bt">${label}</text>`;
        pos[t.id] = { l: bx, r: bx + bw, y: cy };
      }
    });
    // dependency arrows between rows on this page
    let arrows = '';
    chunk.filter((r) => r.kind === 'task').forEach((r) => (r.t.deps || []).forEach((d) => {
      const A = pos[d.from], B = pos[r.t.id];
      if (!A || !B) return;
      const type = d.type || 'FS';
      const x1 = type === 'SS' ? A.l : A.r, x2 = type === 'FF' ? B.r : B.l;
      const xm = type === 'SS' ? Math.min(x1, x2) - 1.5 : Math.max(x1 + 1.5, type === 'FF' ? Math.max(x1, x2) + 1.5 : x1 + 1.5);
      arrows += `<path d="M${x1} ${A.y} H${xm} V${B.y} H${x2}" class="ar" marker-end="url(#pah)"/>`;
    }));
    const lines = `<line x1="${x(today) + dw / 2}" y1="${titleH}" x2="${x(today) + dw / 2}" y2="${H}" class="td"/>`
      + (!allMode && projects[0].target ? `<line x1="${x(dayNum(projects[0].target) + 1)}" y1="${titleH}" x2="${x(dayNum(projects[0].target) + 1)}" y2="${H}" class="tg"/>` : '');
    let title;
    if (allMode) title = `כל הפרויקטים · ${projects.length} פרויקטים`;
    else {
      const p = projects[0], st = projectStats(p), c = costs(data.tasks.filter((t) => t.projectId === p.id && !t.deleted));
      title = `${p.name}${p.frozen ? ' (מוקפא)' : ''} · ${st.pct}%${st.count ? ` · סיום צפוי ${short(isoOf(st.end))}` : ''}${p.target ? ` · יעד ${short(p.target)}${st.late ? ' ⚠' : ''}` : ''}${c.plan || c.act ? ` · עלות ${money(c.act)} מתוך ${money(c.plan)}` : ''}`;
    }
    const pageNo = rows.length > perPage ? ` · עמוד ${Math.floor(i / perPage) + 1}/${Math.ceil(rows.length / perPage)}` : '';
    pages.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm" class="pchart">
      <defs><pattern id="hatch" width="1.6" height="1.6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width=".7" height="1.6" fill="#999"/></pattern>
      <marker id="pah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L8 4L0 8z" fill="#777"/></marker></defs>
      <text x="${W}" y="6" class="tt" text-anchor="end">${esc(title)}</text>
      <text x="${W}" y="11" class="sc" text-anchor="end">Ganty · הודפס ב-${short(todayIso())}${pageNo}</text>
      ${scale}<line x1="0" y1="${titleH + scaleH}" x2="${W}" y2="${titleH + scaleH}" class="gm"/>
      ${grid(titleH + scaleH, H)}${body}${arrows}${lines}
      <line x1="${labelW}" y1="${titleH}" x2="${labelW}" y2="${H}" class="gm"/>
    </svg>`);
    if (!rows.length) break;
  }
  return pages;
}

function printChart(projects, allMode, size, withTable) {
  const area = $('#printArea');
  const svgs = chartSvgPages(projects, allMode, PAPER[size]);
  let html = '';
  if (size === 'a3') {
    // One A3 chart, cut in two A4 (portrait) halves with join marks.
    svgs.forEach((svg, i) => {
      for (const half of [0, 1]) {
        const vb = `${half * 205} 0 205 277`;
        html += `<div class="pp pp-a4p"><div class="half-tag">${half ? 'דף 2 · מדביקים מימין לדף 1' : 'דף 1 · משמאל'}${svgs.length > 1 ? ` · חלק ${i + 1}` : ''}</div>
          ${svg.replace(/viewBox="[^"]+" width="[^"]+" height="[^"]+"/, `viewBox="${vb}" width="205mm" height="270mm" preserveAspectRatio="xMidYMin meet"`)}
          <div class="join ${half ? 'join-l' : 'join-r'}"></div></div>`;
      }
    });
  } else {
    svgs.forEach((svg) => { html += `<div class="pp pp-a4l">${svg}</div>`; });
  }
  if (withTable) {
    const rows = [];
    for (const p of projects) {
      data.tasks.filter((t) => t.projectId === p.id && t.scheduled && !t.deleted)
        .sort((a, b) => (a.start < b.start ? -1 : 1))
        .forEach((t) => rows.push(`<tr>${allMode ? `<td>${esc(p.name)}</td>` : ''}<td>${t.milestone ? '◆ ' : ''}${esc(t.title)}</td><td>${esc((p.stages.find((x) => x.id === t.stageId) || {}).name || '')}</td>
          <td>${short(t.start)}</td><td>${short(isoOf(effEnd(t)))}</td><td>${t.done ? 100 : t.progress || 0}%</td><td>${esc(t.assignee || '')}</td>
          <td>${t.done ? 'בוצע' : esc(STATUS[t.status || 'todo'])}${t.statusWhy ? ` – ${esc(t.statusWhy)}` : ''}</td></tr>`));
    }
    html += `<div class="pp ${size === 'a3' ? 'pp-a4p' : 'pp-a4l'} ptable"><h2>${allMode ? 'כל הפרויקטים' : esc(projects[0].name)} · טבלת משימות</h2>
      <table><thead><tr>${allMode ? '<th>פרויקט</th>' : ''}<th>משימה</th><th>שלב</th><th>התחלה</th><th>סיום</th><th>%</th><th>אחראי</th><th>סטטוס</th></tr></thead>
      <tbody>${rows.join('') || '<tr><td colspan="8">אין משימות בלוח.</td></tr>'}</tbody></table></div>`;
  }
  area.innerHTML = html;
  $('#pageSize').textContent = `@page { size: A4 ${size === 'a3' ? 'portrait' : 'landscape'}; margin: ${size === 'a3' ? '10mm 2.5mm' : '10mm'}; }`;
  window.print();
}

// ---------------------------------------------------------------- start
window.addEventListener('resize', () => renderBoard());
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
ensureBuiltinTemplate();
// Late "manual finish" tasks grow day by day: check the rules on every start.
if (applyConstraints()) commit(); else render();
// The weekly summary opens by itself the first time Ganty is opened each week.
if (ui.weeklyAuto !== false && ui.weeklySeen !== weekKey() && data.tasks.some((t) => t.scheduled && !t.deleted)) setTimeout(() => { if (!dlg.open) openWeekly(true); }, 600);
initGoogle();
