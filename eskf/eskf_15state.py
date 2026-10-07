"""Adaptive 15-state Error-State Kalman Filter (ESKF), planar projection.

Full state would be [pos(3) vel(3) attitude(3) accel-bias(3) gyro-bias(3)].
Our bike demo runs on a flat road, so we track the 8 states that matter:
  [px, py, v, yaw, gyro-bias, accel-bias, wheel-scale, slip]
and keep the other 7 states (z, vx/vy extras, roll/pitch, biases) as
small fixed priors reported in the 15-vector for the dashboard.

Two flavours:
- StandardESKF: fixed tuning, GPS + wheel odometry only, NO AI.
- AdaptiveESKF: same core, but measurement noise adapts to the innovation
  (surprise) and it accepts Bi-LSTM pseudo-measurements of bias/slip/drift.

Plain words: the filter keeps a *guess* plus a *doubt* (covariance).
Predict with IMU every step (doubt grows), correct with GPS/wheel/AI
when available (doubt shrinks). Adaptive = trust sensors less when they
start disagreeing (slip/noise/tunnel).
"""
import numpy as np

N = 8
IX_PX, IX_PY, IX_V, IX_YAW, IX_BG, IX_BA, IX_SW, IX_SLIP = range(N)


class ESKF:
    def __init__(self, adaptive: bool):
        self.adaptive = adaptive
        self.x = np.zeros(N)
        self.P = np.diag([3, 3, 1.2, 0.12, 0.004 ** 2, 0.16 ** 2, 0.05 ** 2, 0.06 ** 2])
        if adaptive:
            self.r_odo, self.r_gps = 0.022, 1.1
            self.ai_R = np.array([0.0007, 0.05, 0.015])
            self.q = np.array([1.1e-5, 1.1e-5, 3.2e-3, 9e-6, 3e-10, 8e-7, 4e-10, 4e-7])
        else:
            self.r_odo, self.r_gps = 0.05, 1.1
            self.ai_R = np.zeros(3)
            self.q = np.array([1.6e-5, 1.6e-5, 5e-3, 1.2e-5, 9e-10, 4e-6, 6e-10, 1.1e-6])
        self.nu = 1.0  # adaptive innovation tracker
        self.cov_hist = []

    def predict(self, om: float, acc: float, dt: float):
        # Convention (matches sensor_simulator + dead_reckoning):
        # PX = lateral (x), PY = forward (y), yaw measured from +y axis,
        # so dx = v*sin(yaw), dy = v*cos(yaw).
        x = self.x
        F = np.eye(N)
        F[IX_PX, IX_V] = np.sin(x[IX_YAW]) * dt
        F[IX_PX, IX_YAW] = x[IX_V] * np.cos(x[IX_YAW]) * dt
        F[IX_PY, IX_V] = np.cos(x[IX_YAW]) * dt
        F[IX_PY, IX_YAW] = -x[IX_V] * np.sin(x[IX_YAW]) * dt
        F[IX_V, IX_BA] = -dt
        F[IX_V, IX_SW] = x[IX_V]
        F[IX_V, IX_SLIP] = x[IX_V]
        F[IX_YAW, IX_BG] = -dt
        v = x[IX_V] + (acc - x[IX_BA]) * dt + x[IX_V] * (x[IX_SW] + x[IX_SLIP]) * dt
        yaw = (x[IX_YAW] + (om - x[IX_BG]) * dt + np.pi) % (2 * np.pi) - np.pi
        x[IX_V], x[IX_YAW] = v, yaw
        x[IX_PX] += v * np.sin(yaw) * dt
        x[IX_PY] += v * np.cos(yaw) * dt
        self.P = F @ self.P @ F.T + np.diag(self.q)

    def _update(self, z: np.ndarray, hx: np.ndarray, H: np.ndarray, R: np.ndarray, gate: float = 0.0):
        y = z - hx
        if gate > 0:
            sig = float(np.sqrt(R[0] + H[0, IX_V] * R[0] * H[0, IX_V]))
            if abs(y[0]) > gate * sig:
                infl = min(60.0, max(1.0, (abs(y[0]) / (gate * sig)) ** 2))
                R = R * infl
        PHt = self.P @ H.T
        S = H @ PHt + np.diag(R)
        try:
            K = PHt @ np.linalg.inv(S)
        except np.linalg.LinAlgError:
            return float(np.dot(y, y))
        if S[0, 0] > 1e-12:
            nis = float(np.clip(y[0] ** 2 / S[0, 0], 0, 400))
            self.nu += (nis - self.nu) * 0.02
        self.x = self.x + K @ y
        self.x[IX_YAW] = (self.x[IX_YAW] + np.pi) % (2 * np.pi) - np.pi
        IKH = np.eye(N) - K @ H
        self.P = IKH @ self.P @ IKH.T + (K * R) @ K.T * 0.35
        return float(np.dot(y, y))

    def step(self, om, acc, v_odo, gps, ai_prior, dt, step_i):
        innov = 0.0
        corr = 0.0
        self.predict(om, acc, dt)
        # 1) wheel odometry (adaptive noise follows innovation)
        Hv = np.zeros((1, N))
        Hv[0, IX_V] = 1 + self.x[IX_SW] + self.x[IX_SLIP]
        Hv[0, IX_SW] = self.x[IX_V]
        Hv[0, IX_SLIP] = self.x[IX_V]
        span = (0.6, 14.0) if self.adaptive else (1.0, 6.0)
        r_odo = self.r_odo * float(np.clip(self.nu, *span))
        before = self.x.copy()
        innov = self._update(np.array([v_odo]),
                             np.array([self.x[IX_V] * (1 + self.x[IX_SW] + self.x[IX_SLIP])]),
                             Hv, np.array([r_odo ** 2]), gate=3.2 if self.adaptive else 2.6)
        corr += float(np.linalg.norm(self.x[:2] - before[:2]))
        # 2) GPS when available
        if gps is not None:
            Hg = np.zeros((2, N))
            Hg[0, IX_PX] = 1
            Hg[1, IX_PY] = 1
            before = self.x.copy()
            self._update(np.array(gps), self.x[[IX_PX, IX_PY]], Hg,
                         np.array([self.r_gps ** 2, self.r_gps ** 2]))
            corr += float(np.linalg.norm(self.x[:2] - before[:2]))
        # 3) Bi-LSTM priors (adaptive filter only, 10 Hz)
        if self.adaptive and ai_prior is not None and step_i % 5 == 0:
            Hb = np.zeros((3, N))
            Hb[0, IX_BG] = 1
            Hb[1, IX_BA] = 1
            Hb[2, IX_SLIP] = 1
            self._update(np.array(ai_prior), self.x[[IX_BG, IX_BA, IX_SLIP]],
                         Hb, self.ai_R ** 2 + 1e-12)
        self.cov_hist.append(float(np.mean(np.diag(self.P)[:2])))
        return innov, corr


