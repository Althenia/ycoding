# Default autonomy modes

## Added

- Permissions, Guardrails and Answers each have a saved default mode that new root Sessions start in. The Autonomous control in the TUI, web and Desktop shows each category's default, saves the selected Session mode as the default, and resets a default to Manual.
- Saving a YOLO default asks for the same explicit risk acceptance as enabling YOLO in a Session and records the acceptance beside the default. A save without acceptance is refused.
- The same defaults are set in the global configuration with `autonomy.defaults`; project configuration cannot set them.

## Unchanged

- Existing Sessions, child Sessions, defer, permission ceilings and deny rules behave as before, and the autonomy badges show the Session's actual mode.
