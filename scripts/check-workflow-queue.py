"""Validate the one concurrency.queue use unsupported by actionlint 1.7.12.

Remove this compatibility check and the exact diagnostic exception together once
the pinned upstream actionlint understands queue. Never broaden the exception.
"""
from pathlib import Path


def validate(path, workflow):
    expected = {
        "group": "dot-link-automatic-merge",
        "queue": "max",
        "cancel-in-progress": False,
    }
    concurrency = workflow.get("concurrency")
    if path.name == "auto-merge.yml":
        if concurrency != expected or concurrency.get("cancel-in-progress") is not False:
            raise ValueError("auto-merge.yml must use the exact serialized, queued, non-cancelling concurrency policy")
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
