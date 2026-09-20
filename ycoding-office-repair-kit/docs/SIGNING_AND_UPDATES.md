# Signing, versioning and updates

The inspected export presets/guidance use unsigned macOS exports. A distributable artifact can exist without being a signed, notarized public release. Keep these two statuses separate.

## macOS

Use a Developer ID Application identity, Xcode command-line signing tools and notarization credentials obtained through the owning account. Import the certificate into a temporary CI keychain only in a trusted protected job; clean it up on all exit paths. Keep secrets in the CI secret store, not export_presets.cfg, project settings, logs, this ZIP or a Pages artifact. Review actual Godot export entitlements rather than blindly enabling every permission. Standard GDScript and a JIT-bearing helper are different signing cases.

Sign nested executables/libraries with their required entitlements before the enclosing bundle; do not use codesign --deep as a substitute for correct signing. Notarize, wait for acceptance, staple the app ticket, package the DMG, sign/notarize/staple the final DMG if used, then calculate checksums. Verify with codesign, spctl, stapler and a real downloaded-file launch on a clean Mac. R7-06 owns this implementation; credentials are not available here and no untested signing automation is silently enabled by this kit. Official export/notarization guidance is linked in SOURCES.md.

## Windows

The included installer is a per-user portable installer. Public “signed” distribution requires Authenticode signing and a timestamp through the organization's approved certificate/HSM/provider, then verification on Windows. Sign before packaging/checksum. This kit does not embed a certificate password, change execution policy or suppress SmartScreen. Do not call a ZIP an MSI installer. An MSI/winget entry is later work only if explicitly required.

## Linux

Keep executable bits and PCK files together, verify GL/system dependency support on the claimed distribution, and test local service discovery. An AppImage/deb is not included; don't claim one. The current tar.gz format remains supported.

## Version contract

Keep CLI/client release versions aligned using the current vX.Y.Z tag and runtime compatibility check. `Godot --version` prints the engine version, not the client version. The existing macOS builder checks the bundle version; record app-visible version and source revision in About/diagnostics after repair. Include a human-readable changelog and known platform/signing limitations.

## Updating / rollback

No silent auto-update engine is introduced. Start with an explicit link to a verified release and the existing installer. Never update or kill a shared service in the middle of an agent run without user consent. Audit the maintained installer's rollback for the entire CLI/helper/Office set; its existence does not prove atomicity of every path. Keep previous versioned local installs until the new version is verified. Uninstall removes application files/shortcuts only; session history/provider configuration is preserved by default. Publish a new patch release rather than overwriting released binaries.
