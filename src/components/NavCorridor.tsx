// The navigation corridor.
//
// A data-driven spatial layer drawn around the AI+ESKF estimate: an uncertainty
// envelope, the three estimator trajectories, navigation rings, a floor grid,
// waypoints, a heading vector, a scan band and drifting dust.
//
// PERFORMANCE MODEL
// The run is a recording, so the corridor never changes shape â€” only the
// viewer's position along it does. Every mesh is therefore built once and
// animated by writing ONE uniform per frame (`uNow`, the viewer's normalised
// position along the corridor). Nothing is allocated, rebuilt or re-rendered by
// React while the run plays. A single ref carries `uNow` down to every layer.
//
// WHERE THE DATA COMES FROM
// The centreline is the AI+ESKF estimate (aiX / aiZ / aiYaw), not ground truth:
// the corridor shows where the system believes it is, with truth appearing as
// one more trajectory among the others. The envelope width is the filter's own
// covariance widened by navConf. Rings sit at real metres of estimated
// displacement. Waypoints are the run's real portals and slip windows. No
// value here is invented.

import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { SimResult } from '../lib/sim/engine'
import { damp, dampAngle } from '../lib/smooth'
import {
  NAV,
  CORRIDOR_R,
  buildCorridor,
  basisAt,
  corridorUByFrame,
  ringStations,
  sampleCorridor,
  waypoints,
  type CorridorSample,
  type Waypoint,
} from '../lib/navpath'
import {
  STATION_VERT,
  TRAJECTORY_FRAG,
  LINE_FRAG,
  ENVELOPE_VERT,
  ENVELOPE_FRAG,
  RING_VERT,
  RING_FRAG,
  NODE_VERT,
  NODE_FRAG,
  DUST_VERT,
  DUST_FRAG,
} from '../lib/navshaders'

interface Props {
  sim: SimResult
  idxRef: MutableRefObject<number>
}

/** Corridor surface height above the road. */
const Y = 0.06

/** Viewer position along the corridor, shared by every layer. */
type Now = MutableRefObject<number>

