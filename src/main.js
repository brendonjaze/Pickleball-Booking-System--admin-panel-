import './style.css';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const SESSION_KEY = 'glan_admin_token';
const REFRESH_KEY = 'glan_admin_refresh';
let refreshInFlight = null; // de-dupes concurrent token refreshes

let allCourts = []; // populated on load from Supabase

let opModalSelectedDates = new Set();
let opModalCurrentMonth = new Date();
let opModalLastClicked = null;
let opModalDragStart = null;
let opSelectMode = false;
let opSelectedIds = new Set();

// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────

function getToken() {
  return localStorage.getItem(SESSION_KEY);
}

async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) throw new Error('Invalid credentials');

  const { access_token, refresh_token } = await res.json();
  localStorage.setItem(SESSION_KEY, access_token);
  if (refresh_token) localStorage.setItem(REFRESH_KEY, refresh_token);
  return access_token;
}

// Exchanges the stored refresh token for a fresh access token. Returns the new
// token, or null if there's no refresh token or it's no longer valid. Concurrent
// callers share one in-flight request so a single rotation can't invalidate the
// others (Supabase refresh tokens rotate on each use).
function refreshSession() {
  if (refreshInFlight) return refreshInFlight;
  const p = (async () => {
    const refresh_token = localStorage.getItem(REFRESH_KEY);
    if (!refresh_token) return null;
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.access_token) return null;
      localStorage.setItem(SESSION_KEY, data.access_token);
      if (data.refresh_token) localStorage.setItem(REFRESH_KEY, data.refresh_token);
      return data.access_token;
    } catch {
      return null;
    }
  })();
  refreshInFlight = p;
  p.finally(() => { if (refreshInFlight === p) refreshInFlight = null; });
  return p;
}

async function signOut() {
  const token = getToken();
  if (token) {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
      },
    }).catch(() => {});
  }
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

// ─── SUPABASE HELPERS ─────────────────────────────────────────────────────────

async function sbFetch(path, options = {}, _allowRefresh = true) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    // Access token likely expired — try a one-shot refresh, then replay once.
    if (_allowRefresh) {
      const newToken = await refreshSession();
      if (newToken) return sbFetch(path, options, false);
    }
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(REFRESH_KEY);
    logout();
    throw new Error('Session expired. Please sign in again.');
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `HTTP ${res.status}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function fetchAllBookings() {
  return sbFetch('bookings?select=*&order=created_at.desc,time_slot.asc');
}

// Cancelling a booking hard-deletes every row in its group, freeing the slots.
// All other (non-cancelled) bookings are kept permanently for revenue records.
async function deleteBookingGroup(bookingRef) {
  return sbFetch(`bookings?booking_ref=eq.${encodeURIComponent(bookingRef)}`, { method: 'DELETE' });
}

async function updateAuthUser(data) {
  const token = getToken();
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.msg || err.message || err.error_description || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── TIME HELPERS ─────────────────────────────────────────────────────────────

function parseTimeToMinutes(timeStr) {
  const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)?/i);
  if (!match) return 0;
  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const period = match[3]?.toUpperCase();
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  return hours * 60 + minutes;
}

function addOneHour(timeStr) {
  const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)?/i);
  if (!match) return timeStr;
  const minutes = match[2];
  const period = match[3]?.toUpperCase();
  let hours = parseInt(match[1]);
  let totalHours = hours;
  if (period === 'PM' && hours !== 12) totalHours += 12;
  if (period === 'AM' && hours === 12) totalHours = 0;
  totalHours += 1;
  if (period) {
    const newPeriod = totalHours >= 12 ? 'PM' : 'AM';
    const newHours = totalHours % 12 || 12;
    return `${newHours}:${minutes} ${newPeriod}`;
  }
  return `${String(totalHours).padStart(2, '0')}:${minutes}`;
}

function groupBookingsByRef(bookings) {
  const groups = {};
  for (const b of bookings) {
    const ref = b.booking_ref;
    if (!groups[ref]) {
      groups[ref] = {
        booking_ref: ref,
        name: b.name,
        phone: b.phone,
        court_id: b.court_id,
        date: b.date,
        payment_method: b.payment_method,
        receipt_url: b.receipt_url || null,
        created_at: b.created_at,
        slots: [],
      };
    }
    groups[ref].slots.push(b.time_slot);
  }
  return Object.values(groups).map(g => {
    const sorted = g.slots.sort((a, b) => parseTimeToMinutes(a) - parseTimeToMinutes(b));
    const firstStart = sorted[0].split('–')[0].trim();
    const lastEnd = sorted[sorted.length - 1].includes('–')
      ? sorted[sorted.length - 1].split('–')[1].trim()
      : addOneHour(sorted[sorted.length - 1]);
    return {
      ...g,
      time_range: `${firstStart} – ${lastEnd}`,
      total_hours: sorted.length,
    };
  });
}

// ─── ANNOUNCEMENT HELPERS ────────────────────────────────────────────────────

async function fetchAnnouncement() {
  const rows = await sbFetch('announcements?select=*&order=id.asc&limit=1');
  return rows.length ? rows[0] : null;
}

async function upsertAnnouncement(id, title, content, is_visible) {
  if (id) {
    return sbFetch(`announcements?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, content, is_visible, updated_at: new Date().toISOString() }),
    });
  }
  return sbFetch('announcements', {
    method: 'POST',
    body: JSON.stringify({ title, content, is_visible }),
  });
}

// ─── COURT LOCK HELPERS ──────────────────────────────────────────────────────

async function fetchCourtLocks() {
  const today = todayStr();
  const PAGE = 1000;
  let offset = 0;
  let result = [];
  while (true) {
    const page = await sbFetch(
      `court_locks?select=*&date=gte.${today}&order=date.asc,time_slot.asc&limit=${PAGE}&offset=${offset}`
    );
    result = result.concat(page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return result;
}

async function createCourtLocks(locks) {
  return sbFetch('court_locks', {
    method: 'POST',
    body: JSON.stringify(locks),
    headers: { 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
  });
}

async function deleteCourtLockGroup(groupId) {
  return sbFetch(`court_locks?lock_group=eq.${encodeURIComponent(groupId)}`, {
    method: 'DELETE',
    headers: { 'Prefer': 'return=minimal' },
  });
}

async function deleteExpiredCourtLocks() {
  const today = todayStr();
  return sbFetch(`court_locks?date=lt.${today}`, {
    method: 'DELETE',
    headers: { 'Prefer': 'return=minimal' },
  });
}

// ─── OPEN PLAY SELECT MODE ───────────────────────────────────────────────────

function enterSelectMode() {
  opSelectMode = true;
  opSelectedIds = new Set();
  document.getElementById('open-play-list').classList.add('op-select-active');
  document.getElementById('btn-add-open-play').style.display = 'none';
  document.getElementById('btn-select-sessions').classList.add('active');
  renderSelectToolbar();
}

function exitSelectMode() {
  opSelectMode = false;
  opSelectedIds = new Set();
  document.getElementById('open-play-list').classList.remove('op-select-active');
  document.getElementById('btn-add-open-play').style.display = '';
  document.getElementById('btn-select-sessions').classList.remove('active');
  document.getElementById('op-select-toolbar').innerHTML = '';
  document.querySelectorAll('.op-select-checkbox-wrap input').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('.op-session-row').forEach(r => r.classList.remove('op-row-selected'));
}

function renderSelectToolbar() {
  const count = opSelectedIds.size;
  const toolbar = document.getElementById('op-select-toolbar');
  toolbar.innerHTML = `
    <input type="checkbox" id="op-select-all" title="Select all" style="width:1.1rem;height:1.1rem;cursor:pointer;accent-color:var(--primary)" />
    <span class="op-select-toolbar-label">${count} selected</span>
    <button class="btn-bulk-delete" id="btn-bulk-delete" ${count === 0 ? 'disabled' : ''}>
      Delete Selected (${count})
    </button>
    <button class="btn-cancel-select" id="btn-cancel-select">Cancel</button>
  `;

  document.getElementById('btn-cancel-select').addEventListener('click', exitSelectMode);
  document.getElementById('btn-bulk-delete').addEventListener('click', bulkDeleteSelected);

  const totalRows = document.querySelectorAll('.op-session-row[data-id]').length;
  const selectAllCb = document.getElementById('op-select-all');
  if (count > 0 && count >= totalRows) {
    selectAllCb.checked = true;
    selectAllCb.indeterminate = false;
  } else if (count > 0) {
    selectAllCb.checked = false;
    selectAllCb.indeterminate = true;
  } else {
    selectAllCb.checked = false;
    selectAllCb.indeterminate = false;
  }
  selectAllCb.addEventListener('change', () => {
    const rows = document.querySelectorAll('.op-session-row[data-id]');
    rows.forEach(row => {
      const id = row.dataset.id;
      if (!id) return;
      const cb = row.querySelector('.op-select-checkbox-wrap input');
      if (selectAllCb.checked) {
        cb.checked = true;
        opSelectedIds.add(id);
        row.classList.add('op-row-selected');
      } else {
        cb.checked = false;
        opSelectedIds.delete(id);
        row.classList.remove('op-row-selected');
      }
    });
    renderSelectToolbar();
  });
}

function bulkDeleteSelected() {
  if (opSelectedIds.size === 0) return;
  const ids = [...opSelectedIds];
  confirmDeleteSession(async () => {
    try {
      await Promise.all(ids.map(id => softDeleteOpenPlaySession(id)));
      exitSelectMode();
      await loadOpenPlay();
      showToast(`${ids.length} session(s) deleted.`);
    } catch (e) {
      showToast('Failed to delete sessions.', true);
    }
  });
}

// ─── ADD SCHEDULE MODAL ──────────────────────────────────────────────────────

function openAddScheduleModal() {
  opModalSelectedDates = new Set();
  opModalCurrentMonth = new Date();
  opModalLastClicked = null;
  opModalDragStart = null;
  document.getElementById('op-modal-start-picker').innerHTML = opTimeChipsHTML(null, 'start');
  document.getElementById('op-modal-end-picker').innerHTML = opTimeChipsHTML(null, 'end');
  document.getElementById('op-modal-price').value = '';
  document.getElementById('op-modal-max').value = '20';
  document.getElementById('op-modal-enabled').checked = true;
  renderOpModalCalendar();
  updateOpModalSaveBtn();
  document.getElementById('op-add-modal').classList.add('show');
}

function closeAddScheduleModal() {
  document.getElementById('op-add-modal').classList.remove('show');
}

function renderOpModalCalendar() {
  const year = opModalCurrentMonth.getFullYear();
  const month = opModalCurrentMonth.getMonth();
  const monthName = opModalCurrentMonth.toLocaleString('default', { month: 'long' });
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const count = opModalSelectedDates.size;

  let html = `
    <div class="op-cal-header">
      <button class="op-cal-nav" id="op-cal-prev">&#8249;</button>
      <span class="op-cal-title">${monthName} ${year}</span>
      <button class="op-cal-nav" id="op-cal-next">&#8250;</button>
    </div>
    <div class="op-cal-grid">
      <div class="op-cal-day-label">Su</div>
      <div class="op-cal-day-label">Mo</div>
      <div class="op-cal-day-label">Tu</div>
      <div class="op-cal-day-label">We</div>
      <div class="op-cal-day-label">Th</div>
      <div class="op-cal-day-label">Fr</div>
      <div class="op-cal-day-label">Sa</div>
  `;

  for (let i = 0; i < firstDay; i++) {
    html += `<div class="op-cal-cell op-cal-empty"></div>`;
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const sel = opModalSelectedDates.has(dateStr) ? ' selected' : '';
    html += `<div class="op-cal-cell op-cal-day${sel}" data-date="${dateStr}">${d}</div>`;
  }

  html += `</div><div class="op-cal-count">${count} date(s) selected</div>`;

  const calEl = document.getElementById('op-modal-calendar');
  calEl.innerHTML = html;

  document.getElementById('op-cal-prev').addEventListener('click', () => {
    opModalCurrentMonth = new Date(year, month - 1, 1);
    renderOpModalCalendar();
  });
  document.getElementById('op-cal-next').addEventListener('click', () => {
    opModalCurrentMonth = new Date(year, month + 1, 1);
    renderOpModalCalendar();
  });

  calEl.querySelectorAll('.op-cal-day').forEach(cell => {
    cell.addEventListener('click', e => {
      const date = cell.dataset.date;
      if (e.shiftKey && opModalLastClicked) {
        selectOpRange(opModalLastClicked, date);
      } else {
        if (opModalSelectedDates.has(date)) {
          opModalSelectedDates.delete(date);
        } else {
          opModalSelectedDates.add(date);
        }
        opModalLastClicked = date;
      }
      renderOpModalCalendar();
      updateOpModalSaveBtn();
    });

    cell.addEventListener('mousedown', () => {
      opModalDragStart = cell.dataset.date;
    });

    cell.addEventListener('mouseover', e => {
      if (opModalDragStart && e.buttons === 1) {
        selectOpRange(opModalDragStart, cell.dataset.date);
        renderOpModalCalendar();
        updateOpModalSaveBtn();
      }
    });

    cell.addEventListener('mouseup', () => {
      opModalDragStart = null;
    });
  });
}

function selectOpRange(startDate, endDate) {
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  const [from, to] = start <= end ? [start, end] : [end, start];
  const cur = new Date(from);
  while (cur <= to) {
    const str = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
    opModalSelectedDates.add(str);
    cur.setDate(cur.getDate() + 1);
  }
  opModalLastClicked = endDate;
}

function updateOpModalSaveBtn() {
  const btn = document.getElementById('op-modal-save');
  const count = opModalSelectedDates.size;
  const start = document.querySelector('#op-modal-start-picker .op-time-chip.selected')?.dataset.value;
  const end = document.querySelector('#op-modal-end-picker .op-time-chip.selected')?.dataset.value;
  btn.disabled = count === 0 || !start || !end;
  btn.textContent = count > 0 ? `Add ${count} Session(s)` : 'Add Session(s)';
}

async function saveAddScheduleModal() {
  const start_time = document.querySelector('#op-modal-start-picker .op-time-chip.selected')?.dataset.value;
  const end_time = document.querySelector('#op-modal-end-picker .op-time-chip.selected')?.dataset.value;
  const price_per_player = parseInt(document.getElementById('op-modal-price').value) || 0;
  const max_players = parseInt(document.getElementById('op-modal-max').value) || 0;
  const is_enabled = document.getElementById('op-modal-enabled').checked;

  if (!start_time || !end_time) { showToast('Please set start and end time.', true); return; }
  if (opModalSelectedDates.size === 0) { showToast('Please select at least one date.', true); return; }
  if (max_players < 1) { showToast('Max players must be at least 1.', true); return; }

  const btn = document.getElementById('op-modal-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const selectedCount = opModalSelectedDates.size;
  try {
    await Promise.all([...opModalSelectedDates].map(date =>
      upsertOpenPlaySession(null, {
        is_enabled, date, start_time, end_time, price_per_player, max_players,
        session_type: 'open',
      })
    ));
    closeAddScheduleModal();
    await loadOpenPlay();
    showToast(`${selectedCount} session(s) added.`);
  } catch (e) {
    showToast(e.message || 'Failed to save sessions.', true);
    btn.disabled = false;
    updateOpModalSaveBtn();
  }
}

// ─── OPEN PLAY API ───────────────────────────────────────────────────────────

async function fetchAllOpenPlaySessions() {
  return sbFetch('open_play_sessions?deleted_at=is.null&order=date.asc,start_time.asc&select=*');
}

async function upsertOpenPlaySession(id, data) {
  if (id) {
    return sbFetch(`open_play_sessions?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
    });
  }
  return sbFetch('open_play_sessions', {
    method: 'POST',
    body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
  });
}

async function softDeleteOpenPlaySession(id) {
  return sbFetch(`open_play_sessions?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
  });
}

async function fetchOpenPlayRegistrations(sessionId) {
  return sbFetch(`open_play_queue?session_id=eq.${sessionId}&select=*`);
}

async function fetchOpenPlayRequests(sessionId) {
  return sbFetch(`open_play_join_requests?session_id=eq.${sessionId}&status=eq.pending&select=*&order=created_at.asc`);
}
async function approveOpenPlayRequest(requestId) {
  const res = await sbFetch('rpc/approve_open_play_request', {
    method: 'POST', body: JSON.stringify({ p_request_id: requestId }),
  });
  return Array.isArray(res) ? res[0] : res;
}
async function declineOpenPlayRequest(requestId) {
  return sbFetch(`open_play_join_requests?id=eq.${requestId}`, {
    method: 'PATCH', body: JSON.stringify({ status: 'declined', decided_at: new Date().toISOString() }),
  });
}
async function fetchOpenPlayMessages(sessionId) {
  return sbFetch(`open_play_messages?session_id=eq.${sessionId}&select=*&order=created_at.asc`);
}
async function postOpenPlayMessage(sessionId, body, imageUrl) {
  return sbFetch('open_play_messages', {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, sender_name: 'Organizer', is_organizer: true,
                           body: body || null, image_url: imageUrl || null }),
  });
}

// ─── CHAT REACTIONS ──────────────────────────────────────────────────────────
// One reaction per person per message (unique on message_id + reactor_token).
// The organizer reacts under the shared token 'organizer'.

const REACTION_EMOJIS = ['👍', '❤️', '😆', '😮', '😢', '😡'];
const ORGANIZER_TOKEN = 'organizer';

// Returns { [messageId]: [{ reactor_token, emoji }, …] } in one request.
async function fetchReactionsFor(messageIds) {
  if (!messageIds.length) return {};
  const rows = await sbFetch(
    `open_play_message_reactions?message_id=in.(${messageIds.join(',')})&select=message_id,reactor_token,emoji`);
  const byMsg = {};
  rows.forEach(r => { (byMsg[r.message_id] = byMsg[r.message_id] || []).push(r); });
  return byMsg;
}

async function upsertOrganizerReaction(messageId, emoji) {
  return sbFetch('open_play_message_reactions?on_conflict=message_id,reactor_token', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
    body: JSON.stringify({
      message_id: messageId, reactor_token: ORGANIZER_TOKEN,
      reactor_name: 'Organizer', is_organizer: true, emoji,
    }),
  });
}

async function deleteOrganizerReaction(messageId) {
  return sbFetch(
    `open_play_message_reactions?message_id=eq.${messageId}&reactor_token=eq.${ORGANIZER_TOKEN}`,
    { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } });
}

