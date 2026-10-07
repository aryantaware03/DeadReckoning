// Derivations for the navigation corridor.
//
// Everything here is pure: it reads the recorded run from the simulation and
// returns plain arrays. No Three.js, no React, no DOM. The corridor geometry in
// components/NavCorridor.tsx is assembled from these, which keeps the
// derivation testable and keeps the render loop free of per-frame maths.
//
// Every value used here comes from an existing SimFrame field. Nothing is
// invented: `covariance` and `navConf` drive the uncertainty corridor, the
// AI+ESKF estimate drives the centreline, and the portals and slip windows come
// from the run's own events.

import type { GnssStatus, SimResult } from './sim/engine'

/** Visual identity. Matches the figures already used in the readout panel. */
export const NAV = {
  truth: '#7a8b93',
  dr: '#E0604F',
  std: '#C79A3C',
  ai: '#7FD4C1',
  grid: '#5f8f86',
  ring: '#7FD4C1',
  node: '#a9e8dc',
  scan: '#7FD4C1',
  denied: '#E0604F',
} as const

/** Corridor half-width. Kept under TUNNEL.halfWidth so it stays inside the bore. */
export const CORRIDOR_R = 4.2
/** Uncertainty corridor never grows past this, so it cannot punch through the walls. */
export const SIGMA_MAX = 5.1

