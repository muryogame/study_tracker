'use strict';

// ── デバイスID（ログイン不要・初回アクセス時に自動生成） ─────
// このIDをサーバーに送ることでデバイスごとに独立した記録を保持する
const token = (() => {
  let id = localStorage.getItem('sf_device_id');
  if (!id) {
    id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    localStorage.setItem('sf_device_id', id);
  }
  return id;
})();

// ── App state ─────────────────────────────────────────────────
let activeSession  = null;
let timerInterval  = null;
let calYear, calMonth;
let calData        = {};
let calDayCache    = {};
let historyOffset  = 0;
let historyTotal   = 0;
let dowChart       = null;
let dailyChart     = null;
let currentPage    = 'home';
let chartsRendered = false;
let _serverReady   = false;
let _isWarming     = false;

async function preWarmServer() {
  if (_isWarming) return;
  _isWarming = true;
  _serverReady = false;

  // サーバー起動中をUIに表示（セッション中でなければ）
  const statusEl = document.getElementById('touch-status');
  if (statusEl && !activeSession) statusEl.textContent = 'サーバー起動中…';

  while (!_serverReady) {
    try {
      const ac = new AbortController();
      const tid = setTimeout(() => ac.abort(), 8000);
      const res = await fetch(`/api/ping?t=${Date.now()}`, {
        signal: ac.signal, cache: 'no-store',
      });
      clearTimeout(tid);
      if (res.ok) {
        const d = await res.json();
        if (d.ok) {
          _serverReady = true;
          _isWarming = false;
          loadAll(); // サーバー準備完了→データ再取得
          return;
        }
      }
    } catch {}
    if (!_serverReady) await new Promise(r => setTimeout(r, 3000));
  }
  _isWarming = false;
}
preWarmServer();

document.addEventListener('DOMContentLoaded', () => {
  const now = new Date();
  calYear   = now.getFullYear();
  calMonth  = now.getMonth() + 1;
  updateHeaderDate();
  setInterval(updateHeaderDate, 60_000);
  loadAll();
  loadMonetization();
});

function updateHeaderDate() {
  const opts = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' };
  document.getElementById('header-date').textContent =
    new Date().toLocaleDateString('ja-JP', opts);
}

/* ══════════════════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════════════════ */
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`page-${name}`).classList.remove('hidden');
  document.querySelector(`.nav-btn[data-page="${name}"]`).classList.add('active');
  currentPage = name;

  if (name === 'analysis' && !chartsRendered) {
    loadStats();
    loadHistory(true);
    loadDailyChart();
    chartsRendered = true;
  }
  if (name === 'calendar') loadCalendar();
  if (name === 'todo')     loadTodos();
  if (name === 'rewards')  loadRewards();
}

