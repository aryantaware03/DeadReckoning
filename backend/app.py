"""FastAPI backend — real algorithms, WebSocket live stream.

Run:
  pip install -r backend/requirements.txt
  uvicorn backend.app:app --reload --port 8000

Endpoints (see README for full docs):
  GET  /api/health            -> {status, torch, model_mode}
  POST /api/simulate          -> run sim + all 3 estimators, return metrics + downsampled path
  POST /api/train             -> (re)generate data + train Bi-LSTM (background)
  GET  /api/model/info        -> DEMO vs LIVE inference mode
  WS   /ws/stream             -> live 10 Hz frames: {t, truth, raw, std, ai, gnss, ai_pred, eskf}
Frontend works WITHOUT the backend (built-in TS engine = same physics);
when the backend is up, the console can mirror its numbers for the jury.
"""
import asyncio
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import numpy as np

from simulation.sensor_simulator import SimConfig, run_truth
from simulation.dead_reckoning import run_raw_dr
from eskf.eskf_15state import run_filters
from models.bilstm import Predictor, HAS_TORCH
from utils.metrics import summarise

app = FastAPI(title="SIH26168 Dead-Reckoning API")
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])

predictor = Predictor()


class SimRequest(BaseModel):
    duration_s: float = 90.0
    speed_kmh: float = 60.0
    tunnel_start_s: float = 20.0
    tunnel_end_s: float = 65.0
    seed: int = 7
    force_gps_outage: bool = False
    imu_bias_boost_deg_s: float = 0.0
    extra_noise: float = 0.0
    slip_inject: bool = False


def _run(req: SimRequest, downsample=5):
    cfg = SimConfig(
        duration_s=req.duration_s, speed_ms=req.speed_kmh / 3.6,
        tunnel_start_s=req.tunnel_start_s, tunnel_end_s=req.tunnel_end_s,
        seed=req.seed, force_gps_outage=req.force_gps_outage,
        imu_bias_boost_deg_s=req.imu_bias_boost_deg_s,
        extra_noise=req.extra_noise, slip_inject=req.slip_inject)
    sim = run_truth(cfg)
    dt = cfg.dt
    raw = run_raw_dr(sim, dt)
    priors = predictor.priors_for_run(sim)
    flt = run_filters(sim, priors, dt)
    m = summarise(sim, raw, flt)
    # slip-detection accuracy (AI flags slip when prior > threshold)
    slip_true = sim["slip"] > 0.008
    slip_flag = priors[:, 2] > 0.03
    m["slip_accuracy"] = float(np.mean(slip_flag[slip_true] == True)) if slip_true.any() else 1.0
    m["model_mode"] = predictor.mode
    idx = np.arange(0, len(sim["t"]), downsample)
    path = {
        "t": sim["t"][idx].tolist(),
        "truth": np.stack([sim["x"][idx], sim["y"][idx]], 1).tolist(),
        "raw": np.stack([raw["x"][idx], raw["y"][idx]], 1).tolist(),
        "std": np.stack([flt["std_x"][idx], flt["std_y"][idx]], 1).tolist(),
        "ai": np.stack([flt["ai_x"][idx], flt["ai_y"][idx]], 1).tolist(),
        "gnss": sim["gps_ok"][idx].tolist(),
    }
    return m, path, sim, raw, flt, priors


@app.get("/api/health")
def health():
    return {"status": "ok", "torch": HAS_TORCH, "model_mode": predictor.mode,
            "project": "SIH26168 AI/ML Dead Reckoning"}


@app.get("/api/model/info")
def model_info():
    return {"mode": predictor.mode, "torch": HAS_TORCH,
            "note": "DEMO INFERENCE until models/bilstm_demo.pt is trained"}


@app.post("/api/simulate")
def simulate(req: SimRequest):
    m, path, *_ = _run(req)
    return {"metrics": m, "path": path}


@app.post("/api/train")
def train(runs: int = 40, epochs: int = 10):
    """Regenerate synthetic data + train (runs in-process; small demo sizes)."""
    from training.generate_data import make_dataset
    if not HAS_TORCH:
        return {"ok": False, "reason": "torch not installed"}
    import torch, torch.nn as nn
    from torch.utils.data import TensorDataset, DataLoader
    from models.bilstm import _Net
    X, Y = make_dataset(runs=runs)
    Xn = (X - X.mean((0, 1), keepdim=True)) / (X.std((0, 1), keepdim=True) + 1e-6)
    ld = DataLoader(TensorDataset(torch.tensor(Xn), torch.tensor(Y)),
                    batch_size=64, shuffle=True)
    net = _Net()
    opt = torch.optim.Adam(net.parameters(), lr=1e-3)
    net.train()
    for _ in range(epochs):
        for xb, yb in ld:
            opt.zero_grad()
            loss = nn.MSELoss()(net(xb), yb)
            loss.backward()
            opt.step()
    os.makedirs("models", exist_ok=True)
    torch.save(net.state_dict(), "models/bilstm_demo.pt")
    global predictor
    predictor = Predictor()  # reload -> LIVE INFERENCE
    return {"ok": True, "mode": predictor.mode, "windows": len(X)}


@app.websocket("/ws/stream")
async def stream(ws: WebSocket):
    """Push live frames at ~10 Hz. Query params mirror SimRequest fields."""
    await ws.accept()
    try:
        q = ws.query_params
        req = SimRequest(
            seed=int(q.get("seed", 7)),
            speed_kmh=float(q.get("speed_kmh", 60)),
            force_gps_outage=q.get("force_gps_outage", "0") == "1",
            slip_inject=q.get("slip_inject", "0") == "1",
        )
        m, _path, sim, raw, flt, priors = _run(req, downsample=1)
        n = len(sim["t"])
        for i in range(0, n, 5):  # 10 Hz
            await ws.send_json({
                "t": float(sim["t"][i]),
                "truth": [float(sim["x"][i]), float(sim["y"][i]), float(sim["yaw"][i])],
                "raw": [float(raw["x"][i]), float(raw["y"][i])],
                "std": [float(flt["std_x"][i]), float(flt["std_y"][i])],
                "ai": [float(flt["ai_x"][i]), float(flt["ai_y"][i])],
                "gnss": bool(sim["gps_ok"][i]),
                "sensors": {"ax": float(sim["ax"][i]), "ay": float(sim["ay"][i]),
                            "az": float(sim["az"][i]), "gz": float(sim["gz"][i]),
                            "v": float(sim["v"][i]), "slip": float(sim["slip"][i])},
                "ai_pred": {"gb": float(priors[i][0]), "ab": float(priors[i][1]),
                            "slip": float(priors[i][2]), "mode": predictor.mode},
                "eskf": {"innov": float(flt["innov"][i]), "corr": float(flt["corr"][i]),
                         "cov": float(flt["cov"][i])},
                "err": {"raw": float(raw["err"][i]), "std": float(flt["std_err"][i]),
                        "ai": float(flt["ai_err"][i])},
            })
            await asyncio.sleep(0.1)
        await ws.send_json({"done": True, "metrics": m})
    except WebSocketDisconnect:
        pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass
