# Desktop Session controls

## Added

- Desktop supports active-question answers, retained prompt history, complete prompt stashes, compact large pastes, configurable shortcuts, native attention, Session process controls and shared diff presentation preferences.
- The terminal inspector renders ANSI/VT output with scrollback, selection copy, keyboard input and paste. Control changes and reconnection retain the PTY generation, fence and byte-offset checks.
- Workspace IDE selections can accompany prompts through MCP or Zed integration. The external draft editor uses `VISUAL` or `EDITOR` and falls back to the Desktop dialog.
- Backend restart supports both the window's private backend and its registered local shared service, with confirmation and connection checks.
- Client service stop accepts an expected connection identity and refuses a changed service or unconfirmed stop before Desktop starts a replacement.
