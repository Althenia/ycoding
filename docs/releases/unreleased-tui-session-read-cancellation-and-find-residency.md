# TUI Session reads and Find

## Fixed

- The TUI cancels obsolete Session reads when their data owner is disposed or the connection drops, and cancels older history reads when the transcript is evicted or replaced. Reconnecting can load the selected Session without waiting for an obsolete response.
- Find waits for a replacement transcript snapshot before continuing through older history and leaves an evicted Session unloaded. Read failures remain visible and retryable.
