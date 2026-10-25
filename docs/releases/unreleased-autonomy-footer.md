# Session autonomy footer

## Changed

- Session footers show effective Permissions, Guardrails, and Answers modes, inherited-mode labels, and an asleep marker. The sidebar retains goals and waiting reviews without a separate autonomy section.

## Fixed

- Failed autonomy refreshes show unknown modes instead of stale permissions, inheritance, or sleep state, without emitting a wake notice. A successful refresh restores the current state.
- Compact parent and child layouts keep the composer and pending-review controls visible with the autonomy footer.
- Chrome connection dialogs keep the pairing code and actions visible in short terminals. Page Up, Page Down, and the mouse wheel reach the full installation path, service address, and permission note.
