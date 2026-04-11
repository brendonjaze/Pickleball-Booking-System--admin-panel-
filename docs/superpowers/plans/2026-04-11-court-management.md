# Court Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow admin to add/edit/deactivate courts from the admin panel; changes reflect immediately on the user-side booking app via Supabase.

**Architecture:** New `courts` table in Supabase becomes single source of truth. Admin panel fetches courts on load, replaces all hardcoded `[1,2,3,4]` arrays and `COURT_NAMES` constant with dynamic data. A new "Courts" tab lets admin manage courts. User side fetches active courts and renders cards dynamically.

**Tech Stack:** Vanilla JS, Vite, Supabase REST API (plain fetch — no SDK)

---

## File Map

| File | Change |
|---|---|
| `src/main.js` | All changes — add API fns, replace hardcoded courts, add Courts tab HTML + JS |
| `src/style.css` | Add styles for Courts tab (list, form, toggle) |

---

## Task 1: Create `courts` table in Supabase

**Files:**
- No code files — run SQL in Supabase dashboard

- [ ] **Step 1: Open Supabase SQL editor**

Go to your Supabase project → SQL Editor → New query.

- [ ] **Step 2: Run migration**

```sql
create table courts (
  id serial primary key,
  name text not null,
  type text not null check (type in ('Indoor', 'Outdoor')),
  price_per_hour int not null default 100,
  is_active boolean not null default true,
  sort_order int not null default 0
);

-- Seed existing courts
insert into courts (name, type, price_per_hour, is_active, sort_order) values
  ('Court 1', 'Outdoor', 100, true, 1),
  ('Court 2', 'Indoor',  100, true, 2),
  ('Court 3', 'Indoor',  100, true, 3),
  ('Court 4', 'Indoor',  100, true, 4);
```

- [ ] **Step 3: Enable public read access (RLS)**

Still in SQL Editor, run:

```sql
alter table courts enable row level security;

create policy "Public read courts"
  on courts for select
  using (true);

create policy "Authenticated manage courts"
  on courts for all
  using (auth.role() = 'authenticated');
```

- [ ] **Step 4: Verify**

In Supabase Table Editor, open `courts` table. Should show 4 rows (Court 1–4).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: note courts table created in Supabase"
```

---

## Task 2: Add court API functions to `src/main.js`

**Files:**
- Modify: `src/main.js` (after the `deleteCourtLockGroup` function, around line 210)

- [ ] **Step 1: Add fetch and CRUD functions**

After line 210 (after `deleteCourtLockGroup`), insert:

```js
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
```

- [ ] **Step 2: Verify dev server starts without errors**

Run: `npm run dev`
Expected: No console errors on load.

- [ ] **Step 3: Commit**

```bash
git add src/main.js
git commit -m "feat: add court management API functions"
```

---

## Task 3: Load courts on init, replace COURT_NAMES

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: Replace COURT_NAMES constant with allCourts array**

Find line 10:
```js
const COURT_NAMES = { 1: 'Court 1', 2: 'Court 2', 3: 'Court 3', 4: 'Court 4' };
```
Replace with:
```js
let allCourts = []; // populated on load from Supabase
```

- [ ] **Step 2: Update `courtBadge()` to use allCourts**

Find (around line 364):
```js
function courtBadge(id) {
  return `<span class="court-badge c${id}">${COURT_NAMES[id] || 'Court ' + id}</span>`;
}
```
Replace with:
```js
function courtBadge(id) {
  const court = allCourts.find(c => c.id === id);
  return `<span class="court-badge c${id}">${court ? court.name : 'Court ' + id}</span>`;
}
```

- [ ] **Step 3: Load courts during app initialization**

Find the `init()` function (search for `async function init()`). At the top of init, before `fetchAllBookings()` is called, add:

```js
allCourts = await fetchCourts();
```

- [ ] **Step 4: Verify**

Open browser. Booking table court badges should still render correctly.

- [ ] **Step 5: Commit**

```bash
git add src/main.js
git commit -m "feat: load courts dynamically from Supabase on init"
```

---

## Task 4: Dynamic dashboard stat cards

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: Replace hardcoded court stat cards in HTML template**

In the HTML template (around line 1209), find and remove the three hardcoded stat cards:
```html
<div class="stat-card court1">
  <div class="stat-icon">💙</div>
  <div class="stat-label">Court 1</div>
  <div class="stat-value" id="stat-court1">—</div>
  <div class="stat-sub">Bookings today</div>