// ---------------------------------------------------------------------------
// Shaders live in ../lib/navshaders so they can be compiled in isolation by
// check-shaders.mjs. A GLSL typo passes tsc and vite build untouched.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** A ribbon of the given half-width following the corridor. */
function ribbonGeometry(corridor: CorridorSample[], width: (c: CorridorSample) => number, y: number) {
  const n = corridor.length
  const pos: number[] = []
  const station: number[] = []
  const idx: number[] = []

  for (let i = 0; i < n; i++) {
    const c = corridor[i]
    const b = basisAt(c)
    const w = width(c)
    pos.push(c.x - b.rx * w, y, c.z - b.rz * w)
    pos.push(c.x + b.rx * w, y, c.z + b.rz * w)
    station.push(c.u, c.u)
    if (i < n - 1) {
      const a0 = i * 2
      idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2)
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aStation', new THREE.Float32BufferAttribute(station, 1))
  g.setIndex(idx)
  return g
}

/** A corridor line (open strip, rendered as segments) at a lateral offset. */
function offsetLine(corridor: CorridorSample[], offset: (c: CorridorSample) => number, y: number) {
  const n = corridor.length
  const pos: number[] = []
  const station: number[] = []
  const idx: number[] = []

  for (let i = 0; i < n; i++) {
    const c = corridor[i]
    const b = basisAt(c)
    const o = offset(c)
    pos.push(c.x + b.rx * o, y, c.z + b.rz * o)
    station.push(c.u)
    if (i < n - 1) idx.push(i, i + 1)
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aStation', new THREE.Float32BufferAttribute(station, 1))
  g.setIndex(idx)
  return g
}

interface Layer {
  geo: THREE.BufferGeometry
  mat: THREE.ShaderMaterial
}

/** Build a shader layer and dispose it when it is replaced. */
function useLayer(build: () => Layer, deps: unknown[]): Layer {
  // `build` is intentionally left out of the dependency list: callers pass
  // hoisted width/offset functions, and listing the inline closure would make
  // every layer rebuild on each render. The explicit deps are the real inputs.
  const layer = useMemo(build, deps)
  useEffect(
    () => () => {
      layer.geo.dispose()
      layer.mat.dispose()
    },
    [layer],
  )
  return layer
}

/**
 * Write the shared viewer position into a material once per frame.
 * Named as a hook because it registers a frame callback.
 */
function useTrack(
  mat: THREE.ShaderMaterial,
  now: Now,
  extra?: (u: Record<string, THREE.IUniform>, dt: number) => void,
) {
  useFrame((_, dt) => {
    const u = mat.uniforms as unknown as Record<string, THREE.IUniform>
    if (u.uNow) (u.uNow.value as number) = now.current
    extra?.(u, dt)
  })
}

// Widths are hoisted so they are stable identities and the layer memos do not
// rebuild on every render.
const wTruth = () => 0.05
const wDr = () => 0.11
const wStd = () => 0.09
const wAi = () => 0.13
const oWallL = (c: CorridorSample) => -c.sigma
const oWallR = (c: CorridorSample) => c.sigma

// ---------------------------------------------------------------------------
// Trajectories
// ---------------------------------------------------------------------------

/**
 * The three estimators plus ground truth, as ribbons.
 *
 * They are separated by a few centimetres of height and by colour rather than
 * by lateral offset, because a lateral offset would misrepresent their actual
 * positions â€” the whole point is that they genuinely diverge.
 */
function Trajectories({ corridor, now }: { corridor: CorridorSample[]; now: Now }) {
  const truth = useLayer(
    () => ({
      geo: ribbonGeometry(corridor, wTruth, Y + 0.12),
      mat: new THREE.ShaderMaterial({
        vertexShader: STATION_VERT,
        fragmentShader: TRAJECTORY_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // The corridor is an instrument projected into the world, so it draws
        // over the rock rather than being buried in it. Underground the estimate
        // genuinely drifts a metre or two off the bore, and with depth testing
        // on, the walls swallowed the whole layer.
        depthTest: false,
        side: THREE.DoubleSide,
        uniforms: {
          uColor: { value: new THREE.Color(NAV.truth) },
          uOpacity: { value: 0.34 },
          uDashPhase: { value: 0 },
          uNow: { value: 0 },
          uBehind: { value: 0.3 },
          uAhead: { value: 0.1 },
        },
      }),
    }),
    [corridor],
  )

  const dr = useLayer(
    () => ({
      geo: ribbonGeometry(corridor, wDr, Y + 0.09),
      mat: new THREE.ShaderMaterial({
        vertexShader: STATION_VERT,
        fragmentShader: TRAJECTORY_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // The corridor is an instrument projected into the world, so it draws
        // over the rock rather than being buried in it. Underground the estimate
        // genuinely drifts a metre or two off the bore, and with depth testing
        // on, the walls swallowed the whole layer.
        depthTest: false,
        side: THREE.DoubleSide,
        uniforms: {
          uColor: { value: new THREE.Color(NAV.dr) },
          uOpacity: { value: 0.9 },
          uDashPhase: { value: 0 },
          uNow: { value: 0 },
          uBehind: { value: 0.26 },
          uAhead: { value: 0.1 },
        },
      }),
    }),
    [corridor],
  )

  const std = useLayer(
    () => ({
      geo: ribbonGeometry(corridor, wStd, Y + 0.11),
      mat: new THREE.ShaderMaterial({
        vertexShader: STATION_VERT,
        fragmentShader: TRAJECTORY_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // The corridor is an instrument projected into the world, so it draws
        // over the rock rather than being buried in it. Underground the estimate
        // genuinely drifts a metre or two off the bore, and with depth testing
        // on, the walls swallowed the whole layer.
        depthTest: false,
        side: THREE.DoubleSide,
        uniforms: {
          uColor: { value: new THREE.Color(NAV.std) },
          uOpacity: { value: 0.75 },
          uDashPhase: { value: 0 },
          uNow: { value: 0 },
          uBehind: { value: 0.26 },
          uAhead: { value: 0.1 },
        },
      }),
    }),
    [corridor],
  )

  const ai = useLayer(
    () => ({
      geo: ribbonGeometry(corridor, wAi, Y + 0.14),
      mat: new THREE.ShaderMaterial({
        vertexShader: STATION_VERT,
        fragmentShader: TRAJECTORY_FRAG,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // The corridor is an instrument projected into the world, so it draws
        // over the rock rather than being buried in it. Underground the estimate
        // genuinely drifts a metre or two off the bore, and with depth testing
        // on, the walls swallowed the whole layer.
        depthTest: false,
        side: THREE.DoubleSide,
        uniforms: {
          uColor: { value: new THREE.Color(NAV.ai) },
          uOpacity: { value: 1 },
          uDashPhase: { value: 0 },
          uNow: { value: 0 },
          uBehind: { value: 0.3 },
          uAhead: { value: 0.12 },
        },
      }),
    }),
    [corridor],
  )

  // Only the AI trajectory marches its dashes; the others are history markers.
  useTrack(ai.mat, now, (u, dt) => {
    const p = u.uDashPhase
    p.value = ((p.value as number) + dt * 0.35) % 1000
  })
  useTrack(truth.mat, now)
  useTrack(dr.mat, now)
  useTrack(std.mat, now)

  return (
    <group>
      <mesh geometry={truth.geo} material={truth.mat} renderOrder={3} frustumCulled={false} />
      <mesh geometry={dr.geo} material={dr.mat} renderOrder={4} frustumCulled={false} />
      <mesh geometry={std.geo} material={std.mat} renderOrder={4} frustumCulled={false} />
      <mesh geometry={ai.geo} material={ai.mat} renderOrder={5} frustumCulled={false} />
    </group>
  )
}

// ---------------------------------------------------------------------------
// Uncertainty envelope
// ---------------------------------------------------------------------------

/**
 * The drift, drawn as a corridor. Half-width is the filter's own position sigma
 * at that station, so the two walls close together where the filter is certain
 * and open out where it is guessing â€” which is the clearest single picture of
 * what dead reckoning under GNSS denial actually does.
 */
function UncertaintyEnvelope({ corridor, now }: { corridor: CorridorSample[]; now: Now }) {
  const fill = useLayer(() => {
    const n = corridor.length
    const pos: number[] = []
    const station: number[] = []
    const sigma: number[] = []
    const idx: number[] = []

    for (let i = 0; i < n; i++) {
      const c = corridor[i]
      const b = basisAt(c)
      pos.push(c.x - b.rx * c.sigma, Y + 0.02, c.z - b.rz * c.sigma)
      pos.push(c.x + b.rx * c.sigma, Y + 0.02, c.z + b.rz * c.sigma)
      station.push(c.u, c.u)
      sigma.push(c.sigma, c.sigma)
      if (i < n - 1) {
        const a0 = i * 2
        idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2)
      }
    }

    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('aStation', new THREE.Float32BufferAttribute(station, 1))
    g.setAttribute('aSigma', new THREE.Float32BufferAttribute(sigma, 1))
    g.setIndex(idx)

    const m = new THREE.ShaderMaterial({
      vertexShader: ENVELOPE_VERT,
      fragmentShader: ENVELOPE_FRAG,
      transparent: true,
      depthWrite: false,
        // The corridor is an instrument projected into the world, so it draws
        // over the rock rather than being buried in it. Underground the estimate
        // genuinely drifts a metre or two off the bore, and with depth testing
        // on, the walls swallowed the whole layer.
        depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTight: { value: new THREE.Color(NAV.ai) },
        uLoose: { value: new THREE.Color(NAV.dr) },
        uNow: { value: 0 },
        uBehind: { value: 0.14 },
        uAhead: { value: 0.08 },
      },
    })
    return { geo: g, mat: m }
  }, [corridor])

  // Thin walls on the envelope edges, so the width stays legible where the fill
  // is nearly transparent.
  const walls = useLayer(() => {
    const left = offsetLine(corridor, oWallL, Y + 0.035)
    const right = offsetLine(corridor, oWallR, Y + 0.035)

    const pos = [
      ...(left.getAttribute('position').array as Float32Array),
      ...(right.getAttribute('position').array as Float32Array),
    ]
    const stations = [
      ...(left.getAttribute('aStation').array as Float32Array),
      ...(right.getAttribute('aStation').array as Float32Array),
    ]
    left.dispose()
    right.dispose()

    const half = corridor.length
    const idx: number[] = []
    for (let i = 0; i < half - 1; i++) idx.push(i, i + 1, half + i, half + i + 1)

    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('aStation', new THREE.Float32BufferAttribute(stations, 1))
    g.setIndex(idx)

    const m = new THREE.ShaderMaterial({
      vertexShader: STATION_VERT,
      fragmentShader: LINE_FRAG,
      transparent: true,
      depthWrite: false,
        // The corridor is an instrument projected into the world, so it draws
        // over the rock rather than being buried in it. Underground the estimate
        // genuinely drifts a metre or two off the bore, and with depth testing
        // on, the walls swallowed the whole layer.
        depthTest: false,
      uniforms: {
        uColor: { value: new THREE.Color(NAV.ai) },
        uOpacity: { value: 0.42 },
        uNow: { value: 0 },
        uBehind: { value: 0.14 },
        uAhead: { value: 0.08 },
      },
    })
    return { geo: g, mat: m }
  }, [corridor])

  useTrack(fill.mat, now)
  useTrack(walls.mat, now)

  return (
    <group>
      <mesh geometry={fill.geo} material={fill.mat} renderOrder={1} frustumCulled={false} />
      <lineSegments geometry={walls.geo} material={walls.mat} renderOrder={2} frustumCulled={false} />
    </group>
  )
}

