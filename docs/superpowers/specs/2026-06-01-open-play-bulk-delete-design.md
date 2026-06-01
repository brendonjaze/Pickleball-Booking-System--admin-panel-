# Open Play Bulk Delete Design

**Date:** 2026-06-01
**Scope:** Bulk delete for open play sessions in the admin panel

---

## Goal

Allow the admin to select multiple open play session rows and delete them all at once, instead of deleting one by one.

---

## Design

### Trigger

A **"Select" button** is added to the `op-tab-header` row, next to the existing "+ Add Schedule" button. Clicking it enters select mode.

### Select Mode

When active:

- A checkbox appears on the left side of every `.op-session-row`
- A toolbar renders above the session list containing:
  - A **"Select All"** checkbox — checks/unchecks all visible rows at once
  - A **"Delete Selected (N)"** button — disabled when N = 0, label updates as rows are checked
  - A **"Cancel"** button — exits select mode, unchecks everything, no changes made
- The "+ Add Schedule" button is hidden while select mode is active
- The individual ✕ delete button on each row is hidden in select mode (only bulk path is available)

### Confirming Deletion

Clicking "Delete Selected (N)" opens the existing `op-delete-session-modal` ("Delete Session?" / "Keep Session" / "Yes, Delete").

On confirm:
- All selected session IDs are soft-deleted in parallel via `Promise.all` using `softDeleteOpenPlaySession`
- On success: exit select mode, reload list via `loadOpenPlay()`, show toast "X session(s) deleted."
- On error: show error toast, stay in select mode so the user can retry

### Exiting Select Mode

- Clicking "Cancel"
- After a successful bulk delete

### What Does Not Change

- Individual ✕ delete button outside select mode — still works as before
- `softDeleteOpenPlaySession` — reused as-is, no API changes needed

---

## Files

| File | Change |
|---|---|
| `src/main.js` | Select mode state variable; updated `renderSessionRow` to include checkbox; new `enterSelectMode`, `exitSelectMode`, `renderSelectToolbar`, `bulkDeleteSelected` functions; updated `renderOpenPlayTable` to render toolbar placeholder; updated `attachRowListeners` to wire checkbox; updated header button listener |
| `src/style.css` | Styles for select toolbar, row checkbox, and "Select" button |
