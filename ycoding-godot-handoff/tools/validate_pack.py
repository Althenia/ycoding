#!/usr/bin/env python3
"""Validate this handoff, not the future Godot app. Python 3.10+, stdlib only."""
from __future__ import annotations
import argparse
import ast
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
STATES = {"todo", "in_progress", "blocked", "in_review", "done", "deferred"}


def safe_file(root: Path, name: str) -> Path | None:
    if not isinstance(name, str) or not name or Path(name).is_absolute():
        return None
    path = (root / name).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError:
        return None
    return path if path.is_file() else None


def validate_tasks(data: dict, root: Path = ROOT) -> list[str]:
    errors: list[str] = []
    tasks = data.get("tasks", [])
    milestones = data.get("milestones", [])
    if not isinstance(tasks, list) or not tasks:
        return ["tasks must be a nonempty list"]
    ids = [t.get("id") for t in tasks]
    if len(ids) != len(set(ids)):
        errors.append("duplicate task IDs")
    by_id = {t.get("id"): t for t in tasks}
    milestone_ids = {m.get("id") for m in milestones}
    for t in tasks:
        ident = t.get("id", "<missing>")
        if not isinstance(ident, str) or not re.fullmatch(r"TASK-\d{3}", ident):
            errors.append(f"invalid task ID: {ident}")
        if t.get("status") not in STATES:
            errors.append(f"{ident}: unknown status")
        if t.get("milestone") not in milestone_ids:
            errors.append(f"{ident}: unknown milestone")
        for field in ["depends_on", "acceptance", "planned_outputs", "requirement_ids", "test_ids", "evidence"]:
            if not isinstance(t.get(field), list):
                errors.append(f"{ident}: {field} must be a list")
        if not t.get("acceptance"):
            errors.append(f"{ident}: acceptance is empty")
        for d in t.get("depends_on", []):
            if d not in by_id:
                errors.append(f"{ident}: missing dependency {d}")
            elif t.get("status") in {"in_progress", "in_review", "done"} and by_id[d]["status"] != "done":
                errors.append(f"{ident}: unsatisfied dependency {d}")
        for q in t.get("requirement_ids", []):
            if q not in {f"RQ-{i:02d}" for i in range(1, 16)}:
                errors.append(f"{ident}: unknown requirement {q}")
        for q in t.get("test_ids", []):
            if q not in {f"TEST-{i:03d}" for i in range(1, 38)}:
                errors.append(f"{ident}: unknown test {q}")
        for evidence in t.get("evidence", []):
            if safe_file(root, evidence) is None:
                errors.append(f"{ident}: evidence must be an existing file inside the handoff: {evidence}")
        if t.get("status") == "done":
            if not t.get("evidence"):
                errors.append(f"{ident}: done without evidence")
            if t.get("requires_user_review"):
                review = t.get("review") or {}
                if review.get("approved_by_user") is not True or safe_file(root, review.get("evidence_path", "")) is None:
                    errors.append(f"{ident}: done without recorded user review")
    for m in milestones:
        gate = by_id.get(m.get("gate_task"))
        if gate is None or gate.get("milestone") != m.get("id"):
            errors.append(f"{m.get('id')}: invalid gate task")
    visiting, visited = set(), set()
    def visit(ident: str) -> None:
        if ident in visiting:
            errors.append(f"dependency cycle at {ident}")
            return
        if ident in visited or ident not in by_id:
            return
        visiting.add(ident)
        for d in by_id[ident].get("depends_on", []):
            visit(d)
        visiting.remove(ident)
        visited.add(ident)
    for ident in ids:
        visit(ident)
    return errors


def schema_subset(value, schema: dict, path: str = "event") -> list[str]:
    """Check only keywords used in this shipped schema, not arbitrary JSON Schema."""
    errors = []
    checks = {"object": lambda v: isinstance(v, dict), "array": lambda v: isinstance(v, list),
              "string": lambda v: isinstance(v, str), "integer": lambda v: type(v) is int,
              "number": lambda v: type(v) in (int, float), "boolean": lambda v: type(v) is bool,
              "null": lambda v: v is None}
    types = schema.get("type")
    if types is not None:
        types = types if isinstance(types, list) else [types]
        if not any(checks[t](value) for t in types):
            return [f"{path}: wrong type; expected {types}"]
    if "const" in schema and (value != schema["const"] or type(value) is not type(schema["const"])):
        errors.append(f"{path}: incorrect const")
    if "enum" in schema and not any(value == v and type(value) is type(v) for v in schema["enum"]):
        errors.append(f"{path}: value outside enum")
    if isinstance(value, str) and len(value) < schema.get("minLength", 0):
        errors.append(f"{path}: string too short")
    if type(value) in (int, float) and "minimum" in schema and value < schema["minimum"]:
        errors.append(f"{path}: value below minimum")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing {key}")
        for key, val in value.items():
            if key in props:
                errors += schema_subset(val, props[key], path + "." + key)
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}: unexpected property {key}")
    for child in schema.get("allOf", []):
        errors += schema_subset(value, child, path)
    if "if" in schema and not schema_subset(value, schema["if"], path):
        errors += schema_subset(value, schema.get("then", {}), path)
    return errors


