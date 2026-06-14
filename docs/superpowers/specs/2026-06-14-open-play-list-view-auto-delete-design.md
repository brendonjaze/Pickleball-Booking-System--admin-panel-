# Open Play — List View + Auto-Delete Passed Schedules

**Date:** 2026-06-14
**Status:** Approved (design)

## Problem

The Open Play tab renders every schedule as a full, always-expanded editable
card (see `renderSessionRow` in `src/main.js`). With many schedules the page
becomes a long, cluttered wall of form fields. Two changes are wanted:

1. **Auto-delete passed schedules** — once a schedule's session has ended, it
   should disappear automatically instead of lingering.
2. **Collapse to a list** — show each schedule as a compact summary row. The
   editable details and the player list only appear when the admin clicks the
   row open.

## Constraints / Context

- Vanilla JS + Vite + Supabase REST (no SDK, no backend, no cron). All logic is
  client-side. Established pattern: plain `fetch()` via `sbFetch()`.
- Data model:
  - `open_play_sessions` — `id`, `date` (YYYY-MM-DD text), `start_time`,
    `end_time` (HH:MM), `price_per_player`, `max_players`, `is_enabled`,
    `session_type`, `deleted_at`, `updated_at`.
  - `open_play_queue` — `id`, `session_id`, `player_name`, `mobile`,
    `created_at`.
- Existing soft-delete pattern: `fetchAllOpenPlaySessions()` filters
  `deleted_at=is.null`; `softDeleteOpenPlaySession(id)` sets `deleted_at`.
- Existing features to preserve: bulk select/delete mode (`opSelectMode`,
  `opSelectedIds`, checkboxes), per-row Save, single Delete, enabled toggle,
  lazy-loaded registrations panel.

## Decisions (confirmed with user)

- **"Passed" = after the session's real end time.** Because end times are at or
  before start times (e.g. 6:00 PM → 12:00 AM), the session crosses midnight, so
  the true end is the *next day* at the end time.
- **Soft delete.** Passed schedules get `deleted_at` set; records and player
  signups are preserved and recoverable.
- **Independent multi-open list.** Clicking a row toggles its own expansion;
  several rows can be open at once.
- **Enabled toggle stays in the always-visible header** (preserves one-click
  enable/disable without expanding).
- **Single Delete lives inside the expanded details** (bulk-delete already
  covers list-level deletion).

## Design

### 1. `isSessionPassed(session, now)` helper

Pure function. Returns `true` when the session has ended.

```
function isSessionPassed(s, now) {
  if (!s || !s.date) return false;          // unsaved / no date → never passed
  const [y, mo, d] = s.date.split('-').map(Number);
  const start = s.start_time || null;
  const end = s.end_time || null;

  // No end time: passed once the calendar day is fully over (next day 00:00).
  if (!end) {
    const endDt = new Date(y, mo - 1, d + 1, 0, 0, 0);
    return now >= endDt;
  }

  const [eh, em] = end.split(':').map(Number);
  // If end <= start, the session crosses midnight → ends next day.
  let dayOffset = 0;
  if (start) {
    const [sh, sm] = start.split(':').map(Number);
    if (eh * 60 + em <= sh * 60 + sm) dayOffset = 1;
  }
  const endDt = new Date(y, mo - 1, d + dayOffset, eh, em, 0);
  return now > endDt;
}
```

- Local time throughout (`new Date(y, m, d, ...)`); admin is in PH timezone and
  dates are stored as naive local dates.
- `now` is passed in (single `new Date()` captured by the caller) so all rows are
  evaluated against the same instant.

### 2. Auto-delete on load

In `loadOpenPlay()`, after fetching:

```
const sessions = await fetchAllOpenPlaySessions();
const now = new Date();
const passed = sessions.filter(s => isSessionPassed(s, now));
const active = sessions.filter(s => !isSessionPassed(s, now));

// Fire-and-forget soft-delete of passed sessions; failures retry next load.
passed.forEach(s => softDeleteOpenPlaySession(s.id).catch(err =>
  console.error('Auto-delete failed for session', s.id, err)));

// Fetch registration counts for the active sessions, then render.
const counts = await fetchOpenPlayRegistrationCounts(active.map(s => s.id));
renderOpenPlayTable(active, counts);
```

