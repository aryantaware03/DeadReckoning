"""Bi-LSTM bias/slip/drift predictor.

Plain words: the model looks at the last ~5 seconds of shaking
(accelerometer + gyro + wheel speed) and guesses three hidden things:
  1. how much the gyro is lying (gyro bias)
  2. how much the accelerometer is lying (accel bias)
  3. how much the wheel is slipping + how fast position is drifting

Interface is identical in DEMO and TRAINED modes so the app never breaks:
  predict(window) -> (gyro_bias, accel_bias, slip, drift, confidence)

- DEMO mode (default): deterministic physics-informed filter, clearly labelled.
- LIVE mode: loads models/bilstm_demo.pt trained by training/train_bilstm.py.
"""
import numpy as np

try:
    import torch
    import torch.nn as nn
    HAS_TORCH = True
except Exception:
    torch = None
    nn = None
    HAS_TORCH = False


class BiLSTMNet:
    def __init__(self, in_dim=6, hid=64, layers=2):
        if not HAS_TORCH:
            raise RuntimeError("torch not installed")
        self.net = _Net(in_dim, hid, layers)

    def __call__(self, x):
        return self.net(x)


if HAS_TORCH:
    class _Net(nn.Module):
        def __init__(self, in_dim=6, hid=64, layers=2):
            super().__init__()
            self.lstm = nn.LSTM(in_dim, hid, layers, batch_first=True, bidirectional=True)
            self.head = nn.Sequential(
                nn.Linear(hid * 2, 64), nn.ReLU(),
                nn.Linear(64, 4),  # gbias, abias, slip_logit, drift
            )

        def forward(self, x):
            y, _ = self.lstm(x)
            return self.head(y[:, -1, :])


class Predictor:
    def __init__(self, model_path="models/bilstm_demo.pt"):
        self.mode = "DEMO INFERENCE"
        self.model = None
        self.model_path = model_path
        if HAS_TORCH:
            try:
                import os
                if os.path.exists(model_path):
                    net = _Net()
                    net.load_state_dict(torch.load(model_path, map_location="cpu"))
                    net.eval()
                    self.model = net
                    self.mode = "LIVE INFERENCE"
            except Exception:
                self.model = None

    def predict_window(self, window: np.ndarray):
        """window: (T,6) [ax,ay,az,gx,gy,gz] -> dict of predictions."""
        if self.model is not None:
            with torch.no_grad():
                x = torch.tensor(window[None, :, :], dtype=torch.float32)
                o = self.model(x).numpy()[0]
            gb, ab = float(o[0]), float(o[1])
            slip = float(1 / (1 + np.exp(-o[2])))
            drift = float(max(0, o[3]))
            conf = float(np.clip(0.97 - drift * 0.02 - slip * 0.12, 0.5, 0.98))
            return {"gyro_bias": gb, "accel_bias": ab, "slip": slip,
                    "drift": drift, "confidence": conf, "mode": self.mode}
        # ---- DEMO inference: rolling residual observer (same interface) ----
        ay = window[:, 1]
        gz = window[:, 5]
        ab = float(np.mean(ay[-20:]) - np.mean(ay[:20])) * 0.15 + 0.03
        gb = float(np.mean(gz[-20:]) - np.mean(gz[:20])) * 0.1 + 0.0016
        slip = float(np.clip(np.std(window[:, 1]) * 1.2, 0, 1))
        drift = float(abs(ab) * 8 + abs(gb) * 40)
        conf = float(np.clip(0.97 - drift * 0.02 - slip * 0.12, 0.5, 0.98))
        return {"gyro_bias": gb, "accel_bias": ab, "slip": slip,
                "drift": drift, "confidence": conf, "mode": self.mode}

    def priors_for_run(self, sim: dict):
        """Slide a window over the whole run -> (n,3) priors for the ESKF."""
        feats = np.stack([sim["ax"], sim["ay"], sim["az"],
                          sim["gx"], sim["gy"], sim["gz"]], axis=1)
        W = 100  # 5 s at 50 Hz... our dt=0.02 -> 100 steps
        n = len(feats)
        out = np.zeros((n, 3))
        for i in range(n):
            w = feats[max(0, i - W + 1):i + 1]
            if len(w) < 10:
                w = np.repeat(feats[max(0, i):max(0, i) + 1], 10, axis=0)
            p = self.predict_window(w)
            out[i] = [p["gyro_bias"], p["accel_bias"], p["slip"] * 0.12]
        return out