// ---------------------------------------------------------------------------
// Rings
// ---------------------------------------------------------------------------

/**
 * Distance gates, placed at real metres of estimated displacement and spaced
 * more tightly inside the bore, where the estimate is actually being judged.
 * All of them live in one buffer, so the whole layer is a single draw call.
 */
function Rings({ sim, corridor, now }: { sim: SimResult; corridor: CorridorSample[]; now: Now }) {
  const layer = useLayer(() => {
    const stations = ringStations(sim, corridor)
    const pos: number[] = []
    const station: number[] = []
    const major: number[] = []
    const idx: number[] = []

    for (const s of stations) {
      const c = nearestByS(corridor, s)
      const b = basisAt(c)
      // Every fifth gate is heavier and taller, which is what makes the
      // distance countable rather than decorative.
      const isMajor = Math.round(s / 10) % 5 === 0
      const r = CORRIDOR_R + (isMajor ? 0.5 : 0.26)
      const h = isMajor ? 4.4 : 2.4
      const base = pos.length / 3
      const kind = isMajor ? 1 : 0

      // A rectangular gate, not a hoop: four legs and a top bar reads as
      // surveyed structure rather than sci-fi decoration.
      const corners: [number, number][] = [
        [-r, 0],
        [-r, h],
        [r, h],
        [r, 0],
      ]
      for (const [lx, ly] of corners) {
        pos.push(c.x + b.rx * lx, Y + ly, c.z + b.rz * lx)
        station.push(c.u)
        major.push(kind)
      }
      idx.push(base, base + 1, base + 1, base + 2, base + 2, base + 3)

      // Centre tick on the lintel, so the gate also marks the road centreline.
      pos.push(c.x, Y + h, c.z)
      station.push(c.u)
      major.push(kind)
      idx.push(base + 1, base + 4, base + 4, base + 2)
    }

    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('aStation', new THREE.Float32BufferAttribute(station, 1))
    g.setAttribute('aMajor', new THREE.Float32BufferAttribute(major, 1))
    g.setIndex(idx)

    const m = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      // Additive: the bore is lit at almost nothing, so the gates have to carry
      // their own light or they vanish into the black.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
        // The corridor is an instrument projected into the world, so it draws
        // over the rock rather than being buried in it. Underground the estimate
        // genuinely drifts a metre or two off the bore, and with depth testing
        // on, the walls swallowed the whole layer.
        depthTest: false,
      uniforms: {
        uColor: { value: new THREE.Color(NAV.ring) },
        uAccent: { value: new THREE.Color('#cfe9ff') },
        uNow: { value: 0 },
        uBehind: { value: 0.02 },
        uAhead: { value: 0.06 },
      },
    })
    return { geo: g, mat: m }
  }, [sim, corridor])

  useTrack(layer.mat, now)

  return <lineSegments geometry={layer.geo} material={layer.mat} renderOrder={3} frustumCulled={false} />
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

