import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "workflow_queue", Path(__file__).parents[1] / "scripts/check-workflow-queue.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class QueuePolicyTests(unittest.TestCase):
    def test_expected_policy(self):
        checker.validate(Path("auto-merge.yml"), {"concurrency": {
            "group": checker.GROUP, "queue": "single", "cancel-in-progress": False}, "jobs": {"assess": {"if": checker.ADMISSION}}})

    def test_missing_or_changed_policy_fails(self):
        expected = {"group": checker.GROUP, "queue": "single", "cancel-in-progress": False}
        for key in expected:
            for value in [None, True, 0, "false", "${{ github.run_id }}", "max"]:
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    checker.validate(Path("auto-merge.yml"), {"concurrency": {**expected, key: value}, "jobs": {"assess": {"if": checker.ADMISSION}}})
            missing = {k: v for k, v in expected.items() if k != key}
            with self.assertRaises(ValueError):
                checker.validate(Path("auto-merge.yml"), {"concurrency": missing, "jobs": {"assess": {"if": checker.ADMISSION}}})

    def test_admission_and_no_periodic_recovery(self):
        valid = {"concurrency": {"group": checker.GROUP, "queue": "single", "cancel-in-progress": False},
                 "jobs": {"assess": {"if": checker.ADMISSION}}}
        with self.assertRaises(ValueError):
            checker.validate(Path("auto-merge.yml"), {**valid, "jobs": {}})
        with self.assertRaises(ValueError):
            checker.validate(Path("auto-merge.yml"), {**valid, "on": {"schedule": []}})

    def test_queue_on_other_workflows_or_jobs_fails(self):
        with self.assertRaises(ValueError):
            checker.validate(Path("other.yml"), {"concurrency": {"queue": "max"}})
        with self.assertRaises(ValueError):
            checker.validate(Path("other.yml"), {"jobs": {"test": {"concurrency": {"queue": "max"}}}})

    def test_unrelated_workflows_are_left_to_actionlint(self):
        checker.validate(Path("ci.yml"), {"jobs": {"test": {}}})


if __name__ == "__main__":
    unittest.main()
