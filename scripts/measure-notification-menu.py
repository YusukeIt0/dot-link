#!/usr/bin/env python3
"""Sample one explicitly supplied process; never collect command lines/content."""
import argparse
import json
import statistics
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--pid", type=int, required=True)
parser.add_argument("--seconds", type=int, default=30)
parser.add_argument("--phase", required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
if args.pid <= 0 or not 5 <= args.seconds <= 300:
    parser.error("pid must be positive; seconds must be 5..300")
samples = []
for i in range(args.seconds + 1):
    fields = subprocess.check_output(
        ["/bin/ps", "-p", str(args.pid), "-o", "%cpu=,rss=,time="], text=True
    ).split()
    if len(fields) != 3:
        raise SystemExit("Target exited or unexpected ps output")
    cpu, rss, cumulative = fields
    minutes, seconds = cumulative.split(":")
    samples.append({"elapsed_seconds": i, "cpu_percent_ps": float(cpu),
                    "rss_bytes": int(rss) * 1024,
                    "cpu_seconds": int(minutes) * 60 + float(seconds)})
    if i < args.seconds:
        time.sleep(1)
summary = {
    "phase": args.phase, "pid": args.pid, "duration_seconds": args.seconds,
    "cpu_percent_from_cumulative": round((samples[-1]["cpu_seconds"] - samples[0]["cpu_seconds"]) / args.seconds * 100, 3),
    "cpu_percent_ps_peak": max(s["cpu_percent_ps"] for s in samples),
    "rss_mib_median": round(statistics.median(s["rss_bytes"] for s in samples) / 2**20, 2),
    "rss_mib_peak": round(max(s["rss_bytes"] for s in samples) / 2**20, 2),
    "rss_mib_change": round((samples[-1]["rss_bytes"] - samples[0]["rss_bytes"]) / 2**20, 2),
    "note": "ps CPU samples are smoothed; cumulative CPU delta is measured over the window. RSS is not total physical footprint.",
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps({"summary": summary, "samples": samples}, indent=2) + "\n")
print(json.dumps(summary))