- Passed sessions are excluded from render unconditionally, so they never flash
  on screen even if the soft-delete request is still in flight or fails.
- Runs every time the admin opens the Open Play tab (`loadOpenPlay` is called
  from the tab switch). This is the only trigger available without a server.

### 3. Registration counts in one query

New API helper:

```
async function fetchOpenPlayRegistrationCounts(sessionIds) {
  if (!sessionIds.length) return {};
  const list = sessionIds.join(',');
  const rows = await sbFetch(
    `open_play_queue?session_id=in.(${list})&select=session_id`);
  const counts = {};
  rows.forEach(r => { counts[r.session_id] = (counts[r.session_id] || 0) + 1; });
  return counts;
}
```

Returns a `{ sessionId: count }` map used to render `count / max` in each
collapsed header. One request total for the whole list.

### 4. Collapsed/expanded row markup

`renderSessionRow(s, count)` is rewritten to produce two parts:

**Always-visible summary header** (`.op-row-header`):
- Expand chevron (`▸` collapsed / `▾` expanded)
- Date (formatted, e.g. `Jun 13, 2026`) · time range (`6:00 PM – 12:00 AM` via
  existing `fmt12`)
- `count / max_players` players
- Enabled toggle (`.op-enabled`) — `click` calls `stopPropagation` so toggling
  does not expand the row
- Select-mode checkbox (`.op-select-checkbox-wrap`) — shown only in select mode,
  same as today

**Hidden detail section** (`.op-session-detail`, shown when row has
`.op-expanded`):
- Editable fields: Date, Start, End, Price, Max (same inputs/classes as today:
  `.op-date`, `.op-start`, `.op-end`, `.op-price`, `.op-max`)
- Actions: **Save** (`.op-btn-save`), **Delete** (`.op-btn-delete`)
- Status line (`.op-session-status`)
- Registrations panel (`.op-registrations-panel`) — lazy-loaded on first expand

A **new unsaved row** (no `id`) renders **expanded** by default, with empty
fields and no registrations panel.

### 5. Interaction wiring (`attachRowListeners`)

- **Header click** (excluding the enabled toggle and, in select mode, mapped to
  the checkbox):
  - If `opSelectMode`: toggle this row's checkbox (existing select behavior).
  - Else: toggle `.op-expanded` on the row. On first expansion of a saved row,
    lazy-load the registrations panel (existing `renderRegistrationsPanel`).
- **Enabled toggle** `change`: existing `autoSaveEnabled(row)`; the `click`
  handler stops propagation so it never triggers expand.
- **Save** / **Delete** / **checkbox**: unchanged from current handlers.

### 6. Render signature changes

- `renderOpenPlayTable(sessions, counts)` — passes each session's count into
  `renderSessionRow`.
- Empty state unchanged.

### 7. CSS

- `.op-row-header` — flex row, pointer cursor, hover state, compact padding.
- `.op-session-detail` — `display:none` by default; `.op-expanded
  .op-session-detail` → `display:block`. Reuse existing field/grid styles where
  possible.
- Chevron rotation/swap between collapsed and expanded.
- Keep existing `.op-registrations-panel`, `.op-reg-*`, select-mode, and toggle
  styles.

## Edge cases

- **New unsaved row**: never auto-deleted (no date); renders expanded; no
  players panel until saved (gets an `id`).
- **Missing end_time**: passed once the next calendar day starts.
- **Midnight-crossing** (`end_time <= start_time`): end computed on `date + 1`.
- **Soft-delete failure**: logged; session reappears next load and retry occurs.
- **Count fetch failure**: render with counts defaulting to `0` (or `–`) rather
  than blocking the list. Wrap the count fetch so a failure still renders rows.

## Out of scope

- Server-side / scheduled deletion (no backend exists).
- Hard deletion of sessions or queue rows.
- Changes to the player-facing app.
- Recovering/undeleting soft-deleted sessions via the UI.

## Files touched

- `src/main.js` — `isSessionPassed`, `fetchOpenPlayRegistrationCounts`,
  `loadOpenPlay`, `renderOpenPlayTable`, `renderSessionRow`,
  `attachRowListeners`, and the registrations/expand wiring.
- `src/style.css` — collapsed/expanded row styles, header layout, chevron.
