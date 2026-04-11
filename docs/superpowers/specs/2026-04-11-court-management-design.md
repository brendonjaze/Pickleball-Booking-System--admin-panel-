# Court Management Feature — Design Spec

**Date:** 2026-04-11
**Project:** Glan Pickleball Community — Admin Panel + User Side

---

## Goal

Admin can add/edit/deactivate courts from the admin panel. Changes reflect immediately on the user-side booking app. Both sides share the same Supabase project.

---

## Database

### New table: `courts`

| Column | Type | Notes |
|---|---|---|
| `id` | int (PK, auto-increment) | Used as `court_id` in existing `bookings` and `court_locks` tables |
| `name` | text, not null | e.g. "Court 1" |
| `type` | text, not null | "Indoor" or "Outdoor" |
| `price_per_hour` | int, not null | e.g. 100 |
| `is_active` | boolean, default true | false = hidden from user side, data preserved |
| `sort_order` | int, not null | controls display order; new courts append to bottom |

No changes to `bookings` or `court_locks` tables — `court_id` already an int, stays compatible.

---

## Admin Panel Changes

### New "Courts" tab
- Added to tab bar alongside Bookings, Revenue, Announcements, Court Lock
- Lists all courts: name, type, price, active status
- Each row has Edit and Activate/Deactivate toggle
- "Add Court" form: Name (text), Type (Indoor/Outdoor select), Price per Hour (number)
- `sort_order` auto-assigned on create (max existing + 1)
- Deactivate hides court from user side; does not delete any booking history

### Dynamic courts everywhere
- Remove `COURT_NAMES` constant (`src/main.js:10`)
- On app load, fetch all courts from Supabase and store in `allCourts` array
- Rebuild all court-dependent UI from `allCourts`:
  - Dashboard stat cards (one per court, generated dynamically)
  - Revenue breakdown cards (one per court)
  - Bookings filter dropdown
  - Court Lock court selector
- `courtBadge()` function uses `allCourts` instead of `COURT_NAMES`
- `RATE_PER_HOUR` constant replaced by per-court `price_per_hour` from DB

---

## User Side Changes

- On page load, fetch `courts` where `is_active = true`, ordered by `sort_order`
- Render court cards dynamically in a loop (replace hardcoded cards)
- Court color auto-assigned by index from palette:
  `['#4a90d9', '#7b4ea6', '#c0392b', '#27ae60', '#e67e22']`
- Court card shows: name, type tag, price per hour, "Available Today" status (computed from bookings/locks as before), Book Now button
- Location string ("Glan Pickleball Community, Sarangani Province") stays hardcoded

---

## Constraints

- Use plain `fetch()` to Supabase REST API — no SDK (matches existing pattern)
- Admin panel: vanilla JS/HTML/CSS (Vite), no framework
- Supabase URL: `https://qzjaegutlsgtlaworbuy.supabase.co`
