# Deployment — SIH26168 AI Navigator (actual stack)

## 0. What deploys where

| Piece | Target | Build |
|---|---|---|
| Web frontend (`src/`, Vite) | Vercel | `npm run build` → `dist/` |
| Python API (`backend/`, FastAPI) | Vercel serverless (current `vercel.json`) or Docker host | `backend/Dockerfile` |
| No database, no secrets, no domain required for the demo | — | — |

## 1. Clone

```powershell
git clone <your-repo-url>
Set-Location -LiteralPath ".\sih-dead-reckoning"
```

## 2. Install

```powershell
npm install
pip install -r backend/requirements.txt
# optional, for LIVE Bi-LSTM inference:
pip install torch --index-url https://download.pytorch.org/whl/cpu
```

## 3. Environment variables

None required. Copy `.env.example` only if overriding:

```powershell
Copy-Item .env.example .env
```

## 4. Start backend (optional — frontend runs standalone)

```powershell
uvicorn backend.app:app --reload --port 8000
# health: http://localhost:8000/api/health
```

## 5. Start frontend

```powershell
npm run dev    # http://localhost:5173/#/navigation
```

## 6. Database

Not required. Mission reports export as local JSON/CSV files.

## 7. Deploy frontend (Vercel)

```powershell
npx vercel login
npx vercel link        # pick sih26168-ai-navigator
npx vercel --prod      # → https://sih26168-ai-navigator.vercel.app
```

Always deploy from the `sih-dead-reckoning/` folder (it contains `package.json`);
deploying a parent folder uploads the wrong directory.

## 8. Deploy backend

Option A — same Vercel project (current setup, `vercel.json` routes `/api/*`
to the Python service). No extra step beyond `npx vercel --prod`.

Option B — Docker host (Render/Railway/Fly/AWS):

```powershell
docker build -f backend/Dockerfile -t sih26168-api .
docker run -p 8000:8000 sih26168-api
```

Then point the frontend at it via Settings → Backend Link
(or `BACKEND_URL` for scripts).

## 9. Domain

Vercel project → Settings → Domains → add domain. No code change needed
(hash routing, no server rewrites for pages).

## 10. CORS

`backend/app.py` currently allows `*` (demo). For production lock-down, replace
`allow_origins=["*"]` with the exact frontend origin.

## 11. Mobile API URL

Web app: none needed (backend optional). Future native app: bake the API base
URL at build time (Expo `extra.apiUrl`), same endpoints as §4.

## 12. Android APK/AAB

Not built (no native app yet). When the Expo app lands: EAS build with package
`com.techminds.sih26168`, permissions `ACCESS_FINE_LOCATION` (+ motion sensors
via expo-sensors, no background location unless the mission requires it).

## 13. Test production

```powershell
npx vercel --prod
# open the aliased URL → #/navigation auto-runs 3D sim
# CONTROL → SIH DEMO MODE → completes → export mission JSON
curl https://<your-api>/api/health
python -m pytest tests/ -q
```

## 14. Rollback

Vercel project → Deployments → previous production deployment → Promote.
Backend Docker: re-run with the previous image tag.