def validate_fixture(path: Path, schema: dict) -> tuple[list[str], int]:
    errors, count, last_ms, seen = [], 0, -1, set()
    for line_number, line in enumerate(path.read_text(encoding="utf8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except ValueError as exc:
            errors.append(f"{path.name}:{line_number}: invalid JSON: {exc}")
            continue
        count += 1
        label = f"{path.name}:{line_number}"
        errs = schema_subset(event, schema, label)
        errors += errs
        if errs:
            continue
        if event["mode"] != "DEMO" or event["source"]["kind"] != "synthetic_fixture":
            errors.append(f"{label}: shipped fixture must remain synthetic DEMO")
        if event["at_ms"] < last_ms:
            errors.append(f"{label}: relative playback times are not ordered")
        last_ms = event["at_ms"]
        if event["event_id"] in seen:
            errors.append(f"{label}: duplicate observation ID; use repeated interaction ID for the social duplicate test")
        seen.add(event["event_id"])
        if event["kind"] != "connection.changed" and event["session_id"] is None:
            errors.append(f"{label}: session observation has no scoped session")
    if count == 0:
        errors.append(f"{path.name}: empty fixture")
    return errors, count


def validate_links(root: Path) -> list[str]:
    errors = []
    for path in root.rglob("*.md"):
        text = re.sub(r"```.*?```", "", path.read_text(encoding="utf8"), flags=re.S)
        for target in re.findall(r"\[[^\]]+\]\(([^\s)]+)\)", text):
            target = unquote(target.split("#", 1)[0])
            if not target or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
                continue
            if not (path.parent / target).exists():
                errors.append(f"{path.relative_to(root)}: broken relative link {target}")
    return errors


def validate_integrity(root: Path) -> list[str]:
    manifest = root / "SHA256SUMS"
    if not manifest.is_file():
        return ["SHA256SUMS missing"]
    errors, recorded = [], set()
    for line in manifest.read_text(encoding="utf8").splitlines():
        digest, sep, name = line.partition("  ")
        path = safe_file(root, name)
        if not sep or path is None:
            errors.append(f"Integrity entry missing/invalid: {name}")
            continue
        recorded.add(name)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            errors.append(f"Integrity changed: {name}")
    actual = {str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()
              and p.name != "SHA256SUMS" and "__pycache__" not in p.parts and ".git" not in p.parts}
    for name in sorted(actual - recorded):
        errors.append(f"Integrity unlisted file: {name}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--integrity", action="store_true", help="Check original archive SHA-256 sums; expected to fail after local edits.")
    args = parser.parse_args()
    errors = []
    try:
        # Ensure every shipped JSON document parses, not just the tracker.
        for p in ROOT.rglob("*.json"):
            json.loads(p.read_text(encoding="utf8"))
        data = json.loads((ROOT / "tracking/tasks.json").read_text(encoding="utf8"))
        errors += validate_tasks(data)
        schema = json.loads((ROOT / "contracts/semantic-event.schema.json").read_text(encoding="utf8"))
        event_count = 0
        fixtures = sorted((ROOT / "fixtures").glob("*.jsonl"))
        for p in fixtures:
            errs, count = validate_fixture(p, schema)
            errors += errs
            event_count += count
        errors += validate_links(ROOT)
        for p in (ROOT / "tools").glob("*.py"):
            ast.parse(p.read_text(encoding="utf8"), filename=str(p))
        from render_tracking import render
        for name, expected in render(data).items():
            path = ROOT / name
            if not path.exists() or path.read_text(encoding="utf8") != expected:
                errors.append(f"Generated tracking view is stale: {name}")
        if args.integrity:
            errors += validate_integrity(ROOT)
        if errors:
            print("PACK VALIDATION FAILED")
            for err in errors:
                print("- " + err)
            return 1
        print(f"PASS: {len(data['tasks'])} tasks; {len(data['milestones'])} milestones; {len(fixtures)} fixtures / {event_count} observations.")
        print("PASS: task dependency graph, acceptance/evidence rules, shipped schema subset, relative links, JSON/Python syntax and generated views.")
        if args.integrity:
            print("PASS: original archive SHA-256 integrity.")
        print("Scope: planning-pack checks only. Godot application, local API, assets, visual gates and native export are NOT validated by this command.")
        return 0
    except (OSError, ValueError, KeyError, TypeError, SyntaxError) as exc:
        print(f"PACK VALIDATION FAILED: {exc}")
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
