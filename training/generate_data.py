"""Generate synthetic training data for the Bi-LSTM.

Plain words: we drive the *simulated* bike thousands of times with random
bias/noise/slip, chop the sensor recordings into 5-second windows, and save
what the TRUE hidden bias/slip was. The Bi-LSTM learns: shaky window -> hidden error.
Run:  python training/generate_data.py --out training/data.npz --runs 60
"""
import argparse
import numpy as np
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from simulation.sensor_simulator import SimConfig, run_truth

W = 100  # window length (5 s @ 50 Hz)


def make_dataset(runs=60, seed=0):
    Xs, Ys = [], []
    for r in range(runs):
        cfg = SimConfig(
            seed=seed + r, duration_s=90.0,
            accel_bias=float(np.random.uniform(-0.05, 0.08)),
            gyro_bias=float(np.random.uniform(-0.003, 0.005)),
            slip_prob=float(np.random.uniform(0.1, 0.5)),
        )
        sim = run_truth(cfg)
        feats = np.stack([sim["ax"], sim["ay"], sim["az"],
                          sim["gx"], sim["gy"], sim["gz"]], axis=1)
        n = len(feats)
        for i in range(0, n - W, 25):
            w = feats[i:i + W]
            gb = float(np.mean(sim["true_gyro_bias"][i:i + W]))
            ab = float(np.mean(sim["true_acc_bias"][i:i + W]))
            sl = float(np.mean(sim["slip"][i:i + W]) > 0.008)
            drift = float(abs(ab) * 8 + abs(gb) * 40)
            Xs.append(w)
            Ys.append([gb, ab, sl, drift])
    return np.array(Xs, np.float32), np.array(Ys, np.float32)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="training/data.npz")
    ap.add_argument("--runs", type=int, default=60)
    a = ap.parse_args()
    X, Y = make_dataset(a.runs)
    np.savez_compressed(a.out, X=X, Y=Y)
    print(f"saved {X.shape} windows -> {a.out}")
