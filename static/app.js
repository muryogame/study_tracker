'use strict';

// ── Auth state ────────────────────────────────────────────────
let token        = localStorage.getItem('sf_token') || null;
let currentEmail = localStorage.getItem('sf_email') || '';
let authMode     = 'login'; // 'login' | 'register'

// ── App state ─────────────────────────────────────────────────
let activeSession = null;
let timerInterval = null;
let calYear, calMonth;
let calData    = {};
let calDayCache = {};
let historyOffset = 0;
let historyTotal  = 0;
let dowChart   = null;
let dailyChart = null;

document.addEventListener('DOMContentLoaded', () => {
  const now = new Date();
  calYear   = now.getFullYear();
  calMonth  = now.getMonth() + 1;
  updateHeaderDate();
  setInterval(updateHeaderDate, 60_000);
  initAuth();
  loadAll();
  loadMonetization();
});

function updateHeaderDate() {
  const opts = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' };
  document.getElementById('header-date').textContent =
    new Date().toLocaleDateString('ja-JP', opts);
}

/* ══════════════════════════════════════════════════════════
   AUTH
══════════════════════════════════════════════════════════ */
async function initAuth() {
  if (!token) return; // 未ログインでもアプリは動く
  try {
    const res = await fetch('/api/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    showLoggedIn(data.email);
  } catch {
    token = null;
    localStorage.removeItem('sf_token');
    localStorage.removeItem('sf_email');
  }
}

function showLoggedIn(email) {
  currentEmail = email;
  localStorage.setItem('sf_email', email);
  document.getElementById('auth-form-section').classList.add('hidden');
  document.getElementById('auth-user-section').classList.remove('hidden');
  document.getElementById('auth-user-email').textContent = email;
  loadAll(); // ログイン後に自分のデータで再読み込み
}

function switchTab(mode) {
  authMode = mode;
  const isLogin = mode === 'login';
  document.getElementById('tab-login').classList.toggle('active', isLogin);
  document.getElementById('tab-register').classList.toggle('active', !isLogin);
  document.getElementById('auth-submit-btn').textContent = isLogin ? 'ログイン' : '登録する';
  document.getElementById('auth-error').classList.add('hidden');
}

async function submitAuth() {
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const btn      = document.getElementById('auth-submit-btn');

  if (!email || !password) {
    showAuthError('メールアドレスとパスワードを入力してください');
    return;
  }
  if (authMode === 'register' && password.length < 8) {
    showAuthError('パスワードは8文字以上で設定してください');
    return;
  }

  btn.disabled = true;
  btn.textContent = '処理中...';

  try {
    const endpoint = authMode === 'login' ? '/api/login' : '/api/register';
    const res = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      showAuthError(data.detail || 'エラーが発生しました');
      return;
    }
    token = data.token;
    localStorage.setItem('sf_token', token);
    showLoggedIn(data.email);
  } catch {
    showAuthError('通信エラーが発生しました');
  } finally {
    btn.disabled = false;
    btn.textContent = authMode === 'login' ? 'ログイン' : '登録する';
  }
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function logout() {
  token = null;
  currentEmail = '';
  localStorage.removeItem('sf_token');
  localStorage.removeItem('sf_email');
  activeSession = null;
  stopTimer();
  document.getElementById('header-session-badge').classList.add('hidden');
  document.getElementById('auth-user-section').classList.add('hidden');
  document.getElementById('auth-form-section').classList.remove('hidden');
  document.getElementById('auth-email').value = '';
  document.getElementById('auth-password').value = '';
  document.getElementById('auth-error').classList.add('hidden');
  switchTab('login');
  loadAll(); // 匿名データで再読み込み
}

/* ── Fetch（トークンがあれば付与、なければ匿名） ─────────── */
async function authFetch(url, opts = {}) {
  if (token) {
    opts.headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` };
  }
  return fetch(url, opts);
}

/* ══════════════════════════════════════════════════════════
   APP
══════════════════════════════════════════════════════════ */
function loadAll() {
  checkActive();
  loadStats();
  loadCalendar();
  loadHistory(true);
  loadDailyChart();
}

/* ── Session ─────────────────────────────────────────────── */
async function checkActive() {
  const res  = await authFetch('/api/active');
  const data = await res.json();
  if (data.active) {
    activeSession = data.session;
    setActiveUI(true);
    startTimer();
  } else {
    activeSession = null;
    setActiveUI(false);
  }
}

async function toggleSession() {
  if (activeSession) { await stopSession(); }
  else               { await startSession(); }
}

async function startSession() {
  const res = await authFetch('/api/start', { method: 'POST' });
  if (!res.ok) return;
  const data = await res.json();
  activeSession = { id: data.session_id, start_time: data.start_time };
  setActiveUI(true);
  startTimer();
  loadStats();
}

async function stopSession() {
  const res = await authFetch('/api/stop', { method: 'POST' });
  if (!res.ok) return;
  activeSession = null;
  setActiveUI(false);
  stopTimer();
  loadAll();
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
    label.textContent  = 'STOP';
    sub.textContent    = 'タッチして終了';
    status.textContent = '学習中…';
    badge.classList.remove('hidden');
    wrap.classList.add('active');
    icon.innerHTML = `<rect x="10" y="10" width="16" height="16" rx="3" fill="currentColor"/>`;
  } else {
    btn.className = 'touch-btn idle';
    label.textContent  = 'START';
    sub.textContent    = 'タッチして開始';
    status.textContent = '学習を始めましょう';
    badge.classList.add('hidden');
    document.getElementById('live-timer-value').textContent = '—';
    wrap.classList.remove('active');
    icon.innerHTML = `
      <path d="M18 6v12M18 6l-5 5M18 6l5 5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M6 18c0 6.627 5.373 12 12 12s12-5.373 12-12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>`;
  }
}

/* ── Timer ───────────────────────────────────────────────── */
function startTimer() {
  stopTimer();
  timerInterval = setInterval(tickTimer, 1000);
  tickTimer();
}
function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}
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
  const data = await authFetch('/api/stats').then(r => r.json());
  setMinDisplay('today-value',   data.today_minutes);
  setMinDisplay('weekly-value',  data.weekly_minutes);
  setMinDisplay('monthly-value', data.monthly_minutes);
  document.getElementById('streak-value').innerHTML =
    `${data.active_days_30}<span class="stat-unit">日</span>`;
  renderDowChart(data.by_day_of_week);
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
  calDayCache = {};
  loadCalendar();
  closeDayDetail();
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

    const num = document.createElement('div');
    num.className = 'cal-day-num'; num.textContent = d;

    const hr = document.createElement('div');
    hr.className = 'cal-day-hours';
    if (mins > 0) {
      const hh = Math.floor(mins/60), mm = Math.floor(mins%60);
      hr.textContent = hh > 0 ? `${hh}h${mm}m` : `${mm}m`;
    }
    cell.appendChild(num); cell.appendChild(hr);
    if (!isFuture) cell.addEventListener('click', () => showDayDetail(key, d));
    grid.appendChild(cell);
  }
}

