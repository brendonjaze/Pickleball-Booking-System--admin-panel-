# Open Play Multiple Schedules — Design Spec

**Date:** 2026-05-05  
**Status:** Approved

---

## Overview

Replace the single fixed "night" open play session with an unlimited list of independently managed schedules. Each schedule has its own date, time range, price, max players, and enabled state. Admins can add, edit, save, and soft-delete sessions from an inline-editable table.

---

## Database

### `open_play_sessions` table — add column

| Column | Type | Notes |
|--------|------|-------|
| `deleted_at` | `timestamptz`, nullable | Null = active; set = soft-deleted |

All existing columns remain. The `session_type` column is kept but no longer used to identify unique sessions — each row is its own independent schedule.

**Soft delete behavior:** When a session is deleted, `deleted_at` is set to the current timestamp. The session row and all associated `open_play_queue` rows are preserved. Deleted sessions are excluded from all admin fetches.

---

## API Layer (`src/main.js`)

### New functions

```js
fetchAllOpenPlaySessions()
// GET open_play_sessions?deleted_at=is.null&order=date.asc,start_time.asc
// Returns all non-deleted sessions

softDeleteOpenPlaySession(id)
// PATCH open_play_sessions?id=eq.{id}
// Body: { deleted_at: new Date().toISOString() }
```

### Removed

- `fetchOpenPlaySession(sessionType)` — replaced by `fetchAllOpenPlaySessions()`
- `currentNightOpenPlayId` state variable — replaced by per-row state

### Reused unchanged

- `upsertOpenPlaySession(id, data)` — handles both POST (new) and PATCH (existing)
- `fetchOpenPlayRegistrations(sessionId)`
- `deleteOpenPlayRegistration(regId)`
- `renderOpenPlayRegistrations(type, sessionId, maxPlayers)`

---

## UI — Open Play Tab

### Layout

```
Open Play Schedules                          [+ Add Schedule]

┌──────────┬───────┬───────┬────────┬──────┬─────────┬──────┬────────┐
│ Date     │ Start │ End   │ Price  │ Max  │ Enabled │ Save │ Delete │
├──────────┼───────┼───────┼────────┼──────┼─────────┼──────┼────────┤
│ [input]  │[time] │[time] │ ₱[num] │[num] │ toggle  │[btn] │  [✕]  │
│ ...      │       │       │        │      │         │      │        │
└──────────┴───────┴───────┴────────┴──────┴─────────┴──────┴────────┘

▼ Registrations (expands below clicked row)
```

### Behaviors

- **"+ Add Schedule"** — prepends a new blank editable row; no DB call yet
- **Save button per row** — validates fields if enabled, then upserts to Supabase; new rows POST and get assigned a real `id`; existing rows PATCH
- **Enable toggle** — auto-saves `is_enabled` immediately on change (no need to click Save)
- **Delete button (✕)** — shows confirm dialog: *"This session will be hidden. Existing registrations are kept."* On confirm, PATCHes `deleted_at = now()`, removes row from UI
- **Registrations panel** — clicking a row expands a panel below it showing registered players (same render logic as current `renderOpenPlayRegistrations`); clicking again collapses
- **Empty state** — when no sessions: *"No schedules yet — click Add Schedule to create one"*

### Validation (on Save, when `is_enabled = true`)

- Date required
- Start time and end time required
- Max players ≥ 1

---

## State Management

Replace `currentNightOpenPlayId` with a row-level approach:

- Each rendered row stores its session `id` in a `data-id` attribute
- New (unsaved) rows have `data-id=""` 
- After a successful POST, the row's `data-id` is updated with the returned `id`

---

## Migration Notes

- The existing "night" session row in `open_play_sessions` is preserved and will appear in the new list
- No data migration needed beyond adding the `deleted_at` column (nullable, defaults to null)
- The `deleted_at` column must be added in Supabase before deploying

---

## Out of Scope

- Player-facing booking page integration (separate project)
- Recurring schedule templates
- Bulk enable/disable
