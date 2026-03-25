import './style.css';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://qzjaegutlsgtlaworbuy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Hy_hFyt_cdZkGV74qjbHlQ_L_gA18rb';
const RATE_PER_HOUR = 100;
const SESSION_KEY = 'glan_admin_token';

const COURT_NAMES = { 1: 'Court 1', 2: 'Court 2', 3: 'Court 3' };

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
    // Token expired — force re-login
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
  return sbFetch('bookings?select=*&order=date.asc,time_slot.asc');
}

async function deleteBookingGroup(bookingRef) {
  return sbFetch(`bookings?booking_ref=eq.${encodeURIComponent(bookingRef)}`, { method: 'DELETE' });
}

async function cleanUpOldBookings() {
  const today = todayStr();
  const old = allBookings.filter(b => b.date < today);
  if (old.length === 0) return;

  const oldRefs = [...new Set(old.map(b => b.booking_ref))];

  try {
    await sbFetch(`bookings?date=lt.${today}`, { method: 'DELETE' });
    allBookings = allBookings.filter(b => b.date >= today);
    applyFilters();
    updateDashboard(allBookings);
    showToast(`Cleaned up ${oldRefs.length} past booking${oldRefs.length !== 1 ? 's' : ''} (${old.length} slot${old.length !== 1 ? 's' : ''}).`, false, 7000);
  } catch (e) {
    console.error('Cleanup failed:', e);
  }
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
        created_at: b.created_at,
        slots: [],
      };
    }
    groups[ref].slots.push(b.time_slot);
  }
  return Object.values(groups).map(g => {
    const sorted = g.slots.sort((a, b) => parseTimeToMinutes(a) - parseTimeToMinutes(b));
    // Each slot may be stored as a range "6:00 AM – 7:00 AM"; extract start/end parts
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

// ─── STATE ────────────────────────────────────────────────────────────────────

let allBookings = [];
let pendingDeleteRef = null;

// ─── TOAST ────────────────────────────────────────────────────────────────────

function showToast(message, isError = false, duration = 3500) {
  const container = document.querySelector('.toast-container');
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' error' : ''}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toLocaleDateString('en-CA');
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function updateDashboard(bookings) {
  const today = todayStr();
  const todayBookings = bookings.filter(b => b.date === today);
  const todayGrouped = groupBookingsByRef(todayBookings);

  document.getElementById('stat-total').textContent = todayGrouped.length;
  document.getElementById('stat-revenue').textContent =
    `₱${(todayBookings.length * RATE_PER_HOUR).toLocaleString()}`;

  [1, 2, 3].forEach(c => {
    const count = todayGrouped.filter(b => b.court_id === c).length;
    document.getElementById(`stat-court${c}`).textContent = count;
  });
}

// ─── TABLE ────────────────────────────────────────────────────────────────────

function courtBadge(id) {
  return `<span class="court-badge c${id}">${COURT_NAMES[id] || 'Court ' + id}</span>`;
}

function paymentBadge(method) {
  const cls = method === 'GCash' ? 'gcash' : 'cash';
  const icon = method === 'GCash' ? '📱' : '💵';
  return `<span class="payment-badge ${cls}">${icon} ${method}</span>`;
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
      <td data-label="Date">${b.date}</td>
      <td data-label="Time">${b.time_range}</td>
      <td data-label="Hours">${b.total_hours}h</td>
      <td data-label="Payment">${paymentBadge(b.payment_method)}</td>
      <td>
        <button class="btn-delete" data-ref="${b.booking_ref}">Cancel Booking</button>
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

  const filtered = allBookings.filter(b => {
    if (date && b.date !== date) return false;
    if (court && String(b.court_id) !== court) return false;
    return true;
  });

  renderTable(groupBookingsByRef(filtered));
}

// ─── DELETE MODAL ─────────────────────────────────────────────────────────────

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

  try {
    allBookings = await fetchAllBookings();
    applyFilters();
    updateDashboard(allBookings);
    await cleanUpOldBookings();
  } catch (e) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="table-empty">
            <div class="icon">⚠️</div>
            <p>Failed to load bookings. Check your connection.</p>
          </div>
        </td>
      </tr>`;
    showToast(e.message || 'Error loading bookings.', true);
    console.error(e);
  }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

function showAdmin() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('admin-app').classList.add('visible');
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


// ─── RENDER APP ───────────────────────────────────────────────────────────────

function renderApp() {
  document.querySelector('#app').innerHTML = `
    <!-- Login -->
    <div id="login-screen" style="display:flex">
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
            <input
              type="password"
              id="login-password"
              placeholder="Enter password"
              autocomplete="current-password"
              required
            />
          </div>
          <div id="login-error" class="login-error">Incorrect email or password.</div>
          <button type="submit" class="btn-primary" id="login-btn">Sign In</button>
        </form>
      </div>
    </div>

    <!-- Admin App -->
    <div id="admin-app">
      <header class="admin-header">
        <div class="header-brand">
          Glan Pickleball Community
        </div>
        <div class="header-right">
          <span class="header-badge">Admin Panel</span>
          <button class="btn-account" id="btn-account">Account</button>
          <button class="btn-logout" id="btn-logout">Sign Out</button>
        </div>
      </header>

      <main class="admin-main">
        <!-- Dashboard -->
        <div class="section-title">📊 Today's Overview</div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Bookings Today</div>
            <div class="stat-value" id="stat-total">—</div>
            <div class="stat-sub">All courts combined</div>
          </div>
          <div class="stat-card revenue">
            <div class="stat-label">Revenue Today</div>
            <div class="stat-value" id="stat-revenue">—</div>
            <div class="stat-sub">₱100/hour per court</div>
          </div>
          <div class="stat-card court1">
            <div class="stat-label">Court 1</div>
            <div class="stat-value" id="stat-court1">—</div>
            <div class="stat-sub">Bookings today</div>
          </div>
          <div class="stat-card court2">
            <div class="stat-label">Court 2</div>
            <div class="stat-value" id="stat-court2">—</div>
            <div class="stat-sub">Bookings today</div>
          </div>
          <div class="stat-card court3">
            <div class="stat-label">Court 3</div>
            <div class="stat-value" id="stat-court3">—</div>
            <div class="stat-sub">Bookings today</div>
          </div>
        </div>

        <!-- Bookings Table -->
        <div class="section-title">📋 All Bookings</div>

        <div class="filters-bar">
          <div class="filter-group">
            <label for="filter-date">Filter by Date</label>
            <input type="date" id="filter-date" />
          </div>
          <div class="filter-group">
            <label for="filter-court">Filter by Court</label>
            <select id="filter-court">
              <option value="">All Courts</option>
              <option value="1">Court 1</option>
              <option value="2">Court 2</option>
              <option value="3">Court 3</option>
            </select>
          </div>
          <button class="btn-reset" id="btn-reset-filters">Reset Filters</button>
        </div>

        <div class="table-wrapper">
          <div class="table-header">
            <span class="section-title" style="margin:0;font-size:0.9rem">Bookings</span>
            <span class="table-count" id="bookings-count">Loading…</span>
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

    <!-- Toast container -->
    <div class="toast-container"></div>
  `;

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
      // If offline and a previous session exists, allow entry
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
  document.getElementById('filter-date').addEventListener('change', applyFilters);
  document.getElementById('filter-court').addEventListener('change', applyFilters);
  document.getElementById('btn-reset-filters').addEventListener('click', () => {
    document.getElementById('filter-date').value = '';
    document.getElementById('filter-court').value = '';
    applyFilters();
  });

  // Modal
  document.getElementById('modal-cancel').addEventListener('click', closeDeleteModal);
  document.getElementById('modal-confirm').addEventListener('click', confirmDelete);
  document.getElementById('delete-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDeleteModal();
  });

  // Auto-restore session if token exists
  if (getToken()) {
    showAdmin();
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

renderApp();
