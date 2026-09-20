#!/usr/bin/env python3
"""Kit-local R3-01 mutation check.

Proves the new suite DISCRIMINATES: each mutation of the implementation must make
the single-suite driver report failures. A suite that stays green under a mutation
asserts nothing about the behaviour that mutation removes.

The implementation is restored byte-identically after every mutation and the
restoration is verified by SHA-256, not by trusting the edit.

    python3 ycoding-office-repair-kit/tools/r301_mutations.py
"""
from __future__ import annotations

import hashlib
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
OFFICE = ROOT / "apps" / "office"
GODOT = "/Applications/Godot.app/Contents/MacOS/Godot"
LOCK = ROOT / "ycoding-office-repair-kit" / "tools" / "godot_lock.sh"
DRIVER = "res://tools/_r301_one.gd"

# (label, repo-relative file, exact old text, replacement)
MUTATIONS = [
    (
        "scope-session-always-valid",
        "apps/office/core/settings_scope.gd",
        "\tif has_session:\n\t\tscopes.append(SESSION)\n",
        "\tscopes.append(SESSION)\n",
    ),
    (
        "group-order-drops-one",
        "apps/office/core/settings_group.gd",
        "const ORDER := [APPLICATION, WORKSPACE, CONNECTIONS, RUNTIME, ADVANCED]",
        "const ORDER := [APPLICATION, WORKSPACE, CONNECTIONS, ADVANCED]",
    ),
    (
        "search-stops-reading-coverage",
        "apps/office/core/settings_group.gd",
        "\tfor item in coverage(page):\n\t\tfields.append(item)\n",
        "\tpass\n",
    ),
    (
        "route-set-drops-settings",
        "apps/office/ui/shell/office_route.gd",
        "const ALL := [OFFICE, SESSIONS, STATISTICS, SETTINGS]",
        "const ALL := [OFFICE, SESSIONS, STATISTICS]",
    ),
    (
        "page-stops-stating-the-boundary",
        "apps/office/ui/settings/settings_panel.gd",
        "\tstate.text = EDITING_UNAVAILABLE\n",
        '\tstate.text = ""\n',
    ),
    (
        "empty-query-matches-nothing",
        "apps/office/core/settings_group.gd",
        "\tif needle.is_empty():\n\t\treturn all_pages()\n",
        "\tif needle.is_empty():\n\t\treturn [] as Array[String]\n",
    ),
    (
        "settings-region-unbounded",
        "apps/office/ui/shell/office_shell_layout.gd",
        "\tvar width := clampf(content_w * SETTINGS_MAX_SHARE, floor_w, ceiling_w)",
        "\tvar width := content_w + 400.0",
    ),
    (
        "scope-reason-empty",
        "apps/office/core/settings_scope.gd",
        "\treturn str(REASONS.get(scope, \"\"))",
        "\treturn \"\"",
    ),
]


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_suite() -> tuple[int, int, int]:
    """Run the single suite. Returns (exit_code, passed, failed)."""
    command = [
        "sh", str(LOCK), GODOT, "--headless", "--path", str(OFFICE),
        "--script", DRIVER,
    ]
    environment = {"GODOT_LOCK_OWNER": "r3-01-mutation", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
    result = subprocess.run(
        command, capture_output=True, text=True, env=environment, timeout=600
    )
    output = result.stdout + result.stderr
    passed = failed = 0
    for line in output.splitlines():
        if line.startswith("passed: "):
            passed = int(line.split(": ")[1])
        elif line.startswith("failed: "):
            failed = int(line.split(": ")[1])
    return result.returncode, passed, failed


def main() -> int:
    failures = []
    print("=== R3-01 mutation check: every mutation must produce FAILURES ===")
    code, passed, failed = run_suite()
    print(f"control: exit={code} passed={passed} failed={failed}")
    if code != 0 or failed != 0 or passed == 0:
        print("CONTROL RUN IS NOT GREEN; aborting")
        return 1

    for label, relative, old, new in MUTATIONS:
        path = ROOT / relative
        original = digest(path)
        text = path.read_text()
        if old not in text:
            print(f"{label}: PATTERN NOT FOUND in {relative}")
            failures.append(label)
            continue
        path.write_text(text.replace(old, new, 1))
        if digest(path) == original:
            print(f"{label}: MUTATION CHANGED NOTHING")
            failures.append(label)
            path.write_text(text)
            continue
        try:
            code, passed, failed = run_suite()
        finally:
            path.write_text(text)
        if digest(path) != original:
            print(f"{label}: RESTORE FAILED")
            return 1
        caught = failed > 0 and passed > 0
        print(
            f"{label}: exit={code} passed={passed} failed={failed} "
            f"{'DETECTED' if caught else 'NOT DETECTED'}"
        )
        if not caught:
            failures.append(label)

    print("")
    if failures:
        print(f"MUTATION CHECK FAILED: not detected -> {', '.join(failures)}")
        return 1
    print(f"MUTATION CHECK PASSED: all {len(MUTATIONS)} mutations produced failures")
    return 0


if __name__ == "__main__":
    sys.exit(main())
