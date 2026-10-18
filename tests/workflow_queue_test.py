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
            "group": "dot-link-automatic-merge", "queue": "max", "cancel-in-progress": False}})

    def test_missing_or_changed_policy_fails(self):
        expected = {"group": "dot-link-automatic-merge", "queue": "max", "cancel-in-progress": False}
        for key in expected:
            for value in [None, True, 0, "false", "${{ github.run_id }}", "single"]:
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    checker.validate(Path("auto-merge.yml"), {"concurrency": {**expected, key: value}})
            missing = {k: v for k, v in expected.items() if k != key}
            with self.assertRaises(ValueError):
                checker.validate(Path("auto-merge.yml"), {"concurrency": missing})

    def test_queue_on_other_workflows_or_jobs_fails(self):
        with self.assertRaises(ValueError):
            checker.validate(Path("other.yml"), {"concurrency": {"queue": "max"}})
        with self.assertRaises(ValueError):
            checker.validate(Path("other.yml"), {"jobs": {"test": {"concurrency": {"queue": "max"}}}})

    def test_unrelated_workflows_are_left_to_actionlint(self):
        checker.validate(Path("ci.yml"), {"jobs": {"test": {}}})


if __name__ == "__main__":
    unittest.main()
