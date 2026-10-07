"""Dataset playback stubs for KITTI / EuRoC.

The hackathon prototype runs fully on synthetic data, but this module is the
*plug-in point* for real datasets later: implement `load_kitti()` /
`load_euroc()` to return the same dict the simulator returns
(t, ax..gz, v_front/v_rear, gps_ok, gps_x/y, x/y/yaw ground truth).
The frontend 'Dataset Playback' section already accepts CSVs in this schema,
so swapping synthetic -> real is a one-function change.
"""
import numpy as np


def describe_expected_schema():
    return ("timestamp,ax,ay,az,gx,gy,gz,wheel_speed,"
            "gps_lat,gps_lon,gps_alt,ground_truth_x,ground_truth_y,ground_truth_z")


def load_csv_rows(rows):
    """rows: list of dicts parsed from an uploaded CSV. Returns sim-like dict."""
    t = np.array([r["t"] for r in rows], float)
    dt = float(np.median(np.diff(t))) if len(t) > 2 else 0.02
    return {
        "t": t, "dt": dt,
        "ax": np.array([r["ax"] for r in rows], float),
        "ay": np.array([r["ay"] for r in rows], float),
        "az": np.array([r["az"] for r in rows], float),
        "gx": np.array([r["gx"] for r in rows], float),
        "gy": np.array([r["gy"] for r in rows], float),
        "gz": np.array([r["gz"] for r in rows], float),
        "v_front": np.array([r["wheel"] for r in rows], float) / 3.6,
        "v_rear": np.array([r["wheel"] for r in rows], float) / 3.6,
        "gps_ok": np.array([r["gnss"] for r in rows], bool),
        "x": np.array([r["x"] for r in rows], float),
        "y": np.array([r["z"] for r in rows], float),
    }


def load_kitti(_path):
    raise NotImplementedError(
        "Plug a KITTI loader here (see datasets/KITTI_GUIDE.md). "
        "Prototype uses synthetic data so judges can run it with no downloads.")


def load_euroc(_path):
    raise NotImplementedError(
        "Plug a EuRoC MAV loader here. Prototype uses synthetic data.")
