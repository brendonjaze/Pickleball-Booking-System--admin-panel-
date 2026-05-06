# Open Play Multiple Schedules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single fixed open play session with an unlimited inline-editable list of schedules, each with its own date, time, price, max players, enabled toggle, and soft delete.

**Architecture:** All changes are in `src/main.js` (API, state, logic, HTML template) and `src/style.css` (new table/row CSS). The Supabase `open_play_sessions` table needs one new nullable column (`deleted_at`) added manually before deployment. No new files are created.

**Tech Stack:** Vanilla JS, Supabase REST API, CSS custom properties

---

## Pre-flight: Add Supabase Column

- [ ] In the Supabase dashboard, open the Table Editor → `open_play_sessions` → Add column:
  - Name: `deleted_at`
  - Type: `timestamptz`
  - Default: (leave empty / null)
  - Nullable: yes
- [ ] Verify the column exists before proceeding.

---

### Task 1: Replace Open Play API Functions

**Files:**
- Modify: `src/main.js` lines 228–254

- [ ] **Step 1: Replace `fetchOpenPlaySession` with `fetchAllOpenPlaySessions`**

Find and replace the entire `// ─── OPEN PLAY API ───` section (lines 228–254):

```js
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

async function deleteOpenPlayRegistration(regId) {
  return sbFetch(`open_play_queue?id=eq.${regId}`, { method: 'DELETE' });
}
```

- [ ] **Step 2: Commit**

```
git add src/main.js
git commit -m "feat: add fetchAllOpenPlaySessions and softDeleteOpenPlaySession"
```

---

### Task 2: Replace Open Play State and Logic

**Files:**
- Modify: `src/main.js` lines 1344–1489

- [ ] **Step 1: Remove old state variable**

Find and delete this line (around line 1346):
```js
let currentNightOpenPlayId = null;
```

- [ ] **Step 2: Replace `loadOpenPlay`, `saveOpenPlay`, `handleDeleteRegistration`, `renderOpenPlayRegistrations`, `updateOpenPlayFieldsState` with new multi-session versions**

Replace the entire `// ─── OPEN PLAY LOGIC ─────────────────────────────────────────────────────────` section through the end of `renderOpenPlayRegistrations` (lines 1344–1489) with:

