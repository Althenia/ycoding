# Explicit selection copy design

Status: approved

## Goal

Mouse selection in the YCoding TUI highlights text only. Copying occurs only through an explicit keyboard command.

## Behavior

- Mouse drag creates or updates the active terminal selection.
- Mouse release never writes to the clipboard.
- Right-click never writes to the clipboard.
- `Cmd+C` on macOS copies the active selection.
- `Ctrl+C` on other supported platforms copies the active selection.
- `Esc` clears the active selection without copying.
- When no selection exists, the normal command meaning of `Ctrl+C` remains unchanged.
- A successful explicit copy clears the selection and shows the existing confirmation toast.

## Configuration compatibility

`terminal.copy_on_select` remains accepted by the configuration decoder so existing files do not fail to load. It no longer enables mouse-triggered copying. Repository documentation marks it as deprecated and behaviorally ignored.

No replacement mouse-copy setting is added.

## Implementation boundary

Selection behavior remains owned by:

- `packages/tui/src/app.tsx` for root mouse and key routing;
- `packages/tui/src/util/selection.ts` for explicit copy and selection clearing;
- TUI configuration documentation for compatibility status.

Components with deliberate click-to-copy actions, such as a visible Copy button or explicitly clickable credential text, are outside this change. The restriction applies to passive terminal text selection.

## Error handling

Clipboard write failures use the existing toast error path. Failed writes do not report success. Selection clearing follows the existing explicit-copy behavior.

## Tests

Regression coverage must prove:

1. mouse release does not invoke clipboard write;
2. right-click does not invoke clipboard write;
3. explicit macOS copy binding copies a selection;
4. explicit non-macOS copy binding copies a selection;
5. `Esc` clears without copying;
6. no-selection `Ctrl+C` is not consumed by selection handling;
7. `terminal.copy_on_select` remains decodable but does not restore mouse copying.

## Non-goals

- Changing native terminal selection rendering.
- Replacing the clipboard implementation.
- Changing explicit Copy buttons or click-to-copy controls.
- Adding another compatibility alias or mouse gesture.
