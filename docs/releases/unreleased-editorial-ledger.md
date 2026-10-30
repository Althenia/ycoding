# Editorial Ledger remote workspace

## Added

- Settings and Usage sections carry a numbered `§01`, `§02`… marker before their headings. The numbers follow the sections actually shown, so Office on a phone leaves no gap, and screen readers skip the marker. Usage keeps its icon-led headings and the Group select.
- Every transcript turn opens with a folio head: a `§NN` marker, a role label, and the turn's delivery receipt or response details. Markers keep their number as older history loads and the window scrolls, and a turn whose position from the start of the Session is not reported shows no marker.
- Usage figures and labels use larger figure type with uppercase labels, so spend and generation values read at a glance.

## Changed

- The remote workspace uses flat sections separated by single rules instead of nested frames. Text fields, menus and sheets, the focus ring, and the hard-review outline keep their boundaries.
- The desktop sidebar is a sunken spine. The current destination shows with stronger text and an accent icon, without a green fill or halo. The phone bottom bar keeps three labelled destinations with the label under the icon.
- Connection, notice, and consent strips are flat bars with an inset status edge. Their text and actions are unchanged.
- Sign-in and invitation pages are one narrow column under a full-width top bar, with an `or` divider between Google and the access key. Errors appear as an inset bar.
- The Sessions list shows rows separated by rules, with plain status text and underline filters. Rows grow with their content. Appearance and Office choices in Settings use the same underline style, and Settings records, devices and notification choices are ruled rows.
- Question options and guardrail decision grades in request forms are ruled rows. The selected option shows a coloured start edge and heavier text. The hard-review outline is unchanged.
- The reading position stays steady when the sidebar collapses or the transcript re-wraps at a new width, including rows that gain a folio head.
- The Office roster, inspection card, and attention bar use the same flat rows. The Office floor is unchanged.

## Fixed

- Opening a subagent from Team selects it directly. Main is no longer offered for the previous parent while the subagent opens, the parent Session is not read again, and Main returns to the same reading position and draft.
