'use strict';
/*
 * Ganty — a light Gantt board.
 * Data lives in this browser (for speed) and in a "Ganty" folder in Google Drive.
 * Tasks of the Google Tasks list "משימות לגנט" (filled by Tasky) arrive in the task pool.
 */

const CFG = window.GANTY_CONFIG || {};
const SCOPES = 'https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/drive.file';
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
  data.updatedAt = Date.now();
  data.dirty = true;
  localStorage.setItem(LS_DATA, JSON.stringify(data));
  render();
  scheduleSync();
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
  sel.innerHTML = (cur ? '' : '<option value="" selected disabled>אין פרויקטים</option>') + data.projects.map((p) => `<option value="${p.id}" ${cur && p.id === cur.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')
    + `<option value="__new">＋ פרויקט חדש</option>`;
  $('#projectMenuBtn').disabled = !cur;
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
function range(tasks) {
  const t0 = dayNum(todayIso());
  let a = t0 - 14, b = t0 + 75;
  for (const t of tasks) {
    if (t.start) a = Math.min(a, dayNum(t.start) - 10);
    if (t.end) b = Math.max(b, dayNum(t.end) + 30);
  }
  a -= weekday(a); // start on a Sunday
  return { a, b, days: b - a + 1 };
}

let R = { a: 0, b: 0, days: 0 }; // current range
const labelWidth = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--label-w')) || 220;

function renderBoard() {
  const g = $('#gantt');
  const cur = current();
  const keepLeft = g.scrollLeft, keepTop = g.scrollTop;
  const hint = $('#emptyHint');
  if (!cur) {
    g.innerHTML = '';
    hint.hidden = false;
    hint.innerHTML = 'אין עדיין פרויקטים.<br><button type="button" class="primary" id="firstProject">＋ צור פרויקט ראשון</button>';
    $('#firstProject').onclick = () => openProjectDialog(null);
    return;
  }
  const tasks = data.tasks.filter((t) => t.scheduled && !t.deleted && t.projectId === cur.id);
  R = range(tasks);
  const dw = ui.dw, W = R.days * dw;
  const today = dayNum(todayIso());

  // Scale: two rows that change with the zoom.
  const top = [], bot = [];
  const mode = dw >= 28 ? 'day' : dw >= 9 ? 'week' : 'month';
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
  function cell(cls, n, text, len) {
    const left = (n - R.a) * dw;
    const width = len ? len * dw : 'auto';
    return `<div class="cell ${cls}" style="left:${left}px;${len ? `width:${width}px` : ''}">${esc(text)}</div>`;
  }

  // Grid lines: one per day (or week / month when zoomed out).
  const step = mode === 'day' ? dw : mode === 'week' ? dw * 7 : dw * 30.44;
  const grid = `background-image: repeating-linear-gradient(to right, var(--line-soft) 0 1px, transparent 1px ${step}px);`;

  // Rows: a stage row, then its tasks (sorted by start).
  const rows = [];
  for (const st of cur.stages) {
    const items = tasks.filter((t) => (t.stageId || cur.stages[0].id) === st.id).sort((x, y) => (x.start < y.start ? -1 : 1));
    const collapsed = !!ui.collapsed[st.id];
    let span = '';
    if (items.length) {
      const s = Math.min(...items.map((t) => dayNum(t.start))), e = Math.max(...items.map((t) => dayNum(t.end)));
      span = `<div class="stage-span" style="left:${(s - R.a) * dw}px;width:${(e - s + 1) * dw}px;background:${cur.color}"></div>`;
    }
    rows.push(`<div class="g-row stage" data-stage="${st.id}">
      <div class="g-label" data-stage-toggle="${st.id}">${collapsed ? '◂' : '▾'} ${esc(st.name)} <span class="count">(${items.length})</span></div>
      <div class="g-track" style="width:${W}px;${grid}">${span}</div></div>`);
    if (collapsed) continue;
    for (const t of items) {
      const left = (dayNum(t.start) - R.a) * dw, width = (dayNum(t.end) - dayNum(t.start) + 1) * dw;
      const pct = t.done ? 100 : (t.progress || 0);
      rows.push(`<div class="g-row" data-stage="${st.id}" data-task="${t.id}">
        <div class="g-label"><span class="name" data-open="${t.id}">${esc(t.title || '(ללא כותרת)')}</span></div>
        <div class="g-track" style="width:${W}px;${grid}">
          <div class="bar ${t.done ? 'done' : ''}" data-bar="${t.id}" style="left:${left}px;width:${width}px;--c:${cur.color}" title="${esc(t.title)} · ${short(t.start)}–${short(t.end)} · ${pct}%">
            <div class="fill" style="width:${pct}%"></div>
            <div class="txt">${esc(t.title)}${width > 90 ? ` · ${pct}%` : ''}</div>
            <div class="h l" data-edge="l"></div><div class="h r" data-edge="r"></div>
          </div></div></div>`);
    }
  }
  // Spare rows, so there is always room to drop.
  for (let i = 0; i < 3; i++) {
    rows.push(`<div class="g-row" data-stage="${cur.stages[cur.stages.length - 1].id}"><div class="g-label"></div><div class="g-track" style="width:${W}px;${grid}"></div></div>`);
  }

  g.innerHTML = `<div class="g-inner" style="width:${labelWidth() + W}px">
    <div class="g-head"><div class="g-corner">${esc(cur.name)}</div><div class="g-scale" style="width:${W}px">${top.join('')}${bot.join('')}</div></div>
    <div class="g-body">${rows.join('')}</div>
    <div class="g-today" style="left:${labelWidth() + (today - R.a) * dw + dw / 2}px"></div>
  </div>`;

  hint.hidden = tasks.length > 0;
  hint.innerHTML = 'הלוח ריק.<br>גרור לכאן משימה מהמאגר, או לחץ על משימה במאגר ובחר "שבץ בלוח".';

  if (renderBoard.first !== false) {
    renderBoard.first = false;
    scrollToToday();
  } else {
    g.scrollLeft = keepLeft;
    g.scrollTop = keepTop;
  }
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
  const barEl = e.target.closest('.bar');
  if (!barEl) return;
  const t = task(barEl.dataset.bar);
  if (!t) return;
  const rect = barEl.getBoundingClientRect();
  const edgeZone = e.pointerType === 'touch' ? 18 : 8;
  let mode = 'move';
  if (e.clientX - rect.left < edgeZone) mode = 'l';
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
  const d = Math.round(dx / ui.dw);
  if (Math.abs(dx) > 3) drag.moved = true;
  let s = dayNum(drag.start), en = dayNum(drag.end);
  if (drag.mode === 'move') { s += d; en += d; }
  if (drag.mode === 'l') s = Math.min(s + d, en);
  if (drag.mode === 'r') en = Math.max(en + d, s);
  drag.newStart = isoOf(s); drag.newEnd = isoOf(en);
  drag.el.classList.add('dragging');
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
  d.el.classList.remove('armed', 'dragging');
  const t = task(d.id);
  if (!t) return;
  if (!d.moved) return openTaskEditor(t);
  t.start = d.newStart; t.end = d.newEnd;
  if (d.mode === 'move') {
    const st = stageAtPoint(e.clientX, e.clientY);
    if (st && current().stages.some((s) => s.id === st)) t.stageId = st;
  }
  markGoogle(t);
  commit();
});
window.addEventListener('pointercancel', () => { if (drag) { clearTimeout(drag.timer); if (drag.ghost) drag.ghost.remove(); drag = null; render(); } });

// Clicks: task names open the editor, stage rows fold.
$('#gantt').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) return openTaskEditor(task(open.dataset.open));
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
  const cur = current() || newProject('פרויקט חדש');
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

/** A bar was tapped: edit its details. */
function openTaskEditor(t) {
  if (!t) return;
  const p = project(t.projectId) || current();
  showDialog(`
    <h3>עריכת משימה</h3>
    <label>כותרת<input type="text" name="title" value="${esc(t.title)}" required></label>
    <label>שלב<select name="stage">${stageOptions(p, t.stageId)}</select></label>
    <div class="row2">
      <label>התחלה<input type="date" name="start" value="${t.start}" required></label>
      <label>סיום<input type="date" name="end" value="${t.end}" required></label>
    </div>
    <label>התקדמות: <output id="pv">${t.progress || 0}%</output>
      <input type="range" name="progress" min="0" max="100" step="5" value="${t.progress || 0}"></label>
    <label class="check"><input type="checkbox" name="done" ${t.done ? 'checked' : ''}> בוצע</label>
    ${t.gid ? '<p class="note">מקושרת ל-Tasky: הכותרת, תאריך הסיום ו"בוצע" מתעדכנים גם שם.</p>' : ''}
    <div class="actions">
      <button value="save" class="primary">שמור</button>
      <button value="unschedule" class="ghost" formnovalidate>החזר למאגר</button>
      <span class="grow"></span>
      <button value="delete" class="danger" formnovalidate>מחק</button>
      <button value="cancel" class="ghost" formnovalidate>ביטול</button>
    </div>`, (action, fd) => {
    if (action === 'delete') {
      if (!confirm('למחוק את המשימה? אם היא מקושרת, היא תימחק גם מ-Tasky.')) return false;
      t.deleted = true; markGoogle(t); return commit();
    }
    if (action === 'unschedule') { t.scheduled = false; return commit(); }
    const start = fd.get('start'), end = fd.get('end');
    t.title = fd.get('title').trim();
    t.stageId = fd.get('stage');
    t.start = start; t.end = end < start ? start : end;
    t.progress = Number(fd.get('progress'));
    t.done = fd.get('done') === 'on';
    if (t.done) t.progress = 100;
    markGoogle(t);
    commit();
  }, (f) => { f.progress.oninput = () => { f.querySelector('#pv').textContent = `${f.progress.value}%`; }; });
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
    <label>שם<input type="text" name="name" value="${esc(draft.name)}" required placeholder="למשל: אתר לעסק"></label>
    <label>צבע<div class="swatches">${COLORS.map((c) => `<button type="button" class="swatch ${c === draft.color ? 'on' : ''}" data-color="${c}" style="background:${c}" aria-label="צבע"></button>`).join('')}</div></label>
    <label>שלבים<div class="stages-edit" id="stagesEdit">${stagesHtml()}</div></label>
    <button type="button" class="ghost small" id="addStage">＋ שלב</button>
    <div class="actions">
      <button value="save" class="primary">${isNew ? 'צור' : 'שמור'}</button>
      <span class="grow"></span>
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
    readStages();
    draft.name = fd.get('name').trim() || 'פרויקט';
    draft.stages = draft.stages.filter((s) => s.name.trim());
    if (!draft.stages.length) draft.stages = [{ id: uid(), name: 'כללי' }];
    if (isNew) {
      const np = newProject(draft.name, draft.color);
      np.stages = draft.stages;
    } else {
      const renamed = p.name !== draft.name;
      Object.assign(p, draft);
      const ids = new Set(p.stages.map((s) => s.id));
      data.tasks.forEach((t) => {
        if (t.projectId !== p.id) return;
        if (!ids.has(t.stageId)) t.stageId = p.stages[0].id;
        if (renamed) { t.projectChanged = true; markGoogle(t); }
      });
    }
    commit();
  }, (f) => {
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
  ui.projectId = e.target.value; saveUi(); renderBoard.first = true; render();
};
$('#projectMenuBtn').onclick = () => current() && openProjectDialog(current());
document.querySelectorAll('.zoom button').forEach((b) => b.onclick = () => setZoom(ZOOM[b.dataset.zoom]));
$('#todayBtn').onclick = scrollToToday;
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

function showBanner(text) { const b = $('#banner'); b.textContent = text; b.hidden = !text; }

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
    if (done && !t.done) t.progress = 100;
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
    const before = JSON.stringify(data.tasks);
    await syncTasks();
    if (JSON.stringify(data.tasks) !== before) { data.updatedAt = Date.now(); data.dirty = true; }
    if (data.dirty) await syncDrive();
    localStorage.setItem(LS_DATA, JSON.stringify(data));
    setStatus(`נשמר ב-Drive ✓ ${new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`);
    showBanner('');
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

// ---------------------------------------------------------------- start
window.addEventListener('resize', () => renderBoard());
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
render();
initGoogle();
