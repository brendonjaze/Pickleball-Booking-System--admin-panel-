# Open Play Bulk Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Select mode to the Open Play tab so the admin can check multiple sessions and delete them all at once.

**Architecture:** A module-level `opSelectMode` flag and `opSelectedIds` Set track state. Checkboxes are always rendered inside each `.op-session-row` but hidden via CSS; adding `.op-select-active` to `#open-play-list` makes them visible without re-rendering rows. A toolbar div `#op-select-toolbar` lives between the header and the list and is populated dynamically when select mode is active. The existing `softDeleteOpenPlaySession` and `op-delete-session-modal` are reused with no changes.

**Tech Stack:** Vanilla JS, CSS custom properties, Vite

---

## File Map

| File | What changes |
|---|---|
| `src/main.js` | Select state variables; `renderSessionRow` gets checkbox; `attachRowListeners` gets checkbox listener; new `enterSelectMode`, `exitSelectMode`, `renderSelectToolbar`, `bulkDeleteSelected`; "Select" button listener wired in init |
| `src/style.css` | `.btn-select-sessions`, `.op-select-toolbar`, `.op-select-checkbox` (hidden by default, visible under `.op-select-active`), `.op-select-active` row highlight |

---

## Task 1: HTML — Add "Select" Button and Toolbar Placeholder

**Files:**
- Modify: `src/main.js` — `renderApp()` Open Play tab section (around line 2314)

- [ ] **Step 1: Add "Select" button next to "+ Add Schedule" and insert toolbar div**

Find this block in `renderApp()`:

```html
          <div class="op-tab-header">
            <div>
              <div class="section-title">🏃 Open Play</div>
              <p class="section-desc">Manage drop-in open play schedules. Players can sign up when a session is enabled.</p>
            </div>
            <button class="btn-add-schedule" id="btn-add-open-play"><span class="btn-add-schedule-icon">＋</span> Add Schedule</button>
          </div>

          <div id="open-play-list">
```

Replace it with:

```html
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
```

- [ ] **Step 2: Commit**

```bash
git add src/main.js
git commit -m "feat(open-play): add Select button and toolbar placeholder HTML"
```

---

## Task 2: CSS — Select Button, Toolbar, Checkbox

**Files:**
- Modify: `src/style.css` — add after the `.btn-add-schedule-icon` block (around line 2733)

- [ ] **Step 1: Add CSS**

Find this line in `src/style.css`:

```css
.op-session-row {
  background: var(--white);
```

Insert before it:

```css
.op-header-actions {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  flex-wrap: wrap;
}

.btn-select-sessions {
  padding: 0.6rem 1.1rem;
  border: 2px solid var(--border-light);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-secondary);
  font-family: 'Montserrat', sans-serif;
  font-size: 0.82rem;
  font-weight: 700;
  cursor: pointer;
  transition: all var(--transition);
}

.btn-select-sessions:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.btn-select-sessions.active {
  border-color: var(--primary);
  background: var(--primary);
  color: var(--white);
}

/* Select toolbar */
.op-select-toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.65rem 1rem;
  background: var(--accent);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}

.op-select-toolbar-label {
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--text-secondary);
  flex: 1;
}

.btn-bulk-delete {
  padding: 0.5rem 1rem;
  background: var(--danger, #e53e3e);
  color: var(--white);
  border: none;
  border-radius: var(--radius-xs);
  font-family: 'Montserrat', sans-serif;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
  transition: filter var(--transition);
}

.btn-bulk-delete:disabled {
  opacity: 0.45;
  cursor: default;
}

.btn-bulk-delete:not(:disabled):hover {
  filter: brightness(1.1);
}

.btn-cancel-select {
  padding: 0.5rem 1rem;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-xs);
  font-family: 'Montserrat', sans-serif;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
  transition: all var(--transition);
}

.btn-cancel-select:hover {
  border-color: var(--border);
  color: var(--text-primary);
}

/* Row checkbox — hidden until select mode active */
.op-select-checkbox-wrap {
  display: none;
  align-items: center;
  padding-right: 0.75rem;
}

.op-select-active .op-select-checkbox-wrap {
  display: flex;
}

.op-select-checkbox-wrap input[type="checkbox"] {
  width: 1.1rem;
  height: 1.1rem;
  cursor: pointer;
  accent-color: var(--primary);
}

.op-session-row.op-row-selected {
  border-color: var(--primary);
  background: color-mix(in srgb, var(--primary) 6%, var(--white));
}

/* Hide individual delete button in select mode */
.op-select-active .op-btn-delete {
  display: none;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/style.css
git commit -m "style(open-play): add select mode, toolbar, and checkbox CSS"
```

