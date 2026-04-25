import './style.css';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://qzjaegutlsgtlaworbuy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Hy_hFyt_cdZkGV74qjbHlQ_L_gA18rb';
const SESSION_KEY = 'glan_admin_token';

let allCourts = []; // populated on load from Supabase

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

  const { access_token } = await res.json();
  localStorage.setItem(SESSION_KEY, access_token);
  return access_token;
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
}

// ─── SUPABASE HELPERS ─────────────────────────────────────────────────────────

async function sbFetch(path, options = {}) {
  const token = getToken();
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    localStorage.removeItem(SESSION_KEY);
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

async function deleteBookingGroup(bookingRef) {
  return sbFetch(`bookings?booking_ref=eq.${encodeURIComponent(bookingRef)}`, { method: 'DELETE' });
}

// Bookings are never deleted — kept permanently for revenue tracking and records

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
    headers: { 'Prefer': 'return=minimal' },
  });
}

async function deleteCourtLock(id) {
  return sbFetch(`court_locks?id=eq.${id}`, { method: 'DELETE' });
}

async function deleteCourtLockGroup(groupId) {
  return sbFetch(`court_locks?lock_group=eq.${encodeURIComponent(groupId)}`, {
    method: 'DELETE',
    headers: { 'Prefer': 'return=minimal' },
  });
}

// ─── OPEN PLAY API ───────────────────────────────────────────────────────────

async function fetchOpenPlaySession() {
  const rows = await sbFetch('open_play_sessions?select=*&order=id.desc&limit=1');
  return rows.length ? rows[0] : null;
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
    body: JSON.stringify(data),
  });
}

