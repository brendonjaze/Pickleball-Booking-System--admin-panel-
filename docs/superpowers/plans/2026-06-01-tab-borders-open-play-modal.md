# Tab Borders + Open Play Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add visible bordered tabs, and replace the inline "Add Schedule" row with a modal that supports selecting multiple dates at once.

**Architecture:** All changes are confined to `src/style.css` (styling) and `src/main.js` (HTML template in `renderApp()`, JS logic). The modal is injected into the existing `renderApp()` HTML alongside other modals. Multi-date state is managed in module-level variables, following the same pattern as court locks.

**Tech Stack:** Vanilla JS, CSS custom properties, Supabase REST via `sbFetch`, Vite

---

## File Map

| File | What changes |
|---|---|
| `src/style.css` | Tab border styles; new modal + calendar CSS |
| `src/main.js` | `renderApp()` modal HTML; new open-play modal functions; updated `#btn-add-open-play` listener |

---

## Task 1: Tab Borders (CSS)

**Files:**
- Modify: `src/style.css` (`.tab-btn`, `.tab-btn:hover`, `.tab-btn.active`, `.tab-nav`)

- [ ] **Step 1: Update `.tab-nav` gap and `.tab-btn` base style**

In `src/style.css`, replace the entire `/* ─── TAB NAVIGATION ───────────────────────────────────── */` block (lines 451–508) with:

```css
/* ─── TAB NAVIGATION ───────────────────────────────────── */

.tab-nav {
  display: flex;
  gap: 4px;
  margin-bottom: 1.75rem;
  border-bottom: 2px solid var(--border-light);
}

.tab-btn {
  padding: 0.75rem 1.5rem;
  border: 2px solid var(--border-light);
  border-bottom: none;
  margin-bottom: -2px;
  border-radius: 6px 6px 0 0;
  font-family: 'Montserrat', sans-serif;
  font-size: 0.82rem;
  font-weight: 700;
  cursor: pointer;
  background: transparent;
  color: var(--text-muted);
  transition: all var(--transition);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  position: relative;
}

.tab-btn:hover {
  color: var(--primary);
  border-color: var(--border);
}

.tab-btn.active {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--white);
}

.tab-icon {
  font-size: 1rem;
  line-height: 1;
}

.tab-badge {
  font-size: 0.6rem;
  font-weight: 800;
  background: var(--primary);
  color: var(--white);
  padding: 0.15rem 0.45rem;
  border-radius: 10px;
  min-width: 1.35rem;
  text-align: center;
  line-height: 1.3;
}

.tab-btn:not(.active) .tab-badge {
  background: var(--border);
  color: var(--text-muted);
}
```

- [ ] **Step 2: Verify no responsive override re-applies `border: none`**

Search `src/style.css` for all `@media` blocks that mention `.tab-btn`. The only changes in those blocks should be `padding` and `font-size`. Confirm none of them set `border: none` — if they do, remove those lines.

- [ ] **Step 3: Commit**

```bash
git add src/style.css
git commit -m "style(tabs): add box border with rounded top corners to each tab"
```

---

## Task 2: Add Schedule Modal HTML

**Files:**
- Modify: `src/main.js` — add modal HTML inside `renderApp()`

- [ ] **Step 1: Add the modal HTML after the `<!-- Remove Open Play Player Modal -->` block**

In `src/main.js`, find this comment in `renderApp()`:

```html
    <!-- Remove Open Play Player Modal -->
```

Immediately after the closing `</div>` of that modal (line ~2198), insert:

```html
    <!-- Add Open Play Schedule Modal -->
    <div class="modal-overlay" id="op-add-modal">
      <div class="modal-card op-add-modal-card">
        <div class="account-modal-header">
          <h2>Add Open Play Schedule</h2>
          <button class="modal-close" id="op-add-modal-close">&times;</button>
        </div>

        <div id="op-modal-calendar"></div>

        <div class="op-modal-settings">
          <div class="input-group">
            <label>Start Time</label>
            <input type="time" id="op-modal-start" />
          </div>
          <div class="input-group">
            <label>End Time</label>
            <input type="time" id="op-modal-end" />
          </div>
          <div class="input-group">
            <label>Price (₱)</label>
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
```

