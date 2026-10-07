// The thirty-second run.
//
// One deterministic simulation, played in real time. The scenario is short by
// design: 60 s of open road, a 400 m tunnel, and 60 s of open road again, at
// 60 km/h. That is 52 seconds of physics, held to a 30-second script by
// running the clock 1.73× faster than the bike — the algorithms never see it.

import { useEffect, useMemo, useRef, useState } from 'react'
import { buildSimulation, type ScenarioParams, type SimResult } from './lib/sim/engine'

/** Wall-clock length of the prototype, in seconds. */
export const SCRIPT_SECONDS = 30

/** Short by intent: a bore you can hold in your head, not a 3 km motorway. */
export const SCENARIO: ScenarioParams = {
  scenario: 'curved',
  bikeSpeedKmh: 62,
  tunnelLengthM: 400,
  curvature: 0.9,
  imuNoise: 1,
  gyroBiasDegS: 0.55,
  accelBiasMss: 0.06,
  slipProbability: 0.3,
  gpsNoiseM: 1.2,
  seed: 7,
  slipInjectAtM: 300,
  approachM: 110,
  exitRunM: 90,
  forceGpsOutage: false,
  imuBiasBoost: 0,
  extraNoise: 0,
}

export interface Run {
  sim: SimResult
  /** fractional frame index, read by the 3D every frame */
  idxRef: { current: number }
  /** 0..1 through the script, read by the camera */
  progressRef: { current: number }
  /** throttled copy for React-rendered readouts */
  ui: number
  playing: boolean
  /** the run has played through once and stopped */
  done: boolean
  play: () => void
  pause: () => void
  toggle: () => void
  seek: (f: number) => void
  replay: () => void
}

export function useRun(): Run {
  const sim = useMemo(() => buildSimulation(SCENARIO), [])
  const n = sim.frames.length
  const idxRef = useRef(0)
  const progressRef = useRef(0)
  // seconds of the 30-second script already played
  const elapsed = useRef(0)
  const [ui, setUi] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let lastUi = 0
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      // rAF hands back the frame's start timestamp, which can predate the
      // performance.now() taken above — so clamp both ends, never negative.
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000))
      last = now
      if (playing && !done) {
        elapsed.current = Math.min(SCRIPT_SECONDS, elapsed.current + dt)
        if (elapsed.current >= SCRIPT_SECONDS) {
          setDone(true)
          setPlaying(false)
        }
      }
      const t = elapsed.current / SCRIPT_SECONDS
      progressRef.current = t
      idxRef.current = t * (n - 1)
      if (now - lastUi > 80) {
        lastUi = now
        setUi(Math.floor(idxRef.current))
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [n, playing, done])

  const seek = (f: number) => {
    const c = Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0
    elapsed.current = c * SCRIPT_SECONDS
    progressRef.current = c
    idxRef.current = c * (n - 1)
    setUi(Math.floor(idxRef.current))
    if (c < 1) setDone(false)
  }

  const replay = () => {
    seek(0)
    setDone(false)
    setPlaying(true)
  }

  const last = Math.max(0, Math.min(n - 1, ui))

  return {
    sim,
    idxRef,
    progressRef,
    ui: last,
    playing,
    done,
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    toggle: () => setPlaying((p) => !p),
    seek,
    replay,
  }
}

/** A readable stage name for wherever the bike is, from the sim's own state. */
export function stageOf(sim: SimResult, s: number, gnss: string): string {
  if (s < sim.entry - 55) return 'Approach — satellites locked'
  if (gnss === 'DEGRADED' || s < sim.entry) return 'Portal — geometry degrading'
  if (s < sim.entry + 40) return 'Inside — GNSS denied, uncorrected DR walking off'
  if (s < sim.exit - 90) return 'Inside — Bi-LSTM estimating bias and slip'
  if (s < sim.exit) return 'Inside — adaptive ESKF holding the line'
  if (s < sim.exit + 45) return 'Exit — satellites returning'
  return 'Clear — re-synchronised'
}
