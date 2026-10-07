# HANDOFF — SIH26168 AI Navigator (for Claude Code)

## 0. What this is

AI/ML dead-reckoning navigation studio (Smart India Hackathon, Smart Vehicles).
A deterministic engine simulates IMU + wheel odometry + GNSS outage; a Bi-LSTM
predicts sensor bias/slip and an adaptive ESKF fuses everything. UI proves it
live: truth vs raw-DR vs AI+ESKF, all metrics computed from the run, demo data
always labelled SIMULATED. Live: https://sih26168-ai-navigator.vercel.app

## 1. Stack (pinned, do not swap)

React 19 + Vite 8 + TypeScript + Tailwind 4, zustand 5 (single store),
MapLibre GL 6 (2D map), three 0.18x + @react-three/fiber 9 + drei 10 (3D),
FastAPI + NumPy/SciPy backend (torch optional). No test runner in frontend
(tsc + oxlint + vite build are the gates); pytest for `tests/`.

## 2. Commands (run from `sih-dead-reckoning/` — it holds package.json)

```powershell
npm install; npm run dev        # http://localhost:5173/#/navigation
npm run build                   # tsc -b && vite build  (Vercel runs this)
npm run lint                    # oxlint, warnings only, no errors
pip install -r backend/requirements.txt pytest; python -m pytest tests/ -q
uvicorn backend.app:app --reload --port 8000
npx vercel --prod               # deploy; MUST run from this folder
```

## 3. Data flow (the one thing to understand)

```
zustand params → buildSimulation(params) [memoized] → rAF frame index →
frame: SimFrame → {3D scene, 2D map, charts, HUD, mission report}
```

- `src/sim/useRun.ts` owns playback + all demo actions; every view consumes
  its `Run` object. Demos are TIME-COMPRESSION: `frame = elapsed/10s * (n-1)`.
- `src/lib/sim/engine.ts` is UI-free and deterministic (seeded). NEVER change
  its algorithm logic; UI may read but not mutate.
- Backend (`backend/app.py`, `eskf/`, `models/`, `simulation/`) mirrors the
  same algorithms over HTTP/WS. The UI never depends on it (offline-first).

## 4. Module map (frontend `src/`)

| Module | Role | May import from |
|---|---|---|
| `lib/sim/engine.ts` | Physics: 4 trajectories + metrics (truth/raw/std/ai) | nothing (types only out) |
| `lib/route.ts` | Real highway geometry, sim-metres ↔ lat/lon, 12 demo phases | engine types |
| `lib/objects.ts` | 10 tracked platforms (speed/noise/env params) | engine types |
| `lib/scenarios.ts` | 6 curated demo presets (bike+tunnel = primary) | engine, objects |
| `lib/navmodes.ts` | 5 nav modes + 7-stage GPS timeline derivation | engine types |
| `lib/smooth.ts` | 60 fps pose interpolation (`samplePose`, `damp`) | engine types |
| `lib/ai/engine.ts` | DEMO vs LIVE inference flag (UI badge source) | — |
| `lib/report.ts` | Mission JSON/CSV builder (live values only; latency = null) | engine, objects, ai |
| `lib/mobile.ts` | Phone GPS/IMU/compass hook (HTTPS-gated) | — |
| `store/useConsole.ts` | ALL shared state: params, playback, camera, toggles, selection | engine types |
| `sim/useRun.ts` | Playback loop + actions (play/pause/GPS/drift/noise/slip/speed/scrub/10s demos) | engine, store |
| `views/Navigation.tsx` | HERO: 3D-first full-screen sim, overlays, demo overlay, summary | map, console/*, nav/*, panels, tracking, report, ai, mobile, objects, route |
| `components/map/NavMap.tsx` | MapLibre: route + projected estimator trails + covariance disc | engine, smooth, route, store |
| `components/console/TunnelScene.tsx` | R3F hero: road/tunnel, 6 damped cams, clickable markers, fixed-size labels | engine, objects, smooth, store, TrackedModel |
| `components/charts/charts.tsx` | SVG LineChart (shade band + playhead) + TrajectoryPlot | engine types |
| `components/nav/*` | GpsControl, GpsTimeline, NavModes, NavHud (KPIs+CEP), MiniCharts, AiEskfMini, ErrorComparison, ScenarioBar, DemoOverlay, CountUp | engine/navmodes/charts/store |
| `components/layout/Shell.tsx` | 68px icon rail + hash routes (default `#/navigation`) | — |
| `views/{Analytics,AIAnalysis,EskfView,Performance,Settings,Overview,ArchitectureView}` | Graphs / AI internals / filter state / report export / tuning / landing / pipeline | charts, kit, run, store, report |
| `components/{kit,panels,tracking}.tsx` | Shared primitives, demo controls, data-source selectors | engine, store, run |

Backend: `app.py` (health/simulate/train/model-info/WS-10Hz) ←
`simulation/` (seeded truth+sensors) + `simulation/dead_reckoning.py` (raw) +
`eskf/eskf_15state.py` (real 8-state planar core: standard vs adaptive) +
`models/bilstm.py` (loads `models/bilstm_demo.pt` → LIVE, else DEMO stand-in) +
`utils/metrics.py` (formula source of truth) + `training/` + `datasets/`
(KITTI/EuRoC adapters, CSV schema).

## 5. Contracts / gotchas

- Hash routing (`#/navigation` …); no server rewrites needed for pages.
- `vercel.json`: `/api/*` → Python service, rest → static `dist/`.
- 3D Html labels are FIXED screen size by design (distance scaling removed —
  it caused 10–20× fullscreen text). R3F canvas `dpr ≤ 1.5`, lazy-loaded.
- Fonts: Inter (UI) + JetBrains Mono (numbers); tokens in `src/index.css`
  `@theme` (`--color-accent/healthy/degraded/critical`).
- STD series are dashed everywhere (colorblind-safe); AI badge on every
  Bi-LSTM surface; Analytics header states the data source.
- Tests are seeded (`seed=7`); never assert exact float metrics, assert ordering.
- No secrets exist (keyless CARTO tiles, localhost backend). Nothing to rotate.
- Deleted 2026-09: legacy marketing components, old console cluster, duplicate
  `src/sim/engine.ts`, `src/data`, `src/hooks` (see git history / ARCHITECTURE.md).

## 6. Full-code dump for pasting into Claude Code

Run from repo root (PowerShell) — produces one file, source only:

```powershell
$out = "claude-context.txt"; "" | Out-File $out; Get-ChildItem -Recurse -Include *.ts,*.tsx,*.py -Path src,backend,simulation,eskf,models,utils,datasets,training,tests | Where-Object { $_.FullName -notmatch '__pycache__' } | Sort-Object FullName | ForEach-Object { "`n===== FILE: " + $_.FullName.Substring($PWD.Path.Length+1) + " =====`n"; Get-Content -Raw -LiteralPath $_.FullName } | Out-File $out -Append
```

(~5.5 k lines total; biggest files: TunnelScene 920, engine 483, NavMap 432,
TrackedModel 410, Navigation 385.)
