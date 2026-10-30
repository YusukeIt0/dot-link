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

class ProductCIValidation(unittest.TestCase):
    def test_product_workflow_ownership(self):
        import yaml
        from pathlib import Path
        ci = yaml.safe_load(Path('.github/workflows/ci.yml').read_text())
        events = ci.get('on', ci.get(True))
        self.assertEqual(events['push']['branches'], ['main'])
        self.assertEqual(events['pull_request']['types'], ['opened', 'synchronize', 'reopened'])
        self.assertEqual(ci['jobs']['test']['runs-on'], 'macos-15')
        self.assertEqual(ci['jobs']['test']['needs'], 'workflow-lint')
        self.assertEqual(ci['jobs']['test']['if'], "${{ !cancelled() }}")
        self.assertNotIn('ready_for_review', events['pull_request']['types'])
        self.assertIn('CI v2', ci['run-name'])
        for name in ['workflow-lint', 'test']:
            self.assertEqual(ci['jobs'][name].get('name', name), name)
            checkout = next(s for s in ci['jobs'][name]['steps'] if s.get('uses', '').startswith('actions/checkout@'))
            self.assertEqual(checkout['with']['ref'], '${{ github.event.pull_request.head.sha || github.sha }}')
        self.assertNotIn('if', ci['jobs']['workflow-lint'])
        self.assertTrue(ci['concurrency']['cancel-in-progress'])
        self.assertIn('github.run_attempt > 1', ci['concurrency']['group'])
        branch = yaml.safe_load(Path('.github/workflows/branch-ci.yml').read_text())
        events = branch.get('on', branch.get(True))
        self.assertEqual(events['push']['branches-ignore'], ['main'])
        self.assertNotIn('test', branch['jobs'])
        self.assertEqual(branch['jobs']['branch-test']['runs-on'], 'macos-15')
        self.assertEqual(branch['jobs']['branch-test']['if'],
                         "${{ !cancelled() && needs.branch-preflight.result == 'success' && needs.branch-preflight.outputs.run == 'true' }}")
        self.assertNotEqual(ci['concurrency']['group'], branch['concurrency']['group'])
        for job in [ci['jobs']['test'], branch['jobs']['branch-test']]:
            self.assertEqual(job['steps'][-1]['run'], 'sh scripts/run-ci-tests.sh')
