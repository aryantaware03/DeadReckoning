"""Synthetic sensor simulator — plain words in comments.

Think of this file as a *video game physics engine* for the bike:
- It invents a true road (gentle S-curves) and a true speed.
- Then it pretends to be cheap sensors: accelerometer, gyroscope,
  wheel speedometer, and GPS — adding the same mistakes real
  sensors make (fixed bias, random noise, wheel slip, GPS blackout).
"""
from dataclasses import dataclass
import numpy as np


@dataclass
class SimConfig:
    duration_s: float = 90.0
    dt: float = 0.02            # 50 Hz physics step
    speed_ms: float = 16.7      # ~60 km/h
    tunnel_start_s: float = 20.0
    tunnel_end_s: float = 65.0
    accel_bias: float = 0.03    # m/s^2 constant lie
    gyro_bias: float = 0.002    # rad/s constant lie (~0.11 deg/s)
    accel_noise: float = 0.06   # random shake
    gyro_noise: float = 0.0016
    odo_noise: float = 0.035
    gps_noise: float = 1.1      # metres
    slip_prob: float = 0.25
    seed: int = 7
    # live failure injection (buttons set these)
    force_gps_outage: bool = False
    imu_bias_boost_deg_s: float = 0.0
    extra_noise: float = 0.0
    slip_inject: bool = False


def _slip_windows(rng, t, cfg: SimConfig):
    """A few slippery patches inside the tunnel + optional injected one."""
    wins = []
    if cfg.slip_prob > 0:
        s = cfg.tunnel_start_s + 6 + rng.random() * 6
        while s < cfg.tunnel_end_s - 4:
            if rng.random() < cfg.slip_prob:
                ln = 3 + rng.random() * 5
                wins.append((s, min(cfg.tunnel_end_s - 1, s + ln), 0.03 + rng.random() * 0.05))
                s += ln + 9 + rng.random() * 14
            else:
                s += 10 + rng.random() * 10
    if cfg.slip_inject:
        mid = (cfg.tunnel_start_s + cfg.tunnel_end_s) / 2
        wins.append((mid - 4, mid + 6, 0.08))
    return wins


def run_truth(cfg: SimConfig):
    """Generate one full run. Returns dict of numpy arrays (the SAME stream
    feeds raw DR, standard ESKF and AI+ESKF so the comparison is fair)."""
    rng = np.random.default_rng(cfg.seed)
    n = int(cfg.duration_s / cfg.dt)
    t = np.arange(n) * cfg.dt
    # true motion: cruise + gentle S-turns inside tunnel
    yaw_rate = 0.12 * np.sin(2 * np.pi * t / 34.0) * ((t > cfg.tunnel_start_s) & (t < cfg.tunnel_end_s))
    yaw_rate += 0.02 * np.sin(2 * np.pi * t / 11.0)
    v = cfg.speed_ms * (1 + 0.018 * np.sin(2 * np.pi * t / 21.0 + cfg.seed))
    yaw = np.cumsum(yaw_rate) * cfg.dt
    x = np.cumsum(v * np.sin(yaw)) * cfg.dt
    y = np.cumsum(v * np.cos(yaw)) * cfg.dt

    wins = _slip_windows(rng, t, cfg)
    slip = np.zeros(n)
    for a, b, m in wins:
        m_ = (t >= a) & (t <= b)
        edge = np.minimum(1, np.minimum((t - a) / 1.2, (b - t) / 1.2))[m_]
        slip[m_] = np.maximum(slip[m_], m * np.clip(edge, 0, 1))

    gb = cfg.gyro_bias + np.deg2rad(cfg.imu_bias_boost_deg_s)
    ab = cfg.accel_bias + cfg.imu_bias_boost_deg_s * 0.05
    ns = 1.0 + cfg.extra_noise
    ax = ab * 0.4 + rng.normal(0, cfg.accel_noise * ns, n)
    ay = v * yaw_rate + ab + rng.normal(0, cfg.accel_noise * ns, n)
    az = 9.81 + rng.normal(0, cfg.accel_noise * ns * 0.7, n)
    gx = rng.normal(0, cfg.gyro_noise * ns * 0.5, n)
    gy = rng.normal(0, cfg.gyro_noise * ns * 0.5, n)
    gz = yaw_rate + gb + rng.normal(0, cfg.gyro_noise * ns, n)
    v_front = v * (1 + rng.normal(0, 0.0012, n))
    v_rear = v * (1 + slip) * (1 + rng.normal(0, 0.0015, n))

    gps_ok = (t < cfg.tunnel_start_s) | (t > cfg.tunnel_end_s)
    if cfg.force_gps_outage:
        gps_ok = np.zeros(n, dtype=bool)
    gps_x = x + rng.normal(0, cfg.gps_noise, n)
    gps_y = y + rng.normal(0, cfg.gps_noise, n)
    return {
        "t": t, "x": x, "y": y, "v": v, "yaw": yaw, "yaw_rate": yaw_rate,
        "ax": ax, "ay": ay, "az": az, "gx": gx, "gy": gy, "gz": gz,
        "v_front": v_front, "v_rear": v_rear, "slip": slip,
        "gps_ok": gps_ok, "gps_x": gps_x, "gps_y": gps_y,
        "true_gyro_bias": np.full(n, gb), "true_acc_bias": np.full(n, ab),
    }