/**
 * A faint floor grid plus five longitudinal guide lines. Between them these are
 * what make the corridor read as a volume with a floor and a vanishing point,
 * rather than a set of floating rings.
 */
function FloorGrid({ corridor, now }: { corridor: CorridorSample[]; now: Now }) {
  const layer = useLayer(() => {
    const pos: number[] = []
    const station: number[] = []
    const idx: number[] = []
    const HALF = 3.9

    for (const frac of [-1, -0.5, 0, 0.5, 1]) {
      const off = frac * HALF
      const base = pos.length / 3
      for (let i = 0; i < corridor.length; i++) {
        const c = corridor[i]
        const b = basisAt(c)
        pos.push(c.x + b.rx * off, Y + 0.008, c.z + b.rz * off)
        station.push(c.u)
      }
      for (let i = 0; i < corridor.length - 1; i++) idx.push(base + i, base + i + 1)
    }

    // Transverse rungs every few metres of displacement.
    let run = 1e9
    let base = pos.length / 3
    for (let i = 1; i < corridor.length; i++) {
      run += Math.abs(corridor[i].s - corridor[i - 1].s)
      if (run < 5) continue
      run = 0
      const c = corridor[i]
      const b = basisAt(c)
      for (const frac of [-1, -0.5, 0.5, 1]) {
        pos.push(c.x + b.rx * frac * HALF, Y + 0.008, c.z + b.rz * frac * HALF)
      }
      for (let k = 0; k < 4; k++) station.push(c.u)
      idx.push(base, base + 1, base + 1, base + 2, base + 2, base + 3)
      base += 4
    }

    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('aStation', new THREE.Float32BufferAttribute(station, 1))
    g.setIndex(idx)

    const m = new THREE.ShaderMaterial({
      vertexShader: STATION_VERT,
      fragmentShader: LINE_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
        // The corridor is an instrument projected into the world, so it draws
        // over the rock rather than being buried in it. Underground the estimate
        // genuinely drifts a metre or two off the bore, and with depth testing
        // on, the walls swallowed the whole layer.
        depthTest: false,
      uniforms: {
        uColor: { value: new THREE.Color(NAV.grid) },
        uOpacity: { value: 0.34 },
        uNow: { value: 0 },
        uBehind: { value: 0.035 },
        uAhead: { value: 0.085 },
      },
    })
    return { geo: g, mat: m }
  }, [corridor])

  useTrack(layer.mat, now)

  return <lineSegments geometry={layer.geo} material={layer.mat} renderOrder={0} frustumCulled={false} />
}

