# Installation, first run and uninstall

A GUI binary without its YCoding service/configuration is not a complete first-run experience. The maintained Unix `script/install.sh --office` installs the CLI and desktop; preserve this path. The added Windows script installs both versioned portable payloads. The local artifact installer in office_tasks.py installs the GUI only and reports the separate service prerequisite.

Before release, verify a clean account can install, launch from Finder/Start menu/desktop rather than a development terminal, locate or configure the service, select a real provider/model, send a real prompt, see the response, restart and reopen history. Test incorrect/missing configuration and show setup/error rather than DEMO. Missing shell PATH or a port conflict must not silently start a simulator or kill another process.

Local artifact installs require --yes and refuse an existing destination. macOS goes to `~/Applications/YCoding Office <version>.app`. Linux goes to `~/.local/share/ycoding-office/<version>/`; launch the binary there. Windows portable builds go to a versioned LocalAppData directory. This keeps a previous install available for rollback. Launchers/PATH changes are explicit, not hidden side effects.

For development use the existing service command discovered from `ycoding --help`/current CLI source. Do not reuse an unverified old `serve` invocation from a planning document. First-run/service ownership and normal-prompt parity are R1 requirements and cannot be replaced by installer messages.

To uninstall a versioned local GUI, quit that app and remove only the exact versioned app directory and its shortcut. Do not delete the user's YCoding data/config/session directories. To uninstall the maintained release installation, inspect that installer's actual destinations and remove only binaries/app bundles; document any launcher cleanup. No privileged uninstall or blanket rm -rf command is shipped.
