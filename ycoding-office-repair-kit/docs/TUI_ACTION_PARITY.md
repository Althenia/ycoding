# TUI action parity

R6-06. Every action in the live TUI keybind registry, classified against the office as it
exists today. The acceptance is *"classify every current action with implementation evidence
or explicit justified scope treatment; **no silent removals**"*, so this document states the
classes and the ledger (`tracking/tui-action-ledger.json`) carries one row per action.

The registry is the oracle, not this prose. `tools/action_parity.py` reads
`packages/tui/src/config/keybind.ts` and fails when an action is unclassified, when a row
survives an action the registry no longer has (a silent removal), when an implementation
claim cites no office path, when that path does not exist, when a classification is unknown,
or when a binding's default has drifted. `tools/verify_pack.py` runs it, so the pack gate
carries the claim rather than this document.

## Classes

| Class | Meaning | Rows |
|---|---|---|
| `equivalent` | The office implements it. The basis must name an office path that exists. | 24 |
| `gap` | A real capability the office lacks. A task owns it; it is never claimed as present. | 71 |
| `widget` | Text-editing mechanics a native widget (TextEdit/LineEdit) already owns. | 39 |
| `diff_viewer` | The TUI's own full-screen diff viewer; the office presents changes as drawer detail. | 16 |
| `terminal` | Meaningless outside a terminal; no desktop equivalent is possible. | 13 |
| `n/a` | Deliberately absent by product rule (reasoning is never rendered). | 1 |
| **total** | | **164** |

## The open gaps, by surface

**71 of 164 actions are gaps.** They are grouped so each names a surface with
an owning task rather than dozens of separate items. R3-12 is the parity gate that holds them
to account; this document does not claim they are done.

| Surface | Actions | Owning task |
|---|---|---|
| Session lifecycle | 17 | R3-02 |
| Session quick-switch | 9 | R3-02 |
| Message navigation | 8 | R6-02 / R3-12 |
| Application debug/console | 7 | R3-07 |
| Model selection | 6 | R3-01 |
| Prompt stash | 4 | R3-07 |
| Child navigation | 3 | R3-02 |
| Agent selection | 2 | R3-01 |
| Plugins | 2 | R3-12 |
| Shell output controls | 2 | R3-07 |
| Theme | 2 | R3-12 |
| Command palette | 1 | R3-12 |
| Debug | 1 | R3-07 |
| Documentation | 1 | R3-12 |
| External editor | 1 | R3-07 |
| Help | 1 | R3-12 |
| MCP | 1 | R3-07 |
| Composer | 1 | R3-12 |
| Providers | 1 | R3-01 / R3-12 |
| Scrollbar | 1 | R3-12 |

## Not gaps

The 39 `widget` rows are the TUI's own multiline-editor mechanics (cursor
motion, selection, word and line deletion, undo/redo, paste). A desktop text field owns these
natively, so re-implementing them would add no capability.

The 16 `diff_viewer` rows are the TUI's full-screen diff surface. The office
shows a change as drawer detail with its bounded, marked patch (R6-05) - a different
presentation of the same fact rather than a missing one.

The 13 `terminal` rows have no desktop equivalent by nature: suspending to a
shell, setting the terminal title, and a which-key overlay are terminal keymap affordances. An
overlay would duplicate the visible sidebar and chrome controls rather than add capability.

The 1 `n/a` row is `display_thinking`: private reasoning is deliberately never
rendered in the office, so a toggle for it would have nothing to show.

## Verification

```
python3 ycoding-office-repair-kit/tools/action_parity.py --root ycoding-office-repair-kit
python3 ycoding-office-repair-kit/tools/verify_pack.py --root ycoding-office-repair-kit
```

Six mutations prove the check bites: a newly added unclassified action, a silent removal, an
implementation claim citing a missing file, an implementation claim citing no path, an unknown
class, and a drifted default. Each is caught with exit 1.
