# Tab Borders + Open Play Modal Design

**Date:** 2026-06-01
**Scope:** Three UI improvements to the admin panel

---

## 1. Tab Navigation Borders

### Goal
Make tabs easier to distinguish on mobile by giving each tab its own visible border box.

### Design
- Each `.tab-btn` receives a border on top, left, and right (`2px solid var(--border-light)`).
- `border-radius: 6px 6px 0 0` — rounded top corners, flat bottom so tabs sit flush against the tab bar's existing bottom border line.
- **Inactive tab:** `border-color: var(--border-light)`, no background fill.
- **Active tab:** `border-color: var(--primary)`, light background (e.g. `var(--white)`) to visually lift it above the bar.
- **Hover:** border color shifts to `var(--border)` (existing hover colour).
- No shape changes on mobile — existing smaller padding breakpoints remain; only the border and radius rules are added.
- The `.tab-nav` bottom border acts as the shared bottom edge for all tabs.

---

## 2. Add Schedule Modal

### Goal
Replace the inline row form with a centered overlay modal that supports selecting multiple dates at once.

### Trigger
Clicking "+ Add Schedule" opens the modal. The inline row insertion is removed.

### Modal Structure

**Header**
- Title: "Add Open Play Schedule"
- X close button (top-right)

**Body — Date Calendar**
- Single-month calendar view with prev/next month navigation arrows.
- Each day cell is clickable to toggle selection (highlighted in `var(--primary)`).
- **Shift+click:** selects a range from the last toggled date to the clicked date.
- **Drag (mousedown → mouseover → mouseup):** selects a range of consecutive days.
- A counter below the calendar shows "X date(s) selected."

**Body — Shared Settings**
- Fields arranged in a 2×2 grid: Start Time, End Time, Price (₱), Max Players.
- Enabled toggle below the grid.
- These settings apply identically to every selected date.

**Footer**
- "Add X Session(s)" primary button — disabled until at least 1 date is selected and both Start Time and End Time are filled.
- "Cancel" secondary button — closes the modal without saving.

### Save Behaviour
- One row inserted to `open_play_sessions` per selected date using the existing `upsertOpenPlaySession` (POST path).
- All inserts fire in parallel (`Promise.all`).
- On success: modal closes, open play list refreshes via `loadOpenPlay()`.
- On error: toast shown, modal stays open.

### Mobile
- Modal is full-width with a small horizontal margin.
- Body scrolls vertically if content exceeds viewport height.

---

## 3. What Is Not Changing
- Editing an existing session row remains inline (no modal for edits).
- The `deleteExpiredCourtLocks` cleanup logic added earlier is unaffected.
- No database schema changes required.