// ---------------------------------------------------------------------------
// Waypoints
// ---------------------------------------------------------------------------

/**
 * A small number of glowing stations: the two portals and each wheel-slip
 * window the run actually detected. Kept sparse deliberately â€” a corridor
 * covered in dots reads as a particle effect, three surveyed stations read as
 * navigation.
 */
function Waypoints({ corridor, nodes, now }: { corridor: CorridorSample[]; nodes: Waypoint[]; now: Now }) {
  const layer = useLayer(() => {
    const pos: number[] = []
    const station: number[] = []
    const kind: number[] = []
    const idx: number[] = []
    const SEG = 12

    for (const w of nodes) {
      const c = corridor[Math.round(w.u * (corridor.length - 1))]
      const kindId = w.kind === 'portal' ? 1 : 2
      // Slip windows carry more information than a portal, so they read larger.
      const size = w.kind === 'slip' ? 0.9 : 0.62
      const top = w.kind === 'slip' ? 3.4 : 2.9
      const base = pos.length / 3

      // A post rather than a floating ball: it stands on the road like a
      // surveyed station, and its head sits at eye level.
      pos.push(c.x, Y, c.z)
      station.push(w.u)
      kind.push(kindId)
      pos.push(c.x, Y + top, c.z)
      station.push(w.u)
      kind.push(kindId)
      idx.push(base, base + 1)

      for (let k = 0; k <= SEG; k++) {
        const a = (k / SEG) * Math.PI * 2
        pos.push(c.x + Math.cos(a) * size, Y + top + size * 1.4, c.z + Math.sin(a) * size)
        station.push(w.u)
        kind.push(kindId)
        if (k > 0) idx.push(base + 1 + k - 1, base + 1 + k)
      }
    }

    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('aStation', new THREE.Float32BufferAttribute(station, 1))
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1))
    g.setIndex(idx)

    const m = new THREE.ShaderMaterial({
      vertexShader: NODE_VERT,
      fragmentShader: NODE_FRAG,
      transparent: true,
      depthWrite: false,
        // The corridor is an instrument projected into the world, so it draws
        // over the rock rather than being buried in it. Underground the estimate
        // genuinely drifts a metre or two off the bore, and with depth testing
        // on, the walls swallowed the whole layer.
        depthTest: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPortal: { value: new THREE.Color(NAV.node) },
        uSlip: { value: new THREE.Color('#e8a33d') },
        uTime: { value: 0 },
        uNow: { value: 0 },
        uBehind: { value: 0.03 },
        uAhead: { value: 0.05 },
      },
    })
    return { geo: g, mat: m }
  }, [corridor, nodes])

  useTrack(layer.mat, now, (u, dt) => {
    const t = u.uTime
    t.value = (t.value as number) + dt
  })

  return <lineSegments geometry={layer.geo} material={layer.mat} renderOrder={4} frustumCulled={false} />
}

