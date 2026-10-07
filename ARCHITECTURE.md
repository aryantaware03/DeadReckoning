# Architecture Report — SIH26168 (audit, 2026-09-29)

## Frontend (`src/`)

- Entry `main.tsx → App → Studio`: hash-routed shell (`overview, navigation,
  analytics, ai, eskf, architecture, performance, settings`). Default route:
  `#/navigation` (boots into the running 3D sim).
- Shared run: `src/sim/useRun.ts` builds `buildSimulation(params)` once per
  param change and advances a 10 Hz frame index via rAF; every view reads the
  same `frame`. Engine is UI-free and deterministic (mulberry32 seeds).
- Engine `src/lib/sim/engine.ts`: 100 Hz internal IMU integration, 10 Hz
  frames, 4 trajectories (truth / raw DR / standard ESKF / AI+adaptive ESKF),
  live metrics (RMSE/final/max/heading/velocity/drift%/slip-accuracy). Untouched
  by this upgrade.
- Viz: `TunnelScene.tsx` (R3F: instanced road/tunnel/dressing, 6 damped
  cameras, constant-size Html tech labels, capped DPR) + `NavMap.tsx`
  (MapLibre dark basemap, projected estimator trails, covariance disc).
- State: zustand `useConsole` (params, playback, camera, layer toggles).
- Live phone path `src/lib/mobile.ts` (GPS + motion + compass, HTTPS-gated);
  dataset CSV + telemetry JSON replay through the same views.

## Backend (`backend/`, `simulation/`, `eskf/`, `models/`, `utils/`, `training/`, `datasets/`)

- `backend/app.py`: FastAPI — `/api/health`, `/api/model/info`,
  `POST /api/simulate`, `POST /api/train`, `WS /ws/stream` (10 Hz). CORS open
  (demo). No auth/DB (none needed).
- `simulation/sensor_simulator.py` + `dead_reckoning.py`: seeded NumPy truth +
  biased/noisy IMU + wheel slip windows.
- `eskf/eskf_15state.py`: REAL filter — 8-state planar core of the 15-state
  error vector, standard (fixed) vs adaptive (innovation-scaled noise + gated
  GPS + 10 Hz Bi-LSTM bias/slip priors), covariance history.
- `models/bilstm.py`: REAL interface — 6→64×2 Bi-LSTM→4 heads; auto-loads
  `models/bilstm_demo.pt` (LIVE) else deterministic stand-in (DEMO), UI-labelled.
- `utils/metrics.py`: RMSE/final/heading/drift%/slip formulas (mirrored in TS).
- `training/`: synthetic data gen + trainer. `datasets/`: KITTI/EuRoC adapters
  + CSV schema + guide.

## Data flow

params → engine build → rAF index → frame → {3D, map, charts, HUD, report}.
Backend mirrors the same algorithms over HTTP/WS when online; UI never depends
on it (offline-first by construction for the demo loop).

## Deployment

Vercel: Vite → `dist/` (frontend) + Python service for `/api/*`
(`vercel.json`). `npm run build` green; `backend/Dockerfile` for container
hosts; zero required env vars (`.env.example`).

## Dead code (unbundled, left in place)

Legacy marketing components (`components/Hero,Simulation,Sections,References,
Nav,Overview,BiLSTM,EskfStates,Architecture,ui`, `data/`, `hooks/`) are not
imported by the Studio shell, so Vite excludes them from the bundle. Kept to
avoid churn; safe to delete in a cleanup pass.

## Bugs found & fixed in this pass

1. 3D Html labels used distance scaling → ~10–20× fullscreen text at follow
   range. Fixed: constant screen-size labels; tips hover-only.
2. Uncertainty was numeric-only; no spatial representation. Fixed: covariance
   disc on the map + legend readout.
3. Outage length only via tunnel dropdown. Fixed: 5/10/30/60/120 s presets.
4. No mission artifact. Fixed: JSON/CSV export from live `SimResult`.
5. No backend tests/CI/Docker/docs. Fixed: 6 deterministic pytest tests,
   `ci.yml`, `backend/Dockerfile`, README/DEPLOYMENT/checklist/`ARCHITECTURE.md`.

## Honest gaps (not claimed)

Recorded-sensor validation, HMM map matching (route-projection today), native
mobile app (browser sensors today), on-device latency measurement, NHC-isolated
ablation arms D/E, mission database.
