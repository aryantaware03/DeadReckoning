"""Deterministic navigation-engine tests (seeded, no randomness without a seed).

Run:  pip install -r backend/requirements.txt pytest
      pytest tests/ -q
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np

from simulation.sensor_simulator import SimConfig, run_truth
from simulation.dead_reckoning import run_raw_dr
from eskf.eskf_15state import run_filters
from models.bilstm import Predictor
from utils.metrics import summarise, rmse


def _run(seed=7):
    cfg = SimConfig(duration_s=90.0, speed_ms=60.0 / 3.6,
                    tunnel_start_s=20.0, tunnel_end_s=65.0, seed=seed)
    sim = run_truth(cfg)
    raw = run_raw_dr(sim, cfg.dt)
    priors = Predictor().priors_for_run(sim)
    flt = run_filters(sim, priors, cfg.dt)
    return sim, raw, flt


def test_determinism_same_seed():
    a = _run(7)
    b = _run(7)
    assert np.allclose(a[0]["x"], b[0]["x"])
    assert np.allclose(a[2]["ai_x"], b[2]["ai_x"])


def test_gnss_outage_exists():
    sim, _, _ = _run()
    assert bool(sim["gps_ok"][0])  # starts locked under open sky
    assert (~sim["gps_ok"]).sum() > 100  # a real outage happened mid-run


def test_ai_beats_raw_on_tunnel_run():
    sim, raw, flt = _run()
    m = summarise(sim, raw, flt)
    assert m["rmse_ai"] < m["rmse_raw"]
    assert m["final_ai"] < m["final_raw"]


def test_metrics_documented_formulas():
    sim, raw, flt = _run()
    m = summarise(sim, raw, flt)
    dist = m["distance_m"]
    assert m["drift_pct_ai"] == abs(flt["ai_err"][-1]) / max(1, dist) * 100
    assert m["rmse_ai"] == rmse(flt["ai_err"])
    assert 0.0 <= m["drift_reduction_pct"] <= 100.0


def test_covariance_grows_in_outage():
    _, _, flt = _run()
    cov = flt["cov"]
    # uncertainty must be higher mid-outage than at the GNSS-locked start
    assert float(np.mean(cov[len(cov) // 2:])) > float(np.mean(cov[:20]))


def test_no_nan_in_estimates():
    sim, raw, flt = _run()
    for arr in (raw["x"], raw["y"], flt["ai_x"], flt["ai_y"], flt["std_x"], flt["cov"]):
        assert np.all(np.isfinite(arr))