// ---------------------------------------------------------------------------
// Scan band
// ---------------------------------------------------------------------------

/**
 * One faint plane sweeping forward. It carries no data, so it stays subtle â€” it
 * is here to give the eye a moving reference for depth.
 */
function ScanBand({ corridor, now }: { corridor: CorridorSample[]; now: Now }) {
  const ref = useRef<THREE.Mesh>(null!)
  const mat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(NAV.scan),
        transparent: true,
        opacity: 0.09,
        depthWrite: false,
        // The corridor is an instrument projected into the world, so it draws
        // over the rock rather than being buried in it. Underground the estimate
        // genuinely drifts a metre or two off the bore, and with depth testing
        // on, the walls swallowed the whole layer.
        depthTest: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    [],
  )
  useEffect(() => () => mat.dispose(), [mat])

  useFrame(() => {
    const u = Math.min(0.999, now.current + 0.03)
    const c = sampleCorridor(corridor, u)
    ref.current.position.set(c.x, Y + 1.9, c.z)
    ref.current.rotation.set(0, c.yaw, 0)
    // Fade with distance from the viewer so the wrap is never visible.
    mat.opacity = 0.09 * (1 - Math.max(0, 0.03 - (u - now.current)) * 20)
  })

  return (
    <mesh ref={ref} material={mat} renderOrder={2} frustumCulled={false}>
      <planeGeometry args={[CORRIDOR_R * 2.3, 5.2]} />
    </mesh>
  )
}

// ---------------------------------------------------------------------------
// Dust
// ---------------------------------------------------------------------------

/**
 * A fixed cloud that gives the corridor air. Positions are derived from the
 * corridor's own geometry with a golden-ratio stride, so they are
 * deterministic and nothing is allocated per frame. The motes never move; the
 * camera's motion parallaxes them, which is both cheaper and more convincing
 * than animating them.
 */
function Dust({ corridor, now }: { corridor: CorridorSample[]; now: Now }) {
  const COUNT = 340
  const layer = useLayer(() => {
    const pos: number[] = []
    const station: number[] = []

    for (let i = 0; i < COUNT; i++) {
      const u = (i * 0.6180339887) % 1
      const c = corridor[Math.floor(u * (corridor.length - 1))]
      const b = basisAt(c)
      // Bias outwards so the middle of the corridor stays readable.
      const side = i % 2 === 0 ? 1 : -1
      const lateral = side * (1.2 + ((i * 37) % 100) / 100 * (CORRIDOR_R - 1.2))
      const height = 0.25 + ((i * 53) % 100) / 100 * 3.4
      pos.push(c.x + b.rx * lateral, Y + height, c.z + b.rz * lateral)
      station.push(u)
    }

    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('aStation', new THREE.Float32BufferAttribute(station, 1))

    const m = new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
        // The corridor is an instrument projected into the world, so it draws
        // over the rock rather than being buried in it. Underground the estimate
        // genuinely drifts a metre or two off the bore, and with depth testing
        // on, the walls swallowed the whole layer.
        depthTest: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(NAV.node) },
        uNow: { value: 0 },
        uPixelRatio: { value: 1 },
      },
    })
    return { geo: g, mat: m }
  }, [corridor])

  useFrame(({ gl }) => {
    const u = layer.mat.uniforms
    u.uNow.value = now.current
    u.uPixelRatio.value = gl.getPixelRatio()
  })

  return <points geometry={layer.geo} material={layer.mat} renderOrder={5} frustumCulled={false} />
}

// ---------------------------------------------------------------------------
// Current pose
// ---------------------------------------------------------------------------

