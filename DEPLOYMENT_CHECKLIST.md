# Production Deployment Checklist — SIH26168

- [ ] `npm run build` passes (tsc + vite, no errors)
- [ ] `npm run lint` shows no new warnings
- [ ] `python -m pytest tests/ -q` — 6/6 pass
- [ ] Deployed from `sih-dead-reckoning/` (contains `package.json`)
- [ ] Frontend loads: `#/navigation` auto-runs the 3D sim
- [ ] `★ SIH DEMO MODE` completes end-to-end (~75 s)
- [ ] GPS ON/OFF forces LOST; raw DR diverges, AI+ESKF holds
- [ ] Analytics A–F graphs shade the GPS-denied band
- [ ] Performance shows live (non-hardcoded) metrics
- [ ] Mission JSON/CSV export downloads
- [ ] `#/overview`, `#/analytics`, `#/ai-analysis`, `#/eskf`, `#/architecture`, `#/performance`, `#/settings` all render
- [ ] No console errors during a full demo run
- [ ] Backend `/api/health` returns ok (if backend deployed)
- [ ] CORS origins locked down for non-demo production
- [ ] No secrets committed (repo needs none — see `.env.example`)
- [ ] Rollback deployment identified in Vercel dashboard
