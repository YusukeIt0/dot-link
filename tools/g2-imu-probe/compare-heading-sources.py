"""Offline feasibility checks. Optional argument: a private 12-pose probe export."""

import argparse
import json
import math
import statistics
from pathlib import Path
from zipfile import ZipFile

import cv2
from geographiclib.geodesic import Geodesic
import numpy as np


def examine_g2(session):
    if session.get("sdk") != "0.0.16" or session.get("stopReason") != "all poses marked":
        raise ValueError("Expected a completed 12-pose G2 export")
    phases = {}
    centers = {}
    for phase in ("move", "settle", "hold"):
        groups = {}
        magnitudes = []
        for row in session["rows"]:
            if row["phase"] != phase:
                continue
            xyz = [row[axis] for axis in "xyz"]
            if not all(isinstance(n, (int, float)) and math.isfinite(n) for n in xyz):
                continue
            magnitudes.append(math.hypot(*xyz))
            groups.setdefault(row["pose"], []).append(xyz)
        if not magnitudes:
            raise ValueError(f"No complete XYZ samples in {phase!r}")
        phases[phase] = {
            "samples": len(magnitudes),
            "range_g": [round(min(magnitudes), 4), round(max(magnitudes), 4)],
            "median_g": round(statistics.median(magnitudes), 4),
            "more_than_0.05g_from_one": sum(abs(n - 1) > 0.05 for n in magnitudes),
        }
        if phase == "hold":
            for pose, group in groups.items():
                mean = np.mean(group, axis=0)
                if np.linalg.norm(mean) <= 1e-10:
                    raise ValueError(f"Unusable gravity vector in {pose!r}")
                centers[pose] = mean / np.linalg.norm(mean)
    clockwise = ["F1", "R1", "B1", "L1"]
    counterclockwise = ["F2", "R2", "B2", "L2"]
    if not all(p in centers for p in clockwise + counterclockwise):
        raise ValueError("Expected complete settled samples in both level sweeps")
    scored = []
    for train, evaluate in ((clockwise, counterclockwise), (counterclockwise, clockwise)):
        predicted = [min(train, key=lambda ref: np.linalg.norm(centers[p] - centers[ref])) for p in evaluate]
        scored.append(sum(a[0] == b[0] for a, b in zip(evaluate, predicted)))
    return {"phases": phases, "held_out_direction_correct_of_four": scored}


def rotation_from_common_acceleration(head, earth):
    """Inputs are simultaneous, levelled horizontal accelerations in the same units.

    The glasses axes are right/forward and the reference axes east/north. The
    test assumes both sensors experienced the same translation and constant yaw.
    """
    energy = np.linalg.norm(head) * np.linalg.norm(earth)
    if energy < 1e-10:
        return None
    dot = np.sum(head * earth)
    cross = np.sum(head[:, 1] * earth[:, 0] - head[:, 0] * earth[:, 1])
    correlation = math.hypot(dot, cross) / energy
    if correlation < 1e-12:
        return None
    return {"deg": round(math.degrees(math.atan2(cross, dot)), 3) % 360,
            "coherence": round(correlation, 4)}


def synthetic_motion():
    # Two independently specified components of an illustrative shared motion.
    t = np.arange(50) / 5
    earth = np.stack((0.6 * np.sin(t * 2), 0.4 * np.cos(t * 3)), axis=1)

    def head_trace(heading):
        h = math.radians(heading)
        axes = np.array([[math.cos(h), math.sin(h)], [-math.sin(h), math.cos(h)]])
        return earth @ axes

    east = rotation_from_common_acceleration(head_trace(90), earth)
    west = rotation_from_common_acceleration(head_trace(270), earth)
    assert east["deg"] == 90 and west["deg"] == 270
    assert rotation_from_common_acceleration(np.zeros_like(earth), earth) is None
    # If the phone moves differently, even a perfect fit can be falsely confident.
    mismatch = rotation_from_common_acceleration(head_trace(90), earth @ np.array([[0, 1], [-1, 0]]))
    assert mismatch == {"deg": 0, "coherence": 1}
    return {"head_east": east, "head_west": west, "stationary": None,
            "independently_rotated_reference_for_true_90deg": mismatch}


def synthetic_face():
    # Generic non-coplanar coordinates in millimetres. No photo or face model
    # is loaded. The unmirrored pinhole camera's axes are right, down, forward.
    face = np.array([[0, 0, -28], [0, 52, -2], [-33, -21, 0], [33, -21, 0],
                     [-24, 24, -4], [24, 24, -4], [-47, 1, 12], [47, 1, 12]], dtype=float)
    K = np.array([[660., 0, 320], [0, 660., 240], [0, 0, 1]])
    rng = np.random.default_rng(448)
    results = []
    # Fixed head while camera moves, then fixed camera while the head turns.
    for camera_heading, head_heading in [(15, 205), (35, 205), (45, 205), (35, 235)]:
        yaw = math.radians(head_heading - camera_heading - 180)
        pixels, _ = cv2.projectPoints(face, np.array([0., yaw, 0.]), np.array([0., 0., 520.]), K, None)
        pixels += rng.normal(0, 0.5, pixels.shape)
        ok, pose, _ = cv2.solvePnP(face, pixels, K, None, flags=cv2.SOLVEPNP_ITERATIVE)
        assert ok
        rotation, _ = cv2.Rodrigues(pose)
        forward = rotation @ np.array([0., 0., -1.])
        # In this fixture only, the reference camera is level with known azimuth.
        heading = (camera_heading + math.degrees(math.atan2(forward[0], forward[2]))) % 360
        error = abs((heading - head_heading + 180) % 360 - 180)
        assert error < 4
        results.append({"camera_deg": camera_heading, "head_deg": head_heading,
                        "estimated_deg": round(heading, 2), "fixture_error_deg": round(error, 2)})
    return results


