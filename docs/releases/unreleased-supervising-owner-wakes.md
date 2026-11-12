# Supervising owner handbacks

## Changed

- A subagent that owns Project members now notifies its parent when it reports new progress text or settles a turn with new final text. New progress text wakes the parent; the final text of a settled turn reaches the parent at its next turn without waking it. Repeated text, empty final text and progress from subagents without owned members still only update stored task state.
