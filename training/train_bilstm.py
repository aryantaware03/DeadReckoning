"""Train the lightweight Bi-LSTM.

Run:
  pip install torch numpy
  python training/generate_data.py --out training/data.npz --runs 60
  python training/train_bilstm.py --data training/data.npz --epochs 15 --out models/bilstm_demo.pt

If torch is missing, this script prints a friendly message and the app keeps
running in clearly-labelled DEMO INFERENCE mode (same interface, no crash).
"""
import argparse, os, sys
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

try:
    import torch
    import torch.nn as nn
    from torch.utils.data import TensorDataset, DataLoader
    HAS_TORCH = True
except Exception:
    HAS_TORCH = False

from models.bilstm import _Net if HAS_TORCH else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="training/data.npz")
    ap.add_argument("--out", default="models/bilstm_demo.pt")
    ap.add_argument("--epochs", type=int, default=15)
    ap.add_argument("--batch", type=int, default=64)
    a = ap.parse_args()
    if not HAS_TORCH:
        print("torch not installed -> skipping training. App will use DEMO INFERENCE.")
        print("Install with: pip install torch --index-url https://download.pytorch.org/whl/cpu")
        return
    if not os.path.exists(a.data):
        print(f"data file {a.data} missing. Run generate_data.py first.")
        return
    d = np.load(a.data)
    X, Y = torch.tensor(d["X"]), torch.tensor(d["Y"])
    # normalise inputs per-channel
    mu, sd = X.mean((0, 1), keepdim=True), X.std((0, 1), keepdim=True) + 1e-6
    Xn = (X - mu) / sd
    ds = TensorDataset(Xn, Y)
    ld = DataLoader(ds, batch_size=a.batch, shuffle=True)
    net = _Net()
    opt = torch.optim.Adam(net.parameters(), lr=1e-3)
    loss_fn = nn.MSELoss()
    net.train()
    for ep in range(a.epochs):
        tot = 0.0
        for xb, yb in ld:
            opt.zero_grad()
            loss = loss_fn(net(xb), yb)
            loss.backward()
            opt.step()
            tot += float(loss) * len(xb)
        print(f"epoch {ep+1}/{a.epochs} loss={tot/len(ds):.5f}")
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    torch.save(net.state_dict(), a.out)
    np.savez_compressed(os.path.splitext(a.out)[0] + "_norm.npz",
                        mu=mu.numpy(), sd=sd.numpy())
    print(f"saved model -> {a.out}  (backend auto-switches to LIVE INFERENCE)")


if __name__ == "__main__":
    main()
