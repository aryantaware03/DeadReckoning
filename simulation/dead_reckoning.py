"""Conventional dead reckoning — the 'dumb but honest' baseline.

Plain words: start from a known point, then keep adding up
"speed x time" in the direction the gyro says we face.
Small sensor lies pile up, so after a tunnel the guess has drifted.
This drift is REAL math here, not animation — that is the point.
"""
import numpy as np


def run_raw_dr(sim: dict, dt: float):
    n = len(sim["t"])
    x = np.zeros(n)
    y = np.zeros(n)
    yaw = np.zeros(n)
    yaw[0] = sim["yaw"][0]
    for i in range(1, n):
        v_odo = (sim["v_front"][i] + sim["v_rear"][i]) / 2 * 1.003
        yaw[i] = yaw[i - 1] + sim["gz"][i] * dt
        x[i] = x[i - 1] + v_odo * np.sin(yaw[i]) * dt
        y[i] = y[i - 1] + v_odo * np.cos(yaw[i]) * dt
    err = np.hypot(x - sim["x"], y - sim["y"])
    hdg = np.abs((yaw - sim["yaw"] + np.pi) % (2 * np.pi) - np.pi)
    return {"x": x, "y": y, "yaw": yaw, "err": err, "hdg": hdg}
