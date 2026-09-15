"""Tests of the handoff utilities only. Run: python3 -B tools/test_tools.py"""
import copy
import json
import tempfile
import unittest
from pathlib import Path
import validate_pack as validator
from render_tracking import render

ROOT = Path(__file__).resolve().parents[1]

class PackToolsTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT / "tracking/tasks.json").read_text(encoding="utf8"))
        self.schema = json.loads((ROOT / "contracts/semantic-event.schema.json").read_text(encoding="utf8"))
        self.event = json.loads((ROOT / "fixtures/oauth-workplace.jsonl").read_text(encoding="utf8").splitlines()[0])

    def test_tracker_is_valid(self):
        self.assertEqual([], validator.validate_tasks(self.data))

    def test_dependency_cycle_is_rejected(self):
        self.data["tasks"][0]["depends_on"] = [self.data["tasks"][1]["id"]]
        errors = validator.validate_tasks(self.data)
        self.assertTrue(any("cycle" in x for x in errors))

    def test_missing_dependency_is_rejected(self):
        self.data["tasks"][0]["depends_on"] = ["TASK-999"]
        self.assertTrue(any("missing dependency" in x for x in validator.validate_tasks(self.data)))

    def test_done_requires_evidence(self):
        self.data["tasks"][0]["status"] = "done"
        self.data["tasks"][0]["evidence"] = []
        self.assertTrue(any("done without evidence" in x for x in validator.validate_tasks(self.data)))

    def test_active_task_requires_dependencies(self):
        self.data["tasks"][1]["status"] = "in_progress"
        self.data["tasks"][0]["status"] = "todo"
        self.assertTrue(any("unsatisfied dependency" in x for x in validator.validate_tasks(self.data)))

    def test_user_review_cannot_be_omitted(self):
        gate = self.data["tasks"][23]
        gate["status"] = "done"
        gate["review"] = None
        self.assertTrue(any("recorded user review" in x for x in validator.validate_tasks(self.data)))

    def test_unknown_status_is_rejected(self):
        self.data["tasks"][0]["status"] = "probably_done"
        self.assertTrue(any("unknown status" in x for x in validator.validate_tasks(self.data)))

    def test_schema_rejects_wrong_kind_payload(self):
        self.event["payload"] = {"state":"invented"}
        self.assertTrue(validator.schema_subset(self.event, self.schema))

    def test_schema_rejects_missing_source(self):
        del self.event["source"]
        self.assertTrue(validator.schema_subset(self.event, self.schema))

    def test_shipped_fixture_cannot_be_live(self):
        self.event["mode"] = "LIVE"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.jsonl"
            path.write_text(json.dumps(self.event) + "\n", encoding="utf8")
            errors, _ = validator.validate_fixture(path, self.schema)
        self.assertTrue(any("synthetic DEMO" in x for x in errors))

    def test_fixture_files_validate(self):
        for path in (ROOT / "fixtures").glob("*.jsonl"):
            errors, count = validator.validate_fixture(path, self.schema)
            self.assertEqual([], errors)
            self.assertGreater(count, 0)

    def test_generated_views_match(self):
        for name, expected in render(self.data).items():
            self.assertEqual(expected, (ROOT/name).read_text(encoding="utf8"))

    def test_relative_links_are_valid(self):
        self.assertEqual([], validator.validate_links(ROOT))

    def test_evidence_cannot_escape_pack(self):
        self.assertIsNone(validator.safe_file(ROOT, "../../etc/passwd"))
        self.assertIsNone(validator.safe_file(ROOT, "/etc/passwd"))

if __name__ == "__main__":
    unittest.main(verbosity=2)