- [ ] **Step 2: Commit**

```bash
git add src/main.js
git commit -m "feat(open-play): add HTML skeleton for add-schedule modal"
```

---

## Task 3: Modal + Calendar CSS

**Files:**
- Modify: `src/style.css` — add `.op-add-modal-card`, calendar grid, and settings styles

- [ ] **Step 1: Add modal and calendar CSS**

At the end of `src/style.css` (before the first `@media` block, or after the Open Play section if one exists), add:

```css
/* ─── ADD SCHEDULE MODAL ───────────────────────────────── */

.op-add-modal-card {
  max-width: 520px;
  width: 100%;
  text-align: left;
  padding: 1.5rem;
}

/* Calendar */
.op-cal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.op-cal-title {
  font-weight: 700;
  font-size: 0.95rem;
  color: var(--text-primary);
}

.op-cal-nav {
  background: var(--bg);
  border: 1px solid var(--border-light);
  border-radius: 6px;
  width: 2rem;
  height: 2rem;
  font-size: 1.1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: all var(--transition);
}

.op-cal-nav:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.op-cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 3px;
  margin-bottom: 0.5rem;
}

.op-cal-day-label {
  text-align: center;
  font-size: 0.65rem;
  font-weight: 700;
  color: var(--text-muted);
  padding: 0.2rem 0;
  text-transform: uppercase;
}

.op-cal-cell {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.78rem;
  border-radius: 4px;
  cursor: default;
  user-select: none;
}

.op-cal-day {
  cursor: pointer;
  font-weight: 600;
  color: var(--text-primary);
  transition: background var(--transition), color var(--transition);
}

.op-cal-day:hover {
  background: var(--accent);
  color: var(--primary);
}

.op-cal-day.selected {
  background: var(--primary);
  color: var(--white);
}

.op-cal-empty {
  pointer-events: none;
}

.op-cal-count {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-muted);
  text-align: center;
  margin-bottom: 1rem;
}

/* Settings grid */
.op-modal-settings {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.op-modal-enabled-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--text-secondary);
}

/* Mobile */
@media (max-width: 480px) {
  .op-add-modal-card {
    padding: 1rem;
  }

  .op-modal-settings {
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/style.css
git commit -m "style(open-play): add modal and calendar CSS for add-schedule modal"
```

---

## Task 4: Modal + Calendar JS Logic

**Files:**
- Modify: `src/main.js` — add modal state variables, `openAddScheduleModal`, `closeAddScheduleModal`, `renderOpModalCalendar`, `selectOpRange`, `updateOpModalSaveBtn`, `saveAddScheduleModal`; update `#btn-add-open-play` listener

- [ ] **Step 1: Add module-level state variables**

Find the line `let allCourts = [];` near the top of `src/main.js` (line ~9). After it, add:

```js
let opModalSelectedDates = new Set();
let opModalCurrentMonth = new Date();
let opModalLastClicked = null;
let opModalDragStart = null;
```

- [ ] **Step 2: Add `openAddScheduleModal` and `closeAddScheduleModal`**

In `src/main.js`, find the `// ─── OPEN PLAY API ───` section comment. Just before it (so around line 235), add:

```js
// ─── ADD SCHEDULE MODAL ──────────────────────────────────────────────────────

function openAddScheduleModal() {
  opModalSelectedDates = new Set();
  opModalCurrentMonth = new Date();
  opModalLastClicked = null;
  opModalDragStart = null;
  document.getElementById('op-modal-start').value = '';
  document.getElementById('op-modal-end').value = '';
  document.getElementById('op-modal-price').value = '';
  document.getElementById('op-modal-max').value = '';
  document.getElementById('op-modal-enabled').checked = false;
  renderOpModalCalendar();
  updateOpModalSaveBtn();
  document.getElementById('op-add-modal').classList.add('show');
}

function closeAddScheduleModal() {
  document.getElementById('op-add-modal').classList.remove('show');
}
```