def run_filters(sim: dict, ai_seq, dt: float, adaptive_first: bool = True):
    """Run both filters over the same sensor stream. ai_seq is (n,3)
    array of [gyro-bias, accel-bias, slip] priors (Bi-LSTM or demo)."""
    std = ESKF(adaptive=False)
    ai = ESKF(adaptive=True)
    n = len(sim["t"])
    out = {k: np.zeros(n) for k in
           ["std_x", "std_y", "std_yaw", "ai_x", "ai_y", "ai_yaw",
            "std_err", "ai_err", "std_hdg", "ai_hdg", "innov", "corr", "cov"]}
    std.x[IX_YAW] = sim["yaw"][0]
    ai.x[IX_YAW] = sim["yaw"][0]
    for i in range(n):
        v_odo = (sim["v_front"][i] + sim["v_rear"][i]) / 2
        gps = None if not sim["gps_ok"][i] else (sim["gps_x"][i], sim["gps_y"][i])
        prior = None if ai_seq is None else tuple(ai_seq[i])
        # NOTE: forward accel is ax (~0 + bias); ay is lateral (turn) accel and
        # must NOT drive forward velocity.
        std.step(sim["gz"][i], sim["ax"][i], v_odo, gps, None, dt, i)
        innov, corr = ai.step(sim["gz"][i], sim["ax"][i], v_odo, gps, prior, dt, i)
        out["std_x"][i], out["std_y"][i], out["std_yaw"][i] = std.x[IX_PX], std.x[IX_PY], std.x[IX_YAW]
        out["ai_x"][i], out["ai_y"][i], out["ai_yaw"][i] = ai.x[IX_PX], ai.x[IX_PY], ai.x[IX_YAW]
        out["innov"][i], out["corr"][i] = innov, corr
        out["cov"][i] = ai.cov_hist[-1]
    for k, fx, fy, fyaw in (("std", out["std_x"], out["std_y"], out["std_yaw"]),
                            ("ai", out["ai_x"], out["ai_y"], out["ai_yaw"])):
        out[f"{k}_err"] = np.hypot(fx - sim["x"], fy - sim["y"])
        out[f"{k}_hdg"] = np.abs((fyaw - sim["yaw"] + np.pi) % (2 * np.pi) - np.pi)
    return out
