# Open Play — List View + Auto-Delete Passed Schedules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse each Open Play schedule into a compact list row that expands on click to reveal its editable details + player list, and automatically soft-delete schedules whose session has already ended.

**Architecture:** Pure client-side changes in `src/main.js` + `src/style.css`. A new `isSessionPassed(session, now)` pure helper drives auto-delete inside `loadOpenPlay()` (the only trigger available — no server/cron). Rows are rebuilt as an always-visible `.op-row-header` (date, time, count, enabled toggle) plus a hidden `.op-session-detail` (edit fields, Save/Delete, players) shown via an `.op-expanded` class. Registration counts for the whole list are fetched in one extra query.

**Tech Stack:** Vanilla JS (ES modules), CSS custom properties, Vite, Supabase REST via `sbFetch()`.

> **Git note:** The repo owner handles all commits. Each task ends with a suggested commit message — **do not run `git add`/`git commit` yourself**; leave the working tree staged-ready and let the owner commit.

---

## File Map

| File | What changes |
|---|---|
| `src/style.css` | New `.op-row-header`, `.op-chevron`, `.op-row-summary/date/time`, `.op-row-count`, `.op-session-detail` (collapsed/expanded) styles; soften `.op-session-fields` cursor |
| `src/main.js` | New `fmtDateLabel` + `isSessionPassed` helpers; new `fetchOpenPlayRegistrationCounts` API; `loadOpenPlay` (auto-delete + counts); `renderOpenPlayTable(sessions, counts)`; rewritten `renderSessionRow(s, count)`; `toggleRegistrationsPanel` → `toggleRowExpand`; `renderRegistrationsPanel` guard + count sync; `attachRowListeners` header wiring |

---

## Task 1: CSS — Collapsed/Expanded Row Styles

**Files:**
- Modify: `src/style.css` — insert before the `.op-session-fields` rule (around line 3088); edit the `.op-session-fields` cursor

- [ ] **Step 1: Add header + detail styles**

Find this rule in `src/style.css` (around line 3088):

```css
.op-session-fields {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 1rem;
  cursor: pointer;
}
```

Replace it with (changes the `cursor` and adds new rules **before** it):

```css
/* ─── Open Play: collapsed list row ─────────────────────────── */
.op-row-header {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  cursor: pointer;
  user-select: none;
}

.op-chevron {
  color: var(--muted);
  font-size: 0.8rem;
  transition: transform 0.2s;
  flex-shrink: 0;
}

.op-session-row.op-expanded .op-chevron {
  transform: rotate(90deg);
}

.op-row-summary {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  flex: 1;
  min-width: 0;
}

.op-row-date {
  font-weight: 700;
  font-size: 0.95rem;
  color: var(--text);
}

.op-row-time {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.op-row-count {
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--primary);
  white-space: nowrap;
}

.op-row-toggle {
  flex-shrink: 0;
}

/* Detail section — hidden until the row is expanded */
.op-session-detail {
  display: none;
  margin-top: 1.25rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--border-light);
}

.op-session-row.op-expanded .op-session-detail {
  display: block;
}

.op-session-fields {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 1rem;
  cursor: default;
}
```

- [ ] **Step 2: Checkpoint (owner commits)**

Suggested message:

```
style(open-play): add collapsed/expanded list row styles
```

---

## Task 2: JS — `fmtDateLabel` + `isSessionPassed` Helpers

**Files:**
- Modify: `src/main.js` — insert immediately after `fmt12` (ends around line 1674), before `async function loadOpenPlay()`

- [ ] **Step 1: Add both helpers**

Find this function in `src/main.js`:

```js
function fmt12(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}
```

Insert immediately after it:

```js
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
```

- [ ] **Step 2: Sanity-check the date logic in the browser console**

Run `npm run dev`, open the app, open DevTools console, and paste:

```js
const now = new Date('2026-06-14T09:00:00');
// June 13, 6PM–12AM → ends June 14 00:00 → passed by 9AM June 14
console.assert(isSessionPassed({date:'2026-06-13',start_time:'18:00',end_time:'00:00'}, now) === true, 'crosses-midnight passed');
// June 14, 6PM–12AM → ends June 15 00:00 → NOT passed at 9AM June 14
console.assert(isSessionPassed({date:'2026-06-14',start_time:'18:00',end_time:'00:00'}, now) === false, 'today not passed');
// June 14, 6AM–8AM → ended 8AM → passed by 9AM
console.assert(isSessionPassed({date:'2026-06-14',start_time:'06:00',end_time:'08:00'}, now) === true, 'same-day ended');
// No date → never passed
console.assert(isSessionPassed({}, now) === false, 'no date');
console.log('isSessionPassed checks passed');
```