/**
 * Where the system currently believes it is: a ground reticle plus a heading
 * vector. An engineering marker, not an avatar â€” the brief is right that a
 * spaceship would be the wrong register entirely.
 *
 * This is also where raw frame-to-frame noise is stopped. The pose is damped
 * toward the corridor rather than snapped to it, so the marker glides even
 * though the simulation emits at 10 Hz.
 */
function CurrentPose({ corridor, now }: { corridor: CorridorSample[]; now: Now }) {
  const reticle = useRef<THREE.LineSegments>(null!)
  const vector = useRef<THREE.LineSegments>(null!)
  const smoothed = useRef<{ x: number; z: number; yaw: number } | null>(null)

  const shape = useMemo(() => {
    const pts: number[] = []
    const add = (ax: number, az: number, bx: number, bz: number) => {
      pts.push(ax, Y + 0.05, az, bx, Y + 0.05, bz)
    }
    add(-0.9, 0, 0.9, 0)
    add(0, -0.9, 0, 0.9)
    add(-1.35, 0, -1.0, 0)
    add(1.0, 0, 1.35, 0)
    add(0, -1.35, 0, -1.0)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    return g
  }, [])

  const arrow = useMemo(() => {
    const pts = [
      0, Y + 0.06, 1.4, 0, Y + 0.06, 3.6,
      0, Y + 0.06, 3.6, -0.36, Y + 0.06, 3.1,
      0, Y + 0.06, 3.6, 0.36, Y + 0.06, 3.1,
    ]
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    return g
  }, [])

  const mat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffffff'), transparent: true, opacity: 0.88, depthWrite: false }),
    [],
  )
  useEffect(() => () => mat.dispose(), [mat])

  useEffect(
    () => () => {
      shape.dispose()
      arrow.dispose()
    },
    [shape, arrow],
  )

  useFrame(({ clock }, dt) => {
    const c = sampleCorridor(corridor, now.current)
    if (!smoothed.current) smoothed.current = { x: c.x, z: c.z, yaw: c.yaw }
    const s = smoothed.current
    s.x = damp(s.x, c.x, 14, dt)
    s.z = damp(s.z, c.z, 14, dt)
    s.yaw = dampAngle(s.yaw, c.yaw, 10, dt)

    const pulse = 1 + 0.05 * Math.sin(clock.elapsedTime * 2.2)
    reticle.current.position.set(s.x, 0, s.z)
    reticle.current.rotation.set(0, s.yaw, 0)
    reticle.current.scale.setScalar(pulse)

    vector.current.position.set(s.x, 0, s.z)
    vector.current.rotation.set(0, s.yaw, 0)
  })

  return (
    <group>
      <lineSegments ref={reticle} geometry={shape} material={mat} renderOrder={6} frustumCulled={false} />
      <lineSegments ref={vector} geometry={arrow} material={mat} renderOrder={6} frustumCulled={false} />
    </group>
  )
}

// ---------------------------------------------------------------------------

function nearestByS(corridor: CorridorSample[], s: number): CorridorSample {
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

export default function NavCorridor({ sim, idxRef }: Props) {
  const corridor = useMemo(() => buildCorridor(sim), [sim])
  const nodes = useMemo(() => waypoints(sim, corridor), [sim, corridor])
  const frameToU = useMemo(() => corridorUByFrame(sim, corridor), [sim, corridor])
  const now = useRef(0)

  useFrame(() => {
    // idxRef is a fractional frame index. The corridor is parameterised by arc
    // length instead, so the run's varying speed is removed from the mapping â€”
    // otherwise the gates would slide against the road as the bike accelerates.
    const n = sim.frames.length
    if (n === 0) return
    const i = Math.min(n - 1, Math.max(0, Math.round(idxRef.current)))
    now.current = frameToU[i]
  })

  return (
    <group>
      <FloorGrid corridor={corridor} now={now} />
      <UncertaintyEnvelope corridor={corridor} now={now} />
      <Rings sim={sim} corridor={corridor} now={now} />
      <Trajectories corridor={corridor} now={now} />
      <Waypoints corridor={corridor} nodes={nodes} now={now} />
      <ScanBand corridor={corridor} now={now} />
      <Dust corridor={corridor} now={now} />
      <CurrentPose corridor={corridor} now={now} />
    </group>
  )
}