</div>
<div class="stat-card court2">
  <div class="stat-icon">💜</div>
  <div class="stat-label">Court 2</div>
  <div class="stat-value" id="stat-court2">—</div>
  <div class="stat-sub">Bookings today</div>
</div>
<div class="stat-card court3">
  <div class="stat-icon">🩷</div>
  <div class="stat-label">Court 3</div>
  <div class="stat-value" id="stat-court3">—</div>
  <div class="stat-sub">Bookings today</div>
</div>
```
Replace with a single container:
```html
<div id="court-stat-cards"></div>
```

- [ ] **Step 2: Update `updateDashboard()` to render stat cards dynamically**

Find `updateDashboard()` (around line 290). Replace the court stat block:
```js
[1, 2, 3].forEach(c => {
  const count = todayGrouped.filter(b => b.court_id === c).length;
  document.getElementById(`stat-court${c}`).textContent = count;
});
```
Replace with:
```js
const courtStatContainer = document.getElementById('court-stat-cards');
const COURT_COLORS = ['#4a90d9', '#7b4ea6', '#c0392b', '#27ae60', '#e67e22'];
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
```

- [ ] **Step 3: Update revenue stat sub-label**

Find (around line 1207):
```html
<div class="stat-sub">₱${RATE_PER_HOUR}/hour per court</div>
```
Replace with:
```html
<div class="stat-sub">Per court/hour</div>
```

- [ ] **Step 4: Verify**

Load app. Dashboard should show one stat card per court from Supabase, with colored tops.

- [ ] **Step 5: Commit**

```bash
git add src/main.js
git commit -m "feat: render dashboard court stat cards dynamically"
```

---

## Task 5: Dynamic filter and court lock dropdowns

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: Replace hardcoded bookings filter dropdown**

Find in HTML template (around line 1242):
```html
<select id="filter-court">
  <option value="">All Courts</option>
  <option value="1">Court 1</option>
  <option value="2">Court 2</option>
  <option value="3">Court 3</option>
</select>
```
Replace with:
```html
<select id="filter-court">
  <option value="">All Courts</option>
</select>
```

- [ ] **Step 2: Replace hardcoded court lock dropdown**

Find in HTML template (around line 1419):
```html
<select id="lock-court">
  <option value="all">All Courts</option>
  <option value="1">Court 1</option>
  <option value="2">Court 2</option>
  <option value="3">Court 3</option>
  <option value="4">Court 4</option>
</select>
```
Replace with:
```html
<select id="lock-court">
  <option value="all">All Courts</option>