/* ── Fetch helper（デバイスIDをBearerトークンとして自動付与） ─ */
async function authFetch(url, opts = {}) {
  opts.headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` };
  return fetch(url, opts);
}

// ミューテーション操作専用: サーバー準備まで最大120秒待機。準備できたらtrue、タイムアウトはfalse
async function waitServerReady() {
  if (_serverReady) return true;
  preWarmServer();
  const deadline = Date.now() + 120000;
  while (!_serverReady && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }
  return _serverReady;
}

/* ══════════════════════════════════════════════════════════
   APP LOAD
══════════════════════════════════════════════════════════ */
function loadAll() {
  checkActive();
  loadStats();
  loadHomeTodos();
  chartsRendered = false;
  // 現在表示中のページのデータも再取得
  if (currentPage === 'todo')     loadTodos();
  if (currentPage === 'calendar') loadCalendar();
  if (currentPage === 'rewards')  loadRewards();
}

/* ── Session ─────────────────────────────────────────────── */
async function checkActive() {
  try {
    const res = await authFetch('/api/active');
    if (!res.ok) return;
    const data = await res.json();
    if (data.active) { activeSession = data.session; setActiveUI(true); startTimer(); }
    else             { activeSession = null; setActiveUI(false); }
  } catch {}
}

async function toggleSession() {
  if (activeSession) await stopSession();
  else               await startSession();
}

async function startSession() {
  const btn    = document.getElementById('touch-btn');
  const status = document.getElementById('touch-status');
  btn.disabled = true;
  try {
    if (!_serverReady) {
      status.textContent = 'サーバー起動中…';
      await waitServerReady();
    }
    const res = await authFetch('/api/start', { method: 'POST' });
    if (!res.ok) { status.textContent = 'エラーが発生しました。再度タッチしてください。'; return; }
    const data = await res.json();
    activeSession = { id: data.session_id, start_time: data.start_time };
    setActiveUI(true); startTimer(); loadStats();
  } catch {
    status.textContent = 'エラーが発生しました。再度タッチしてください。';
  } finally {
    btn.disabled = false;
  }
}

async function stopSession() {
  const btn = document.getElementById('touch-btn');
  btn.disabled = true;
  try {
    const res = await authFetch('/api/stop', { method: 'POST' });
    if (!res.ok) return;
    activeSession = null; setActiveUI(false); stopTimer(); loadAll();
  } catch {}
  finally { btn.disabled = false; }
}

function setActiveUI(active) {
  const btn    = document.getElementById('touch-btn');
  const label  = document.getElementById('touch-label');
  const sub    = document.getElementById('touch-sub');
  const status = document.getElementById('touch-status');
  const badge  = document.getElementById('header-session-badge');
  const wrap   = document.querySelector('.touch-wrap');
  const icon   = document.getElementById('touch-icon-svg');
  if (active) {
    btn.className = 'touch-btn active';
    label.textContent = 'STOP'; sub.textContent = 'タッチして終了';
    status.textContent = '学習中…'; badge.classList.remove('hidden');
    wrap.classList.add('active');
    icon.innerHTML = `<rect x="10" y="10" width="16" height="16" rx="3" fill="currentColor"/>`;
  } else {
    btn.className = 'touch-btn idle';
    label.textContent = 'START'; sub.textContent = 'タッチして開始';
    status.textContent = '学習を始めましょう'; badge.classList.add('hidden');
    document.getElementById('live-timer-value').textContent = '—';
    wrap.classList.remove('active');
    icon.innerHTML = `
      <path d="M18 6v12M18 6l-5 5M18 6l5 5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M6 18c0 6.627 5.373 12 12 12s12-5.373 12-12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>`;
  }
}

/* ── Timer ───────────────────────────────────────────────── */
function startTimer() { stopTimer(); timerInterval = setInterval(tickTimer, 1000); tickTimer(); }
function stopTimer()  { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }
function tickTimer() {
  if (!activeSession) return;
  const elapsed = Math.floor((Date.now() - new Date(activeSession.start_time).getTime()) / 1000);
  const fmt = `${pad(Math.floor(elapsed/3600))}:${pad(Math.floor(elapsed%3600/60))}:${pad(elapsed%60)}`;
  document.getElementById('live-timer-value').textContent = fmt;
  document.getElementById('header-timer').textContent     = fmt;
}
function pad(n) { return String(n).padStart(2, '0'); }

/* ── Stats ───────────────────────────────────────────────── */
async function loadStats() {
  try {
    const res = await authFetch('/api/stats');
    if (!res.ok) return;
    const data = await res.json();
    setMinDisplay('today-value',   data.today_minutes);
    setMinDisplay('weekly-value',  data.weekly_minutes);
    setMinDisplay('monthly-value', data.monthly_minutes);
    document.getElementById('streak-value').innerHTML =
      `${data.active_days_30}<span class="stat-unit">日</span>`;
    if (currentPage === 'analysis') renderDowChart(data.by_day_of_week);
  } catch {}
}

function setMinDisplay(id, minutes) {
  const h = Math.floor(minutes / 60), m = Math.floor(minutes % 60);
  document.getElementById(id).innerHTML =
    `${h}<span class="stat-unit">h</span>${m}<span class="stat-unit">m</span>`;
}

/* ── Calendar ────────────────────────────────────────────── */
async function loadCalendar() {
  const rows = await authFetch(`/api/calendar/${calYear}/${calMonth}`).then(r => r.json());
  calData = {};
  for (const r of rows) calData[r.day] = r;
  renderCalendar();
}