def known_landmark():
    # An invented location and an identified point. The explicit premise is that
    # the wearer currently reports facing that point. A nearby POI alone is insufficient.
    point = Geodesic.WGS84.Direct(0, 0, 72, 100)
    inverse = Geodesic.WGS84.Inverse(0, 0, point["lat2"], point["lon2"])
    return {"true_bearing_deg": round(inverse["azi1"], 2),
            "position_only_cone_deg_for_10m_combined_error_at_100m": round(math.degrees(math.asin(10 / inverse["s12"])), 2)}


def paired_recording(folder, subject, activity):
    streams = {}
    for sensor in ("acc", "mag"):
        with ZipFile(folder / f"s{subject}-{sensor}-{activity}.zip") as archive:
            for site in ("head", "waist"):
                member, = [n for n in archive.namelist() if n.lower().endswith(f"_{site}.csv")]
                with archive.open(member) as f:
                    streams[sensor, site] = np.loadtxt(f, delimiter=",", skiprows=1, usecols=(1, 2, 3, 4))
    # Align on the original timestamps; never tune an offset using the answer.
    begin = math.ceil(max(s[0, 0] for s in streams.values()) / 200) * 200
    end = math.floor(min(s[-1, 0] for s in streams.values()) / 200) * 200
    count = int((end - begin) // 200)
    for key, stream in streams.items():
        ids = np.floor((stream[:, 0] - begin) / 200).astype(int)
        valid = (ids >= 0) & (ids < count)
        bins = ids[valid]
        sizes = np.bincount(bins, minlength=count)
        summed = np.column_stack([np.bincount(bins, weights=stream[valid, i], minlength=count) for i in (1, 2, 3)])
        streams[key] = np.divide(summed, sizes[:, None], out=np.full((count, 3), np.nan), where=sizes[:, None] > 0)
    return streams, count


def horizontal_axes(up, towards):
    north = towards - np.dot(towards, up) * up
    if np.linalg.norm(north) < 1e-8:
        raise ValueError("No independent horizontal direction")
    north /= np.linalg.norm(north)
    return np.column_stack((np.cross(north, up), north))


def compare_realworld(folder, subject, activity):
    streams, count = paired_recording(folder, subject, activity)
    errors, selected = [], []
    for start in range(0, count - 49, 50):
        block = {key: val[start:start + 50] for key, val in streams.items()}
        if not all(np.isfinite(s).all() for s in block.values()):
            continue
        head = block["acc", "head"]
        waist = block["acc", "waist"]
        head_up = head.mean(axis=0) / np.linalg.norm(head.mean(axis=0))
        waist_up = waist.mean(axis=0) / np.linalg.norm(waist.mean(axis=0))
        # Choose a well-conditioned horizontal head-device axis, independent of
        # its magnetometer. Anatomical mounting offset is unknown in this data.
        head_axis = np.eye(3)[np.argmin(np.abs(head_up))]
        head_basis = horizontal_axes(head_up, head_axis)
        waist_earth = horizontal_axes(waist_up, block["mag", "waist"].mean(axis=0))
        head_motion = (head - head.mean(axis=0)) @ head_basis
        reference_motion = (waist - waist.mean(axis=0)) @ waist_earth
        estimate = rotation_from_common_acceleration(head_motion, reference_motion)
        if estimate is None:
            continue
        # Only the independent comparison below sees the head magnetometer.
        head_earth = horizontal_axes(head_up, block["mag", "head"].mean(axis=0))
        east, north = head_basis[:, 1] @ head_earth
        reference_deg = math.degrees(math.atan2(east, north))
        error = abs((estimate["deg"] - reference_deg + 180) % 360 - 180)
        errors.append(error)
        rms = min(np.sqrt(np.mean(np.sum(a * a, axis=1))) for a in (head_motion, reference_motion))
        # Illustrative fixed gates chosen before inspecting the outcome.
        if rms >= 0.25 and estimate["coherence"] >= 0.6:
            selected.append(error)

    def stats(values):
        if not values:
            return {"windows": 0}
        return {"windows": len(values), "median_error_deg": round(float(np.median(values)), 1),
                "p90_error_deg": round(float(np.percentile(values, 90)), 1),
                "within_30deg": sum(e <= 30 for e in values)}

    return {"subject": subject, "activity": activity, "all": stats(errors), "gated": stats(selected)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("probe_export", type=Path, nargs="?")
    parser.add_argument("--paired-archives", type=Path, help="Local RealWorld HAR acceleration and magnetic archives")
    args = parser.parse_args()
    report = {"synthetic_shared_acceleration": synthetic_motion(), "synthetic_optical_pose": synthetic_face(),
              "synthetic_identified_landmark": known_landmark()}
    if args.probe_export:
        report["physical_g2_aggregates"] = examine_g2(json.loads(args.probe_export.read_text()))
    if args.paired_archives:
        report["realworld_reference_comparison"] = [compare_realworld(args.paired_archives, subject, activity)
            for subject in (1, 2) for activity in ("walking", "sitting")]
    print(json.dumps(report, indent=2))