Expected: console prints `isSessionPassed checks passed` with no assertion errors.
(`isSessionPassed`/`fmtDateLabel` are module-scoped; if they aren't visible in the console, temporarily attach `window.isSessionPassed = isSessionPassed` while testing, then remove it.)

- [ ] **Step 3: Checkpoint (owner commits)**

Suggested message:

```
feat(open-play): add date-label and isSessionPassed helpers
```

---

## Task 3: JS — Registration-Count API Helper

**Files:**
- Modify: `src/main.js` — insert after `deleteOpenPlayRegistration` (around line 518), before the `// ─── COURT MANAGEMENT API ───` comment

- [ ] **Step 1: Add `fetchOpenPlayRegistrationCounts`**

Find this function in `src/main.js`:

```js
async function deleteOpenPlayRegistration(regId) {
  return sbFetch(`open_play_queue?id=eq.${regId}`, { method: 'DELETE' });
}
```

Insert immediately after it:

```js
// Returns { [sessionId]: count } for the given session ids in one request.
async function fetchOpenPlayRegistrationCounts(sessionIds) {
  if (!sessionIds.length) return {};
  const rows = await sbFetch(
    `open_play_queue?session_id=in.(${sessionIds.join(',')})&select=session_id`);
  const counts = {};
  rows.forEach(r => { counts[r.session_id] = (counts[r.session_id] || 0) + 1; });
  return counts;
}
```

- [ ] **Step 2: Checkpoint (owner commits)**

Suggested message:

```
feat(open-play): add batched registration-count fetch
```

---

## Task 4: JS — Switch Open Play to the List UI (atomic)

This task swaps the whole render/interaction path at once so the app is never in a half-converted state. All edits are in `src/main.js`.

**Files:**
- Modify: `src/main.js` — `loadOpenPlay`, `renderOpenPlayTable`, `renderSessionRow`, `toggleRegistrationsPanel`, `renderRegistrationsPanel`, `attachRowListeners`

- [ ] **Step 1: Auto-delete + counts in `loadOpenPlay`**

Find:

```js
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
```

Replace with:

```js
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
```

- [ ] **Step 2: Pass counts through `renderOpenPlayTable`**

Find:

```js
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
```

Replace with:

```js
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
```

- [ ] **Step 3: Rewrite `renderSessionRow` to header + detail**

Find the whole current function:

```js
function renderSessionRow(s = {}) {
  const id = s.id || '';
  const isNew = !id;
  return `
    <div class="op-session-row${isNew ? ' op-session-new' : ''}" data-id="${id}">
      <div class="op-select-checkbox-wrap">
        <input type="checkbox" />
      </div>
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
          <label class="op-toggle">
            <input type="checkbox" class="op-enabled" ${s.is_enabled ? 'checked' : ''} />
            <span class="op-toggle-track"><span class="op-toggle-thumb"></span></span>
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
```

Replace with:

```js
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
          <button class="btn-primary op-btn-save" style="width:auto">Save</button>
          <button class="op-btn-delete btn-icon-danger" title="Delete session">✕</button>
        </div>
        <div class="op-session-status"></div>
        <div class="op-registrations-panel"></div>
      </div>
    </div>`;
}
```

- [ ] **Step 4: Replace `toggleRegistrationsPanel` with `toggleRowExpand`**

Find:

```js
async function toggleRegistrationsPanel(row) {
  const panel = row.querySelector('.op-registrations-panel');
  const isOpen = panel.style.display !== 'none';
  if (isOpen) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const maxPlayers = parseInt(row.querySelector('.op-max').value) || 0;
  renderRegistrationsPanel(row, maxPlayers);
}
```

Replace with:

```js
function toggleRowExpand(row) {
  const willExpand = !row.classList.contains('op-expanded');
  row.classList.toggle('op-expanded', willExpand);
  if (willExpand && row.dataset.id) {
    const maxPlayers = parseInt(row.querySelector('.op-max').value) || 0;
    renderRegistrationsPanel(row, maxPlayers);
  }
}
```

- [ ] **Step 5: Update `renderRegistrationsPanel` guard + sync the header count**

Find:

```js
async function renderRegistrationsPanel(row, maxPlayers) {
  const panel = row.querySelector('.op-registrations-panel');
  if (panel.style.display === 'none') return;
  const sessionId = row.dataset.id;
  if (!sessionId) return;

  panel.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>Loading registrations…</div>';

  try {
    const regs = await fetchOpenPlayRegistrations(sessionId);
    const spotsLeft = maxPlayers - regs.length;
```

Replace with:

```js
async function renderRegistrationsPanel(row, maxPlayers) {
  const panel = row.querySelector('.op-registrations-panel');
  if (!row.classList.contains('op-expanded')) return;
  const sessionId = row.dataset.id;
  if (!sessionId) return;

  panel.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>Loading registrations…</div>';

  try {
    const regs = await fetchOpenPlayRegistrations(sessionId);
    // Keep the collapsed header count in sync with the live list.
    row.dataset.count = regs.length;
    const countEl = row.querySelector('.op-row-count');
    if (countEl) countEl.textContent = `${regs.length} / ${maxPlayers || '—'} players`;
    const spotsLeft = maxPlayers - regs.length;
```

- [ ] **Step 6: Rewire `attachRowListeners` for the header**

Find:

```js
function attachRowListeners(container) {
  container.querySelectorAll('.op-session-row').forEach(row => {
    row.querySelector('.op-enabled').addEventListener('change', () => autoSaveEnabled(row));
    row.querySelector('.op-btn-save').addEventListener('click', () => saveSessionRow(row));
    row.querySelector('.op-btn-delete').addEventListener('click', () => deleteSessionRow(row));

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

    row.querySelector('.op-session-fields').addEventListener('click', e => {
      if (e.target.tagName === 'INPUT') return;
      if (!row.dataset.id) return;
      if (opSelectMode) {
        const cb = row.querySelector('.op-select-checkbox-wrap input');
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
        return;
      }
      toggleRegistrationsPanel(row);
    });
  });
}
```

Replace with:

```js
function attachRowListeners(container) {
  container.querySelectorAll('.op-session-row').forEach(row => {
    row.querySelector('.op-enabled').addEventListener('change', () => autoSaveEnabled(row));
    row.querySelector('.op-btn-save').addEventListener('click', () => saveSessionRow(row));
    row.querySelector('.op-btn-delete').addEventListener('click', () => deleteSessionRow(row));

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
```

- [ ] **Step 7: Verify no dangling references**

Run:

```bash
grep -n "toggleRegistrationsPanel" src/main.js
```

Expected: **no output** (the old function and its only caller are both gone).

- [ ] **Step 8: Checkpoint (owner commits)**

Suggested message:

```
feat(open-play): collapse schedules into expandable list rows
```

---

## Task 5: Manual Smoke Test

- [ ] **Step 1: Run the dev server**

```bash
npm run dev
```

- [ ] **Step 2: Verify the list view**

Open the app → Open Play tab. Confirm:
- Each schedule shows as a single compact row: chevron, date (e.g. `Jun 13, 2026`), time range (`6:00 PM – 12:00 AM`), `N / 50 players`, and the enabled toggle on the right.
- The edit fields and player list are **hidden** by default.
- Clicking a row (not the toggle) expands it: chevron rotates, edit fields + Save/Delete + player list appear; the players load on first expand.
- **Multiple rows** can be open at once; clicking an open row again collapses it.
- Clicking the **enabled toggle** flips it (and toasts) **without** expanding the row.

- [ ] **Step 3: Verify auto-delete of passed schedules**

In Supabase (or via the Add Schedule modal) ensure there is:
- A schedule dated **yesterday** with start `18:00` / end `00:00` (crosses midnight, so it ended at 00:00 today).
- A schedule dated **today** with a future end, and one dated **tomorrow**.

Reload the Open Play tab. Confirm:
- Yesterday's schedule is **gone** from the list.
- Today's (not yet ended) and tomorrow's schedules **remain**.
- In Supabase, the removed row now has `deleted_at` set (soft delete) and its `open_play_queue` rows still exist.

- [ ] **Step 4: Verify counts stay correct**

Expand a schedule with registrations, remove a player via the ✕ → confirm the player list updates **and** the collapsed header count (`N / 50 players`) decreases to match.

- [ ] **Step 5: Verify select/bulk-delete still works**

Click **Select** → checkboxes appear in each row header → clicking a row toggles its checkbox **instead of expanding** → `Delete Selected (N)` count updates → confirm modal → rows disappear → toast shows count. Click **Cancel** to exit select mode cleanly.

- [ ] **Step 6: Verify single edit + save**

Expand a row, change Price or Max Players, click **Save** → toast confirms → the header summary (date/time, and `/ max`) reflects the saved values. Reload to confirm persistence.