function heatLevel(m) {
  if (m <= 0)  return 0; if (m < 60)  return 1;
  if (m < 120) return 2; if (m < 240) return 3; return 4;
}

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
        const h = Math.floor(s.duration_minutes/60), m = Math.floor(s.duration_minutes%60);
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
  for (const s of data.sessions) { const k = s.start_time.slice(0,10); map[k] = (map[k]||0) + s.duration_minutes; }
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
  for (const s of sessions) { const k = s.start_time.slice(0,10); if (!groups[k]) groups[k]=[]; groups[k].push(s); }
  for (const [dateKey, items] of Object.entries(groups)) {
    const label = new Date(dateKey+'T00:00:00').toLocaleDateString('ja-JP', { year:'numeric',month:'long',day:'numeric',weekday:'long' });
    const g = document.createElement('div');
    g.innerHTML = `<div class="history-group-label">${label}</div>`;
    list.appendChild(g);
    for (const s of items) {
      const st = fmtDatetime(s.start_time), en = fmtDatetime(s.end_time);
      const h = Math.floor(s.duration_minutes/60), m = Math.floor(s.duration_minutes%60);
      const item = document.createElement('div');
      item.className = 'history-item';
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
   MONETIZATION
══════════════════════════════════════════════════════════ */
const AFFILIATE_ITEMS = [
  { emoji: '⏱️', title: '勉強タイマー',      desc: 'ポモドーロ・カウントダウン対応。集中力UP！', q: '勉強+タイマー' },
  { emoji: '📓', title: '学習ノート・手帳',   desc: '計画を可視化して継続率アップ。',              q: '学習+手帳+スケジュール' },
  { emoji: '🎧', title: 'ノイズキャンセリング', desc: 'カフェや自習室でも集中できる環境を。',       q: 'ノイズキャンセリング+勉強' },
  { emoji: '💡', title: '学習用デスクライト',  desc: '目に優しい光で長時間学習をサポート。',       q: 'デスクライト+勉強' },
  { emoji: '📚', title: '人気参考書・問題集',  desc: '最新の人気学習本をチェック。',               q: '参考書+問題集+資格' },
  { emoji: '🪑', title: '姿勢サポートグッズ', desc: '腰痛対策で長時間学習を快適に。',              q: '腰痛+クッション+椅子' },
];

async function loadMonetization() {
  let cfg = {};
  try { cfg = await fetch('/api/site-config').then(r => r.json()); } catch {}

  renderAffiliateSection(cfg.amazon_tag || '');
  renderSupportButtons(cfg);
  injectAdSense(cfg.adsense_id || '');
  injectBMCWidget(cfg.bmc_username || '');
}

/* ── アフィリエイト ───────────────────────────────────────── */
function renderAffiliateSection(tag) {
  const grid = document.getElementById('affiliate-grid');
  if (!grid) return;
  grid.innerHTML = AFFILIATE_ITEMS.map(item => {
    const tagParam = tag ? `&tag=${tag}` : '';
    const url = `https://www.amazon.co.jp/s?k=${encodeURIComponent(item.q)}${tagParam}`;
    return `
      <a href="${url}" target="_blank" rel="noopener" class="affiliate-card">
        <div class="affiliate-card-emoji">${item.emoji}</div>
        <div class="affiliate-card-title">${item.title}</div>
        <div class="affiliate-card-desc">${item.desc}</div>
        <div class="affiliate-card-link">Amazonで見る →</div>
      </a>`;
  }).join('');
}

/* ── サポートボタン ──────────────────────────────────────── */
function renderSupportButtons(cfg) {
  const wrap = document.getElementById('support-buttons');
  if (!wrap) return;
  const btns = [];

  if (cfg.bmc_username) {
    btns.push(`<a href="https://www.buymeacoffee.com/${cfg.bmc_username}" target="_blank" rel="noopener" class="support-btn btn-bmc">
      ☕ Buy Me a Coffee
    </a>`);
  }
  if (cfg.kofi_username) {
    btns.push(`<a href="https://ko-fi.com/${cfg.kofi_username}" target="_blank" rel="noopener" class="support-btn btn-kofi">
      ❤️ Ko-fi でサポート
    </a>`);
  }
  if (cfg.stripe_link) {
    btns.push(`<a href="${cfg.stripe_link}" target="_blank" rel="noopener" class="support-btn btn-stripe">
      💳 カードで寄付する
    </a>`);
  }

  if (btns.length === 0) {
    wrap.innerHTML = `<p style="color:var(--text3);font-size:13px;">近日公開予定</p>`;
  } else {
    wrap.innerHTML = btns.join('');
  }
}

/* ── Google AdSense ──────────────────────────────────────── */
function injectAdSense(publisherId) {
  if (!publisherId) return;
  const s = document.createElement('script');
  s.async = true;
  s.src   = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${publisherId}`;
  s.setAttribute('crossorigin', 'anonymous');
  document.head.appendChild(s);
  ['ad-slot-1', 'ad-slot-2'].forEach(slotId => {
    const el = document.getElementById(slotId);
    if (!el) return;
    el.innerHTML = `
      <ins class="adsbygoogle"
           style="display:block"
           data-ad-client="${publisherId}"
           data-ad-slot="auto"
           data-ad-format="auto"
           data-full-width-responsive="true"></ins>`;
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch {}
  });
}

/* ── Buy Me a Coffee フローティングウィジェット ─────────── */
function injectBMCWidget(username) {
  if (!username) return;
  const s = document.createElement('script');
  s.setAttribute('data-name',        'BMC-Widget');
  s.setAttribute('data-cfasync',     'false');
  s.setAttribute('data-id',          username);
  s.setAttribute('data-description', 'StudyFlowを応援する');
  s.setAttribute('data-message',     '学習の継続をサポートします！');
  s.setAttribute('data-color',       '#6366F1');
  s.setAttribute('data-position',    'Right');
  s.setAttribute('data-x_margin',    '18');
  s.setAttribute('data-y_margin',    '18');
  s.src = 'https://cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js';
  document.body.appendChild(s);
}