// ─── CHAT TYPING INDICATOR ───────────────────────────────────────────────────
// One open_play_typing row per (session, person), refreshed while typing.
// "Typing" = the other party's row was updated within the last TYPING_FRESH_MS.

const TYPING_FRESH_MS = 4000;
let orgTypingLastSent = 0;

async function sendOrganizerTyping(sessionId) {
  const now = Date.now();
  if (now - orgTypingLastSent < 2000) return; // throttle writes
  orgTypingLastSent = now;
  try {
    await sbFetch('open_play_typing?on_conflict=session_id,actor_token', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
      body: JSON.stringify({
        session_id: sessionId, actor_token: ORGANIZER_TOKEN,
        actor_name: 'Organizer', is_organizer: true,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (e) { /* typing is best-effort */ }
}

async function fetchPlayersTyping(sessionId) {
  const since = new Date(Date.now() - TYPING_FRESH_MS).toISOString();
  return sbFetch(
    `open_play_typing?session_id=eq.${sessionId}&is_organizer=eq.false` +
    `&updated_at=gte.${encodeURIComponent(since)}&select=actor_name`);
}

async function deleteOpenPlayRegistration(regId) {
  return sbFetch(`open_play_queue?id=eq.${regId}`, { method: 'DELETE' });
}

// Revenue inputs for Open Play: every live session plus a per-session player
// count, plus the permanent revenue log — snapshots written by the purge
// function just before a finished session (and its registrations) is deleted.
async function fetchOpenPlayRevenueData() {
  const [sessions, queueRows, log] = await Promise.all([
    // Exclude soft-deleted sessions — their players must not count toward revenue
    // for a session the admin can no longer see or manage.
    sbFetch('open_play_sessions?select=id,date,price_per_player&deleted_at=is.null'),
    sbFetch('open_play_queue?select=session_id,amount_paid'),
    // Table may not be migrated yet — degrade to live-only.
    sbFetch('open_play_revenue_log?select=session_id,date,players,total').catch(() => []),
  ]);
  // Prefer the amount actually paid per registration (snapshotted at payment
  // time); fall back to the session's current price only for legacy rows that
  // predate the amount_paid column, so editing a price never rewrites history.
  const counts = {}, paidBySession = {}, unpricedBySession = {};
  queueRows.forEach(r => {
    counts[r.session_id] = (counts[r.session_id] || 0) + 1;
    const amt = Number(r.amount_paid);
    if (Number.isFinite(amt) && amt > 0) {
      paidBySession[r.session_id] = (paidBySession[r.session_id] || 0) + amt;
    } else {
      unpricedBySession[r.session_id] = (unpricedBySession[r.session_id] || 0) + 1;
    }
  });
  return { sessions, counts, paidBySession, unpricedBySession, log };
}

// Returns { [sessionId]: count } for the given session ids in one request.
async function fetchOpenPlayRegistrationCounts(sessionIds) {
  if (!sessionIds.length) return {};
  const rows = await sbFetch(
    `open_play_queue?session_id=in.(${sessionIds.join(',')})&select=session_id`);
  const counts = {};
  rows.forEach(r => { counts[r.session_id] = (counts[r.session_id] || 0) + 1; });
  return counts;
}

// ─── COURT MANAGEMENT API ─────────────────────────────────────────────────────

async function fetchCourts() {
  return sbFetch('courts?select=*&order=sort_order.asc');
}

async function createCourt(data) {
  return sbFetch('courts', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

async function updateCourt(id, data) {
  return sbFetch(`courts?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// ─── PRICING SETTINGS API ─────────────────────────────────────────────────────
// Time-based court pricing lives in a single row (id = 1) of pricing_settings.
async function fetchPricingSettings() {
  const rows = await sbFetch('pricing_settings?select=*&order=id.asc&limit=1');
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function updatePricingSettings(data) {
  // PATCH the single row; sbFetch sends Prefer: return=representation, so the
  // updated row comes back and we can verify the write actually landed.
  return sbFetch('pricing_settings?id=eq.1', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// ─── STATE ────────────────────────────────────────────────────────────────────

let allBookings = [];
let openPlayRevenueData = { sessions: [], counts: {}, log: [] }; // live sessions + counts + purge snapshots
let pricingSettings = null; // time-based rates ({ daytime_rate, evening_rate, cutoff_hour })
let pendingDeleteRef = null;
let currentRevenuePeriod = 'monthly';
let lastUpdatedTime = null;
let allCourtLocks = [];
let lockCalendarDate = new Date();
let selectedLockDates = new Set();
let selectedLockTimes = new Set();
let isDraggingDates = false;
let isDraggingTimes = false;
let dragDateAdding = true;
let dragTimeAdding = true;
let pendingDeleteLockGroup = null;
let selectedLockMonths = new Set();

// ─── TOAST ────────────────────────────────────────────────────────────────────

function showToast(message, isError = false, duration = 3500) {
  const container = document.querySelector('.toast-container');
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' error' : ''}`;
  toast.textContent = message;
  container.appendChild(toast);

  toast.addEventListener('click', () => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 250);
  });

  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 250);
    }
  }, duration);
}

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toLocaleDateString('en-CA');
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatDisplayDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatLastUpdated() {
  if (!lastUpdatedTime) return '';
  return lastUpdatedTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ─── PRICING / COURT HELPERS ────────────────────────────────────────────────────

// Courts customers can currently book. allCourts stays the full list (needed for
// historical booking badges and the Courts management tab); active-only is for
// dropdowns, dashboards and lock targets.
function activeCourts() {
  return allCourts.filter(c => c.is_active);
}

// Courts to show in a per-court breakdown for a given set of slot rows: every
// active court, plus any now-inactive court that still has data in the set, so
// the cards always reconcile with the headline total.
function courtsForBreakdown(rows) {
  return allCourts.filter(c => c.is_active || rows.some(b => b.court_id === c.id));
}

// Revenue must mirror what the booking app charges. New bookings record the
// exact amount paid in `price` (pesos, per slot) — use it verbatim so a later
// rate change never rewrites historical revenue. Only legacy rows saved before
// `price` existed fall back to re-deriving the time-based rate (switching at
// EVENING_START_HOUR / 6 PM), and to the court's flat price_per_hour if pricing
// settings haven't loaded or the rate is invalid.
function rateForBooking(b) {
  // Use the stored price verbatim whenever one was recorded — including a
  // genuine ₱0 booking. Only a truly absent price (legacy rows) falls back to
  // re-deriving a rate; treating 0 as "missing" would show phantom revenue.
  if (b.price !== null && b.price !== undefined && b.price !== '') {
    const stored = Number(b.price);
    if (Number.isFinite(stored) && stored >= 0) return stored;
  }
  const court = allCourts.find(c => c.id === b.court_id);
  const fallback = court ? court.price_per_hour : 100;
  if (!pricingSettings) return fallback;
  const startHour = Math.floor(parseTimeToMinutes(b.time_slot) / 60);
  const cutoff = Number(pricingSettings.cutoff_hour) || EVENING_START_HOUR;
  const rate = Number(startHour >= cutoff ? pricingSettings.evening_rate : pricingSettings.daytime_rate);
  return rate > 0 ? rate : fallback;
}

// Open Play income: players × price per player, filtered by date prefix
// ('' = all time, 'YYYY' = a year, 'YYYY-MM' = a month, 'YYYY-MM-DD' = one day).
// Live sessions + purge snapshots; a session is only ever in one of the two
// (the log row is written as the session is deleted), but skip any overlap
// defensively so nothing double-counts mid-purge.
function openPlayRevenue(prefix) {
  const { sessions, counts, paidBySession, unpricedBySession, log } = openPlayRevenueData;
  let total = 0, players = 0;
  const liveIds = new Set();
  for (const s of sessions) {
    liveIds.add(s.id);
    if (!s.date || !s.date.startsWith(prefix)) continue;
    const n = counts[s.id] || 0;
    // Snapshotted amounts + session-price fallback for legacy (unpriced) rows.
    const stored = (paidBySession && paidBySession[s.id]) || 0;
    const unpriced = (unpricedBySession && unpricedBySession[s.id]) || 0;
    total += stored + unpriced * (Number(s.price_per_player) || 0);
    players += n;
  }
  for (const row of log || []) {
    if (liveIds.has(row.session_id)) continue;
    if (!row.date || !row.date.startsWith(prefix)) continue;
    total += Number(row.total) || 0;
    players += Number(row.players) || 0;
  }
  return { total, players };
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function updateDashboard(bookings) {
  const today = todayStr();
  const todayBookings = bookings.filter(b => b.date === today);
  const todayGrouped = groupBookingsByRef(todayBookings);

  const greetingEl = document.getElementById('greeting');
  if (greetingEl) greetingEl.textContent = `${getGreeting()}! Here's today's overview`;

  document.getElementById('stat-total').textContent = todayGrouped.length;

  const todayRevenue = todayBookings.reduce((sum, b) => sum + rateForBooking(b), 0)
    + openPlayRevenue(today).total;
  document.getElementById('stat-revenue').textContent = `₱${todayRevenue.toLocaleString()}`;

  const courtStatContainer = document.getElementById('court-stat-cards');
  if (courtStatContainer) {
    courtStatContainer.innerHTML = courtsForBreakdown(todayBookings).map((court, i) => {
      const count = todayGrouped.filter(b => b.court_id === court.id).length;
      const color = COURT_COLORS[i % COURT_COLORS.length];
      return `
        <div class="stat-card" style="border-top: 4px solid ${color}">
          <div class="stat-label">${court.name}</div>
          <div class="stat-value" id="stat-court${court.id}">${count}</div>
          <div class="stat-sub">Bookings today</div>
        </div>`;
    }).join('');
  }

  // Update tab badge
  const tabBadge = document.getElementById('tab-bookings-badge');
  if (tabBadge) {
    const upcoming = groupBookingsByRef(bookings.filter(b => b.date >= today));
    tabBadge.textContent = upcoming.length;
  }
}

// ─── REVENUE ─────────────────────────────────────────────────────────────────

function updateRevenue() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');

  let filtered, periodLabel;

  if (currentRevenuePeriod === 'monthly') {
    const prefix = `${year}-${month}`;
    filtered = allBookings.filter(b => b.date.startsWith(prefix));
    periodLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  } else {
    filtered = allBookings.filter(b => b.date.startsWith(String(year)));
    periodLabel = String(year);
  }

  const periodPrefix = currentRevenuePeriod === 'monthly' ? `${year}-${month}` : String(year);
  const op = openPlayRevenue(periodPrefix);
  const totalRevenue = filtered.reduce((sum, b) => sum + rateForBooking(b), 0) + op.total;
  const grouped = groupBookingsByRef(filtered);

  document.getElementById('revenue-period-label').textContent = periodLabel;
  document.getElementById('revenue-total').textContent = `₱${totalRevenue.toLocaleString()}`;
  document.getElementById('revenue-bookings').textContent = grouped.length;
  document.getElementById('revenue-hours').textContent = `${filtered.length}h`;
  const opPlayersEl = document.getElementById('revenue-op-players');
  if (opPlayersEl) opPlayersEl.textContent = op.players;

  // Court breakdown
  const courtCardsEl = document.getElementById('revenue-court-cards');
  if (courtCardsEl) {
    courtCardsEl.innerHTML = courtsForBreakdown(filtered).map((court, i) => {
      const courtSlots = filtered.filter(b => b.court_id === court.id);
      const courtGrouped = groupBookingsByRef(courtSlots);
      const amount = courtSlots.reduce((sum, b) => sum + rateForBooking(b), 0);
      const color = COURT_COLORS[i % COURT_COLORS.length];
      return `
        <div class="revenue-card" style="border-left: 4px solid ${color}">
          <div class="rev-card-label">${court.name}</div>
          <div class="rev-card-amount">₱${amount.toLocaleString()}</div>
          <div class="rev-card-meta">
            <span>${courtSlots.length}h</span> · <span>${courtGrouped.length} booking${courtGrouped.length !== 1 ? 's' : ''}</span>
          </div>
        </div>`;
    }).join('');
  }

  // Payment breakdown. Online checkout stores 'QRPh (GCash/Maya/ShopeePay)'
  // (and older rows may say 'GCash'), so bucket everything that isn't Cash as
  // QR Payment. QR + Cash (court bookings) + Open Play = headline total, so the
  // three cards always reconcile with it.
  const cashBookings = filtered.filter(b => b.payment_method === 'Cash');
  const qrBookings = filtered.filter(b => b.payment_method !== 'Cash');
  const qrRevenue = qrBookings.reduce((sum, b) => sum + rateForBooking(b), 0);
  const cashRevenue = cashBookings.reduce((sum, b) => sum + rateForBooking(b), 0);

  document.getElementById('rev-gcash-amount').textContent = `₱${qrRevenue.toLocaleString()}`;
  document.getElementById('rev-gcash-count').textContent = `${qrBookings.length} hours`;
  document.getElementById('rev-cash-amount').textContent = `₱${cashRevenue.toLocaleString()}`;
  document.getElementById('rev-cash-count').textContent = `${cashBookings.length} hours`;
  document.getElementById('rev-openplay-amount').textContent = `₱${op.total.toLocaleString()}`;
  document.getElementById('rev-openplay-count').textContent = `${op.players} player${op.players !== 1 ? 's' : ''}`;
}

// ─── TABLE ────────────────────────────────────────────────────────────────────

function courtBadge(id) {
  const court = allCourts.find(c => c.id === id);
  return `<span class="court-badge c${id}">${court ? court.name : 'Court ' + id}</span>`;
}

function populateCourtDropdowns() {
  const options = activeCourts().map(c =>
    `<option value="${c.id}">${c.name}</option>`
  ).join('');

  const filterCourtEl = document.getElementById('filter-court');
  if (filterCourtEl) {
    filterCourtEl.innerHTML = `<option value="">All Courts</option>${options}`;
  }

  const lockCourtEl = document.getElementById('lock-court');
  if (lockCourtEl) {
    lockCourtEl.innerHTML = `<option value="all">All Courts</option>${options}`;
  }
}

function paymentBadge(method) {
  // Everything that isn't Cash is an online QR payment (stored as
  // 'QRPh (GCash/Maya/ShopeePay)', or 'GCash' on older rows).
  const isCash = method === 'Cash';
  const cls = isCash ? 'cash' : 'gcash';
  const icon = isCash ? '💵' : '💳';
  const label = isCash ? 'Cash' : 'QR Payment';
  return `<span class="payment-badge ${cls}">${icon} ${label}</span>`;
}

function renderDateCell(dateStr) {
  return formatDisplayDate(dateStr);
}

function renderTable(grouped) {
  const tbody = document.getElementById('bookings-tbody');
  const count = document.getElementById('bookings-count');

  count.textContent = `${grouped.length} booking${grouped.length !== 1 ? 's' : ''}`;

  if (grouped.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="table-empty">
            <div class="icon">📭</div>
            <p>No bookings found</p>
            <div class="sub">Try adjusting your filters or search</div>
          </div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = grouped.map(b => `
    <tr>
      <td data-label="Name">${b.name || '—'}</td>
      <td data-label="Phone">${b.phone}</td>
      <td data-label="Court">${courtBadge(b.court_id)}</td>
      <td data-label="Date">${renderDateCell(b.date)}</td>
      <td data-label="Time">${b.time_range}</td>
      <td data-label="Hours">${b.total_hours}h</td>
      <td data-label="Payment">${paymentBadge(b.payment_method)}</td>
      <td>
        <button class="btn-delete" data-ref="${b.booking_ref}">Cancel</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', () => openDeleteModal(btn.dataset.ref));
  });

}

// ─── FILTERS ─────────────────────────────────────────────────────────────────

function applyFilters() {
  const date = document.getElementById('filter-date').value;
  const court = document.getElementById('filter-court').value;
  const search = document.getElementById('filter-search').value.trim().toLowerCase();
  const showPast = document.getElementById('filter-show-past').checked;
  const today = todayStr();

  const filtered = allBookings.filter(b => {
    // Hide past bookings unless a specific date is picked or "Show past" is checked
    if (!date && !showPast && b.date < today) return false;
    if (date && b.date !== date) return false;
    if (court && String(b.court_id) !== court) return false;
    if (search) {
      const matchName = (b.name || '').toLowerCase().includes(search);
      const matchPhone = (b.phone || '').toLowerCase().includes(search);
      if (!matchName && !matchPhone) return false;
    }
    return true;
  });

  renderTable(groupBookingsByRef(filtered));
}

// ─── EXCEL EXPORT ────────────────────────────────────────────────────────────

function downloadPastBookingsCSV() {
  const today = todayStr();
  const past = allBookings.filter(b => b.date < today);

  if (past.length === 0) {
    showToast('No past bookings to export.', true);
    return;
  }

  const grouped = groupBookingsByRef(past);

  const headers = ['Booking Ref', 'Name', 'Phone', 'Court', 'Date', 'Time Range', 'Hours', 'Payment Method'];

  const rows = grouped.map(b => [
    b.booking_ref,
    b.name || '',
    b.phone,
    allCourts.find(c => c.id === b.court_id)?.name || `Court ${b.court_id}`,
    formatDisplayDate(b.date),
    b.time_range,
    b.total_hours,
    b.payment_method,
  ]);

  const escape = v => {
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const csv = [headers, ...rows].map(r => r.map(escape).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `past-bookings-${today}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${grouped.length} past booking${grouped.length !== 1 ? 's' : ''}.`);
}

// ─── DELETE MODAL ─────────────────────────────────────────────────────────────

function openReceiptModal(url) {
  const modal = document.getElementById('receipt-modal');
  const img = document.getElementById('receipt-img');
  const loading = document.getElementById('receipt-loading');
  const error = document.getElementById('receipt-error');
  const link = document.getElementById('receipt-open-link');

  img.style.display = 'none';
  error.style.display = 'none';
  loading.style.display = 'flex';
  // Only allow http(s) image URLs as the "open full size" link — a player-supplied
  // image_url of `javascript:…` would otherwise run in the admin's browser on click.
  const safeUrl = /^https?:\/\//i.test(url) ? url : '';
  link.href = safeUrl || '#';

  modal.classList.add('show');

  img.onload = () => {
    loading.style.display = 'none';
    img.style.display = 'block';
  };
  img.onerror = () => {
    loading.style.display = 'none';
    error.style.display = 'block';
  };
  img.src = safeUrl;
}

function closeReceiptModal() {
  document.getElementById('receipt-modal').classList.remove('show');
  const img = document.getElementById('receipt-img');
  img.src = '';
  img.style.display = 'none';
}

function openDeleteModal(ref) {
  pendingDeleteRef = ref;
  document.getElementById('delete-modal').classList.add('show');
}

function closeDeleteModal() {
  pendingDeleteRef = null;
  document.getElementById('delete-modal').classList.remove('show');
}

async function confirmDelete() {
  if (!pendingDeleteRef) return;
  const ref = pendingDeleteRef;
  closeDeleteModal();

  try {
    const deleted = await deleteBookingGroup(ref);
    if (!deleted || deleted.length === 0) {
      throw new Error('Booking could not be deleted. Check Supabase RLS policies.');
    }
    allBookings = allBookings.filter(b => b.booking_ref !== ref);
    applyFilters();
    updateDashboard(allBookings);
    updateRevenue();
    showToast('Booking cancelled successfully.');
  } catch (e) {
    showToast(e.message || 'Failed to cancel booking.', true);
    console.error(e);
  }
}

// ─── LOAD DATA ────────────────────────────────────────────────────────────────

async function loadBookings() {
  const tbody = document.getElementById('bookings-tbody');
  tbody.innerHTML = `
    <tr>
      <td colspan="8">
        <div class="loading-spinner">
          <div class="spinner"></div>
          Loading bookings…
        </div>
      </td>
    </tr>`;

  const refreshBtn = document.getElementById('btn-refresh');
  if (refreshBtn) refreshBtn.classList.add('spinning');

  try {
    const [bookings, opData] = await Promise.all([
      fetchAllBookings(),
      // Open Play revenue is additive — if it fails, keep the last known data
      // rather than failing the whole bookings load.
      fetchOpenPlayRevenueData().catch(() => openPlayRevenueData),
    ]);
    allBookings = bookings;
    openPlayRevenueData = opData;
    lastUpdatedTime = new Date();

    applyFilters();
    updateDashboard(allBookings);
    updateRevenue();

    const updatedEl = document.getElementById('last-updated');
    if (updatedEl) updatedEl.textContent = `Updated ${formatLastUpdated()}`;
  } catch (e) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="table-empty">
            <div class="icon">⚠️</div>
            <p>Failed to load bookings</p>
            <div class="sub">Check your connection and try again</div>
          </div>
        </td>
      </tr>`;
    showToast(e.message || 'Error loading bookings.', true);
    console.error(e);
  } finally {
    if (refreshBtn) refreshBtn.classList.remove('spinning');
  }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

async function showAdmin() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('admin-app').classList.add('visible');
  const [courts, pricing] = await Promise.all([
    fetchCourts(),
    fetchPricingSettings().catch(() => null),
  ]);
  allCourts = courts;
  pricingSettings = pricing;
  populateCourtDropdowns();
  loadBookings();
  startChatHead();
}

function logout() {
  signOut();
  stopChatHead();
  closeOrganizerChat();
  // Clear any per-row Open Play polling intervals — the admin app is only hidden
  // (DOM persists), so these would keep firing sbFetch after sign-out.
  document.querySelectorAll('.op-expanded').forEach(row => {
    if (row._opPoll) { clearInterval(row._opPoll); row._opPoll = null; }
  });
  document.getElementById('admin-app').classList.remove('visible');
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('login-error').classList.remove('show');
}

// ─── ACCOUNT MODAL ────────────────────────────────────────────────────────────

function openAccountModal() {
  document.getElementById('account-modal').classList.add('show');
  document.getElementById('new-password').value = '';
  document.getElementById('confirm-password').value = '';
  document.getElementById('account-password-error').textContent = '';
}

function closeAccountModal() {
  document.getElementById('account-modal').classList.remove('show');
}

async function handleChangePassword() {
  const newPass = document.getElementById('new-password').value;
  const confirmPass = document.getElementById('confirm-password').value;
  const errEl = document.getElementById('account-password-error');
  const btn = document.getElementById('btn-change-password');

  errEl.textContent = '';

  if (newPass.length < 6) {
    errEl.textContent = 'Password must be at least 6 characters.';
    return;
  }
  if (newPass !== confirmPass) {
    errEl.textContent = 'Passwords do not match.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Updating…';

  try {
    await updateAuthUser({ password: newPass });
    closeAccountModal();
    showToast('Password updated successfully.');
  } catch (e) {
    errEl.textContent = e.message || 'Failed to update password.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update Password';
  }
}

// ─── TAB SWITCHING ────────────────────────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.classList.add('active');

  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const target = document.getElementById(`tab-${tab}`);
  if (target) target.classList.add('active');

  if (tab === 'revenue') {
    updateRevenue(); // render immediately from cache…
    fetchOpenPlayRevenueData() // …then refresh open play numbers in the background
      .then(d => { openPlayRevenueData = d; updateRevenue(); })
      .catch(() => {});
  }
  if (tab === 'announcements') loadAnnouncement();
  if (tab === 'courts') renderCourtsTab();
  if (tab === 'pricing') loadPricing();
  if (tab === 'open-play') loadOpenPlay();
  if (tab === 'locks') {
    renderLockCalendar();
    renderLockTimeGrid();
    loadCourtLocks();
  }
}

// ─── ANNOUNCEMENT LOGIC ──────────────────────────────────────────────────────

let currentAnnouncementId = null;

async function loadAnnouncement() {
  const statusEl = document.getElementById('announcement-status');
  statusEl.textContent = 'Loading…';
  try {
    const ann = await fetchAnnouncement();
    if (ann) {
      currentAnnouncementId = ann.id;
      document.getElementById('announcement-title').value = ann.title || '';
      document.getElementById('announcement-content').innerHTML = ann.content || '';
      document.getElementById('announcement-visible').checked = ann.is_visible ?? false;
      statusEl.textContent = ann.updated_at
        ? `Last saved ${new Date(ann.updated_at).toLocaleString()}`
        : '';
      updateAnnouncementPreview();
    } else {
      currentAnnouncementId = null;
      statusEl.textContent = 'No announcement yet — create one below.';
    }
  } catch (e) {
    statusEl.textContent = 'Failed to load.';
    console.error(e);
  }
}

function updateAnnouncementPreview() {
  const title = document.getElementById('announcement-title').value.trim();
  const contentEl = document.getElementById('announcement-content');
  const content = contentEl.innerHTML.trim();
  const preview = document.getElementById('announcement-preview');
  if (!title && (!content || content === '<br>')) {
    preview.style.display = 'none';
    return;
  }
  preview.style.display = 'block';
  document.getElementById('announcement-preview-title').textContent = title;
  document.getElementById('announcement-preview-content').innerHTML = content;
}

async function saveAnnouncement() {
  const title = document.getElementById('announcement-title').value.trim();
  const content = document.getElementById('announcement-content').innerHTML.trim();
  const is_visible = document.getElementById('announcement-visible').checked;
  const btn = document.getElementById('btn-save-announcement');
  const statusEl = document.getElementById('announcement-status');

  if (!title && !content) {
    showToast('Please enter a title or content.', true);
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const result = await upsertAnnouncement(currentAnnouncementId, title, content, is_visible);
    if (!currentAnnouncementId && result?.length) {
      currentAnnouncementId = result[0].id;
    }
    statusEl.textContent = `Saved ${new Date().toLocaleString()}`;
    showToast('Announcement saved successfully.');
  } catch (e) {
    showToast(e.message || 'Failed to save announcement.', true);
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Announcement';
  }
}

// ─── COURT LOCK LOGIC ────────────────────────────────────────────────────────

const LOCK_TIME_SLOTS = [
  '9:00 AM – 10:00 AM',
  '10:00 AM – 11:00 AM',
  '11:00 AM – 12:00 PM',
  '12:00 PM – 1:00 PM',
  '1:00 PM – 2:00 PM',
  '2:00 PM – 3:00 PM',
  '3:00 PM – 4:00 PM',
  '4:00 PM – 5:00 PM',
  '5:00 PM – 6:00 PM',
  '6:00 PM – 7:00 PM',
  '7:00 PM – 8:00 PM',
  '8:00 PM – 9:00 PM',
  '9:00 PM – 10:00 PM',
  '10:00 PM – 11:00 PM',
  '11:00 PM – 12:00 AM',
];

const LOCK_TIME_GROUPS = [
  { label: 'Morning', icon: '☀️', slots: ['9:00 AM – 10:00 AM', '10:00 AM – 11:00 AM', '11:00 AM – 12:00 PM'] },
  { label: 'Afternoon', icon: '⛅', slots: ['12:00 PM – 1:00 PM', '1:00 PM – 2:00 PM', '2:00 PM – 3:00 PM', '3:00 PM – 4:00 PM', '4:00 PM – 5:00 PM'] },
  { label: 'Evening', icon: '🌙', slots: ['5:00 PM – 6:00 PM', '6:00 PM – 7:00 PM', '7:00 PM – 8:00 PM', '8:00 PM – 9:00 PM', '9:00 PM – 10:00 PM', '10:00 PM – 11:00 PM', '11:00 PM – 12:00 AM'] },
];

const OP_TIME_GROUPS = [
  { label: 'Morning', icon: '☀️', slots: [
    { label: '6:00 AM', value: '06:00' }, { label: '7:00 AM', value: '07:00' },
    { label: '8:00 AM', value: '08:00' }, { label: '9:00 AM', value: '09:00' },
    { label: '10:00 AM', value: '10:00' }, { label: '11:00 AM', value: '11:00' },
  ]},
  { label: 'Afternoon', icon: '⛅', slots: [
    { label: '12:00 PM', value: '12:00' }, { label: '1:00 PM', value: '13:00' },
    { label: '2:00 PM', value: '14:00' }, { label: '3:00 PM', value: '15:00' },
    { label: '4:00 PM', value: '16:00' }, { label: '5:00 PM', value: '17:00' },
  ]},
  { label: 'Evening', icon: '🌙', slots: [
    { label: '6:00 PM', value: '18:00' }, { label: '7:00 PM', value: '19:00' },
    { label: '8:00 PM', value: '20:00' }, { label: '9:00 PM', value: '21:00' },
    { label: '10:00 PM', value: '22:00' }, { label: '11:00 PM', value: '23:00' },
    { label: 'Midnight', value: '00:00' },
  ]},
];

function opTimeChipsHTML(selectedValue, role) {
  return `<div class="op-time-picker" data-role="${role}">${
    OP_TIME_GROUPS.map(group =>
      `<div class="op-time-group">
        <div class="lock-time-group-header">
          <span class="lock-time-group-icon">${group.icon}</span>
          <span class="lock-time-group-label">${group.label}</span>
        </div>
        <div class="op-time-chips">
          ${group.slots.map(slot =>
            `<div class="op-time-chip${selectedValue === slot.value ? ' selected' : ''}" data-value="${slot.value}"><span class="lock-time-check">✓</span><span>${slot.label}</span></div>`
          ).join('')}
        </div>
      </div>`
    ).join('')
  }</div>`;
}

function renderLockCalendar() {
  const container = document.getElementById('lock-cal-days');
  const monthLabel = document.getElementById('lock-cal-month');
  if (!container || !monthLabel) return;

  const year = lockCalendarDate.getFullYear();
  const month = lockCalendarDate.getMonth();
  monthLabel.textContent = new Date(year, month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayString = todayStr();

  let html = '';
  for (let i = 0; i < firstDay; i++) {
    html += '<span class="lock-cal-day empty"></span>';
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isPast = dateStr < todayString;
    const isSelected = selectedLockDates.has(dateStr);
    const classes = ['lock-cal-day'];
    if (isPast) classes.push('past');
    if (isSelected) classes.push('selected');
    if (dateStr === todayString) classes.push('today');
    html += `<span class="${classes.join(' ')}" data-date="${dateStr}">${d}</span>`;
  }
  container.innerHTML = html;
  updateLockDatesInfo();
  attachCalendarDragEvents();
}

function attachCalendarDragEvents() {
  const container = document.getElementById('lock-cal-days');
  const days = container.querySelectorAll('.lock-cal-day:not(.empty):not(.past)');

  days.forEach(day => {
    day.addEventListener('mousedown', e => {
      e.preventDefault();
      isDraggingDates = true;
      const date = day.dataset.date;
      dragDateAdding = !selectedLockDates.has(date);
      toggleLockDate(date, dragDateAdding);
    });
    day.addEventListener('mouseenter', () => {
      if (isDraggingDates) {
        toggleLockDate(day.dataset.date, dragDateAdding);
      }
    });
    day.addEventListener('touchstart', e => {
      e.preventDefault();
      isDraggingDates = true;
      const date = day.dataset.date;
      dragDateAdding = !selectedLockDates.has(date);
      toggleLockDate(date, dragDateAdding);
    }, { passive: false });
  });

  // Bind the document-level drag terminators ONCE (they only flip a
  // module-level flag), not on every re-render — otherwise navigating months
  // accumulates duplicate handlers.
  if (!attachCalendarDragEvents._docBound) {
    document.addEventListener('mouseup', () => { isDraggingDates = false; });
    document.addEventListener('touchend', () => { isDraggingDates = false; });
    attachCalendarDragEvents._docBound = true;
  }

  container.addEventListener('touchmove', e => {
    if (!isDraggingDates) return;
    const touch = e.touches[0];
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    if (el?.classList.contains('lock-cal-day') && !el.classList.contains('empty') && !el.classList.contains('past')) {
      toggleLockDate(el.dataset.date, dragDateAdding);
    }
  }, { passive: false });
}

function toggleLockDate(dateStr, add) {
  if (add) {
    selectedLockDates.add(dateStr);
  } else {
    selectedLockDates.delete(dateStr);
  }
  const el = document.querySelector(`.lock-cal-day[data-date="${dateStr}"]`);
  if (el) el.classList.toggle('selected', add);
  updateLockDatesInfo();
}

function updateLockDatesInfo() {
  const el = document.getElementById('lock-dates-info');
  if (!el) return;
  const count = selectedLockDates.size;
  el.textContent = count === 0 ? 'No dates selected' : `${count} date${count !== 1 ? 's' : ''} selected`;
}

function renderLockTimeGrid() {
  const container = document.getElementById('lock-time-grid');
  if (!container) return;

  container.innerHTML = LOCK_TIME_GROUPS.map(group => `
    <div class="lock-time-group">
      <div class="lock-time-group-header">
        <span class="lock-time-group-icon">${group.icon}</span>
        <span class="lock-time-group-label">${group.label}</span>
      </div>
      <div class="lock-time-chips">
        ${group.slots.map(slot => `
          <div class="lock-time-slot${selectedLockTimes.has(slot) ? ' selected' : ''}" data-slot="${slot}">
            <span class="lock-time-check">✓</span>
            <span class="lock-time-label">${slot}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');

  updateLockTimesInfo();
  attachTimeDragEvents();
}

function attachTimeDragEvents() {
  const container = document.getElementById('lock-time-grid');
  const slots = container.querySelectorAll('.lock-time-slot');

  slots.forEach(slot => {
    slot.addEventListener('mousedown', e => {
      e.preventDefault();
      isDraggingTimes = true;
      const s = slot.dataset.slot;
      dragTimeAdding = !selectedLockTimes.has(s);
      toggleLockTime(s, dragTimeAdding);
    });
    slot.addEventListener('mouseenter', () => {
      if (isDraggingTimes) {
        toggleLockTime(slot.dataset.slot, dragTimeAdding);
      }
    });
    slot.addEventListener('touchstart', e => {
      e.preventDefault();
      isDraggingTimes = true;
      const s = slot.dataset.slot;
      dragTimeAdding = !selectedLockTimes.has(s);
      toggleLockTime(s, dragTimeAdding);
    }, { passive: false });
  });

  // Bind once (see attachCalendarDragEvents) to avoid handler accumulation.
  if (!attachTimeDragEvents._docBound) {
    document.addEventListener('mouseup', () => { isDraggingTimes = false; });
    document.addEventListener('touchend', () => { isDraggingTimes = false; });
    attachTimeDragEvents._docBound = true;
  }

  container.addEventListener('touchmove', e => {
    if (!isDraggingTimes) return;
    const touch = e.touches[0];
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    if (el?.classList.contains('lock-time-slot')) {
      toggleLockTime(el.dataset.slot, dragTimeAdding);
    }
  }, { passive: false });
}

function toggleLockTime(slot, add) {
  if (add) {
    selectedLockTimes.add(slot);
  } else {
    selectedLockTimes.delete(slot);
  }
  const el = document.querySelector(`.lock-time-slot[data-slot="${slot}"]`);
  if (el) el.classList.toggle('selected', add);
  updateLockTimesInfo();
}

function updateLockTimesInfo() {
  const el = document.getElementById('lock-times-info');
  if (!el) return;
  const count = selectedLockTimes.size;
  el.textContent = count === 0 ? 'No times selected' : `${count} slot${count !== 1 ? 's' : ''} selected`;
}

async function lockSelectedSlots() {
  if (selectedLockDates.size === 0) {
    showToast('Please select at least one date.', true);
    return;
  }
  if (selectedLockTimes.size === 0) {
    showToast('Please select at least one time slot.', true);
    return;
  }

  const courtVal = document.getElementById('lock-court').value;
  const reason = document.getElementById('lock-reason').value.trim();
  const courts = courtVal === 'all' ? activeCourts().map(c => c.id) : [parseInt(courtVal)];
  const lockGroup = `lock_${Date.now()}`;

  // Check for duplicates against existing locks
  const duplicates = [];
  for (const date of selectedLockDates) {
    for (const slot of selectedLockTimes) {
      for (const court_id of courts) {
        const exists = allCourtLocks.some(l => l.date === date && l.time_slot === slot && l.court_id === court_id);
        if (exists) duplicates.push(`${date} ${slot} (Court ${court_id})`);
      }
    }
  }

  if (duplicates.length > 0) {
    showToast(`Some slots are already locked: ${duplicates.slice(0, 3).join(', ')}${duplicates.length > 3 ? ` +${duplicates.length - 3} more` : ''}.`, true, 5000);
    return;
  }

  const locks = [];
  for (const date of selectedLockDates) {
    for (const slot of selectedLockTimes) {
      for (const court_id of courts) {
        locks.push({ date, time_slot: slot, court_id, reason, lock_group: lockGroup });
      }
    }
  }

  const btn = document.getElementById('btn-lock-slots');
  btn.disabled = true;
  btn.textContent = 'Locking…';

  try {
    await createCourtLocks(locks);
    showToast(`Locked ${locks.length} slot${locks.length !== 1 ? 's' : ''} successfully.`);
    selectedLockDates.clear();
    selectedLockTimes.clear();
    renderLockCalendar();
    renderLockTimeGrid();
    document.getElementById('lock-reason').value = '';
    loadCourtLocks();
  } catch (e) {
    showToast(e.message || 'Failed to lock slots.', true);
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔒 Lock Selected Slots';
  }
}

// ─── LOCK MONTH ──────────────────────────────────────────────────────────────

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function openLockMonthModal() {
  selectedLockMonths.clear();
  renderLockMonthGrid();
  document.getElementById('lock-month-modal').classList.add('show');
}

function closeLockMonthModal() {
  document.getElementById('lock-month-modal').classList.remove('show');
  selectedLockMonths.clear();
}

function renderLockMonthGrid() {
  const grid = document.getElementById('lock-month-grid');
  const now = new Date();
  const year = now.getFullYear();
  const currentMonthKey = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  grid.innerHTML = MONTH_NAMES.map((name, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    const isPast = key < currentMonthKey;
    const isSelected = selectedLockMonths.has(key);
    return `<button class="lock-month-btn${isSelected ? ' selected' : ''}${isPast ? ' past' : ''}" data-month="${key}">
      <span class="lock-month-name">${name}</span>
      <span class="lock-month-year">${year}</span>
    </button>`;
  }).join('');

  grid.querySelectorAll('.lock-month-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.month;
      if (selectedLockMonths.has(key)) {
        selectedLockMonths.delete(key);
        btn.classList.remove('selected');
      } else {
        selectedLockMonths.add(key);
        btn.classList.add('selected');
      }
    });
  });
}

function openLockMonthConfirmModal() {
  if (selectedLockMonths.size === 0) {
    showToast('Select at least one month.', true);
    return;
  }

  const monthList = [...selectedLockMonths].sort().map(key => {
    const [y, m] = key.split('-');
    return `${MONTH_NAMES[parseInt(m) - 1]} ${y}`;
  }).join(', ');

  const totalDays = [...selectedLockMonths].reduce((sum, key) => {
    const [y, m] = key.split('-').map(Number);
    return sum + new Date(y, m, 0).getDate();
  }, 0);

  const courtCount = activeCourts().length;
  const slotCount = LOCK_TIME_SLOTS.length;

  document.getElementById('lock-month-confirm-summary').innerHTML =
    `<strong>${monthList}</strong> will be fully locked.<br>` +
    `${totalDays} days × ${slotCount} time slots × ${courtCount} court${courtCount !== 1 ? 's' : ''} = <strong>${(totalDays * slotCount * courtCount).toLocaleString()} lock records</strong>.`;

  document.getElementById('lock-month-confirm-modal').classList.add('show');
}

function closeLockMonthConfirmModal() {
  document.getElementById('lock-month-confirm-modal').classList.remove('show');
}

async function executeLockMonths() {
  const reason = 'Month Lock';
  const courtIds = activeCourts().map(c => c.id);

  if (courtIds.length === 0) {
    showToast('No courts loaded. Reload the page and try again.', true);
    return;
  }

  const locks = [];
  for (const key of selectedLockMonths) {
    const [year, month] = key.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const lockGroup = `month-lock-${key}-${Date.now()}`;
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      for (const slot of LOCK_TIME_SLOTS) {
        for (const court_id of courtIds) {
          locks.push({ date: dateStr, time_slot: slot, court_id, reason, lock_group: lockGroup });
        }
      }
    }
  }

  const btn = document.getElementById('lock-month-confirm-ok');
  btn.disabled = true;
  btn.textContent = 'Locking…';

  try {
    const BATCH = 500;
    let failed = 0;
    for (let i = 0; i < locks.length; i += BATCH) {
      try {
        await createCourtLocks(locks.slice(i, i + BATCH));
      } catch {
        failed++;
      }
    }
    if (failed > 0) {
      showToast(`Partially locked — ${failed} batch(es) failed. Try again to fill gaps.`, true);
    } else {
      showToast(`Locked ${selectedLockMonths.size} month${selectedLockMonths.size !== 1 ? 's' : ''} successfully.`);
    }
    closeLockMonthConfirmModal();
    closeLockMonthModal();
    loadCourtLocks();
  } catch (e) {
    showToast(e.message || 'Failed to lock months.', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Yes, Lock All';
  }
}

async function loadCourtLocks() {
  const container = document.getElementById('locks-list');
  if (!container) return;

  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>Loading locks…</div>';

  try {
    await deleteExpiredCourtLocks();
    allCourtLocks = await fetchCourtLocks();
    renderCourtLocks();
  } catch (e) {
    container.innerHTML = '<div class="table-empty"><div class="icon">⚠️</div><p>Failed to load locks</p></div>';
    console.error(e);
  }
}

function renderCourtLocks() {
  const container = document.getElementById('locks-list');
  if (!container) return;

  const today = todayStr();
  const activeLocks = allCourtLocks.filter(l => l.date >= today);

  if (activeLocks.length === 0) {
    container.innerHTML = '<div class="table-empty"><div class="icon">🔓</div><p>No active locks</p><div class="sub">Lock some slots above to prevent bookings</div></div>';
    return;
  }

  // Group by lock_group or by date+court+reason
  const groups = {};
  for (const lock of activeLocks) {
    const key = lock.lock_group || `${lock.date}_${lock.court_id}_${lock.reason || ''}`;
    if (!groups[key]) {
      groups[key] = { key, reason: lock.reason, locks: [] };
    }
    groups[key].locks.push(lock);
  }

  const groupList = Object.values(groups).sort((a, b) => {
    const ad = a.locks[0]?.date || '';
    const bd = b.locks[0]?.date || '';
    return ad.localeCompare(bd);
  });

  container.innerHTML = groupList.map(g => {
    const dates = [...new Set(g.locks.map(l => l.date))].sort();
    const courts = [...new Set(g.locks.map(l => l.court_id))].sort();
    const times = [...new Set(g.locks.map(l => l.time_slot))];
    const dateDisplay = dates.length === 1
      ? formatDisplayDate(dates[0])
      : `${formatDisplayDate(dates[0])} — ${formatDisplayDate(dates[dates.length - 1])} (${dates.length} days)`;
    const activeIds = activeCourts().map(c => c.id);
    const coversAllCourts = activeIds.length > 0 && activeIds.every(id => courts.includes(id));
    const courtDisplay = coversAllCourts
      ? 'All Courts'
      : courts.map(c => allCourts.find(ct => ct.id === c)?.name || `Court ${c}`).join(', ');

    return `
      <div class="lock-card">
        <div class="lock-card-header">
          <div class="lock-card-info">
            <div class="lock-card-dates">${dateDisplay}</div>
            <div class="lock-card-meta">
              <span class="lock-court-tag">${courtDisplay}</span>
              <span>${times.length} time slot${times.length !== 1 ? 's' : ''}</span>
              ${g.reason ? `<span class="lock-reason-tag">${g.reason}</span>` : ''}
            </div>
          </div>
          <button class="btn-delete" data-lock-group="${g.key}">Unlock</button>
        </div>
        <div class="lock-card-times">${times.map(t => `<span class="lock-time-tag">${t}</span>`).join('')}</div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.btn-delete[data-lock-group]').forEach(btn => {
    btn.addEventListener('click', () => openDeleteLockModal(btn.dataset.lockGroup));
  });
}

function openDeleteLockModal(groupKey) {
  pendingDeleteLockGroup = groupKey;
  document.getElementById('delete-lock-modal').classList.add('show');
}

function closeDeleteLockModal() {
  pendingDeleteLockGroup = null;
  document.getElementById('delete-lock-modal').classList.remove('show');
}

async function confirmDeleteLock() {
  if (!pendingDeleteLockGroup) return;
  const groupKey = pendingDeleteLockGroup;
  closeDeleteLockModal();

  try {
    await deleteCourtLockGroup(groupKey);
    allCourtLocks = allCourtLocks.filter(l => {
      const key = l.lock_group || `${l.date}_${l.court_id}_${l.reason || ''}`;
      return key !== groupKey;
    });
    renderCourtLocks();
    showToast('Slots unlocked successfully.');
  } catch (e) {
    showToast(e.message || 'Failed to unlock slots.', true);
    console.error(e);
  }
}

// ─── OPEN PLAY LOGIC ─────────────────────────────────────────────────────────

function fmt12(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

function fmtDateLabel(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

// A session is "passed" once its real end moment is behind `now`.
// End times here are <= start times (e.g. 6:00 PM → 12:00 AM), so the
// session crosses midnight and actually ends the NEXT day at end_time.
function isSessionPassed(s, now) {
  if (!s || !s.date) return false; // no date (unsaved) → never auto-deleted
  const [y, mo, d] = s.date.split('-').map(Number);
  const end = s.end_time || null;

  // No end time: passed once the calendar day is fully over (next day 00:00).
  if (!end) {
    return now >= new Date(y, mo - 1, d + 1, 0, 0, 0);
  }

  const [eh, em] = end.split(':').map(Number);
  let dayOffset = 0;
  if (s.start_time) {
    const [sh, sm] = s.start_time.split(':').map(Number);
    if (eh * 60 + em <= sh * 60 + sm) dayOffset = 1; // crosses midnight
  }
  return now > new Date(y, mo - 1, d + dayOffset, eh, em, 0);
}

async function loadOpenPlay() {
  const container = document.getElementById('open-play-list');
  if (!container) return;
  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>Loading…</div>';
  try {
    const sessions = await fetchAllOpenPlaySessions();
    const now = new Date();
    const active = [];
    const passedIds = [];
    sessions.forEach(s => {
      if (isSessionPassed(s, now)) passedIds.push(s.id);
      else active.push(s);
    });

    // Soft-delete passed sessions (fire-and-forget; retried on next load).
    passedIds.forEach(id => softDeleteOpenPlaySession(id).catch(err =>
      console.error('Auto-delete failed for session', id, err)));

    let counts = {};
    try {
      counts = await fetchOpenPlayRegistrationCounts(active.map(s => s.id));
    } catch (err) {
      console.error('Failed to load registration counts', err);
    }
    renderOpenPlayTable(active, counts);
  } catch (e) {
    container.innerHTML = '<div class="table-empty"><div class="icon">⚠️</div><p>Failed to load sessions</p></div>';
    console.error(e);
  }
}

function renderOpenPlayTable(sessions, counts = {}) {
  const container = document.getElementById('open-play-list');
  if (!container) return;

  if (sessions.length === 0) {
    container.innerHTML = `
      <div class="table-empty">
        <div class="icon">📋</div>
        <p>No schedules yet</p>
        <div class="sub">Click "+ Add Schedule" to create one</div>
      </div>`;
    return;
  }

  container.innerHTML = sessions.map(s => renderSessionRow(s, counts[s.id] || 0)).join('');
  attachRowListeners(container);
}

function renderSessionRow(s = {}, count = 0) {
  const id = s.id || '';
  const isNew = !id;
  const dateLabel = s.date ? fmtDateLabel(s.date) : 'New schedule';
  const timeLabel = (s.start_time || s.end_time)
    ? `${fmt12(s.start_time)} – ${fmt12(s.end_time)}`
    : 'Set time';
  const countLabel = id ? `${count} / ${s.max_players ?? '—'} players` : '';
  return `
    <div class="op-session-row${isNew ? ' op-session-new op-expanded' : ''}" data-id="${id}" data-count="${count}">
      <div class="op-row-header">
        <div class="op-select-checkbox-wrap">
          <input type="checkbox" />
        </div>
        <span class="op-chevron">▸</span>
        <div class="op-row-summary">
          <span class="op-row-date">${dateLabel}</span>
          <span class="op-row-time">${timeLabel}</span>
        </div>
        <span class="op-row-count">${countLabel}</span>
        <label class="op-toggle op-row-toggle" title="Enabled">
          <input type="checkbox" class="op-enabled" ${s.is_enabled ? 'checked' : ''} />
          <span class="op-toggle-track"><span class="op-toggle-thumb"></span></span>
        </label>
      </div>
      <div class="op-session-detail">
        <div class="op-session-fields">
          <div class="input-group">
            <label>Date</label>
            <input type="date" class="op-date" value="${s.date || ''}" />
          </div>
          <div class="input-group">
            <label>Start</label>
            <input type="time" class="op-start" value="${s.start_time || ''}" />
          </div>
          <div class="input-group">
            <label>End</label>
            <input type="time" class="op-end" value="${s.end_time || ''}" />
          </div>
          <div class="input-group">
            <label>Price (₱)</label>
            <input type="number" class="op-price" min="0" placeholder="50" value="${s.price_per_player ?? ''}" />
          </div>
          <div class="input-group">
            <label>Max Players</label>
            <input type="number" class="op-max" min="1" placeholder="20" value="${s.max_players ?? ''}" />
          </div>
        </div>
        <div class="op-session-actions">
          <button class="op-btn-chat" style="width:auto" ${id ? '' : 'disabled'}>💬 Chat</button>
          <button class="btn-primary op-btn-save" style="width:auto">Save</button>
          <button class="op-btn-delete btn-icon-danger" title="Delete session">✕</button>
        </div>
        <div class="op-session-status"></div>
        <div class="op-registrations-panel"></div>
      </div>
    </div>`;
}

function attachRowListeners(container) {
  container.querySelectorAll('.op-session-row').forEach(row => {
    row.querySelector('.op-enabled').addEventListener('change', () => autoSaveEnabled(row));
    row.querySelector('.op-btn-save').addEventListener('click', () => saveSessionRow(row));
    row.querySelector('.op-btn-delete').addEventListener('click', () => deleteSessionRow(row));
    const chatBtn = row.querySelector('.op-btn-chat');
    if (chatBtn) chatBtn.addEventListener('click', () => { if (row.dataset.id) openOrganizerChat(row.dataset.id); });

    const cb = row.querySelector('.op-select-checkbox-wrap input');
    cb.addEventListener('change', () => {
      const id = row.dataset.id;
      if (!id) return;
      if (cb.checked) {
        opSelectedIds.add(id);
        row.classList.add('op-row-selected');
      } else {
        opSelectedIds.delete(id);
        row.classList.remove('op-row-selected');
      }
      renderSelectToolbar();
    });

    row.querySelector('.op-row-header').addEventListener('click', e => {
      // The enabled toggle and the select checkbox handle their own clicks.
      if (e.target.closest('.op-toggle')) return;
      if (e.target.closest('.op-select-checkbox-wrap')) return;
      if (opSelectMode) {
        if (!row.dataset.id) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
        return;
      }
      toggleRowExpand(row);
    });
  });
}

async function saveSessionRow(row) {
  const id = row.dataset.id || null;
  const is_enabled = row.querySelector('.op-enabled').checked;
  const date = row.querySelector('.op-date').value || null;
  const start_time = row.querySelector('.op-start').value || null;
  const end_time = row.querySelector('.op-end').value || null;
  const price_per_player = parseInt(row.querySelector('.op-price').value) || 0;
  const max_players = parseInt(row.querySelector('.op-max').value) || 0;
  const btn = row.querySelector('.op-btn-save');
  const statusEl = row.querySelector('.op-session-status');

  if (is_enabled) {
    if (!date) { showToast('Please set a date.', true); return; }
    if (!start_time || !end_time) { showToast('Please set start and end time.', true); return; }
    if (max_players < 1) { showToast('Max players must be at least 1.', true); return; }
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const result = await upsertOpenPlaySession(id, {
      is_enabled, date, start_time, end_time, price_per_player, max_players,
      session_type: 'open',
    });
    if (!id && result?.length) {
      row.dataset.id = result[0].id;
      row.classList.remove('op-session-new');
    }
    statusEl.textContent = `Saved ${new Date().toLocaleTimeString()}`;
    showToast(is_enabled ? 'Session enabled and saved.' : 'Session saved (disabled).');
    if (row.dataset.id) renderRegistrationsPanel(row, max_players);
  } catch (e) {
    showToast(e.message || 'Failed to save session.', true);
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function autoSaveEnabled(row) {
  const id = row.dataset.id;
  if (!id) { showToast('Save the session first before toggling.', true); return; }
  const checkbox = row.querySelector('.op-enabled');
  const is_enabled = checkbox.checked;
  const statusEl = row.querySelector('.op-session-status');
  statusEl.textContent = 'Saving…';
  try {
    await upsertOpenPlaySession(id, { is_enabled });
    statusEl.textContent = `${is_enabled ? 'Enabled' : 'Disabled'} — ${new Date().toLocaleTimeString()}`;
    showToast(is_enabled ? 'Session enabled.' : 'Session disabled.');
  } catch (e) {
    checkbox.checked = !is_enabled;
    statusEl.textContent = 'Failed to update.';
    showToast(e.message || 'Failed to update enabled state.', true);
    console.error(e);
  }
}

function confirmRemovePlayer(playerName, onConfirm) {
  const modal = document.getElementById('op-remove-player-modal');
  const nameEl = document.getElementById('op-remove-player-name');
  nameEl.textContent = `Remove "${playerName}" from this session? This cannot be undone.`;
  modal.classList.add('show');

  const confirmBtn = document.getElementById('op-remove-player-confirm');
  const cancelBtn = document.getElementById('op-remove-player-cancel');

  function close() {
    modal.classList.remove('show');
    confirmBtn.replaceWith(confirmBtn.cloneNode(true));
    cancelBtn.replaceWith(cancelBtn.cloneNode(true));
  }

  document.getElementById('op-remove-player-confirm').addEventListener('click', () => {
    close();
    onConfirm();
  });
  document.getElementById('op-remove-player-cancel').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); }, { once: true });
}

async function deleteSessionRow(row) {
  const id = row.dataset.id;
  if (!id) { row.remove(); return; }
  confirmDeleteSession(async () => {
    try {
      await softDeleteOpenPlaySession(id);
      row.remove();
      const container = document.getElementById('open-play-list');
      if (!container.querySelector('.op-session-row')) {
        renderOpenPlayTable([]);
      }
    } catch (e) {
      showToast('Failed to delete session.', true);
    }
  });
}

function confirmDeleteSession(onConfirm) {
  const modal = document.getElementById('op-delete-session-modal');
  modal.classList.add('show');

  const confirmBtn = document.getElementById('op-delete-session-confirm');
  const cancelBtn = document.getElementById('op-delete-session-cancel');

  function close() {
    modal.classList.remove('show');
    confirmBtn.replaceWith(confirmBtn.cloneNode(true));
    cancelBtn.replaceWith(cancelBtn.cloneNode(true));
  }

  document.getElementById('op-delete-session-confirm').addEventListener('click', () => {
    close();
    onConfirm();
  });
  document.getElementById('op-delete-session-cancel').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); }, { once: true });
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function toggleRowExpand(row) {
  const willExpand = !row.classList.contains('op-expanded');
  row.classList.toggle('op-expanded', willExpand);
  if (willExpand && row.dataset.id) {
    const maxPlayers = parseInt(row.querySelector('.op-max').value) || 0;
    renderRegistrationsPanel(row, maxPlayers);
    if (row._opPoll) clearInterval(row._opPoll);
    row._opPoll = setInterval(() => {
      const pe = row.querySelector('.op-pending-panel');
      if (pe) renderPendingRequests(row.dataset.id, pe, row, maxPlayers);
    }, 10000);
  } else if (!willExpand && row._opPoll) {
    clearInterval(row._opPoll); row._opPoll = null;
  }
}

async function renderRegistrationsPanel(row, maxPlayers) {
  const panel = row.querySelector('.op-registrations-panel');
  if (!row.classList.contains('op-expanded')) return;
  const sessionId = row.dataset.id;
  if (!sessionId) return;

  panel.innerHTML = `<div class="op-pending-panel"></div><div class="op-confirmed-panel"><div class="loading-spinner"><div class="spinner"></div>Loading registrations…</div></div>`;
  const pendingEl = panel.querySelector('.op-pending-panel');
  const confirmedEl = panel.querySelector('.op-confirmed-panel');

  renderPendingRequests(sessionId, pendingEl, row, maxPlayers);

  try {
    const regs = await fetchOpenPlayRegistrations(sessionId);
    // Keep the collapsed header count in sync with the live list.
    row.dataset.count = regs.length;
    const countEl = row.querySelector('.op-row-count');
    if (countEl) countEl.textContent = `${regs.length} / ${maxPlayers || '—'} players`;
    const spotsLeft = maxPlayers - regs.length;

    if (regs.length === 0) {
      confirmedEl.innerHTML = `
        <div class="table-empty">
          <div class="icon">📋</div>
          <p>No confirmed players yet</p>
          <div class="sub">Approved players will appear here</div>
        </div>`;
      return;
    }

    confirmedEl.innerHTML = `
      <div class="op-reg-header">
        <span class="op-reg-count">${regs.length} confirmed</span>
        <span class="op-spots-left ${spotsLeft <= 0 ? 'op-full' : ''}">${spotsLeft <= 0 ? 'Session Full' : `${spotsLeft} spot${spotsLeft !== 1 ? 's' : ''} left`}</span>
      </div>
      <div class="op-reg-list">
        ${regs.map((r, i) => `
          <div class="op-reg-item">
            <span class="op-reg-num">${i + 1}</span>
            <div class="op-reg-info">
              <span class="op-reg-name">${escHtml(r.player_name || '—')}</span>
              <span class="op-reg-phone">${escHtml(r.mobile || '—')}</span>
            </div>
            <span class="op-reg-time">${r.joined_at ? new Date(r.joined_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''}</span>
            <button class="op-reg-delete" data-id="${r.id}" title="Remove player">✕</button>
          </div>`).join('')}
      </div>`;

    confirmedEl.querySelectorAll('.op-reg-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const playerName = btn.closest('.op-reg-item').querySelector('.op-reg-name').textContent;
        confirmRemovePlayer(playerName, async () => {
          try {
            await deleteOpenPlayRegistration(btn.dataset.id);
            renderRegistrationsPanel(row, maxPlayers);
          } catch (e) {
            showToast('Failed to remove player.', true);
          }
        });
      });
    });
  } catch (e) {
    confirmedEl.innerHTML = '<div class="table-empty"><div class="icon">⚠️</div><p>Failed to load registrations</p></div>';
    console.error(e);
  }
}

async function renderPendingRequests(sessionId, containerEl, row, maxPlayers) {
  if (!containerEl) return;
  let reqs;
  try { reqs = await fetchOpenPlayRequests(sessionId); }
  catch (e) { containerEl.innerHTML = ''; return; }
  if (!reqs.length) { containerEl.innerHTML = ''; return; }
  containerEl.innerHTML = `
    <div class="op-pending-title" style="font-weight:700;margin:0.5rem 0;">Pending requests (${reqs.length})</div>
    ${reqs.map(r => `
      <div class="op-pending-row" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #eee;">
        <span style="flex:1;">${escHtml(r.player_name || '—')} · ${escHtml(r.mobile || '—')} · ${escHtml(r.skill_level)}</span>
        <button class="btn-approve-req" data-id="${r.id}" style="background:#2e7d32;color:#fff;border:none;border-radius:8px;padding:4px 10px;cursor:pointer;">Approve</button>
        <button class="btn-decline-req" data-id="${r.id}" style="background:#c62828;color:#fff;border:none;border-radius:8px;padding:4px 10px;cursor:pointer;">Decline</button>
      </div>`).join('')}`;
  containerEl.querySelectorAll('.btn-approve-req').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    let res;
    try { res = await approveOpenPlayRequest(b.dataset.id); }
    catch (e) { showToast('Approve failed.', true); b.disabled = false; return; }
    if (res && res.ok) { showToast('Player approved.'); renderRegistrationsPanel(row, maxPlayers); }
    else { showToast(res && res.reason === 'full' ? 'Session is full.' : 'Approve failed.', true); b.disabled = false; }
  }));
  containerEl.querySelectorAll('.btn-decline-req').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await declineOpenPlayRequest(b.dataset.id); showToast('Request declined.'); }
    catch (e) { showToast('Decline failed.', true); b.disabled = false; return; }
    renderPendingRequests(sessionId, containerEl, row, maxPlayers);
  }));
}

let orgChatPoll = null;
let orgTypingPoll = null;
function openOrganizerChat(sessionId) {
  closeOrganizerChat();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay show';
  overlay.id = 'org-chat-modal';
  overlay.innerHTML = `
    <div class="modal-card" style="max-width:440px;width:92%;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <h3 style="margin:0;">Session Chat</h3>
        <button id="org-chat-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;">&times;</button>
      </div>
      <div id="org-chat-scroll" style="height:320px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:10px;padding:8px;background:#fafafa;"></div>
      <div id="org-chat-typing" class="chat-typing"></div>
      <div style="display:flex;gap:6px;margin-top:8px;">
        <input id="org-chat-input" type="text" placeholder="Reply as organizer…" style="flex:1;padding:0.55rem 0.7rem;border:1px solid #ccc;border-radius:10px;" />
        <button id="org-chat-send" style="background:#2e7d32;color:#fff;border:none;border-radius:10px;padding:0.55rem 0.9rem;font-weight:700;cursor:pointer;">Send</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#org-chat-close').addEventListener('click', closeOrganizerChat);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeOrganizerChat(); });
  const send = async () => {
    const inp = document.getElementById('org-chat-input');
    const text = inp.value.trim(); if (!text) return;
    inp.value = '';
    try { await postOpenPlayMessage(sessionId, text); } catch (e) { showToast('Message failed.', true); inp.value = text; return; }
    renderOrganizerChat(sessionId);
  };
  overlay.querySelector('#org-chat-send').addEventListener('click', send);
  overlay.querySelector('#org-chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  overlay.querySelector('#org-chat-input').addEventListener('input', () => sendOrganizerTyping(sessionId));
  overlay.querySelector('#org-chat-scroll').addEventListener('click', e => onOrgChatClick(e, sessionId));
  renderOrganizerChat(sessionId);
  orgChatPoll = setInterval(() => renderOrganizerChat(sessionId), 4000);
  orgTypingPoll = setInterval(async () => {
    const el = document.getElementById('org-chat-typing');
    if (!el) return;
    try {
      const rows = await fetchPlayersTyping(sessionId);
      el.innerHTML = rows.length
        ? `${escHtml(rows[0].actor_name || 'Player')}${rows.length > 1 ? ` +${rows.length - 1}` : ''} is typing<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>`
        : '';
    } catch (e) { /* typing table may not be migrated yet */ }
  }, 2000);
}

// Delegated clicks inside the chat scroll area: receipt images, reaction
// chips, the add-reaction button, and the emoji picker.
async function onOrgChatClick(e, sessionId) {
  const img = e.target.closest('.org-chat-img');
  if (img) { openReceiptModal(img.dataset.full); return; }

  const addBtn = e.target.closest('.chat-react-add');
  if (addBtn) {
    const mid = addBtn.dataset.mid;
    orgChatOpenPicker = orgChatOpenPicker === mid ? null : mid;
    paintOrganizerChat();
    return;
  }

  const pick = e.target.closest('.chat-react-pick');
  const chip = e.target.closest('.chat-react-chip');
  const target = pick || chip;
  if (target) {
    const mid = target.dataset.mid;
    const emoji = target.dataset.emoji;
    const mine = (orgChatData.reactions[mid] || [])
      .find(r => r.reactor_token === ORGANIZER_TOKEN)?.emoji;
    orgChatOpenPicker = null;
    try {
      if (mine === emoji) await deleteOrganizerReaction(mid);
      else await upsertOrganizerReaction(mid, emoji);
    } catch (err) {
      showToast('Reaction failed.', true);
      console.error(err);
    }
    renderOrganizerChat(sessionId);
  }
}
function closeOrganizerChat() {
  if (orgChatPoll) { clearInterval(orgChatPoll); orgChatPoll = null; }
  if (orgTypingPoll) { clearInterval(orgTypingPoll); orgTypingPoll = null; }
  const ex = document.getElementById('org-chat-modal');
  if (ex) ex.remove();
}
let orgChatData = { msgs: [], reactions: {} };
let orgChatOpenPicker = null; // message id whose emoji picker is open

async function renderOrganizerChat(sessionId) {
  const el = document.getElementById('org-chat-scroll'); if (!el) return;
  let msgs;
  try { msgs = await fetchOpenPlayMessages(sessionId); } catch (e) { return; }
  let reactions = {};
  try {
    reactions = await fetchReactionsFor((msgs || []).map(m => m.id).filter(Boolean));
  } catch (e) {
    // Reactions table may not be migrated yet — chat still works without it.
    console.error('Failed to load reactions', e);
  }
  orgChatData = { msgs: msgs || [], reactions };

  // Viewing the chat marks its player messages as read for the chat head.
  const maxPlayerId = Math.max(0, ...orgChatData.msgs
    .filter(m => !m.is_organizer && m.id).map(m => m.id));
  if (maxPlayerId > 0) {
    markSessionSeen(sessionId, maxPlayerId);
    if (chatHeadUnread[sessionId]) {
      delete chatHeadUnread[sessionId];
      renderChatHead();
    }
  }

  paintOrganizerChat();
}

function reactionRowHTML(mid, reactions, myToken) {
  const list = reactions[mid] || [];
  const counts = {};
  list.forEach(r => { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
  const mine = list.find(r => r.reactor_token === myToken)?.emoji;
  const chips = Object.entries(counts).map(([emoji, n]) =>
    `<button class="chat-react-chip${mine === emoji ? ' mine' : ''}" data-mid="${mid}" data-emoji="${escHtml(emoji)}">${escHtml(emoji)} ${n}</button>`
  ).join('');
  const picker = orgChatOpenPicker === String(mid)
    ? `<div class="chat-react-picker">${REACTION_EMOJIS.map(e =>
        `<button class="chat-react-pick${mine === e ? ' mine' : ''}" data-mid="${mid}" data-emoji="${e}">${e}</button>`
      ).join('')}</div>`
    : '';
  return `<div class="chat-react-row">${chips}<button class="chat-react-add" data-mid="${mid}" title="React">🙂<span>+</span></button>${picker}</div>`;
}

function paintOrganizerChat() {
  const el = document.getElementById('org-chat-scroll'); if (!el) return;
  const { msgs, reactions } = orgChatData;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.innerHTML = msgs.map(m => {
    const who = m.is_organizer ? 'Organizer' : (m.sender_name || 'Player');
    const align = m.is_organizer ? 'flex-end' : 'flex-start';
    const img = m.image_url
      ? `<img src="${escHtml(m.image_url)}" class="org-chat-img" data-full="${escHtml(m.image_url)}" style="max-width:180px;border-radius:8px;display:block;margin-top:4px;cursor:zoom-in;">`
      : '';
    return `<div class="org-chat-msg" style="display:flex;flex-direction:column;align-items:${align};margin-bottom:8px;">
      <div style="font-size:0.68rem;color:#888;">${escHtml(who)}</div>
      <div style="max-width:80%;background:${m.is_organizer ? '#e8f0fe' : '#f1f1f1'};border-radius:10px;padding:6px 10px;font-size:0.85rem;word-break:break-word;">${m.body ? escHtml(m.body) : ''}${img}</div>
      ${m.id ? reactionRowHTML(m.id, reactions, ORGANIZER_TOKEN) : ''}
    </div>`;
  }).join('') || '<div style="text-align:center;color:#aaa;padding:1rem;">No messages yet.</div>';
  if (nearBottom || !el.dataset.painted) el.scrollTop = el.scrollHeight;
  el.dataset.painted = '1';
}

// ─── CHAT HEAD ───────────────────────────────────────────────────────────────
// Floating bubble visible on every tab while at least one enabled Open Play
// session is "live": its date has arrived and its real end moment hasn't
// passed. Shows unread player-message counts (seen state kept per device).

let chatHeadSessions = [];
let chatHeadUnread = {};
let chatHeadPoll = null;
let chatHeadListOpen = false;

function getSeenMap() {
  try { return JSON.parse(localStorage.getItem('op_chat_seen') || '{}'); }
  catch { return {}; }
}

function markSessionSeen(sessionId, maxMsgId) {
  const m = getSeenMap();
  if ((m[sessionId] || 0) < maxMsgId) {
    m[sessionId] = maxMsgId;
    localStorage.setItem('op_chat_seen', JSON.stringify(m));
  }
}

async function refreshChatHead() {
  try {
    const sessions = await fetchAllOpenPlaySessions();
    const now = new Date();
    const today = todayStr();
    chatHeadSessions = sessions.filter(s =>
      s.is_enabled && s.date && s.date <= today && !isSessionPassed(s, now));

    if (chatHeadSessions.length) {
      const ids = chatHeadSessions.map(s => s.id);
      const msgs = await sbFetch(
        `open_play_messages?session_id=in.(${ids.join(',')})&is_organizer=eq.false&select=id,session_id`);
      const seen = getSeenMap();
      chatHeadUnread = {};
      msgs.forEach(m => {
        if (m.id > (seen[m.session_id] || 0)) {
          chatHeadUnread[m.session_id] = (chatHeadUnread[m.session_id] || 0) + 1;
        }
      });
    } else {
      chatHeadUnread = {};
      chatHeadListOpen = false;
    }
  } catch (e) {
    console.error('Chat head refresh failed', e);
  }
  renderChatHead();
}

function renderChatHead() {
  const head = document.getElementById('chat-head');
  if (!head) return;
  const loggedIn = document.getElementById('admin-app')?.classList.contains('visible');
  if (!loggedIn || chatHeadSessions.length === 0) {
    head.style.display = 'none';
    return;
  }
  head.style.display = 'block';

  const totalUnread = Object.values(chatHeadUnread).reduce((a, b) => a + b, 0);
  const badge = document.getElementById('chat-head-badge');
  badge.style.display = totalUnread > 0 ? 'flex' : 'none';
  badge.textContent = totalUnread > 99 ? '99+' : totalUnread;
  document.getElementById('chat-head-btn').classList.toggle('pulse', totalUnread > 0);

  const list = document.getElementById('chat-head-list');
  if (!chatHeadListOpen) { list.innerHTML = ''; list.style.display = 'none'; return; }
  list.style.display = 'block';
  list.innerHTML = `
    <div class="chat-head-list-title">Live Open Play chats</div>
    ${chatHeadSessions.map(s => {
      const unread = chatHeadUnread[s.id] || 0;
      return `<button class="chat-head-item" data-id="${s.id}">
        <span class="chat-head-item-main">
          <span class="chat-head-item-date">${fmtDateLabel(s.date)}</span>
          <span class="chat-head-item-time">${fmt12(s.start_time)} – ${fmt12(s.end_time)}</span>
        </span>
        ${unread ? `<span class="chat-head-item-unread">${unread}</span>` : ''}
      </button>`;
    }).join('')}`;
  list.querySelectorAll('.chat-head-item').forEach(btn => {
    btn.addEventListener('click', () => {
      chatHeadListOpen = false;
      renderChatHead();
      openOrganizerChat(btn.dataset.id);
    });
  });
}

function startChatHead() {
  refreshChatHead();
  if (!chatHeadPoll) chatHeadPoll = setInterval(refreshChatHead, 15000);
}

function stopChatHead() {
  if (chatHeadPoll) { clearInterval(chatHeadPoll); chatHeadPoll = null; }
  chatHeadSessions = [];
  chatHeadUnread = {};
  chatHeadListOpen = false;
  renderChatHead();
}

// ─── COURTS MANAGEMENT ────────────────────────────────────────────────────────

const COURT_COLORS = ['#4a90d9', '#7b4ea6', '#c0392b', '#27ae60', '#e67e22'];

let editingCourtId = null;

function setLocationToggle(toggleId, value) {
  const toggle = document.getElementById(toggleId);
  if (!toggle) return;
  toggle.querySelectorAll('.location-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
  const hidden = toggle.querySelector('input[type="hidden"]');
  if (hidden) hidden.value = value;
}

function openEditCourtModal(court) {
  editingCourtId = court.id;
  document.getElementById('edit-court-name').value = court.name;
  setLocationToggle('edit-location-toggle', court.type);
  document.getElementById('edit-court-error').textContent = '';
  document.getElementById('edit-court-modal').classList.add('show');
}

function closeEditCourtModal() {
  editingCourtId = null;
  document.getElementById('edit-court-modal').classList.remove('show');
}

async function handleEditCourt() {
  const name = document.getElementById('edit-court-name').value.trim();
  const type = document.getElementById('edit-court-type').value;
  const errEl = document.getElementById('edit-court-error');
  const btn = document.getElementById('btn-save-court');

  errEl.textContent = '';

  if (!name) { errEl.textContent = 'Court name is required.'; return; }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    // Price is set in the global Court Pricing tab now — only name/type here.
    await updateCourt(editingCourtId, { name, type });
    allCourts = await fetchCourts();
    populateCourtDropdowns();
    renderCourtsTab();
    closeEditCourtModal();
    showToast('Court updated successfully.');
  } catch (e) {
    errEl.textContent = 'Failed to update court. Try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
}

function renderCourtsTab() {
  const list = document.getElementById('courts-list');
  if (!list) return;

  if (allCourts.length === 0) {
    list.innerHTML = '<p class="empty-state">No courts yet. Add one below.</p>';
    return;
  }

  list.innerHTML = allCourts.map((court, i) => {
    const color = COURT_COLORS[i % COURT_COLORS.length];
    return `
      <div class="court-item ${court.is_active ? '' : 'court-inactive'}">
        <div class="court-item-color" style="background:${color}"></div>
        <div class="court-item-info">
          <div class="court-item-name">${court.name}</div>
          <div class="court-item-meta">${court.type} · ₱${court.price_per_hour}/hr</div>
        </div>
        <div class="court-item-actions">
          <button class="btn-court-edit" data-id="${court.id}">Edit</button>
          <button class="btn-court-toggle ${court.is_active ? 'btn-deactivate' : 'btn-activate'}"
            data-id="${court.id}" data-active="${court.is_active}">
            ${court.is_active ? 'Deactivate' : 'Activate'}
          </button>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.btn-court-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const court = allCourts.find(c => c.id === parseInt(btn.dataset.id));
      if (court) openEditCourtModal(court);
    });
  });

  list.querySelectorAll('.btn-court-toggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id);
      const currentlyActive = btn.dataset.active === 'true';
      btn.disabled = true;
      try {
        await updateCourt(id, { is_active: !currentlyActive });
        allCourts = await fetchCourts();
        populateCourtDropdowns();
        renderCourtsTab();
        showToast(`Court ${currentlyActive ? 'deactivated' : 'activated'}.`);
      } catch (e) {
        showToast('Failed to update court.');
        btn.disabled = false;
      }
    });
  });
}

async function handleAddCourt() {
  const name = document.getElementById('court-name').value.trim();
  const type = document.getElementById('court-type').value;
  const errEl = document.getElementById('court-form-error');
  const btn = document.getElementById('btn-add-court');

  errEl.textContent = '';

  if (!name) { errEl.textContent = 'Court name is required.'; return; }

  const maxOrder = allCourts.reduce((m, c) => Math.max(m, c.sort_order), 0);
  // Per-court price is just a fallback now (real prices come from the global
  // Court Pricing tab), so seed new courts with the current daytime rate.
  const fallbackPrice = Number(pricingSettings?.daytime_rate) || 100;

  btn.disabled = true;
  btn.textContent = 'Adding…';

  try {
    await createCourt({ name, type, price_per_hour: fallbackPrice, is_active: true, sort_order: maxOrder + 1 });
    allCourts = await fetchCourts();
    populateCourtDropdowns();
    renderCourtsTab();
    document.getElementById('court-name').value = '';
    showToast(`${name} added successfully.`);
  } catch (e) {
    errEl.textContent = 'Failed to add court. Try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = '+ Add Court';
  }
}

// ─── PRICING SETTINGS LOGIC ───────────────────────────────────────────────────

// Evening rate begins at 6 PM (18:00). Fixed in code — the admin only sets the
// two rates, never the cutoff time.
const EVENING_START_HOUR = 18;

function hourLabel(h) {
  const ampm = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12} ${ampm}`;
}

function updatePricingHint() {
  const hint = document.getElementById('pricing-hint');
  if (!hint) return;
  const d = document.getElementById('pricing-daytime').value;
  const e = document.getElementById('pricing-evening').value;
  if (d && e) {
    hint.textContent = `Players pay ₱${d}/hr for slots starting before ${hourLabel(EVENING_START_HOUR)}, then ₱${e}/hr from ${hourLabel(EVENING_START_HOUR)} onward.`;
  } else {
    hint.textContent = '';
  }
}

async function loadPricing() {
  const errEl = document.getElementById('pricing-form-error');
  if (errEl) errEl.textContent = '';
  try {
    const row = await fetchPricingSettings();
    if (row) {
      pricingSettings = row;
      document.getElementById('pricing-daytime').value = Number(row.daytime_rate);
      document.getElementById('pricing-evening').value = Number(row.evening_rate);
    } else if (errEl) {
      errEl.textContent = 'No pricing row found. Run the pricing_settings migration in Supabase first.';
    }
  } catch (e) {
    if (errEl) errEl.textContent = 'Failed to load pricing. ' + (e.message || '');
  }
  updatePricingHint();
}

async function handleSavePricing() {
  const errEl = document.getElementById('pricing-form-error');
  const btn = document.getElementById('btn-save-pricing');
  errEl.textContent = '';

  const daytime = Number(document.getElementById('pricing-daytime').value);
  const evening = Number(document.getElementById('pricing-evening').value);

  if (!(daytime > 0)) { errEl.textContent = 'Enter a valid daytime rate (greater than 0).'; return; }
  if (!(evening > 0)) { errEl.textContent = 'Enter a valid evening rate (greater than 0).'; return; }

  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const result = await updatePricingSettings({
      daytime_rate: daytime,
      evening_rate: evening,
      cutoff_hour: EVENING_START_HOUR,   // always 6 PM — kept fixed in the DB
    });
    // Verify the write landed — an RLS-blocked update returns 0 rows, not an error.
    const row = Array.isArray(result) ? result[0] : null;
    if (!row || Number(row.daytime_rate) !== daytime || Number(row.evening_rate) !== evening) {
      throw new Error('Save did not persist. Confirm the pricing_settings row exists and admin writes are allowed.');
    }
    pricingSettings = row;
    showToast('Pricing updated successfully.');
    updatePricingHint();
  } catch (e) {
    errEl.textContent = 'Failed to save pricing. ' + (e.message || '');
    showToast('Failed to save pricing.', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Pricing';
  }
}

// ─── RENDER APP ───────────────────────────────────────────────────────────────

function renderApp() {
  document.querySelector('#app').innerHTML = `
    <!-- Login -->
    <div id="login-screen" style="display:flex">
      <div class="login-wrapper">
        <img src="/BMJ COURT PICKLEBALL - PRIMARY LOGO.png" alt="BMJ Court Pickleball" class="login-logo" />
      <div class="login-card">
        <h1>Your Pickleball<br>Community</h1>
        <p>Admin Panel — Sign in to continue</p>
        <form id="login-form" autocomplete="off">
          <div class="input-group">
            <label for="login-email">Email</label>
            <input
              type="email"
              id="login-email"
              placeholder="admin@example.com"
              autocomplete="email"
              required
            />
          </div>
          <div class="input-group">
            <label for="login-password">Password</label>
            <div class="password-wrapper">
              <input
                type="password"
                id="login-password"
                placeholder="Enter password"
                autocomplete="current-password"
                required
              />
              <button type="button" class="btn-show-password" id="btn-show-password" aria-label="Show password">
                <svg id="eye-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
                <svg id="eye-off-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
              </button>
            </div>
          </div>
          <div id="login-error" class="login-error">Incorrect email or password.</div>
          <button type="submit" class="btn-primary" id="login-btn">Sign In</button>
        </form>
      </div>
      </div>
    </div>

    <!-- Admin App -->
    <div id="admin-app">
      <header class="admin-header">
        <div class="header-brand">
          Your Pickleball Community
        </div>
        <div class="header-center">
          <img src="/BMJ COURT PICKLEBALL - PRIMARY LOGO.png" alt="BMJ Court Pickleball" class="header-logo" />
        </div>
        <div class="header-right">
          <span class="header-badge">Admin</span>
          <button class="btn-header" id="btn-account">Account</button>
          <button class="btn-header btn-danger" id="btn-logout">Sign Out</button>
        </div>
      </header>

      <main class="admin-main">
        <!-- Tab Navigation -->
        <div class="tab-nav">
          <button class="tab-btn active" data-tab="bookings">
            <span class="tab-icon">📋</span>
            Bookings
            <span class="tab-badge" id="tab-bookings-badge">0</span>
          </button>
          <button class="tab-btn" data-tab="revenue">
            <span class="tab-icon">💰</span>
            Revenue
          </button>
          <button class="tab-btn" data-tab="announcements">
            <span class="tab-icon">📢</span>
            Announcements
          </button>
          <button class="tab-btn" data-tab="locks">
            <span class="tab-icon">🔒</span>
            Court Lock
          </button>
          <button class="tab-btn" data-tab="open-play">
            <span class="tab-icon">🏃</span>
            Open Play
          </button>
          <button class="tab-btn" data-tab="courts">
            <span class="tab-icon">🏓</span>
            Courts
          </button>
          <button class="tab-btn" data-tab="pricing">
            <span class="tab-icon">💵</span>
            Pricing
          </button>
        </div>

        <!-- ═══ BOOKINGS TAB ═══ -->
        <div class="tab-content active" id="tab-bookings">

          <div class="dashboard-toolbar">
            <div class="greeting" id="greeting">${getGreeting()}! Here's today's overview</div>
            <div class="toolbar-right">
              <span class="last-updated" id="last-updated"></span>
              <button class="btn-refresh" id="btn-refresh">
                <span class="refresh-icon">↻</span> Refresh
              </button>
            </div>
          </div>

          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-icon">📋</div>
              <div class="stat-label">Bookings Today</div>
              <div class="stat-value" id="stat-total">—</div>
              <div class="stat-sub">All courts combined</div>
            </div>
            <div class="stat-card revenue">
              <div class="stat-icon">💰</div>
              <div class="stat-label">Revenue Today</div>
              <div class="stat-value" id="stat-revenue">—</div>
              <div class="stat-sub">Courts + open play</div>
            </div>
            <div id="court-stat-cards"></div>
          </div>

          <div class="section-title">📋 All Bookings</div>

          <div class="filters-bar">
            <div class="filter-group">
              <label for="filter-search">Search</label>
              <input type="text" id="filter-search" placeholder="Name or phone…" />
            </div>
            <div class="filter-group">
              <label for="filter-date">Date</label>
              <input type="date" id="filter-date" />
            </div>
            <div class="filter-group">
              <label for="filter-court">Court</label>
              <select id="filter-court">
                <option value="">All Courts</option>
              </select>
            </div>
            <label class="filter-checkbox">
              <input type="checkbox" id="filter-show-past" />
              <span>Show past bookings</span>
            </label>
            <button class="btn-reset" id="btn-reset-filters">Reset</button>
          </div>

          <div class="table-wrapper">
            <div class="table-header">
              <span class="section-title" style="margin:0;font-size:0.88rem">Bookings</span>
              <div style="display:flex;align-items:center;gap:0.75rem">
                <span class="table-count" id="bookings-count">Loading…</span>
                <button class="btn-export" id="btn-export-csv">⬇ Download Past Bookings</button>
              </div>
            </div>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Phone</th>
                    <th>Court</th>
                    <th>Date</th>
                    <th>Time Range</th>
                    <th>Hours</th>
                    <th>Payment</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody id="bookings-tbody"></tbody>
              </table>
            </div>
          </div>

        </div><!-- /tab-bookings -->

        <!-- ═══ REVENUE TAB ═══ -->
        <div class="tab-content" id="tab-revenue">
          <div class="section-title">💰 Revenue Overview</div>

          <div class="revenue-period-toggle">
            <button class="rev-period-btn active" data-period="monthly">Monthly</button>
            <button class="rev-period-btn" data-period="yearly">Yearly</button>
          </div>

          <div class="revenue-summary-card">
            <div class="revenue-period-label" id="revenue-period-label">—</div>
            <div class="revenue-total-amount" id="revenue-total">₱0</div>
            <div class="revenue-meta">
              <span><strong id="revenue-bookings">0</strong> bookings</span>
              <span><strong id="revenue-hours">0h</strong> total hours</span>
              <span><strong id="revenue-op-players">0</strong> open play players</span>
            </div>
          </div>

          <div class="section-title" style="margin-top:1.5rem">By Court</div>
          <div class="revenue-grid" id="revenue-court-cards"></div>

          <div class="section-title" style="margin-top:1.5rem">Income Breakdown</div>
          <div class="revenue-grid">
            <div class="revenue-card gcash-card">
              <div class="rev-card-label">💳 QR Payment (Courts)</div>
              <div class="rev-card-amount" id="rev-gcash-amount">₱0</div>
              <div class="rev-card-meta" id="rev-gcash-count">0 hours</div>
            </div>
            <div class="revenue-card cash-card">
              <div class="rev-card-label">💵 Cash (Courts)</div>
              <div class="rev-card-amount" id="rev-cash-amount">₱0</div>
              <div class="rev-card-meta" id="rev-cash-count">0 hours</div>
            </div>
            <div class="revenue-card openplay-card">
              <div class="rev-card-label">🏃 Open Play</div>
              <div class="rev-card-amount" id="rev-openplay-amount">₱0</div>
              <div class="rev-card-meta" id="rev-openplay-count">0 players</div>
            </div>
          </div>
        </div><!-- /tab-revenue -->

        <!-- ═══ ANNOUNCEMENTS TAB ═══ -->
        <div class="tab-content" id="tab-announcements">
          <div class="section-title">📢 Announcement Board</div>
          <p class="section-desc">Edit the announcement below. When visible, it will be shown to all users on the booking page.</p>

          <div class="announcement-editor">
            <div class="announcement-toolbar">
              <label class="announcement-toggle">
                <input type="checkbox" id="announcement-visible" />
                <span class="toggle-slider"></span>
                <span class="toggle-label">Visible to users</span>
              </label>
              <span class="announcement-status" id="announcement-status"></span>
            </div>

            <div class="input-group">
              <label for="announcement-title">Title</label>
              <input type="text" id="announcement-title" placeholder="e.g. Court Maintenance Notice" />
            </div>

            <div class="input-group">
              <label for="announcement-content">Content</label>
              <div class="ann-format-bar">
                <button type="button" class="ann-fmt-btn" id="ann-btn-bold" title="Bold"><b>B</b></button>
                <button type="button" class="ann-fmt-btn" id="ann-btn-italic" title="Italic"><i>I</i></button>
                <button type="button" class="ann-fmt-btn" id="ann-btn-underline" title="Underline"><u>U</u></button>
              </div>
              <div id="announcement-content" class="ann-content-editable" contenteditable="true" data-placeholder="Write your announcement here…"></div>
            </div>

            <div class="announcement-preview" id="announcement-preview" style="display:none">
              <div class="announcement-preview-label">Preview — how users will see it</div>
              <div class="announcement-preview-title" id="announcement-preview-title"></div>
              <div class="announcement-preview-content" id="announcement-preview-content"></div>
            </div>

            <div class="announcement-actions">
              <button class="btn-primary" id="btn-save-announcement" style="width:auto">Save Announcement</button>
            </div>
          </div>
        </div><!-- /tab-announcements -->

        <!-- ═══ COURT LOCK TAB ═══ -->
        <div class="tab-content" id="tab-locks">
          <div class="lock-tab-header">
            <div>
              <div class="section-title" style="margin-bottom:0.25rem">🔒 Court Lock</div>
              <p class="section-desc" style="margin-bottom:0">Lock specific dates and times to prevent bookings. Drag to select multiple dates or time slots.</p>
            </div>
            <button class="btn-lock-month" id="btn-lock-month">🗓️ Lock Month</button>
          </div>

          <div class="lock-editor">
            <div class="lock-grid">
              <!-- Calendar -->
              <div class="lock-panel">
                <div class="lock-panel-title">Select Dates</div>
                <div class="lock-calendar">
                  <div class="lock-cal-header">
                    <button class="lock-cal-nav" id="lock-cal-prev">&#8249;</button>
                    <span class="lock-cal-month" id="lock-cal-month"></span>
                    <button class="lock-cal-nav" id="lock-cal-next">&#8250;</button>
                  </div>
                  <div class="lock-cal-weekdays">
                    <span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span>
                  </div>
                  <div class="lock-cal-days" id="lock-cal-days"></div>
                </div>
                <div class="lock-selected-info" id="lock-dates-info">No dates selected</div>
              </div>

              <!-- Time Slots -->
              <div class="lock-panel">
                <div class="lock-panel-title-row">
                  <span class="lock-panel-title" style="margin-bottom:0">Select Time Slots</span>
                  <button class="btn-lock-all-time" id="btn-lock-all-time">Lock All</button>
                </div>
                <div class="lock-time-grid" id="lock-time-grid"></div>
                <div class="lock-selected-info" id="lock-times-info">No times selected</div>
              </div>
            </div>

            <!-- Court & Reason -->
            <div class="lock-options">
              <div class="filter-group">
                <label for="lock-court">Court</label>
                <select id="lock-court">
                  <option value="all">All Courts</option>
                </select>
              </div>
              <div class="filter-group" style="flex:2">
                <label for="lock-reason">Event / Reason</label>
                <input type="text" id="lock-reason" placeholder="e.g. Tournament, Maintenance…" />
              </div>
              <button class="btn-primary btn-lock" id="btn-lock-slots">🔒 Lock Selected Slots</button>
            </div>
          </div>

          <!-- Active Locks -->
          <div class="section-title" style="margin-top:2rem">Active Locks</div>
          <div class="locks-list" id="locks-list">
            <div class="loading-spinner"><div class="spinner"></div>Loading locks…</div>
          </div>
        </div><!-- /tab-locks -->

        <!-- ═══ COURTS TAB ═══ -->
        <div class="tab-content" id="tab-courts">
          <div class="section-title">🏓 Manage Courts</div>
          <p class="section-desc">Add or deactivate courts. Changes reflect immediately on the booking page.</p>

          <div class="section-title">Add New Court</div>
          <div class="court-add-form">
            <div class="filter-group">
              <label for="court-name">Court Name</label>
              <input type="text" id="court-name" placeholder="e.g. Court 5" />
            </div>
            <div class="filter-group">
              <label>Type</label>
              <div class="location-type-toggle" id="add-location-toggle">
                <button type="button" class="location-btn active" data-value="Indoor">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                  Indoor
                </button>
                <button type="button" class="location-btn" data-value="Outdoor">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                  Outdoor
                </button>
                <input type="hidden" id="court-type" value="Indoor" />
              </div>
            </div>
            <button class="btn-primary btn-add-court" id="btn-add-court">+ Add Court</button>
          </div>
          <div class="form-error" id="court-form-error"></div>

          <div class="section-title" style="margin-top:2rem">Current Courts</div>
          <div class="courts-list" id="courts-list">
            <div class="loading-spinner"><div class="spinner"></div>Loading courts…</div>
          </div>

        </div><!-- /tab-courts -->

        <!-- ═══ PRICING TAB ═══ -->
        <div class="tab-content" id="tab-pricing">
          <div class="section-title">💵 Court Pricing</div>
          <p class="section-desc">Time-based rental rate for all courts. The rate switches automatically at <strong>6 PM</strong> — daytime before, evening after. Applies to every court and overrides the per-court "price per hour" (now only a fallback). Changes show on the booking page after the next page refresh.</p>

          <div class="court-add-form">
            <div class="filter-group">
              <label for="pricing-daytime">Daytime rate (before 6 PM)</label>
              <div class="price-input-wrapper">
                <span class="price-prefix">₱</span>
                <input type="number" id="pricing-daytime" min="1" step="1" placeholder="150" />
              </div>
            </div>
            <div class="filter-group">
              <label for="pricing-evening">Evening rate (6 PM – midnight)</label>
              <div class="price-input-wrapper">
                <span class="price-prefix">₱</span>
                <input type="number" id="pricing-evening" min="1" step="1" placeholder="200" />
              </div>
            </div>
            <button class="btn-primary" id="btn-save-pricing">Save Pricing</button>
          </div>
          <p class="section-desc" id="pricing-hint" style="margin-top:0.75rem"></p>
          <div class="form-error" id="pricing-form-error"></div>

        </div><!-- /tab-pricing -->

        <!-- ═══ OPEN PLAY TAB ═══ -->
        <div class="tab-content" id="tab-open-play">
          <div class="op-tab-header">
            <div>
              <div class="section-title">🏃 Open Play</div>
              <p class="section-desc">Manage drop-in open play schedules. Players can sign up when a session is enabled.</p>
            </div>
            <div class="op-header-actions">
              <button class="btn-select-sessions" id="btn-select-sessions">Select</button>
              <button class="btn-add-schedule" id="btn-add-open-play"><span class="btn-add-schedule-icon">＋</span> Add Schedule</button>
            </div>
          </div>

          <div id="op-select-toolbar"></div>

          <div id="open-play-list">
            <div class="table-empty">
              <div class="icon">📋</div>
              <p>No schedules yet</p>
              <div class="sub">Click "+ Add Schedule" to create one</div>
            </div>
          </div>

        </div><!-- /tab-open-play -->

      </main>
    </div>

    <!-- Account Settings Modal -->
    <div class="modal-overlay" id="account-modal">
      <div class="modal-card account-modal-card">
        <div class="account-modal-header">
          <h2>Change Password</h2>
          <button class="modal-close" id="account-modal-close">&times;</button>
        </div>

        <div class="account-tab-panel" id="tab-password">
          <div class="input-group">
            <label for="new-password">New Password</label>
            <input type="password" id="new-password" placeholder="At least 6 characters" autocomplete="new-password" />
          </div>
          <div class="input-group">
            <label for="confirm-password">Confirm Password</label>
            <input type="password" id="confirm-password" placeholder="Re-enter new password" autocomplete="new-password" />
          </div>
          <div class="form-error" id="account-password-error"></div>
          <button class="btn-primary" id="btn-change-password">Update Password</button>
        </div>
      </div>
    </div>

    <!-- Delete Confirm Modal -->
    <div class="modal-overlay" id="delete-modal">
      <div class="modal-card">
        <div class="modal-icon">🗑️</div>
        <h2>Cancel Booking?</h2>
        <p>This will permanently delete the booking and free up the time slot for other users.</p>
        <div class="modal-actions">
          <button class="btn-cancel-modal" id="modal-cancel">Keep Booking</button>
          <button class="btn-confirm-delete" id="modal-confirm">Yes, Cancel It</button>
        </div>
      </div>
    </div>

    <!-- Remove Open Play Player Modal -->
    <div class="modal-overlay" id="op-remove-player-modal">
      <div class="modal-card">
        <div class="modal-icon">👤</div>
        <h2>Remove Player?</h2>
        <p id="op-remove-player-name">This will remove the player from the session.</p>
        <div class="modal-actions">
          <button class="btn-cancel-modal" id="op-remove-player-cancel">Keep Player</button>
          <button class="btn-confirm-delete" id="op-remove-player-confirm">Yes, Remove</button>
        </div>
      </div>
    </div>

    <!-- Delete Open Play Session Modal -->
    <div class="modal-overlay" id="op-delete-session-modal">
      <div class="modal-card">
        <div class="modal-icon">🗑️</div>
        <h2>Delete Session?</h2>
        <p>This session will be hidden. Existing registrations are kept.</p>
        <div class="modal-actions">
          <button class="btn-cancel-modal" id="op-delete-session-cancel">Keep Session</button>
          <button class="btn-confirm-delete" id="op-delete-session-confirm">Yes, Delete</button>
        </div>
      </div>
    </div>

    <!-- Add Open Play Schedule Modal -->
    <div class="modal-overlay" id="op-add-modal">
      <div class="modal-card op-add-modal-card">
        <div class="account-modal-header">
          <h2>Add Open Play Schedule</h2>
          <button class="modal-close" id="op-add-modal-close">&times;</button>
        </div>

        <div id="op-modal-calendar"></div>

        <div class="op-modal-settings">
          <div class="op-time-picker-field">
            <div class="op-time-picker-field-label">Start Time</div>
            <div id="op-modal-start-picker"></div>
          </div>
          <div class="op-time-picker-field">
            <div class="op-time-picker-field-label">End Time</div>
            <div id="op-modal-end-picker"></div>
          </div>
          <div class="input-group">
            <label>Price (&#8369;)</label>
            <input type="number" id="op-modal-price" min="0" placeholder="50" />
          </div>
          <div class="input-group">
            <label>Max Players</label>
            <input type="number" id="op-modal-max" min="1" placeholder="20" />
          </div>
        </div>

        <div class="op-modal-enabled-row">
          <label>Enabled</label>
          <label class="op-toggle">
            <input type="checkbox" id="op-modal-enabled" />
            <span class="op-toggle-track"><span class="op-toggle-thumb"></span></span>
          </label>
        </div>

        <div class="modal-actions" style="margin-top:1rem">
          <button class="btn-cancel-modal" id="op-add-modal-cancel">Cancel</button>
          <button class="btn-primary" id="op-modal-save" disabled>Add Session(s)</button>
        </div>
      </div>
    </div>

    <!-- Delete Lock Confirm Modal -->
    <div class="modal-overlay" id="delete-lock-modal">
      <div class="modal-card">
        <div class="modal-icon">🔓</div>
        <h2>Remove Lock?</h2>
        <p>This will unlock the slots and allow users to book them again.</p>
        <div class="modal-actions">
          <button class="btn-cancel-modal" id="lock-modal-cancel">Keep Lock</button>
          <button class="btn-confirm-delete" id="lock-modal-confirm">Yes, Unlock</button>
        </div>
      </div>
    </div>

    <!-- Edit Court Modal -->
    <div class="modal-overlay" id="edit-court-modal">
      <div class="modal-card edit-court-modal-card">
        <div class="edit-court-modal-header">
          <h2>Edit Court</h2>
          <button class="modal-close" id="edit-court-modal-close">&times;</button>
        </div>
        <div class="edit-court-modal-body">
          <div class="input-group">
            <label for="edit-court-name">Court Name</label>
            <input type="text" id="edit-court-name" placeholder="e.g. Court 1" />
          </div>
          <div class="input-group">
            <label>Location Type</label>
            <div class="location-type-toggle" id="edit-location-toggle">
              <button type="button" class="location-btn active" data-value="Indoor">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                Indoor
              </button>
              <button type="button" class="location-btn" data-value="Outdoor">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                Outdoor
              </button>
              <input type="hidden" id="edit-court-type" value="Indoor" />
            </div>
          </div>
          <div class="form-error" id="edit-court-error"></div>
          <div class="modal-actions edit-court-actions">
            <button class="btn-cancel-modal" id="edit-court-cancel">Cancel</button>
            <button class="btn-primary btn-save-court-primary" id="btn-save-court">Save Changes</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Lock Month Modal -->
    <div class="modal-overlay" id="lock-month-modal">
      <div class="modal-card lock-month-modal-card">
        <div class="lock-month-modal-header">
          <h2>🗓️ Lock Month</h2>
          <button class="modal-close" id="lock-month-modal-close">&times;</button>
        </div>
        <p class="lock-month-modal-desc">Select months to lock — all days, all time slots, all courts.</p>
        <div class="lock-month-grid" id="lock-month-grid"></div>
        <div class="modal-actions" style="margin-top:1.25rem">
          <button class="btn-cancel-modal" id="lock-month-cancel">Cancel</button>
          <button class="btn-primary" id="btn-lock-month-next">Lock Selected Months</button>
        </div>
      </div>
    </div>

    <!-- Lock Month Confirm Modal -->
    <div class="modal-overlay" id="lock-month-confirm-modal">
      <div class="modal-card">
        <div class="modal-icon">🔒</div>
        <h2>Lock These Months?</h2>
        <p id="lock-month-confirm-summary" style="line-height:1.7"></p>
        <div class="modal-actions" style="margin-top:1.5rem">
          <button class="btn-cancel-modal" id="lock-month-confirm-cancel">Cancel</button>
          <button class="btn-confirm-delete" id="lock-month-confirm-ok">Yes, Lock All</button>
        </div>
      </div>
    </div>

    <!-- Receipt / chat image viewer -->
    <div class="modal-overlay" id="receipt-modal">
      <div class="modal-card receipt-modal-card">
        <div class="account-modal-header">
          <h2>Receipt</h2>
          <button class="modal-close" id="receipt-modal-close">&times;</button>
        </div>
        <div class="receipt-modal-body">
          <div id="receipt-loading" class="loading-spinner" style="display:none"><div class="spinner"></div>Loading image…</div>
          <div id="receipt-error" style="display:none;text-align:center;color:#c62828;padding:1rem;">Couldn't load the image.</div>
          <img id="receipt-img" alt="Receipt" style="display:none" />
        </div>
        <a id="receipt-open-link" href="#" target="_blank" rel="noopener" class="receipt-open-link">Open full size in new tab ↗</a>
      </div>
    </div>

    <!-- Floating Open Play chat head (only while a session is live) -->
    <div id="chat-head" style="display:none">
      <div id="chat-head-list" style="display:none"></div>
      <button id="chat-head-btn" title="Open Play chat" aria-label="Open Play chat">
        💬
        <span id="chat-head-badge" class="chat-head-badge" style="display:none"></span>
      </button>
    </div>

    <!-- Toast container -->
    <div class="toast-container"></div>
  `;

  // ─── EVENT LISTENERS ─────────────────────────────────

  // Login form
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const errEl = document.getElementById('login-error');
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    btn.disabled = true;
    btn.textContent = 'Signing in…';
    errEl.classList.remove('show');

    try {
      await signIn(email, password);
      showAdmin();
    } catch {
      if (!navigator.onLine && getToken()) {
        showAdmin();
        showToast('You are offline. Showing cached session.', true);
      } else {
        errEl.classList.add('show');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });

  // Show/hide password
  document.getElementById('btn-show-password').addEventListener('click', () => {
    const input = document.getElementById('login-password');
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    document.getElementById('eye-icon').style.display = isPassword ? 'none' : '';
    document.getElementById('eye-off-icon').style.display = isPassword ? '' : 'none';
  });

  // Logout
  document.getElementById('btn-logout').addEventListener('click', logout);

  // Account modal
  document.getElementById('btn-account').addEventListener('click', openAccountModal);
  document.getElementById('account-modal-close').addEventListener('click', closeAccountModal);
  document.getElementById('account-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeAccountModal();
  });
  document.getElementById('btn-change-password').addEventListener('click', handleChangePassword);

  // Filters
  document.getElementById('filter-search').addEventListener('input', applyFilters);
  document.getElementById('filter-date').addEventListener('change', applyFilters);
  document.getElementById('filter-court').addEventListener('change', applyFilters);
  document.getElementById('filter-show-past').addEventListener('change', applyFilters);
  document.getElementById('btn-reset-filters').addEventListener('click', () => {
    document.getElementById('filter-search').value = '';
    document.getElementById('filter-date').value = '';
    document.getElementById('filter-court').value = '';
    document.getElementById('filter-show-past').checked = false;
    applyFilters();
  });

  // Export past bookings
  document.getElementById('btn-export-csv').addEventListener('click', downloadPastBookingsCSV);

  // Refresh
  document.getElementById('btn-refresh').addEventListener('click', loadBookings);

  // Tab navigation
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Revenue period toggle
  document.querySelectorAll('.rev-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rev-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentRevenuePeriod = btn.dataset.period;
      updateRevenue();
    });
  });

  // Delete modal
  document.getElementById('modal-cancel').addEventListener('click', closeDeleteModal);
  document.getElementById('modal-confirm').addEventListener('click', confirmDelete);
  document.getElementById('delete-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDeleteModal();
  });

  // Announcement
  document.getElementById('btn-save-announcement').addEventListener('click', saveAnnouncement);
  document.getElementById('announcement-title').addEventListener('input', updateAnnouncementPreview);
  document.getElementById('announcement-content').addEventListener('input', updateAnnouncementPreview);
  ['ann-btn-bold', 'ann-btn-italic', 'ann-btn-underline'].forEach(id => {
    const cmdMap = { 'ann-btn-bold': 'bold', 'ann-btn-italic': 'italic', 'ann-btn-underline': 'underline' };
    document.getElementById(id).addEventListener('mousedown', e => {
      e.preventDefault();
      document.execCommand(cmdMap[id]);
      updateAnnouncementPreview();
    });
  });

  // Court Lock
  document.getElementById('lock-cal-prev').addEventListener('click', () => {
    const today = new Date();
    if (lockCalendarDate.getFullYear() === today.getFullYear() && lockCalendarDate.getMonth() === today.getMonth()) return;
    lockCalendarDate.setMonth(lockCalendarDate.getMonth() - 1);
    renderLockCalendar();
  });
  document.getElementById('lock-cal-next').addEventListener('click', () => {
    const maxDate = new Date(new Date().getFullYear(), 11, 1); // December of current year
    if (lockCalendarDate >= maxDate) return;
    lockCalendarDate.setMonth(lockCalendarDate.getMonth() + 1);
    renderLockCalendar();
  });
  document.getElementById('btn-lock-slots').addEventListener('click', lockSelectedSlots);
  document.getElementById('btn-lock-month').addEventListener('click', openLockMonthModal);
  document.getElementById('lock-month-modal-close').addEventListener('click', closeLockMonthModal);
  document.getElementById('lock-month-cancel').addEventListener('click', closeLockMonthModal);
  document.getElementById('lock-month-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeLockMonthModal();
  });
  document.getElementById('btn-lock-month-next').addEventListener('click', openLockMonthConfirmModal);
  document.getElementById('lock-month-confirm-cancel').addEventListener('click', closeLockMonthConfirmModal);
  document.getElementById('lock-month-confirm-ok').addEventListener('click', executeLockMonths);
  document.getElementById('lock-month-confirm-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeLockMonthConfirmModal();
  });
  document.getElementById('btn-add-court')?.addEventListener('click', handleAddCourt);

  // Pricing tab
  document.getElementById('btn-save-pricing')?.addEventListener('click', handleSavePricing);
  ['pricing-daytime', 'pricing-evening'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updatePricingHint);
  });
  // Open Play
  document.getElementById('btn-select-sessions').addEventListener('click', () => {
    if (opSelectMode) exitSelectMode(); else enterSelectMode();
  });
  document.getElementById('btn-add-open-play').addEventListener('click', openAddScheduleModal);
  document.getElementById('op-add-modal-close').addEventListener('click', closeAddScheduleModal);
  document.getElementById('op-add-modal-cancel').addEventListener('click', closeAddScheduleModal);
  document.getElementById('op-add-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('op-add-modal')) closeAddScheduleModal();
  });
  document.getElementById('op-modal-save').addEventListener('click', saveAddScheduleModal);
  document.getElementById('op-add-modal').addEventListener('click', e => {
    const chip = e.target.closest('.op-time-chip');
    if (!chip) return;
    const picker = chip.closest('.op-time-picker');
    if (!picker) return;
    picker.querySelectorAll('.op-time-chip').forEach(c => c.classList.remove('selected'));
    chip.classList.add('selected');
    updateOpModalSaveBtn();
  });

  // Location type toggles
  ['edit-location-toggle', 'add-location-toggle'].forEach(id => {
    const toggle = document.getElementById(id);
    if (!toggle) return;
    toggle.querySelectorAll('.location-btn').forEach(btn => {
      btn.addEventListener('click', () => setLocationToggle(id, btn.dataset.value));
    });
  });

  document.getElementById('edit-court-modal-close').addEventListener('click', closeEditCourtModal);
  document.getElementById('edit-court-cancel').addEventListener('click', closeEditCourtModal);
  document.getElementById('btn-save-court').addEventListener('click', handleEditCourt);
  document.getElementById('edit-court-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeEditCourtModal();
  });
  document.getElementById('btn-lock-all-time').addEventListener('click', () => {
    const allSelected = LOCK_TIME_SLOTS.every(s => selectedLockTimes.has(s));
    LOCK_TIME_SLOTS.forEach(s => toggleLockTime(s, !allSelected));
  });

  // Chat head: one live session opens its chat directly; several show the list.
  document.getElementById('chat-head-btn').addEventListener('click', () => {
    if (chatHeadSessions.length === 1) {
      chatHeadListOpen = false;
      renderChatHead();
      openOrganizerChat(chatHeadSessions[0].id);
    } else {
      chatHeadListOpen = !chatHeadListOpen;
      renderChatHead();
    }
  });

  // Receipt / chat image viewer
  document.getElementById('receipt-modal-close').addEventListener('click', closeReceiptModal);
  document.getElementById('receipt-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeReceiptModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('receipt-modal').classList.contains('show')) {
      closeReceiptModal();
    }
  });

  // Delete lock modal
  document.getElementById('lock-modal-cancel').addEventListener('click', closeDeleteLockModal);
  document.getElementById('lock-modal-confirm').addEventListener('click', confirmDeleteLock);
  document.getElementById('delete-lock-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDeleteLockModal();
  });

  // Auto-restore session
  if (getToken()) {
    showAdmin();
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

renderApp();
