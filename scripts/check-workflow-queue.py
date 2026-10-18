"""Validate the one concurrency.queue use unsupported by actionlint 1.7.12.

Remove this compatibility check and the exact diagnostic exception together once
the pinned upstream actionlint understands queue. Never broaden the exception.
"""
from pathlib import Path


ADMISSION = " ".join("""
github.repository == 'YusukeIt0/dot-link' &&
(github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main') &&
(github.event_name != 'issue_comment' || github.event.issue.pull_request != null)
""".split())
GROUP = "${{ " + ADMISSION + " && 'dot-link-automatic-merge' || format('dot-link-automatic-merge-ignored-{0}', github.run_id) }}"


def validate(path, workflow):
    expected = {
        "group": GROUP,
        "queue": "single",
        "cancel-in-progress": False,
    }
    concurrency = workflow.get("concurrency")
    if isinstance(concurrency, dict):
        concurrency = {**concurrency, "group": " ".join(str(concurrency.get("group", "")).split())}
    if path.name == "auto-merge.yml":
        if concurrency != expected or concurrency.get("cancel-in-progress") is not False:
            raise ValueError("auto-merge.yml must use the exact serialized, single-pending, non-cancelling concurrency policy")
        if " ".join(str(workflow.get("jobs", {}).get("assess", {}).get("if", "")).split()) != ADMISSION:
            raise ValueError("Assessor admission must match the shared queue admission")
        events = workflow.get("on", workflow.get(True, {}))
        if "schedule" in events:
            raise ValueError("Automatic merge recovery must not use a schedule")
    elif isinstance(concurrency, dict) and "queue" in concurrency:
        raise ValueError(f"{path}: concurrency.queue is only supported in auto-merge.yml")
    for name, job in workflow.get("jobs", {}).items():
        value = job.get("concurrency")
        if isinstance(value, dict) and "queue" in value:
            raise ValueError(f"{path}: job {name} cannot use the workflow-only queue compatibility exception")


def main():
    import yaml

    root = Path(".github/workflows")
    files = sorted([*root.glob("*.yml"), *root.glob("*.yaml")])
    if root / "auto-merge.yml" not in files:
        raise ValueError("Missing automatic-merge workflow")
    for path in files:
        validate(path, yaml.safe_load(path.read_text()))
    print("Workflow queue policy: pass")


if __name__ == "__main__":
    main()