export interface CorridorSample {
  /** index into the source frames */
  idx: number
  x: number
  z: number
  yaw: number
  /** metres travelled along the run */
  s: number
  /** 0..1 position along the whole corridor */
  u: number
  /** position sigma in metres, from the filter's own covariance */
  sigma: number
  navConf: number
  v: number
  slip: number
  predSlip: number
  gnss: GnssStatus
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Convert the filter's covariance proxy into a metres sigma.
 *
 * `covariance` is a mean squared position error, so its square root is the
 * standard deviation. `navConf` then widens the envelope a little when the
 * filter is less sure of itself than its own covariance suggests, which keeps
 * the corridor honest without inventing a second uncertainty model.
 */
export function sigmaFrom(covariance: number, navConf: number): number {
  const base = Math.sqrt(Math.max(0, covariance))
  const widened = base * (1 + 0.85 * (1 - clamp(navConf, 0, 1)))
  return clamp(widened, 0.3, SIGMA_MAX)
}

/**
 * Resample the AI+ESKF estimate into an evenly spaced corridor.
 *
 * The estimate is the corridor's centreline rather than ground truth: the
 * corridor is meant to show where the system *believes* it is, with truth only
 * appearing as one more trajectory among the others.
 */
export function buildCorridor(sim: SimResult, count = 640): CorridorSample[] {
  const frames = sim.frames
  const n = frames.length
  if (n === 0) return []

  // Cumulative arc length along the estimate, so spacing is even in metres
  // rather than even in frames — the bike's speed varies.
  const arc: number[] = new Array(n)
  arc[0] = 0
  for (let i = 1; i < n; i++) {
    arc[i] = arc[i - 1] + Math.hypot(frames[i].aiX - frames[i - 1].aiX, frames[i].aiZ - frames[i - 1].aiZ)
  }
  const total = arc[n - 1] || 1

  const out: CorridorSample[] = []
  let cursor = 0
  for (let k = 0; k < count; k++) {
    const target = (k / (count - 1)) * total
    while (cursor < n - 2 && arc[cursor + 1] < target) cursor++
    const span = arc[cursor + 1] - arc[cursor]
    const t = span > 1e-6 ? (target - arc[cursor]) / span : 0
    const a = frames[cursor]
    const b = frames[cursor + 1]

    out.push({
      idx: cursor,
      x: lerp(a.aiX, b.aiX, t),
      z: lerp(a.aiZ, b.aiZ, t),
      yaw: blendAngle(a.aiYaw, b.aiYaw, t),
      s: lerp(a.s, b.s, t),
      u: k / (count - 1),
      sigma: sigmaFrom(lerp(a.covariance, b.covariance, t), lerp(a.navConf, b.navConf, t)),
      navConf: lerp(a.navConf, b.navConf, t),
      v: lerp(a.v, b.v, t),
      slip: lerp(a.slip, b.slip, t),
      predSlip: lerp(a.predSlip, b.predSlip, t),
      gnss: a.gnss,
    })
  }
  return out
}

/** Local frame at a corridor sample: forward and right unit vectors. */
export function basisAt(s: CorridorSample): { fx: number; fz: number; rx: number; rz: number } {
  const fx = Math.sin(s.yaw)
  const fz = Math.cos(s.yaw)
  return { fx, fz, rx: fz, rz: -fx }
}

/**
 * Stations for the navigation rings, in metres of estimated displacement.
 *
 * Spacing tightens inside the bore and loosens on the approach, because that is
 * where the reader's attention is and where the ring spacing actually has to
 * resolve. Derived from the run's own portal positions rather than fixed.
 */
export function ringStations(sim: SimResult, corridor: CorridorSample[]): number[] {
  const stations: number[] = []
  const total = corridor[corridor.length - 1]?.s ?? 0
  const near = Math.min(6, total / 10)
  const far = Math.max(near * 2, total / 5)

  let s = 0
  while (s <= total) {
    const inside = s >= sim.entry && s <= sim.exit
    // Tighter gates underground, where the estimate is actually being judged.
    stations.push(s)
    s += inside ? near : far
  }
  return stations
}

export interface Waypoint {
  /** 0..1 along the corridor */
  u: number
  s: number
  label: string
  detail: string
  kind: 'portal' | 'slip' | 'gps'
}

/**
 * Real stations worth marking: the two portals, every wheel-slip window the run
 * detected, and the point where GNSS actually went away.
 */
export function waypoints(sim: SimResult, corridor: CorridorSample[]): Waypoint[] {
  if (corridor.length === 0) return []
  const frames = sim.frames
  const nearest = (s: number) => {
    let best = corridor[0]
    let bd = Infinity
    for (const c of corridor) {
      const d = Math.abs(c.s - s)
      if (d < bd) {
        bd = d
        best = c
      }
    }
    return best
  }

  const out: Waypoint[] = []

  const push = (s: number, label: string, detail: string, kind: Waypoint['kind']) => {
    const c = nearest(s)
    if (out.some((w) => w.kind === kind && Math.abs(w.u - c.u) < 0.012)) return
    out.push({ u: c.u, s: c.s, label, detail, kind })
  }

  push(sim.entry, 'PORTAL', `GNSS denied · ${Math.round(sim.entry)} m`, 'portal')
  push(sim.exit, 'PORTAL', `fix reacquired · ${Math.round(sim.exit)} m`, 'portal')

  // Contiguous slip windows, one marker each, labelled with the peak slip.
  let runStart = -1
  let runPeak = 0
  for (let i = 0; i < frames.length; i++) {
    const slipping = frames[i].slip > 0.008
    if (slipping && runStart === -1) {
      runStart = i
      runPeak = frames[i].slip
    } else if (slipping) {
      runPeak = Math.max(runPeak, frames[i].slip)
    } else if (runStart !== -1) {
      push(frames[runStart].s, 'SLIP', `peak ${(runPeak * 100).toFixed(1)}% · model flagged ${(frames[runStart].predSlip * 100).toFixed(0)}%`, 'slip')
      runStart = -1
      runPeak = 0
    }
  }
  if (runStart !== -1) {
    push(frames[runStart].s, 'SLIP', `peak ${(runPeak * 100).toFixed(1)}%`, 'slip')
  }

  return out
}

/**
 * Map every source frame index onto the corridor's own 0..1 parameterisation.
 *
 * The corridor is spaced evenly by arc length, but frames are spaced evenly by
 * time, and the bike's speed varies. Without this lookup the rings would slide
 * against the road as the viewer moves. Returns a Float32Array of length
 * `sim.frames.length` holding the corridor u for each frame.
 */
export function corridorUByFrame(sim: SimResult, corridor: CorridorSample[]): Float32Array {
  const n = sim.frames.length
  const map = new Float32Array(Math.max(1, n))
  if (corridor.length === 0) return map

  let cursor = 0
  for (let i = 0; i < n; i++) {
    while (cursor < corridor.length - 2 && corridor[cursor].idx < i) cursor++
    // Linear blend between the two bracketing samples so the mapping is smooth
    // rather than a staircase.
    const a = corridor[cursor]
    const b = corridor[Math.min(corridor.length - 1, cursor + 1)]
    const span = b.idx - a.idx
    const t = span > 1e-6 ? Math.min(1, Math.max(0, (i - a.idx) / span)) : 0
    map[i] = a.u + (b.u - a.u) * t
  }
  return map
}

/**
 * How far ahead of the current position the corridor still shows predicted
 * path, in metres. Bounded by the run's own length so it can never run off the
 * end of the recorded data.
 */
export function predictionHorizon(sim: SimResult, idx: number, metres = 90): number {
  const frames = sim.frames
  const here = frames[clamp(idx | 0, 0, frames.length - 1)]
  const last = frames[frames.length - 1]
  return clamp(last.s - here.s, 0, Math.min(metres, 120))
}

/** One frame's worth of the corridor, interpolated. Used by markers and camera. */
export function sampleCorridor(corridor: CorridorSample[], u: number): CorridorSample {
  const n = corridor.length
  if (n === 0) throw new Error('sampleCorridor needs at least one sample')
  const c = clamp(u, 0, 1) * (n - 1)
  const i0 = Math.floor(c)
  const i1 = Math.min(n - 1, i0 + 1)
  const t = c - i0
  const a = corridor[i0]
  const b = corridor[i1]
  return {
    idx: lerp(a.idx, b.idx, t),
    x: lerp(a.x, b.x, t),
    z: lerp(a.z, b.z, t),
    yaw: blendAngle(a.yaw, b.yaw, t),
    s: lerp(a.s, b.s, t),
    u: c / (n - 1),
    sigma: lerp(a.sigma, b.sigma, t),
    navConf: lerp(a.navConf, b.navConf, t),
    v: lerp(a.v, b.v, t),
    slip: lerp(a.slip, b.slip, t),
    predSlip: lerp(a.predSlip, b.predSlip, t),
    gnss: a.gnss,
  }
}

/**
 * Ring opacity for a station, from its distance ahead of the viewer.
 * Returns 0 well outside the window so rings never pop in at the far clip.
 */
export function ringOpacity(uStation: number, uNow: number, behind = 0.06, ahead = 0.075): number {
  const d = uStation - uNow
  if (d < -behind || d > ahead) return 0
  if (d >= 0) return 1 - d / ahead
  return 1 + d / behind
}

/**
 * Brightness for a trajectory station, split into travelled and ahead-of-time.
 *
 * The brief asks for the two states to be distinguishable without inventing a
 * second path: everything behind the viewer is history and reads subdued, and
 * everything ahead is the model's forward estimate and reads brighter. Because
 * the run is a recording, "ahead" is the AI filter's own recorded output for
 * those frames, not an extrapolation.
 */
export function liveSplit(uStation: number, uNow: number, behind = 0.2, ahead = 0.09) {
  const d = uStation - uNow
  const fade = ringOpacity(uStation, uNow, behind, ahead)
  return {
    fade,
    predicted: d > 0,
    /** 0 at the viewer, ramping to 1 a little way ahead. */
    horizon: Math.min(1, Math.max(0, d / Math.max(1e-6, ahead))),
  }
}

/** Grid line alpha, fading harder than rings so it reads as a floor, not a cage. */
export function gridOpacity(uLine: number, uNow: number, behind = 0.035, ahead = 0.09): number {
  const d = uLine - uNow
  if (d < -behind || d > ahead) return 0
  if (d >= 0) return (1 - d / ahead) * 0.85
  return (1 + d / behind) * 0.4
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function blendAngle(a: number, b: number, t: number): number {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}