function changeMonth(delta) {
  calMonth += delta;
  if (calMonth > 12) { calMonth = 1; calYear++; }
  if (calMonth < 1)  { calMonth = 12; calYear--; }
  calDayCache = {}; loadCalendar(); closeDayDetail();
}

function renderCalendar() {
  document.getElementById('cal-title').textContent = `${calYear}年 ${calMonth}月`;
  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';
  const firstDay    = new Date(calYear, calMonth - 1, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const today       = new Date();
  for (let i = 0; i < firstDay; i++) {
    const e = document.createElement('div'); e.className = 'cal-cell empty'; grid.appendChild(e);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const key  = `${calYear}-${String(calMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const mins = calData[key]?.total_minutes || 0;
    const isToday  = calYear===today.getFullYear() && calMonth===today.getMonth()+1 && d===today.getDate();
    const isFuture = new Date(calYear, calMonth-1, d) > today;
    const cell = document.createElement('div');
    cell.className = `cal-cell l${heatLevel(mins)}${isToday?' today':''}${isFuture?' future':''}`;
    const num = document.createElement('div'); num.className = 'cal-day-num'; num.textContent = d;
    const hr  = document.createElement('div'); hr.className = 'cal-day-hours';
    if (mins > 0) { const hh=Math.floor(mins/60),mm=Math.floor(mins%60); hr.textContent = hh>0?`${hh}h${mm}m`:`${mm}m`; }
    cell.appendChild(num); cell.appendChild(hr);
    if (!isFuture) cell.addEventListener('click', () => showDayDetail(key, d));
    grid.appendChild(cell);
  }
}
function heatLevel(m) { if(m<=0)return 0; if(m<60)return 1; if(m<120)return 2; if(m<240)return 3; return 4; }

async function showDayDetail(dateKey, dayNum) {
  if (!calDayCache[dateKey]) {
    const data = await authFetch('/api/history?limit=500').then(r => r.json());
    for (const s of data.sessions) {
      const k = s.start_time.slice(0, 10);
      if (!calDayCache[k]) calDayCache[k] = [];
      calDayCache[k].push(s);
    }
  }
  const sessions = calDayCache[dateKey] || [];
  document.getElementById('day-detail-title').textContent = `${calYear}年${calMonth}月${dayNum}日`;
  const body = document.getElementById('day-detail-body');
  body.innerHTML = sessions.length
    ? sessions.map(s => {
        const h=Math.floor(s.duration_minutes/60),m=Math.floor(s.duration_minutes%60);
        return `<div class="day-session-item">
          <span class="day-session-time">${fmtTime(s.start_time)} → ${fmtTime(s.end_time)}</span>
          <span class="day-session-dur">${h>0?`${h}時間${m}分`:`${m}分`}</span>
        </div>`;
      }).join('')
    : `<div style="color:var(--text3);padding:8px 0;font-size:14px;">この日の記録はありません</div>`;
  document.getElementById('day-detail').classList.remove('hidden');
  document.getElementById('day-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function closeDayDetail() { document.getElementById('day-detail').classList.add('hidden'); }
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ── Charts ──────────────────────────────────────────────── */
function renderDowChart(byDow) {
  const map = {};
  for (const d of byDow) map[d.dow] = d.days > 0 ? d.total_minutes / d.days : 0;
  const values = [0,1,2,3,4,5,6].map(i => Math.round((map[i]||0)/60*10)/10);
  const colors = ['#6366F1','#818CF8','#8B5CF6','#A78BFA','#EC4899','#F472B6','#10B981'];
  const ctx = document.getElementById('dow-chart').getContext('2d');
  if (dowChart) dowChart.destroy();
  dowChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: ['日','月','火','水','木','金','土'], datasets: [{ data: values, backgroundColor: colors, borderRadius: 8, borderSkipped: false }] },
    options: chartOpts(),
  });
}

async function loadDailyChart() {
  const today = new Date();
  const days = [], labels = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    days.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
    labels.push(`${d.getMonth()+1}/${d.getDate()}`);
  }
  const data = await authFetch('/api/history?limit=500').then(r => r.json());
  const map  = {};
  for (const s of data.sessions) { const k=s.start_time.slice(0,10); map[k]=(map[k]||0)+s.duration_minutes; }
  const values = days.map(k => Math.round((map[k]||0)/60*10)/10);
  const ctx = document.getElementById('daily-chart').getContext('2d');
  if (dailyChart) dailyChart.destroy();
  dailyChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: 'rgba(99,102,241,.5)', borderColor: '#6366F1', borderWidth: 1, borderRadius: 4, borderSkipped: false }] },
    options: chartOpts(),
  });
}

function chartOpts() {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: '#1E293B', borderColor: 'rgba(99,102,241,.3)', borderWidth: 1, titleColor: '#94A3B8', bodyColor: '#F0F2FF', callbacks: { label: c => ` ${c.parsed.y} 時間` } }
    },
    scales: {
      x: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#6B7280', font: { size: 11 } } },
      y: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#6B7280', font: { size: 11 }, callback: v => `${v}h` }, beginAtZero: true }
    }
  };
}

/* ── History ─────────────────────────────────────────────── */
async function loadHistory(reset = false) {
  if (reset) { historyOffset = 0; document.getElementById('history-list').innerHTML = ''; }
  const data = await authFetch(`/api/history?limit=20&offset=${historyOffset}`).then(r => r.json());
  historyTotal   = data.total;
  historyOffset += data.sessions.length;
  renderHistoryItems(data.sessions);
  document.getElementById('history-count').textContent = `全 ${historyTotal} 件`;
  document.getElementById('history-more').classList.toggle('hidden', historyOffset >= historyTotal);
}
function loadMoreHistory() { loadHistory(false); }

function renderHistoryItems(sessions) {
  const list   = document.getElementById('history-list');
  const groups = {};
  for (const s of sessions) { const k=s.start_time.slice(0,10); if(!groups[k])groups[k]=[]; groups[k].push(s); }
  for (const [dateKey, items] of Object.entries(groups)) {
    const label = new Date(dateKey+'T00:00:00').toLocaleDateString('ja-JP', { year:'numeric',month:'long',day:'numeric',weekday:'long' });
    const g = document.createElement('div');
    g.innerHTML = `<div class="history-group-label">${label}</div>`;
    list.appendChild(g);
    for (const s of items) {
      const st=fmtDatetime(s.start_time), en=fmtDatetime(s.end_time);
      const h=Math.floor(s.duration_minutes/60), m=Math.floor(s.duration_minutes%60);
      const item = document.createElement('div'); item.className = 'history-item';
      item.innerHTML = `
        <div class="history-date">${st.date}</div>
        <div class="history-time-range">${st.time} → ${en.time}</div>
        <div class="history-dur">${h>0?`${h}時間${m}分`:`${m}分`}</div>
        <button class="history-del" title="削除" onclick="deleteSession(${s.id},this)">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>`;
      list.appendChild(item);
    }
  }
}
function fmtDatetime(iso) {
  if (!iso) return { date: '—', time: '—' };
  const d = new Date(iso);
  return { date: d.toLocaleDateString('ja-JP',{month:'numeric',day:'numeric'}), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}
async function deleteSession(id, btn) {
  if (!confirm('このセッションを削除しますか？')) return;
  const res = await authFetch(`/api/sessions/${id}`, { method: 'DELETE' });
  if (res.ok) {
    btn.closest('.history-item').remove();
    historyTotal--;
    document.getElementById('history-count').textContent = `全 ${historyTotal} 件`;
    loadStats(); loadCalendar(); calDayCache = {};
  }
}

/* ══════════════════════════════════════════════════════════
   TODO
══════════════════════════════════════════════════════════ */
async function loadTodos() {
  try {
    const todos = await authFetch('/api/todos').then(r => r.json());
    renderTodoList(todos);
  } catch {}
}

async function loadHomeTodos() {
  try {
    const todos = await authFetch('/api/todos').then(r => r.json());
    renderHomeTodos(todos);
  } catch {}
}

function renderTodoList(todos) {
  const list = document.getElementById('todo-list');
  if (!list) return;
  if (todos.length === 0) {
    list.innerHTML = `<div class="todo-empty">タスクがありません。上のフォームから追加してください。</div>`;
    return;
  }
  list.innerHTML = todos.map(t => {
    const pct  = t.target_hours > 0 ? Math.min(100, (t.done_hours / t.target_hours) * 100) : 0;
    const done = t.completed || pct >= 100;
    return `
    <div class="todo-item${done ? ' todo-done' : ''}" id="todo-item-${t.id}">
      <div class="todo-item-top">
        <label class="todo-check-wrap">
          <input type="checkbox" ${done ? 'checked' : ''} onchange="toggleTodoComplete(${t.id}, this.checked)" />
          <span class="todo-check-box"></span>
        </label>
        <span class="todo-item-title">${escHtml(t.title)}</span>
        <div class="todo-item-actions">
          <button class="todo-log-btn" onclick="logTodoTime(${t.id}, ${t.done_hours}, ${t.target_hours})" title="時間を記録">+</button>
          <button class="todo-del-btn" onclick="deleteTodo(${t.id})" title="削除">×</button>
        </div>
      </div>
      <div class="todo-progress-row">
        <div class="todo-progress-bar"><div class="todo-progress-fill" style="width:${pct}%"></div></div>
        <span class="todo-progress-text">${t.done_hours}h / ${t.target_hours}h</span>
      </div>
    </div>`;
  }).join('');
}

function renderHomeTodos(todos) {
  const list = document.getElementById('home-todo-list');
  if (!list) return;
  const active = todos.filter(t => !t.completed).slice(0, 4);
  if (active.length === 0) {
    list.innerHTML = `<div class="todo-empty">進行中のタスクはありません。<button class="link-btn" onclick="showPage('todo')">ToDoを追加する →</button></div>`;
    return;
  }
  list.innerHTML = active.map(t => {
    const pct = t.target_hours > 0 ? Math.min(100, (t.done_hours / t.target_hours) * 100) : 0;
    return `
    <div class="home-todo-item">
      <span class="home-todo-title">${escHtml(t.title)}</span>
      <div class="todo-progress-bar"><div class="todo-progress-fill" style="width:${pct}%"></div></div>
      <span class="home-todo-pct">${Math.round(pct)}%</span>
    </div>`;
  }).join('');
}

async function addTodo() {
  const titleEl  = document.getElementById('todo-title-input');
  const hoursEl  = document.getElementById('todo-hours-input');
  const addBtn   = document.querySelector('.todo-add-btn');
  const errorEl  = document.getElementById('todo-add-error');
  const title    = titleEl.value.trim();
  const hours    = parseFloat(hoursEl.value) || 1;
  if (!title) { titleEl.focus(); return; }
  if (errorEl) errorEl.textContent = '';
  if (addBtn) { addBtn.disabled = true; if (!_serverReady) addBtn.textContent = '起動中...'; }
  try {
    if (!_serverReady) {
      const ready = await waitServerReady();
      if (!ready) {
        if (errorEl) errorEl.textContent = 'サーバーが起動できませんでした。ページを再読み込みしてください。';
        return;
      }
    }
    const res = await authFetch('/api/todos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, target_hours: hours }),
    });
    if (!res.ok) {
      if (errorEl) errorEl.textContent = `追加に失敗しました (${res.status})。再度お試しください。`;
      return;
    }
    titleEl.value = ''; hoursEl.value = '1';
    await loadTodos();
    loadHomeTodos();
  } catch (e) {
    if (errorEl) errorEl.textContent = 'ネットワークエラーが発生しました。再度お試しください。';
  } finally {
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = '追加'; }
  }
}

async function toggleTodoComplete(id, completed) {
  await authFetch(`/api/todos/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ completed }),
  });
  loadTodos(); loadHomeTodos();
}

