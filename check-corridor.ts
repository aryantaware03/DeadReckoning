// Checks that the corridor's derivations survive contact with the real run.
//
// Every quantity the corridor draws ends up in a shader uniform or a vertex
// buffer. A NaN in the covariance reaches the GPU and the layer silently
// vanishes — a failure the type checker cannot see and a screenshot taken at
// the wrong moment will not catch either. So each check asserts a property the
// visualisation actually relies on.
//
// Invoked by check-corridor.mjs, which bundles this file first.

import { buildSimulation, DEFAULT_PARAMS } from './src/lib/sim/engine'
import {
  buildCorridor,
  corridorUByFrame,
  ringStations,
  sampleCorridor,
  sigmaFrom,
  waypoints,
  predictionHorizon,
  ringOpacity,
  CORRIDOR_R,
  SIGMA_MAX,
} from './src/lib/navpath'

export async function run(): Promise<number> {
  let failures = 0
  const check = (name: string, ok: boolean, detail = '') => {
    if (ok) {
      console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
    } else {
      failures++
      console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    }
  }

  const sim = buildSimulation(DEFAULT_PARAMS)
  const corridor = buildCorridor(sim)

  console.log(`\nrun: ${sim.frames.length} frames, ${sim.totalLen.toFixed(0)} m, bore ${sim.entry}..${sim.exit} m\n`)

  /* ---- the centreline ---- */
  check('corridor built', corridor.length > 0, `${corridor.length} samples`)
  check(
    'every sample finite',
    corridor.every(
      (c) =>
        Number.isFinite(c.x) &&
        Number.isFinite(c.z) &&
        Number.isFinite(c.yaw) &&
        Number.isFinite(c.sigma) &&
        Number.isFinite(c.navConf),
    ),
  )
  check('u spans 0..1', corridor[0].u === 0 && Math.abs(corridor[corridor.length - 1].u - 1) < 1e-9)
  check('s is monotonic', corridor.every((c, i) => i === 0 || c.s >= corridor[i - 1].s))

  let minGap = Infinity
  let maxGap = 0
  for (let i = 1; i < corridor.length; i++) {
    const d = Math.hypot(corridor[i].x - corridor[i - 1].x, corridor[i].z - corridor[i - 1].z)
    minGap = Math.min(minGap, d)
    maxGap = Math.max(maxGap, d)
  }
  check(
    'spacing roughly even in metres',
    maxGap / minGap < 1.6,
    `${minGap.toFixed(3)}..${maxGap.toFixed(3)} m per sample`,
  )

  /* ---- uncertainty must be driven by the filter, not decoration ---- */
  const tight = sigmaFrom(0.25, 0.95)
  const loose = sigmaFrom(25, 0.1)
  check('sigma grows with covariance', tight < loose, `${tight.toFixed(2)} m vs ${loose.toFixed(2)} m`)
  check('sigma clamped', sigmaFrom(1e6, 0) <= SIGMA_MAX)
  check('sigma never zero', sigmaFrom(0, 1) > 0)

  const sigmas = corridor.map((c) => c.sigma)
  const spread = Math.max(...sigmas) - Math.min(...sigmas)
  check('sigma varies along the run', spread > 0.4, `spread ${spread.toFixed(2)} m`)

  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
  const inside = corridor.filter((c) => c.gnss === 'LOST')
  const outside = corridor.filter((c) => c.gnss === 'LOCKED')
  check(
    'envelope widens under GNSS denial',
    mean(inside.map((c) => c.sigma)) > mean(outside.map((c) => c.sigma)),
    `lost ${mean(inside.map((c) => c.sigma)).toFixed(2)} m vs locked ${mean(outside.map((c) => c.sigma)).toFixed(2)} m`,
  )
  check('denied samples exist to compare', inside.length > 0, `${inside.length} samples`)

  /* ---- gates ---- */
  const stations = ringStations(sim, corridor)
  const last = corridor[corridor.length - 1].s
  check('gates generated', stations.length > 4, `${stations.length}`)
  check(
    'gates monotonic and within the corridor',
    stations.every((s, i) => (i === 0 || s > stations[i - 1]) && s <= last + 1e-6),
  )
  const gaps: number[] = []
  for (let i = 1; i < stations.length; i++) gaps.push(stations[i] - stations[i - 1])
  const gapInside: number[] = []
  const gapOutside: number[] = []
  for (let i = 1; i < stations.length; i++) {
    const mid = (stations[i] + stations[i - 1]) / 2
    ;(mid >= sim.entry && mid <= sim.exit ? gapInside : gapOutside).push(stations[i] - stations[i - 1])
  }
  check(
    'gates are denser inside the bore than outside',
    gapInside.length > 0 && gapOutside.length > 0 && mean(gapInside) < mean(gapOutside),
    `inside ${mean(gapInside).toFixed(1)} m vs outside ${mean(gapOutside).toFixed(1)} m`,
  )

  /* ---- frame to corridor mapping ---- */
  const map = corridorUByFrame(sim, corridor)
  check('map length matches frames', map.length === sim.frames.length)
  check('map monotonic', Array.from(map).every((v, i) => i === 0 || v >= map[i - 1] - 1e-6))
  check('map endpoints', Math.abs(map[0]) < 1e-6 && Math.abs(map[map.length - 1] - 1) < 1e-3)
  let maxJump = 0
  for (let i = 1; i < map.length; i++) maxJump = Math.max(maxJump, Math.abs(map[i] - map[i - 1]))
  check('map has no discontinuity', maxJump < 0.02, `max step ${maxJump.toFixed(4)}`)

  /* ---- waypoints come from real events ---- */
  const nodes = waypoints(sim, corridor)
  const portals = nodes.filter((n) => n.kind === 'portal')
  const slips = nodes.filter((n) => n.kind === 'slip')
  check('both portals marked', portals.length === 2, `${portals.length}`)
  check('portal labels carry real metres', portals.every((p) => /\d+ m/.test(p.detail)))
  check('slip windows marked', slips.length > 0, `${slips.length} window(s), run reports ${sim.metrics.slipEvents}`)
  check(
    'slip markers agree with the run',
    Math.abs(slips.length - sim.metrics.slipEvents) <= 1,
    `markers ${slips.length} vs sim ${sim.metrics.slipEvents}`,
  )
  check('waypoints inside the corridor', nodes.every((n) => n.u >= 0 && n.u <= 1))

  /* ---- the horizon can never run past the recording ---- */
  check('horizon bounded', predictionHorizon(sim, 0, 90) <= 90, `${predictionHorizon(sim, 0, 90).toFixed(1)} m`)
  check('horizon zero at the end', predictionHorizon(sim, sim.frames.length - 1, 90) === 0)
  check('horizon never negative', predictionHorizon(sim, -5, 90) >= 0)

  /* ---- sampling used by the camera and the reticle ---- */
  let sampleOk = true
  for (const u of [0, 0.001, 0.25, 0.5, 0.999, 1, -1, 4]) {
    const c = sampleCorridor(corridor, u)
    if (!Number.isFinite(c.x) || !Number.isFinite(c.sigma)) sampleOk = false
  }
  check('sampleCorridor finite for out-of-range u', sampleOk)
  check(
    'sampleCorridor clamps',
    sampleCorridor(corridor, -1).u === 0 && sampleCorridor(corridor, 9).u === 1,
  )
  check('ringOpacity zero outside the window', ringOpacity(0, 0.5) === 0 && ringOpacity(0.5, 0.5) === 1)

  /* ---- the envelope has to stay inside the bore ---- */
  const widest = Math.max(...sigmas)
  check(
    'envelope fits inside the tunnel',
    widest <= 6.2 - 1,
    `max sigma ${widest.toFixed(2)} m vs bore half-width 6.20 m`,
  )
  check('corridor radius inside the bore', CORRIDOR_R < 6.2, `${CORRIDOR_R} m`)

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\n`)
  return failures === 0 ? 0 : 1
}