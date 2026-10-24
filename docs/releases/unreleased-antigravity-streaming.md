# Antigravity streaming and cache telemetry

## Fixed

- Antigravity streaming preserves multiline SSE responses and fragmented UTF-8, including thinking, assistant text, tool signatures, and cache usage. Stream cancellation and read failures propagate to the source.
- Fragmented gateway responses buffer incomplete lines without repeatedly scanning their growing contents, and completed events share an output chunk.
- Missing cached-input telemetry stays unreported instead of displaying a zero cache read; an explicit zero remains reported.
