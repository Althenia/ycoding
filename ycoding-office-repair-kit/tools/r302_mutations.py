#!/usr/bin/env python3
"""R3-02 mutation check.

Proves the configuration-bridge suite DISCRIMINATES: each mutation of the
implementation must make the single-suite driver report failures. A suite that stays
green under a mutation asserts nothing about the behaviour that mutation removes.

Restores byte-identically after every mutation, verified by SHA-256.

    python3 ycoding-office-repair-kit/tools/r302_mutations.py
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
DRIVER = "res://tools/_r302_one.gd"

MUTATIONS = [
    (
        "redaction-guard-removed",
        "apps/office/integration/config_api.gd",
        "\tfor key in _redacted_paths(patch, \"\"):\n\t\treturn (\n"
        "\t\t\t\"This patch would write the service's redacted placeholder back for '%s'. \"\n"
        "\t\t\t+ \"A withheld value cannot be re-sent; edit the field with a new value or leave it alone.\"\n"
        "\t\t) % key\n\treturn \"\"",
        "\treturn \"\"",
    ),
    (
        "session-scope-accepted",
        "apps/office/integration/config_api.gd",
        '\tif scope != WRITE_GLOBAL and scope != WRITE_PROJECT:',
        '\tif false:',
    ),
    (
        "revision-guard-dropped",
        "apps/office/integration/config_api.gd",
        '\tif not revision.is_empty():\n\t\tbody["expectedRevision"] = revision',
        '\tif false:\n\t\tbody["expectedRevision"] = revision',
    ),
    (
        "envelope-data-ignored",
        "apps/office/integration/config_api.gd",
        '\tvar payload: Variant = (body as Dictionary).get("data", null)',
        '\tvar payload: Variant = body',
    ),
    (
        "virtual-scope-writable",
        "apps/office/core/settings_scope.gd",
        "const WRITABLE := [GLOBAL, PROJECT]",
        "const WRITABLE := [GLOBAL, PROJECT, VIRTUAL]",
    ),
    (
        "session-not-explained",
        "apps/office/core/settings_scope.gd",
        '\t"session": (\n'
        '\t\t"Session overrides are not configuration documents. They belong to the session, "\n'
        '\t\t+ "not to a settings file."\n\t),',
        '\t"session": "",',
    ),
    (
        "commit-before-preview-allowed",
        "apps/office/core/config_review.gd",
        '\tif validated_key != key or validated_text != text or _preview_state != PREVIEW_READY:\n'
        '\t\t_last_error = (\n'
        '\t\t\t"The text to write is not the text the preview validated. Preview it again."\n'
        '\t\t)\n'
        '\t\treturn false',
        "\tpass",
    ),
    (
        "json-text-unchecked",
        "apps/office/core/config_review.gd",
        "\tvar json := JSON.new()\n\tif json.parse(trimmed) != OK:\n"
        "\t\treturn \"That is not valid JSON, so it cannot be stored: %s\" % json.get_error_message()\n"
        "\treturn \"\"",
        '\treturn ""',
    ),
    (
        "apply-arms-without-preview",
        "apps/office/ui/settings/config_review_panel.gd",
        "\t_apply.disabled = change or _preview_revision.is_empty()",
        "\t_apply.disabled = false",
    ),
    (
        "provenance-guard-removed",
        "apps/office/core/config_review.gd",
        "\tvar source := _source_for(key)\n"
        '\tif source.is_empty():\n\t\treturn ConfigApi.WRITE_GLOBAL\n'
        '\tvar scope := str(source.get("scope", ""))\n'
        "\treturn scope if SettingsScope.is_writable(scope) else \"\"",
        '\treturn ConfigApi.WRITE_GLOBAL',
    ),
    # The five defects the integration review found. Each mutation removes exactly the
    # behaviour that defect was about, so a green run under one means the suite does not
    # actually cover it.
    (
        "preview-control-does-not-emit",
        "apps/office/ui/settings/config_review_panel.gd",
        "\t_in_flight = true\n\t_sync_apply()\n\tpreview_requested.emit(_key, _editor.text)",
        "\t_in_flight = true\n\t_sync_apply()",
    ),
    (
        "apply-ignores-review-readiness",
        "apps/office/ui/settings/config_review_panel.gd",
        "\t_apply.disabled = true\n\tif not ready:",
        "\t_apply.disabled = change or _preview_revision.is_empty()\n\tif false:",
    ),
    (
        "inflight-does-not-disable",
        "apps/office/ui/settings/config_review_panel.gd",
        "\tif _in_flight:\n\t\t_apply.disabled = true\n\t\t_preview.disabled = true",
        "\tif false:\n\t\t_apply.disabled = true\n\t\t_preview.disabled = true",
    ),
    (
        "chosen-scope-ignored",
        "apps/office/core/config_review.gd",
        "\tif SettingsScope.is_writable(_chosen_scope):\n\t\treturn _chosen_scope",
        "\tpass",
    ),
    (
        "scope-change-keeps-preview",
        "apps/office/core/config_review.gd",
        "\t_chosen_scope = scope\n\t_pending_request = {}\n\t_preview_state = PREVIEW_IDLE\n\treturn true",
        "\t_chosen_scope = scope\n\treturn true",
    ),
    (
        "rebind-does-not-cancel",
        "apps/office/integration/config_api.gd",
        "\tif _transport != null and _transport != transport:\n\t\tcancel_pending()",
        "\tpass",
    ),
    (
        "commit-skips-preview-identity",
        "apps/office/core/config_review.gd",
        "\tif validated_key != key or validated_text != text or _preview_state != PREVIEW_READY:",
        "\tif false:",
    ),
    # Remove. Each mutation removes one rule the action depends on, so a green run under
    # one means the suite does not cover it.
    (
        "remove-ignores-key-ownership",
        "apps/office/core/config_review.gd",
        "\tif _defines_in(key, scope):\n\t\treturn \"\"",
        "\treturn \"\"",
    ),
    (
        "remove-ignores-withheld-values",
        "apps/office/core/config_review.gd",
        "\tvar withheld := ConfigApi.withheld_write_reason({key: value_for(key)})\n"
        "\tif not withheld.is_empty():",
        "\tvar withheld := \"\"\n\tif false:",
    ),
    (
        "removal-patch-writes-a-value-not-null",
        "apps/office/integration/config_api.gd",
        'static func removal_patch(key: String) -> Dictionary:\n\treturn {key: null} if not key.is_empty() else {}',
        'static func removal_patch(key: String) -> Dictionary:\n\treturn {key: ""} if not key.is_empty() else {}',
    ),
    (
        "removal-commit-accepts-an-edit-validation",
        "apps/office/core/config_review.gd",
        '\tif validated_key != key or not bool(_settled_request.get("removal", false)) \\\n\t\t\tor _preview_state != PREVIEW_READY:',
        "\tif false:",
    ),
    (
        "remove-control-never-emits",
        "apps/office/ui/settings/config_review_panel.gd",
        "\tremove_requested.emit(key)",
        "\tpass",
    ),
    (
        "removal-does-not-arm-apply",
        "apps/office/ui/settings/config_review_panel.gd",
        "\tif _removing:\n\t\t_apply.disabled = _preview_revision.is_empty()",
        "\tif _removing:\n\t\t_apply.disabled = true",
    ),
    # The integration-review defects. Each removes exactly the behaviour the review found
    # missing, so a green run under one means the suite does not cover it.
    (
        "remove-does-not-show-the-actions-box",
        "apps/office/ui/settings/config_review_panel.gd",
        '\t_editor.text = ""\n\t_editor_box.visible = true\n\t_render()\n\tremove_requested.emit(key)',
        "\t_render()\n\tremove_requested.emit(key)",
    ),
    (
        "edit-keeps-a-pending-removal",
        "apps/office/ui/settings/config_review_panel.gd",
        "\t# An edit supersedes any pending removal: they are different payloads for one key, and\n"
        "\t# a late answer for the removal must not arm the edit.\n"
        "\t_removing = false\n",
        "\tpass\n",
    ),
    (
        "page-change-keeps-a-pending-removal",
        "apps/office/ui/settings/config_review_panel.gd",
        '\t_key = ""\n\t_removing = false\n\t_previewed_text = ""\n\t_preview_revision = ""\n'
        "\t_in_flight = false\n\t_editor_box.visible = false\n\t_render()",
        '\t_key = ""\n\t_previewed_text = ""\n\t_preview_revision = ""\n'
        "\t_in_flight = false\n\t_editor_box.visible = false\n\t_render()",
    ),
    (
        "preview-enabled-during-a-removal",
        "apps/office/ui/settings/config_review_panel.gd",
        "\t\t_preview.disabled = not editing or _in_flight or not ready or _removing",
        "\t\t_preview.disabled = not editing or _in_flight or not ready",
    ),
    (
        "revision-takes-the-first-document",
        "apps/office/integration/config_api.gd",
        "\t\tvar revision := str(source.get(\"revision\", \"\"))\n"
        "\t\t# Ascending priority, so the LAST non-empty revision is the target's.\n"
        '\t\tif not revision.is_empty():\n\t\t\tfound = revision\n'
        "\treturn found",
        "\t\tvar revision := str(source.get(\"revision\", \"\"))\n"
        '\t\tif not revision.is_empty():\n\t\t\treturn revision\n'
        '\treturn ""',
    ),
    (
        "target-definition-checks-any-document",
        "apps/office/core/config_review.gd",
        "\tvar target := _target_source(scope)\n"
        "\tif target.is_empty():\n\t\treturn false\n"
        '\tvar keys: Variant = target.get("keys", [])\n'
        "\treturn keys is Array and (keys as Array).has(key)",
        "\tif _api == null:\n\t\treturn false\n"
        "\tfor value in _api.sources():\n"
        '\t\tvar source: Dictionary = value\n'
        '\t\tif str(source.get("scope", "")) != scope:\n\t\t\tcontinue\n'
        '\t\tvar keys: Variant = source.get("keys", [])\n'
        "\t\tif keys is Array and (keys as Array).has(key):\n\t\t\treturn true\n"
        "\treturn false",
    ),
]


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_suite() -> tuple[int, int, int]:
    command = [
        "sh", str(LOCK), GODOT, "--headless", "--path", str(OFFICE),
        "--script", DRIVER,
    ]
    environment = {"GODOT_LOCK_OWNER": "r3-02-mutation", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
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


def detected(code: int, passed: int, failed: int) -> bool:
    """Whether a run shows the mutation was caught.

    Detection keys on the ASSERTION count, not on the exit code: a driver whose `quit()`
    does not reflect failures would otherwise make every mutation look undetected, which
    is a defect in the CHECK rather than a finding about the suite. An exit code is
    accepted as additional evidence but never required.
    """
    return failed > 0 and passed > 0


def main() -> int:
    failures = []
    print("=== R3-02 mutation check: every mutation must produce FAILURES ===")
    code, passed, failed = run_suite()
    print(f"control: exit={code} passed={passed} failed={failed}")
    if code != 0 or failed != 0 or passed == 0:
        print("CONTROL RUN IS NOT GREEN; aborting")
        return 1

    for label, relative, old, new in MUTATIONS:
        path = ROOT / relative
        original = digest(path)
        text = path.read_text()
        occurrences = text.count(old)
        if occurrences == 0:
            print(f"{label}: PATTERN NOT FOUND in {relative}")
            failures.append(label)
            continue
        if occurrences > 1:
            # An ambiguous pattern mutates whichever site comes first, which may not be the
            # one the label names - so the run would report NOT DETECTED for a rule the
            # suite may in fact cover. A checker must not be able to test the wrong code.
            print(f"{label}: PATTERN IS AMBIGUOUS ({occurrences} matches) in {relative}")
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
        caught = detected(code, passed, failed)
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