</select>
```

- [ ] **Step 3: Add function to populate dropdowns**

After the `courtBadge()` function, add:

```js
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
```

- [ ] **Step 4: Call `populateCourtDropdowns()` after courts load**

In `init()`, right after `allCourts = await fetchCourts();`, add:
```js
populateCourtDropdowns();
```

- [ ] **Step 5: Fix court lock logic to use allCourts IDs**

Find (around line 938):
```js
const courts = courtVal === 'all' ? [1, 2, 3, 4] : [parseInt(courtVal)];
```
Replace with:
```js
const courts = courtVal === 'all' ? allCourts.map(c => c.id) : [parseInt(courtVal)];
```

- [ ] **Step 6: Verify**

Load app. Bookings filter and Court Lock court select should list courts from Supabase.

- [ ] **Step 7: Commit**

```bash
git add src/main.js
git commit -m "feat: populate court dropdowns dynamically from Supabase"
```

---

## Task 6: Dynamic revenue breakdown + per-court pricing

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: Replace hardcoded revenue breakdown cards in HTML template**

Find (around line 1304):
```html
<div class="revenue-grid">
  <div class="revenue-card court1">
    <div class="rev-card-label">Court 1</div>
    <div class="rev-card-amount" id="rev-court1-amount">₱0</div>
    <div class="rev-card-meta">
      <span id="rev-court1-hours">0h</span> · <span id="rev-court1-bookings">0 bookings</span>
    </div>
  </div>
  <div class="revenue-card court2">
    <div class="rev-card-label">Court 2</div>
    <div class="rev-card-amount" id="rev-court2-amount">₱0</div>
    <div class="rev-card-meta">
      <span id="rev-court2-hours">0h</span> · <span id="rev-court2-bookings">0 bookings</span>
    </div>
  </div>
  <div class="revenue-card court3">
    <div class="rev-card-label">Court 3</div>
    <div class="rev-card-amount" id="rev-court3-amount">₱0</div>
    <div class="rev-card-meta">
      <span id="rev-court3-hours">0h</span> · <span id="rev-court3-bookings">0 bookings</span>
    </div>
  </div>
</div>
```
Replace with:
```html
<div class="revenue-grid" id="revenue-court-cards"></div>
```

- [ ] **Step 2: Rewrite `updateRevenue()` court breakdown block**

Find in `updateRevenue()` (around line 342):
```js
// Court breakdown
[1, 2, 3].forEach(c => {
  const courtSlots = filtered.filter(b => b.court_id === c);
  const courtGrouped = groupBookingsByRef(courtSlots);
  document.getElementById(`rev-court${c}-amount`).textContent =
    `₱${(courtSlots.length * RATE_PER_HOUR).toLocaleString()}`;
  document.getElementById(`rev-court${c}-hours`).textContent = `${courtSlots.length}h`;
  document.getElementById(`rev-court${c}-bookings`).textContent =
    `${courtGrouped.length} booking${courtGrouped.length !== 1 ? 's' : ''}`;
});
```
Replace with:
```js
// Court breakdown
const COURT_COLORS = ['#4a90d9', '#7b4ea6', '#c0392b', '#27ae60', '#e67e22'];
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
```

- [ ] **Step 3: Fix total revenue to use per-court pricing**

Find in `updateRevenue()`:
```js
const totalRevenue = filtered.length * RATE_PER_HOUR;
```
Replace with:
```js
const totalRevenue = filtered.reduce((sum, b) => {
  const court = allCourts.find(c => c.id === b.court_id);
  return sum + (court ? court.price_per_hour : 100);
}, 0);
```

- [ ] **Step 4: Fix today's revenue in `updateDashboard()`**

Find (around line 299):
```js
document.getElementById('stat-revenue').textContent =
  `₱${(todayBookings.length * RATE_PER_HOUR).toLocaleString()}`;
```
Replace with:
```js
const todayRevenue = todayBookings.reduce((sum, b) => {
  const court = allCourts.find(c => c.id === b.court_id);
  return sum + (court ? court.price_per_hour : 100);
}, 0);
document.getElementById('stat-revenue').textContent = `₱${todayRevenue.toLocaleString()}`;
```

- [ ] **Step 5: Remove RATE_PER_HOUR constant**

Find line 7:
```js
const RATE_PER_HOUR = 100;
```
Delete this line. (Search for remaining usages of `RATE_PER_HOUR` and confirm none remain.)

- [ ] **Step 6: Verify**

Load app → Revenue tab. Court cards should appear dynamically. Totals should match.

- [ ] **Step 7: Commit**

```bash
git add src/main.js
git commit -m "feat: dynamic revenue breakdown with per-court pricing"
```

---

## Task 7: Courts Management tab — HTML

**Files:**
- Modify: `src/main.js` (HTML template section)

- [ ] **Step 1: Add "Courts" tab button**

Find the tab navigation in HTML (around line 1178):
```html
<button class="tab-btn" data-tab="locks">
  <span class="tab-icon">🔒</span>
  Court Lock