- [ ] **Step 3: Add `renderOpModalCalendar`**

Immediately after `closeAddScheduleModal`, add:

```js
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
```

- [ ] **Step 4: Add `selectOpRange`, `updateOpModalSaveBtn`, and `saveAddScheduleModal`**

Immediately after `renderOpModalCalendar`, add:

```js
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
  const start = document.getElementById('op-modal-start').value;
  const end = document.getElementById('op-modal-end').value;
  btn.disabled = count === 0 || !start || !end;
  btn.textContent = count > 0 ? `Add ${count} Session(s)` : 'Add Session(s)';
}

async function saveAddScheduleModal() {
  const start_time = document.getElementById('op-modal-start').value;
  const end_time = document.getElementById('op-modal-end').value;
  const price_per_player = parseInt(document.getElementById('op-modal-price').value) || 0;
  const max_players = parseInt(document.getElementById('op-modal-max').value) || 0;
  const is_enabled = document.getElementById('op-modal-enabled').checked;

  if (!start_time || !end_time) { showToast('Please set start and end time.', true); return; }
  if (opModalSelectedDates.size === 0) { showToast('Please select at least one date.', true); return; }

  const btn = document.getElementById('op-modal-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    await Promise.all([...opModalSelectedDates].map(date =>
      upsertOpenPlaySession(null, {
        is_enabled, date, start_time, end_time, price_per_player, max_players,
        session_type: 'open',
      })
    ));
    closeAddScheduleModal();
    await loadOpenPlay();
    showToast(`${opModalSelectedDates.size} session(s) added.`);
  } catch (e) {
    showToast(e.message || 'Failed to save sessions.', true);
    btn.disabled = false;
    updateOpModalSaveBtn();
  }
}
```

- [ ] **Step 5: Update the `#btn-add-open-play` event listener**

Find this block in `src/main.js` (around line 2412):

```js
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

Replace it with:

```js
  document.getElementById('btn-add-open-play').addEventListener('click', openAddScheduleModal);
  document.getElementById('op-add-modal-close').addEventListener('click', closeAddScheduleModal);
  document.getElementById('op-add-modal-cancel').addEventListener('click', closeAddScheduleModal);
  document.getElementById('op-add-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('op-add-modal')) closeAddScheduleModal();
  });
  document.getElementById('op-modal-save').addEventListener('click', saveAddScheduleModal);
  ['op-modal-start', 'op-modal-end'].forEach(id => {
    document.getElementById(id).addEventListener('change', updateOpModalSaveBtn);
  });
```

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "feat(open-play): replace inline form with multi-date add-schedule modal"
```

---

## Task 5: Smoke Test

- [ ] **Step 1: Run the dev server**

```bash
npm run dev
```

- [ ] **Step 2: Check tab borders**

Open the app in a browser. Each tab should have a visible box border (top + left + right) with rounded top corners. The active tab should have a primary-color border and white background. Non-active tabs have a light grey border.

- [ ] **Step 3: Test the modal**

Click "+ Add Schedule". A modal should open with:
- A month calendar (current month)
- Prev/next month navigation working
- Clicking individual days toggles selection (highlighted in primary colour)
- Shift+clicking a second day selects all days in between
- Dragging across days selects a range
- "X date(s) selected" counter updates
- Save button stays disabled until at least 1 date + both time fields are filled
- Filling start/end time enables the Save button showing correct count
- Clicking Save creates sessions and refreshes the list
- X button, Cancel button, and clicking the overlay all close the modal

- [ ] **Step 4: Check mobile view**

Resize browser to 375px wide. Tabs should still show bordered boxes (smaller padding). Modal should be full-width and scrollable.