---

## Task 3: JS State Variables and Modal Functions

**Files:**
- Modify: `src/main.js` — state variables near top; new functions before `// ─── OPEN PLAY API ───`

- [ ] **Step 1: Add state variables**

Find this existing block near the top of `src/main.js`:

```js
let opModalSelectedDates = new Set();
let opModalCurrentMonth = new Date();
let opModalLastClicked = null;
let opModalDragStart = null;
```

Add two lines after it:

```js
let opSelectMode = false;
let opSelectedIds = new Set();
```

- [ ] **Step 2: Add `enterSelectMode`, `exitSelectMode`, `renderSelectToolbar`, `bulkDeleteSelected`**

Find the comment `// ─── ADD SCHEDULE MODAL ───` in `src/main.js`. Insert these four functions immediately before it:

```js
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

  const selectAllCb = document.getElementById('op-select-all');
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
```

- [ ] **Step 3: Commit**

```bash
git add src/main.js
git commit -m "feat(open-play): add select mode state and bulk delete functions"
```

---

## Task 4: Update `renderSessionRow` and `attachRowListeners`

**Files:**
- Modify: `src/main.js` — `renderSessionRow` and `attachRowListeners`

- [ ] **Step 1: Add checkbox to `renderSessionRow`**

Find this in `renderSessionRow`:

```js
    <div class="op-session-row${isNew ? ' op-session-new' : ''}" data-id="${id}">
      <div class="op-session-fields">
```

Replace with:

```js
    <div class="op-session-row${isNew ? ' op-session-new' : ''}" data-id="${id}">
      <div class="op-select-checkbox-wrap">
        <input type="checkbox" />
      </div>
      <div class="op-session-fields">
```

- [ ] **Step 2: Add checkbox listener in `attachRowListeners`**

Find this in `attachRowListeners`:

```js
  container.querySelectorAll('.op-session-row').forEach(row => {
    row.querySelector('.op-enabled').addEventListener('change', () => autoSaveEnabled(row));
    row.querySelector('.op-btn-save').addEventListener('click', () => saveSessionRow(row));
    row.querySelector('.op-btn-delete').addEventListener('click', () => deleteSessionRow(row));
```

Replace with:

```js
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
```

- [ ] **Step 3: Commit**

```bash
git add src/main.js
git commit -m "feat(open-play): add per-row checkbox for select mode"
```

---

## Task 5: Wire "Select" Button in Init

**Files:**
- Modify: `src/main.js` — event listener init block (where `btn-add-open-play` listener is)

- [ ] **Step 1: Add listener for "Select" button**

Find this line in the init block:

```js
  document.getElementById('btn-add-open-play').addEventListener('click', openAddScheduleModal);
```

Add one line immediately before it:

```js
  document.getElementById('btn-select-sessions').addEventListener('click', () => {
    if (opSelectMode) exitSelectMode(); else enterSelectMode();
  });
```

- [ ] **Step 2: Commit**

```bash
git add src/main.js
git commit -m "feat(open-play): wire Select button to toggle select mode"
```

---

## Task 6: Smoke Test

- [ ] **Step 1: Run dev server**

```bash
npm run dev
```

- [ ] **Step 2: Verify select mode**

Open the app → Open Play tab. Confirm:
- "Select" button visible next to "+ Add Schedule"
- Clicking "Select" shows checkboxes on every row, hides "+ Add Schedule", shows toolbar
- "Select" button changes appearance (active state)
- Checking rows updates "Delete Selected (N)" count and enables the button
- "Select All" checks every row and updates count
- Unchecking "Select All" unchecks everything
- "Cancel" exits select mode cleanly, all checkboxes cleared

- [ ] **Step 3: Verify bulk delete**

Check 2–3 sessions → click "Delete Selected (N)" → custom confirmation modal appears → confirm → sessions disappear from list → toast shows "X session(s) deleted."

- [ ] **Step 4: Verify individual delete still works**

Outside select mode, click the ✕ on a single session → custom modal appears → works as before.