</button>
```
After it, add:
```html
<button class="tab-btn" data-tab="courts">
  <span class="tab-icon">🏓</span>
  Courts
</button>
```

- [ ] **Step 2: Add "Courts" tab content**

Find (around line 1440):
```html
</div><!-- /tab-locks -->
```
After it, add:
```html
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
      <label for="court-type">Type</label>
      <select id="court-type">
        <option value="Indoor">Indoor</option>
        <option value="Outdoor">Outdoor</option>
      </select>
    </div>
    <div class="filter-group">
      <label for="court-price">Price per Hour (₱)</label>
      <input type="number" id="court-price" placeholder="100" min="1" value="100" />
    </div>
    <button class="btn-primary btn-add-court" id="btn-add-court">+ Add Court</button>
  </div>
  <div class="form-error" id="court-form-error"></div>
</div><!-- /tab-courts -->
```

- [ ] **Step 3: Verify HTML renders**

Load app. Click "Courts" tab. Should show loading spinner and empty add form.

- [ ] **Step 4: Commit**

```bash
git add src/main.js
git commit -m "feat: add Courts tab HTML structure"
```

---

## Task 8: Courts Management tab — JS logic

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: Add `renderCourtsTab()` function**

After `renderCourtLocks()` function, add:

```js
// ─── COURTS MANAGEMENT ────────────────────────────────────────────────────────

const COURT_COLORS = ['#4a90d9', '#7b4ea6', '#c0392b', '#27ae60', '#e67e22'];

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
          <button class="btn-court-toggle ${court.is_active ? 'btn-deactivate' : 'btn-activate'}"
            data-id="${court.id}" data-active="${court.is_active}">
            ${court.is_active ? 'Deactivate' : 'Activate'}
          </button>
        </div>
      </div>`;
  }).join('');

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
```

- [ ] **Step 2: Add `handleAddCourt()` function**

Right after `renderCourtsTab()`, add:

```js
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
```

- [ ] **Step 3: Wire up Courts tab in `switchTab()`**

Find `switchTab()` (around line 661). In the block that handles tab-specific logic, add:

```js
if (tab === 'courts') renderCourtsTab();
```

- [ ] **Step 4: Wire up Add Court button in event listeners**

In the event listeners section (after login form), add:

```js
document.getElementById('btn-add-court')?.addEventListener('click', handleAddCourt);
```

- [ ] **Step 5: Remove duplicate COURT_COLORS declarations**

Search `src/main.js` for all occurrences of:
```js
const COURT_COLORS = ['#4a90d9', '#7b4ea6', '#c0392b', '#27ae60', '#e67e22'];
```
Keep only the one added in Step 1 of this task (inside the Courts Management section). Remove all others added in Tasks 4 and 6.

- [ ] **Step 6: Verify**

Load app → Courts tab. Should list all 4 courts with color swatch, type, price. Click "Deactivate" on one — it should update immediately. Add a new court — it should appear in list and in all dropdowns.

- [ ] **Step 7: Commit**

```bash
git add src/main.js
git commit -m "feat: courts management tab — list, add, activate/deactivate"
```

---

## Task 9: Add Courts tab styles

**Files:**
- Modify: `src/style.css`

- [ ] **Step 1: Add court management styles**

At the end of `src/style.css`, add:

```css
/* ─── COURTS MANAGEMENT ─────────────────────────────────────────────────────── */

.court-add-form {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: flex-end;
  background: #fff;
  border-radius: 12px;
  padding: 1.25rem;
  box-shadow: 0 1px 4px rgba(0,0,0,0.07);
  margin-bottom: 0.5rem;
}

.btn-add-court {
  width: auto;
  white-space: nowrap;
}

.courts-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.court-item {
  display: flex;
  align-items: center;
  gap: 1rem;
  background: #fff;
  border-radius: 10px;
  padding: 1rem 1.25rem;
  box-shadow: 0 1px 4px rgba(0,0,0,0.07);
}

.court-item.court-inactive {
  opacity: 0.5;
}

.court-item-color {
  width: 14px;
  height: 40px;
  border-radius: 4px;
  flex-shrink: 0;
}

.court-item-info {
  flex: 1;
}

.court-item-name {
  font-weight: 700;
  font-size: 1rem;
  color: #1e5c45;
}

.court-item-meta {
  font-size: 0.85rem;
  color: #666;
  margin-top: 2px;
}

.court-item-actions {
  display: flex;
  gap: 0.5rem;
}

.btn-deactivate {
  background: #fff;
  color: #c0392b;
  border: 1.5px solid #c0392b;
  padding: 0.35rem 0.9rem;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
  font-weight: 600;
  transition: background 0.15s;
}

.btn-deactivate:hover {
  background: #ffeaea;
}

.btn-activate {
  background: #fff;
  color: #1e5c45;
  border: 1.5px solid #1e5c45;
  padding: 0.35rem 0.9rem;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
  font-weight: 600;
  transition: background 0.15s;
}

.btn-activate:hover {
  background: #eaf5ef;
}
```

- [ ] **Step 2: Verify**

Load app → Courts tab. Court list should have colored bars, clean layout. Add form should align properly.

- [ ] **Step 3: Commit**

```bash
git add src/style.css
git commit -m "feat: add Courts tab styles"
```

---

## Task 10: Instructions for user-side Claude

This task is not code — it's what you tell Claude in the user-side project folder.

- [ ] **Step 1: Open the user-side project in Claude Code**

- [ ] **Step 2: Paste this prompt to Claude:**

> We're adding dynamic courts to this app. A `courts` table now exists in our Supabase DB with columns: `id` (int), `name` (text), `type` (text: "Indoor"/"Outdoor"), `price_per_hour` (int), `is_active` (boolean), `sort_order` (int).
>
> **What needs to change:**
> 1. On page load, fetch courts from Supabase where `is_active = true`, ordered by `sort_order asc`. Use plain `fetch()` to the Supabase REST API (same pattern as the rest of the codebase — no SDK).
>    URL: `https://qzjaegutlsgtlaworbuy.supabase.co/rest/v1/courts?select=*&is_active=eq.true&order=sort_order.asc`
>    Headers: `{ 'apikey': '<existing anon key>', 'Content-Type': 'application/json' }`
>
> 2. Replace the hardcoded court cards with a dynamic render loop. For each court, render a card showing:
>    - Court name (`court.name`)
>    - Type tag (`court.type`) — "Indoor" or "Outdoor"
>    - Price (`₱${court.price_per_hour}/hr`)
>    - "Available Today" status (keep existing logic — compute from bookings/locks)
>    - "Book Now" button (same behavior as existing hardcoded buttons)
>
> 3. Auto-assign court color by index from this palette: `['#4a90d9', '#7b4ea6', '#c0392b', '#27ae60', '#e67e22']`
>    Use `palette[index % palette.length]` so it wraps for 5+ courts.
>
> 4. The `court.id` from Supabase is the same integer used in `bookings.court_id` — keep using it as the identifier when booking.
>
> Read the existing court card and booking code first so you follow the same patterns. Do not change the booking flow — only replace the hardcoded court list with a dynamic one.

---

## Self-Review

- **Spec coverage:** ✓ `courts` table with all fields. ✓ Admin Courts tab (add, list, activate/deactivate). ✓ Dynamic dashboard stats. ✓ Dynamic filter + court lock dropdowns. ✓ Dynamic revenue with per-court pricing. ✓ User side instructions.
- **No placeholders:** All steps have exact code.
- **Type consistency:** `allCourts` used consistently. `court.id` (int) matches `bookings.court_id`. `COURT_COLORS` declared once in Task 8, Step 5 cleans up duplicates from Tasks 4 and 6.
- **RATE_PER_HOUR:** Fully removed in Task 6 Step 5. Revenue and dashboard both use per-court pricing.