async function deleteTodo(id) {
  if (!confirm('このタスクを削除しますか？')) return;
  await authFetch(`/api/todos/${id}`, { method: 'DELETE' });
  loadTodos(); loadHomeTodos();
}

async function logTodoTime(id, currentDone, target) {
  const input = prompt(`完了した時間を入力してください（現在: ${currentDone}h / 目標: ${target}h）`, '0.5');
  if (input === null) return;
  const add = parseFloat(input);
  if (isNaN(add) || add < 0) return;
  const newDone = Math.round((currentDone + add) * 10) / 10;
  await authFetch(`/api/todos/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done_hours: newDone, completed: newDone >= target }),
  });
  loadTodos(); loadHomeTodos();
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ══════════════════════════════════════════════════════════
   REWARDS
══════════════════════════════════════════════════════════ */
const MILESTONES = [
  { hours: 10,   emoji: '🌱', label: 'はじめの一歩',  reward: '学習の旅がスタートしました！この調子で続けましょう。', color: '#10B981' },
  { hours: 50,   emoji: '⭐', label: '本気の学習者',   reward: '50時間突破！学習が習慣になってきた証拠です。', color: '#F59E0B' },
  { hours: 100,  emoji: '🥉', label: '百時間の勇者',   reward: '100時間達成！ブロンズランクに到達。プロフィールに「学習者」称号が解放されました。', color: '#CD7F32' },
  { hours: 200,  emoji: '🥈', label: '努力家',         reward: '200時間達成！シルバーランク。モチベーション名言コレクション（10選）が解放されました。', color: '#94A3B8' },
  { hours: 300,  emoji: '🥇', label: '秀才',           reward: '300時間達成！ゴールドランク。特別カレンダーテーマが解放されました。', color: '#FBBF24' },
  { hours: 500,  emoji: '💎', label: '超人',           reward: '500時間達成！ダイヤモンドランク。プレミアムパープルテーマが解放されました。', color: '#818CF8' },
  { hours: 1000, emoji: '👑', label: '学習マスター',   reward: '1000時間達成！殿堂入り。全テーマ・全称号・特別エフェクトが解放されました！', color: '#F472B6' },
];

const QUOTES = [
  '「学ぶことをやめた時、教えることもやめなければならない」— サン＝テグジュペリ',
  '「千里の道も一歩から」— 中国の諺',
  '「努力は必ず報われる」— 王貞治',
  '「今日できることを明日に延ばすな」— ベンジャミン・フランクリン',
  '「成功とは、情熱を失わずに失敗から失敗へと進んでいく能力だ」— ウィンストン・チャーチル',
  '「夢を見るだけでは不十分だ、それを実行しなければ」— 福沢諭吉',
  '「学習は宝、それを使う人を決して裏切らない」— 中国の諺',
  '「どれだけ遅くても、歩み続ける者は止まっている者を超える」— 孔子',
  '「1万時間の法則。真の習熟には1万時間の練習が必要だ」— マルコム・グラッドウェル',
  '「今日の努力が、明日の可能性を広げる」',
];

async function loadRewards() {
  const data = await authFetch('/api/total-hours').then(r => r.json());
  const total = data.total_hours;

  document.getElementById('rewards-total-hours').textContent = `${total} h`;

  // 次のマイルストーンまでのヒント
  const next = MILESTONES.find(m => m.hours > total);
  const hint = next
    ? `次のご褒美まで あと ${Math.ceil(next.hours - total)} 時間 (${next.emoji} ${next.label})`
    : '🎉 全てのマイルストーンを達成しました！';
  document.getElementById('rewards-next-hint').textContent = hint;

  const grid = document.getElementById('rewards-grid');
  grid.innerHTML = MILESTONES.map(m => {
    const unlocked = total >= m.hours;
    const pct      = Math.min(100, Math.round((total / m.hours) * 100));
    const showQuotes = unlocked && m.hours >= 200;
    return `
    <div class="reward-card${unlocked ? ' unlocked' : ' locked'}">
      <div class="reward-emoji" style="${unlocked ? `color:${m.color}` : ''}">${unlocked ? m.emoji : '🔒'}</div>
      <div class="reward-label">${m.label}</div>
      <div class="reward-hours">${m.hours}時間達成</div>
      ${unlocked
        ? `<div class="reward-desc">${m.reward}</div>
           ${showQuotes ? `<div class="reward-quote">${QUOTES[Math.floor(Math.random()*QUOTES.length)]}</div>` : ''}`
        : `<div class="reward-progress-bar"><div class="reward-progress-fill" style="width:${pct}%;background:${m.color}"></div></div>
           <div class="reward-progress-text">${total}h / ${m.hours}h (${pct}%)</div>`
      }
    </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════
   MONETIZATION
══════════════════════════════════════════════════════════ */
const AFFILIATE_ITEMS = [
  { emoji: '⏱️', title: '勉強タイマー',       desc: 'ポモドーロ・カウントダウン対応。集中力UP！', q: '勉強+タイマー' },
  { emoji: '📓', title: '学習ノート・手帳',    desc: '計画を可視化して継続率アップ。',              q: '学習+手帳+スケジュール' },
  { emoji: '🎧', title: 'ノイズキャンセリング', desc: 'カフェや自習室でも集中できる環境を。',       q: 'ノイズキャンセリング+勉強' },
  { emoji: '💡', title: '学習用デスクライト',   desc: '目に優しい光で長時間学習をサポート。',       q: 'デスクライト+勉強' },
  { emoji: '📚', title: '人気参考書・問題集',   desc: '最新の人気学習本をチェック。',               q: '参考書+問題集+資格' },
  { emoji: '🪑', title: '姿勢サポートグッズ',  desc: '腰痛対策で長時間学習を快適に。',              q: '腰痛+クッション+椅子' },
];

async function loadMonetization() {
  let cfg = {};
  try { cfg = await fetch('/api/site-config').then(r => r.json()); } catch {}
  renderAffiliateSection(cfg.amazon_tag || '');
  renderSupportButtons(cfg);
  injectAdSense(cfg.adsense_id || '');
  injectBMCWidget(cfg.bmc_username || '');
}

function renderAffiliateSection(tag) {
  const grid = document.getElementById('affiliate-grid');
  if (!grid) return;
  grid.innerHTML = AFFILIATE_ITEMS.map(item => {
    const tagParam = tag ? `&tag=${tag}` : '';
    const url = `https://www.amazon.co.jp/s?k=${encodeURIComponent(item.q)}${tagParam}`;
    return `<a href="${url}" target="_blank" rel="noopener" class="affiliate-card">
      <div class="affiliate-card-emoji">${item.emoji}</div>
      <div class="affiliate-card-title">${item.title}</div>
      <div class="affiliate-card-desc">${item.desc}</div>
      <div class="affiliate-card-link">Amazonで見る →</div>
    </a>`;
  }).join('');
}

function renderSupportButtons(cfg) {
  const wrap = document.getElementById('support-buttons');
  if (!wrap) return;
  const btns = [];
  if (cfg.bmc_username) btns.push(`<a href="https://www.buymeacoffee.com/${cfg.bmc_username}" target="_blank" rel="noopener" class="support-btn btn-bmc">☕ Buy Me a Coffee</a>`);
  if (cfg.kofi_username) btns.push(`<a href="https://ko-fi.com/${cfg.kofi_username}" target="_blank" rel="noopener" class="support-btn btn-kofi">❤️ Ko-fi でサポート</a>`);
  if (cfg.stripe_link)  btns.push(`<a href="${cfg.stripe_link}" target="_blank" rel="noopener" class="support-btn btn-stripe">💳 カードで寄付する</a>`);
  wrap.innerHTML = btns.length ? btns.join('') : `<p style="color:var(--text3);font-size:13px;">近日公開予定</p>`;
}

function injectAdSense(publisherId) {
  if (!publisherId) return;
  const s = document.createElement('script');
  s.async = true; s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${publisherId}`;
  s.setAttribute('crossorigin', 'anonymous'); document.head.appendChild(s);
  ['ad-slot-1','ad-slot-2'].forEach(slotId => {
    const el = document.getElementById(slotId); if (!el) return;
    el.innerHTML = `<ins class="adsbygoogle" style="display:block" data-ad-client="${publisherId}" data-ad-slot="auto" data-ad-format="auto" data-full-width-responsive="true"></ins>`;
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch {}
  });
}

function injectBMCWidget(username) {
  if (!username) return;
  const s = document.createElement('script');
  s.setAttribute('data-name','BMC-Widget'); s.setAttribute('data-cfasync','false');
  s.setAttribute('data-id',username); s.setAttribute('data-description','学録を応援する');
  s.setAttribute('data-message','学習の継続をサポートします！'); s.setAttribute('data-color','#6366F1');
  s.setAttribute('data-position','Right'); s.setAttribute('data-x_margin','18'); s.setAttribute('data-y_margin','18');
  s.src = 'https://cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js';
  document.body.appendChild(s);
}