```js
// ─── OPEN PLAY LOGIC ─────────────────────────────────────────────────────────

function fmt12(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

async function loadOpenPlay() {
  const container = document.getElementById('open-play-list');
  if (!container) return;
  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>Loading…</div>';
  try {
    const sessions = await fetchAllOpenPlaySessions();
    renderOpenPlayTable(sessions);
  } catch (e) {
    container.innerHTML = '<div class="table-empty"><div class="icon">⚠️</div><p>Failed to load sessions</p></div>';
    console.error(e);
  }
}

function renderOpenPlayTable(sessions) {
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

  container.innerHTML = sessions.map(s => renderSessionRow(s)).join('');
  attachRowListeners(container);
}

function renderSessionRow(s = {}) {
  const id = s.id || '';
  const isNew = !id;
  return `
    <div class="op-session-row${isNew ? ' op-session-new' : ''}" data-id="${id}">
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
        <div class="input-group op-toggle-group">
          <label>Enabled</label>
          <label class="announcement-toggle">
            <input type="checkbox" class="op-enabled" ${s.is_enabled ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="op-session-actions">
        <button class="btn-primary op-btn-save" style="width:auto">Save</button>
        <button class="op-btn-delete btn-icon-danger" title="Delete session">✕</button>
      </div>
      <div class="op-session-status"></div>
      <div class="op-registrations-panel" style="display:none"></div>
    </div>`;
}

function attachRowListeners(container) {
  container.querySelectorAll('.op-session-row').forEach(row => {
    const id = () => row.dataset.id;

    row.querySelector('.op-enabled').addEventListener('change', () => autoSaveEnabled(row));
    row.querySelector('.op-btn-save').addEventListener('click', () => saveSessionRow(row));
    row.querySelector('.op-btn-delete').addEventListener('click', () => deleteSessionRow(row));

    // Toggle registrations panel on row click (not on inputs/buttons)
    row.querySelector('.op-session-fields').addEventListener('click', e => {
      if (e.target.tagName === 'INPUT') return;
      if (!id()) return;
      toggleRegistrationsPanel(row);
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
  if (!id) return;
  const is_enabled = row.querySelector('.op-enabled').checked;
  try {
    await upsertOpenPlaySession(id, { is_enabled });
    showToast(is_enabled ? 'Session enabled.' : 'Session disabled.');
  } catch (e) {
    showToast('Failed to update.', true);
  }
}

async function deleteSessionRow(row) {
  const id = row.dataset.id;
  if (!id) { row.remove(); return; }
  if (!confirm('This session will be hidden. Existing registrations are kept.')) return;
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
}

async function toggleRegistrationsPanel(row) {
  const panel = row.querySelector('.op-registrations-panel');
  const isOpen = panel.style.display !== 'none';
  if (isOpen) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const sessionId = row.dataset.id;
  const maxPlayers = parseInt(row.querySelector('.op-max').value) || 0;
  renderRegistrationsPanel(row, maxPlayers);
}

async function renderRegistrationsPanel(row, maxPlayers) {
  const panel = row.querySelector('.op-registrations-panel');
  if (panel.style.display === 'none') return;
  const sessionId = row.dataset.id;
  if (!sessionId) return;

  panel.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>Loading registrations…</div>';

  try {
    const regs = await fetchOpenPlayRegistrations(sessionId);
    const spotsLeft = maxPlayers - regs.length;

    if (regs.length === 0) {
      panel.innerHTML = `
        <div class="table-empty">
          <div class="icon">📋</div>
          <p>No registrations yet</p>
          <div class="sub">Players will appear here once they sign up</div>
        </div>`;
      return;
    }

    panel.innerHTML = `
      <div class="op-reg-header">
        <span class="op-reg-count">${regs.length} registered</span>
        <span class="op-spots-left ${spotsLeft <= 0 ? 'op-full' : ''}">${spotsLeft <= 0 ? 'Session Full' : `${spotsLeft} spot${spotsLeft !== 1 ? 's' : ''} left`}</span>
      </div>
      <div class="op-reg-list">
        ${regs.map((r, i) => `
          <div class="op-reg-item">
            <span class="op-reg-num">${i + 1}</span>
            <div class="op-reg-info">
              <span class="op-reg-name">${r.player_name || '—'}</span>
              <span class="op-reg-phone">${r.mobile || '—'}</span>
            </div>
            <span class="op-reg-time">${new Date(r.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
            <button class="op-reg-delete" data-id="${r.id}" title="Remove player">✕</button>
          </div>`).join('')}
      </div>`;

    panel.querySelectorAll('.op-reg-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this player from the session?')) return;
        try {
          await deleteOpenPlayRegistration(btn.dataset.id);
          renderRegistrationsPanel(row, maxPlayers);
        } catch (e) {
          showToast('Failed to remove player.', true);
        }
      });
    });
  } catch (e) {
    panel.innerHTML = '<div class="table-empty"><div class="icon">⚠️</div><p>Failed to load registrations</p></div>';
    console.error(e);
  }
}
```

- [ ] **Step 3: Commit**

```
git add src/main.js
git commit -m "feat: replace open play logic with multi-session support"
```

---

### Task 3: Replace Open Play Tab HTML

**Files:**
- Modify: `src/main.js` lines 1995–2052

- [ ] **Step 1: Replace the open play tab HTML block**

Find this block (around line 1995):
```html
        <!-- ═══ OPEN PLAY TAB ═══ -->
        <div class="tab-content" id="tab-open-play">
          <div class="section-title">🏃 Open Play</div>
          <p class="section-desc">Set up a drop-in open play session. Players can sign up from the booking page when this is enabled.</p>

          <div class="open-play-editor">
            ...
          </div>

          <div class="section-title" style="margin-top:2rem">Registrations</div>
          <div id="open-play-registrations-night">
            ...
          </div>

        </div><!-- /tab-open-play -->
```

Replace the entire block with:
```html
        <!-- ═══ OPEN PLAY TAB ═══ -->
        <div class="tab-content" id="tab-open-play">
          <div class="op-tab-header">
            <div>
              <div class="section-title">🏃 Open Play</div>
              <p class="section-desc">Manage drop-in open play schedules. Players can sign up when a session is enabled.</p>
            </div>
            <button class="btn-primary" id="btn-add-open-play" style="white-space:nowrap">＋ Add Schedule</button>
          </div>

          <div id="open-play-list">
            <div class="table-empty">
              <div class="icon">📋</div>
              <p>No schedules yet</p>
              <div class="sub">Click "+ Add Schedule" to create one</div>
            </div>
          </div>

        </div><!-- /tab-open-play -->
```

- [ ] **Step 2: Commit**

```
git add src/main.js
git commit -m "feat: replace open play tab HTML with dynamic list container"
```

---

### Task 4: Update Event Listeners

**Files:**
- Modify: `src/main.js` around lines 2304–2309

- [ ] **Step 1: Replace old open play event listeners**

Find this block (around line 2304):
```js
  // Open Play
  document.getElementById('open-play-enabled-night').addEventListener('change', () => {
    updateOpenPlayFieldsState('night');
    saveOpenPlay('night');
  });
  document.getElementById('btn-save-open-play-night').addEventListener('click', () => saveOpenPlay('night'));
```

Replace with:
```js
  // Open Play
  document.getElementById('btn-add-open-play').addEventListener('click', () => {
    const container = document.getElementById('open-play-list');
    const emptyState = container.querySelector('.table-empty');
    if (emptyState) container.innerHTML = '';
    const rowHtml = renderSessionRow({});
    container.insertAdjacentHTML('afterbegin', rowHtml);
    attachRowListeners(container);
    container.querySelector('.op-session-row .op-date')?.focus();
  });
```

- [ ] **Step 2: Commit**

```
git add src/main.js
git commit -m "feat: update open play event listeners for multi-session"
```

---

### Task 5: Add CSS for New Layout

**Files:**
- Modify: `src/style.css` — replace old open play CSS block (lines 2565–2602) and add new styles

- [ ] **Step 1: Replace old open play CSS and add new styles**

Find and replace the `.open-play-editor`, `.open-play-toolbar`, `.open-play-fields`, `.op-fields-disabled`, `.open-play-grid`, `.open-play-actions` block (lines 2565–2602):

```css
/* Open Play — tab header */
.op-tab-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.25rem;
  flex-wrap: wrap;
}

/* Open Play — session row */
.op-session-row {
  background: var(--white);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  padding: 1.25rem 1.5rem;
  margin-bottom: 0.75rem;
  box-shadow: var(--shadow-xs);
}

.op-session-new {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(74, 144, 217, 0.15);
}

.op-session-fields {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 1rem;
  cursor: pointer;
}

.op-toggle-group {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.op-session-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
  margin-top: 1rem;
  align-items: center;
}

.btn-icon-danger {
  background: none;
  border: 1px solid var(--danger);
  color: var(--danger);
  border-radius: var(--radius-sm);
  padding: 0.35rem 0.75rem;
  cursor: pointer;
  font-size: 0.85rem;
  transition: background 0.15s;
}

.btn-icon-danger:hover {
  background: var(--danger-light);
}

.op-session-status {
  font-size: 0.75rem;
  color: var(--muted);
  margin-top: 0.4rem;
  text-align: right;
}

.op-registrations-panel {
  margin-top: 1rem;
  border-top: 1px solid var(--border-light);
  padding-top: 1rem;
}
```

- [ ] **Step 2: Also update the responsive breakpoints** — find `.open-play-grid` inside `@media` queries (around lines 2711, 2721) and remove or replace them with:

```css
  .op-session-fields {
    grid-template-columns: 1fr 1fr;
  }
```

(inside the existing `@media (max-width: ...)` block)

- [ ] **Step 3: Commit**

```
git add src/style.css
git commit -m "feat: add CSS for open play multi-session table layout"
```

---

### Task 6: Manual Verification

- [ ] Run the dev server: `npm run dev`
- [ ] Navigate to the Open Play tab — verify "No schedules yet" empty state shows
- [ ] Click "+ Add Schedule" — verify a blank editable row appears with all fields
- [ ] Fill in a date, start time, end time, max players — click Save — verify row saves and status updates
- [ ] Toggle "Enabled" — verify auto-save fires (check Supabase row)
- [ ] Add a second schedule with a different date — verify both rows appear after reload
- [ ] Click on a saved row's fields area — verify registrations panel expands/collapses
- [ ] Click ✕ on a row — verify confirm dialog appears, row disappears, Supabase `deleted_at` is set
- [ ] Reload the tab — verify deleted sessions do not reappear
- [ ] Verify the existing "night" session (if any) appears in the list with its data intact