async function fetchOpenPlayRegistrations(sessionId) {
  return sbFetch(`open_play_registrations?session_id=eq.${sessionId}&select=*&order=created_at.asc`);
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

// ─── STATE ────────────────────────────────────────────────────────────────────

let allBookings = [];
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

function getRelativeDay(dateStr) {
  const today = todayStr();
  const [ty, tm, td] = today.split('-').map(Number);
  const todayDate = new Date(ty, tm - 1, td);
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const diff = Math.round((target - todayDate) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return null;
}

function formatLastUpdated() {
  if (!lastUpdatedTime) return '';
  return lastUpdatedTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function updateDashboard(bookings) {
  const today = todayStr();
  const todayBookings = bookings.filter(b => b.date === today);
  const todayGrouped = groupBookingsByRef(todayBookings);

  const greetingEl = document.getElementById('greeting');
  if (greetingEl) greetingEl.textContent = `${getGreeting()}! Here's today's overview`;

  document.getElementById('stat-total').textContent = todayGrouped.length;

  const todayRevenue = todayBookings.reduce((sum, b) => {
    const court = allCourts.find(c => c.id === b.court_id);
    return sum + (court ? court.price_per_hour : 100);
  }, 0);
  document.getElementById('stat-revenue').textContent = `₱${todayRevenue.toLocaleString()}`;

  const courtStatContainer = document.getElementById('court-stat-cards');
  if (courtStatContainer) {
    courtStatContainer.innerHTML = allCourts.map((court, i) => {
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

  const totalRevenue = filtered.reduce((sum, b) => {
    const court = allCourts.find(c => c.id === b.court_id);
    return sum + (court ? court.price_per_hour : 100);
  }, 0);
  const grouped = groupBookingsByRef(filtered);

  document.getElementById('revenue-period-label').textContent = periodLabel;
  document.getElementById('revenue-total').textContent = `₱${totalRevenue.toLocaleString()}`;
  document.getElementById('revenue-bookings').textContent = grouped.length;
  document.getElementById('revenue-hours').textContent = `${filtered.length}h`;

  // Court breakdown
  const courtCardsEl = document.getElementById('revenue-court-cards');
  if (courtCardsEl) {
    courtCardsEl.innerHTML = allCourts.map((court, i) => {
      const courtSlots = filtered.filter(b => b.court_id === court.id);
      const courtGrouped = groupBookingsByRef(courtSlots);
      const amount = courtSlots.length * court.price_per_hour;
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

  // Payment breakdown
  const gcashBookings = filtered.filter(b => b.payment_method === 'GCash');
  const cashBookings = filtered.filter(b => b.payment_method === 'Cash');
  const gcashRevenue = gcashBookings.reduce((sum, b) => {
    const court = allCourts.find(c => c.id === b.court_id);
    return sum + (court ? court.price_per_hour : 100);
  }, 0);
  const cashRevenue = cashBookings.reduce((sum, b) => {
    const court = allCourts.find(c => c.id === b.court_id);
    return sum + (court ? court.price_per_hour : 100);
  }, 0);

  document.getElementById('rev-gcash-amount').textContent = `₱${gcashRevenue.toLocaleString()}`;
  document.getElementById('rev-gcash-count').textContent = `${gcashBookings.length} hours`;
  document.getElementById('rev-cash-amount').textContent = `₱${cashRevenue.toLocaleString()}`;
  document.getElementById('rev-cash-count').textContent = `${cashBookings.length} hours`;
}

// ─── TABLE ────────────────────────────────────────────────────────────────────

function courtBadge(id) {
  const court = allCourts.find(c => c.id === id);
  return `<span class="court-badge c${id}">${court ? court.name : 'Court ' + id}</span>`;
}

function populateCourtDropdowns() {
  const options = allCourts.map(c =>
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
  const cls = method === 'GCash' ? 'gcash' : 'cash';
  const icon = method === 'GCash' ? '📱' : '💵';
  return `<span class="payment-badge ${cls}">${icon} ${method}</span>`;
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
  link.href = url;

  modal.classList.add('show');

  img.onload = () => {
    loading.style.display = 'none';
    img.style.display = 'block';
  };
  img.onerror = () => {
    loading.style.display = 'none';
    error.style.display = 'block';
  };
  img.src = url;
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
    allBookings = await fetchAllBookings();
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
  allCourts = await fetchCourts();
  populateCourtDropdowns();
  loadBookings();
}

function logout() {
  signOut();
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

  if (tab === 'revenue') updateRevenue();
  if (tab === 'announcements') loadAnnouncement();
  if (tab === 'courts') renderCourtsTab();
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
      document.getElementById('announcement-content').value = ann.content || '';
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
  const content = document.getElementById('announcement-content').value.trim();
  const preview = document.getElementById('announcement-preview');
  if (!title && !content) {
    preview.style.display = 'none';
    return;
  }
  preview.style.display = 'block';
  document.getElementById('announcement-preview-title').textContent = title;
  document.getElementById('announcement-preview-content').textContent = content;
}

async function saveAnnouncement() {
  const title = document.getElementById('announcement-title').value.trim();
  const content = document.getElementById('announcement-content').value.trim();
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

  const stopDrag = () => { isDraggingDates = false; };
  document.addEventListener('mouseup', stopDrag);
  document.addEventListener('touchend', stopDrag);

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

  container.innerHTML = LOCK_TIME_SLOTS.map(slot =>
    `<div class="lock-time-slot" data-slot="${slot}">${slot}</div>`
  ).join('');

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

  const stopDrag = () => { isDraggingTimes = false; };
  document.addEventListener('mouseup', stopDrag);
  document.addEventListener('touchend', stopDrag);

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
  const courts = courtVal === 'all' ? allCourts.map(c => c.id) : [parseInt(courtVal)];
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

  const courtCount = allCourts.length;
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
  const courtIds = allCourts.map(c => c.id);

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
    for (let i = 0; i < locks.length; i += BATCH) {
      await createCourtLocks(locks.slice(i, i + BATCH));
    }
    showToast(`Locked ${selectedLockMonths.size} month${selectedLockMonths.size !== 1 ? 's' : ''} successfully.`);
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
    const courtDisplay = courts.length === 3
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

let currentOpenPlayId = null;

function fmt12(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

function updateOpenPlayFieldsState() {
  const enabled = document.getElementById('open-play-enabled')?.checked;
  const fields = document.getElementById('open-play-fields');
  if (fields) fields.classList.toggle('op-fields-disabled', !enabled);
}

async function loadOpenPlay() {
  const statusEl = document.getElementById('open-play-status');
  if (!statusEl) return;
  statusEl.textContent = 'Loading…';

  try {
    const session = await fetchOpenPlaySession();
    if (session) {
      currentOpenPlayId = session.id;
      document.getElementById('open-play-enabled').checked = session.is_enabled ?? false;
      document.getElementById('open-play-date').value = session.date || '';
      document.getElementById('open-play-start').value = session.start_time || '';
      document.getElementById('open-play-end').value = session.end_time || '';
      document.getElementById('open-play-price').value = session.price_per_player ?? '';
      document.getElementById('open-play-max').value = session.max_players ?? '';
      statusEl.textContent = session.updated_at
        ? `Last saved ${new Date(session.updated_at).toLocaleString()}`
        : '';
      updateOpenPlayFieldsState();
      if (session.id) renderOpenPlayRegistrations(session.id, session.max_players);
    } else {
      currentOpenPlayId = null;
      statusEl.textContent = 'No session yet — configure one below.';
      updateOpenPlayFieldsState();
    }
  } catch (e) {
    statusEl.textContent = 'Failed to load.';
    console.error(e);
  }
}

async function saveOpenPlay() {
  const is_enabled = document.getElementById('open-play-enabled').checked;
  const date = document.getElementById('open-play-date').value || null;
  const start_time = document.getElementById('open-play-start').value || null;
  const end_time = document.getElementById('open-play-end').value || null;
  const price_per_player = parseInt(document.getElementById('open-play-price').value) || 0;
  const max_players = parseInt(document.getElementById('open-play-max').value) || 0;
  const btn = document.getElementById('btn-save-open-play');
  const statusEl = document.getElementById('open-play-status');

  if (is_enabled) {
    if (!date) { showToast('Please set a date for open play.', true); return; }
    if (!start_time || !end_time) { showToast('Please set start and end time.', true); return; }
    if (max_players < 1) { showToast('Max players must be at least 1.', true); return; }
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const result = await upsertOpenPlaySession(currentOpenPlayId, {
      is_enabled, date, start_time, end_time, price_per_player, max_players,
    });
    if (!currentOpenPlayId && result?.length) {
      currentOpenPlayId = result[0].id;
    }
    statusEl.textContent = `Saved ${new Date().toLocaleString()}`;
    showToast(is_enabled ? 'Open play enabled and saved.' : 'Open play saved (disabled).');
    if (currentOpenPlayId) renderOpenPlayRegistrations(currentOpenPlayId, max_players);
  } catch (e) {
    showToast(e.message || 'Failed to save open play.', true);
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Open Play';
  }
}

async function renderOpenPlayRegistrations(sessionId, maxPlayers) {
  const container = document.getElementById('open-play-registrations');
  if (!container) return;

  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>Loading registrations…</div>';

  try {
    const regs = await fetchOpenPlayRegistrations(sessionId);
    const spotsLeft = maxPlayers - regs.length;

    if (regs.length === 0) {
      container.innerHTML = `
        <div class="table-empty">
          <div class="icon">📋</div>
          <p>No registrations yet</p>
          <div class="sub">Players will appear here once they sign up</div>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="op-reg-header">
        <span class="op-reg-count">${regs.length} registered</span>
        <span class="op-spots-left ${spotsLeft <= 0 ? 'op-full' : ''}">${spotsLeft <= 0 ? 'Session Full' : `${spotsLeft} spot${spotsLeft !== 1 ? 's' : ''} left`}</span>
      </div>
      <div class="op-reg-list">
        ${regs.map((r, i) => `
          <div class="op-reg-item">
            <span class="op-reg-num">${i + 1}</span>
            <div class="op-reg-info">
              <span class="op-reg-name">${r.name || '—'}</span>
              <span class="op-reg-phone">${r.phone || '—'}</span>
            </div>
            <span class="op-reg-time">${new Date(r.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
          </div>`).join('')}
      </div>`;
  } catch (e) {
    container.innerHTML = '<div class="table-empty"><div class="icon">⚠️</div><p>Failed to load registrations</p></div>';
    console.error(e);
  }
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
  document.getElementById('edit-court-price').value = court.price_per_hour;
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
  const price = parseInt(document.getElementById('edit-court-price').value);
  const errEl = document.getElementById('edit-court-error');
  const btn = document.getElementById('btn-save-court');

  errEl.textContent = '';

  if (!name) { errEl.textContent = 'Court name is required.'; return; }
  if (!price || price < 1) { errEl.textContent = 'Enter a valid price.'; return; }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    await updateCourt(editingCourtId, { name, type, price_per_hour: price });
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
  const price = parseInt(document.getElementById('court-price').value);
  const errEl = document.getElementById('court-form-error');
  const btn = document.getElementById('btn-add-court');

  errEl.textContent = '';

  if (!name) { errEl.textContent = 'Court name is required.'; return; }
  if (!price || price < 1) { errEl.textContent = 'Enter a valid price.'; return; }

  const maxOrder = allCourts.reduce((m, c) => Math.max(m, c.sort_order), 0);

  btn.disabled = true;
  btn.textContent = 'Adding…';

  try {
    await createCourt({ name, type, price_per_hour: price, is_active: true, sort_order: maxOrder + 1 });
    allCourts = await fetchCourts();
    populateCourtDropdowns();
    renderCourtsTab();
    document.getElementById('court-name').value = '';
    document.getElementById('court-price').value = '100';
    showToast(`${name} added successfully.`);
  } catch (e) {
    errEl.textContent = 'Failed to add court. Try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = '+ Add Court';
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
        <h1>Glan Pickleball<br>Community</h1>
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
          Glan Pickleball Community
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
              <div class="stat-sub">Per court/hour</div>
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
            </div>
          </div>

          <div class="section-title" style="margin-top:1.5rem">By Court</div>
          <div class="revenue-grid" id="revenue-court-cards"></div>

          <div class="section-title" style="margin-top:1.5rem">By Payment Method</div>
          <div class="revenue-grid two-col">
            <div class="revenue-card gcash-card">
              <div class="rev-card-label">📱 GCash</div>
              <div class="rev-card-amount" id="rev-gcash-amount">₱0</div>
              <div class="rev-card-meta" id="rev-gcash-count">0 hours</div>
            </div>
            <div class="revenue-card cash-card">
              <div class="rev-card-label">💵 Cash</div>
              <div class="rev-card-amount" id="rev-cash-amount">₱0</div>
              <div class="rev-card-meta" id="rev-cash-count">0 hours</div>
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
              <textarea id="announcement-content" rows="6" placeholder="Write your announcement here…"></textarea>
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
                    <span class="lock-cal-month" id="lock-cal-month"></span>
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

          <div class="courts-list" id="courts-list">
            <div class="loading-spinner"><div class="spinner"></div>Loading courts…</div>
          </div>

          <div class="section-title" style="margin-top:2rem">Add New Court</div>
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
            <div class="filter-group">
              <label for="court-price">Price per Hour</label>
              <div class="price-input-wrapper">
                <span class="price-prefix">₱</span>
                <input type="number" id="court-price" placeholder="100" min="1" value="100" />
              </div>
            </div>
            <button class="btn-primary btn-add-court" id="btn-add-court">+ Add Court</button>
          </div>
          <div class="form-error" id="court-form-error"></div>

        </div><!-- /tab-courts -->

        <!-- ═══ OPEN PLAY TAB ═══ -->
        <div class="tab-content" id="tab-open-play">
          <div class="section-title">🏃 Open Play</div>
          <p class="section-desc">Set up a drop-in open play session. Players can sign up from the booking page when this is enabled.</p>

          <div class="open-play-editor">
            <div class="open-play-toolbar">
              <label class="announcement-toggle">
                <input type="checkbox" id="open-play-enabled" />
                <span class="toggle-slider"></span>
                <span class="toggle-label">Enable Open Play</span>
              </label>
              <span class="announcement-status" id="open-play-status"></span>
            </div>

            <div class="open-play-fields" id="open-play-fields">
              <div class="open-play-grid">
                <div class="input-group">
                  <label for="open-play-date">Date</label>
                  <input type="date" id="open-play-date" />
                </div>
                <div class="input-group">
                  <label for="open-play-start">Start Time</label>
                  <input type="time" id="open-play-start" />
                </div>
                <div class="input-group">
                  <label for="open-play-end">End Time</label>
                  <input type="time" id="open-play-end" />
                </div>
                <div class="input-group">
                  <label for="open-play-price">Price per Player</label>
                  <div class="price-input-wrapper">
                    <span class="price-prefix">₱</span>
                    <input type="number" id="open-play-price" min="0" placeholder="50" />
                  </div>
                </div>
                <div class="input-group">
                  <label for="open-play-max">Max Players</label>
                  <input type="number" id="open-play-max" min="1" placeholder="20" />
                </div>
              </div>
            </div>

            <div class="open-play-actions">
              <button class="btn-primary" id="btn-save-open-play" style="width:auto">Save Open Play</button>
            </div>
          </div>

          <div class="section-title" style="margin-top:2rem">Registrations</div>
          <div id="open-play-registrations">
            <div class="table-empty">
              <div class="icon">📋</div>
              <p>No registrations yet</p>
              <div class="sub">Save a session first to see sign-ups here</div>
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
          <div class="input-group">
            <label for="edit-court-price">Price per Hour</label>
            <div class="price-input-wrapper">
              <span class="price-prefix">₱</span>
              <input type="number" id="edit-court-price" min="1" placeholder="100" />
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

  // Court Lock
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
  // Open Play
  document.getElementById('open-play-enabled').addEventListener('change', updateOpenPlayFieldsState);
  document.getElementById('btn-save-open-play').addEventListener('click', saveOpenPlay);

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
