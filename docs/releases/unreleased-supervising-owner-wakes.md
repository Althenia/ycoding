# Supervising owner handbacks

## Changed

- A subagent that owns Project members now notifies and wakes its parent when it reports new progress text or settles a turn with new final text. Repeated text, empty final text and progress from subagents without owned members still only update stored task state.
