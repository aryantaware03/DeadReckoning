// Visual smoothing helpers for the 3D/map navigation views.
//
// The simulation emits frames at 10 Hz. Sampling them with Math.floor() makes
// the bike jump ~1.7 m per step at 60 km/h ( judder that the camera then
// amplifies). These pure functions interpolate between frames and apply
// critically-damped smoothing instead — same data, continuous motion.
// No simulation logic lives here; nothing about the run changes.

import type { SimFrame } from './sim/engine'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export interface SmoothPose {
  x: number
  z: number
  s: number
  t: number
  yaw: number
  v: number
  curve: number
  slip: number
}

/** Shortest-arc angle blend between two headings. */
function blendAngle(a: number, b: number, t: number): number {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

/** Continuously sample the recorded run at a fractional frame position. */
export function samplePose(frames: SimFrame[], pos: number): SmoothPose {
  const n = frames.length
  const c = clamp(pos, 0, Math.max(0, n - 1))
  const i0 = Math.floor(c)
  const i1 = Math.min(n - 1, i0 + 1)
  const t = clamp(c - i0, 0, 1)
  const a = frames[i0]
  const b = frames[i1]
  const lerp = (u: number, v: number) => u + (v - u) * t
  return {
    x: lerp(a.x, b.x),
    z: lerp(a.z, b.z),
    s: lerp(a.s, b.s),
    t: lerp(a.t, b.t),
    yaw: blendAngle(a.yaw, b.yaw, t),
    v: lerp(a.v, b.v),
    curve: lerp(a.curve, b.curve),
    slip: lerp(a.slip, b.slip),
  }
}

/** Frame-rate independent exponential damping. lambda ≈ speed of convergence. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  const k = 1 - Math.exp(-lambda * Math.min(dt, 0.1))
  return current + (target - current) * k
}

/** Angle-aware version of damp (no snapping across ±π). */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  let d = target - current
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  const k = 1 - Math.exp(-lambda * Math.min(dt, 0.1))
  return current + d * k
}
