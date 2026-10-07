"""Metrics — every number the Performance Panel shows is computed here.

Plain words:
- RMSE = typical (average) mistake size in metres. Smaller = better.
- Final error = mistake left at the very end.
- Heading error = how many degrees the direction is wrong.
- Drift % = final mistake divided by total distance (like "off by 1%").
- Slip accuracy = of all truly-slippery moments, how many did AI flag.
"""
import numpy as np


def rmse(a):
    return float(np.sqrt(np.mean(np.square(a))))


def summarise(sim, raw, flt):
    n = len(sim["t"])
    dist = float(np.sum(sim["v"]) * (sim["t"][1] - sim["t"][0]))
    ae, se, re_ = flt["ai_err"], flt["std_err"], raw["err"]
    out = {
        "rmse_raw": rmse(re_), "rmse_std": rmse(se), "rmse_ai": rmse(ae),
        "final_raw": float(re_[-1]), "final_std": float(se[-1]), "final_ai": float(ae[-1]),
        "heading_raw_deg": float(np.degrees(rmse(raw["hdg"]))),
        "heading_std_deg": float(np.degrees(rmse(flt["std_hdg"]))),
        "heading_ai_deg": float(np.degrees(rmse(flt["ai_hdg"]))),
        "drift_pct_raw": float(re_[-1] / max(1, dist) * 100),
        "drift_pct_std": float(se[-1] / max(1, dist) * 100),
        "drift_pct_ai": float(ae[-1] / max(1, dist) * 100),
        "distance_m": dist,
        "duration_s": float(sim["t"][-1]),
    }
    out["drift_reduction_pct"] = float((np.mean(re_) - np.mean(ae)) / max(1e-9, np.mean(re_)) * 100)
    slip_true = sim["slip"] > 0.008
    # slip accuracy needs AI slip probs; caller passes them in (see app.py)
    out["slip_true_frames"] = int(np.sum(slip_true))
    return out
