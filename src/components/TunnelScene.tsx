// The scene. One short tunnel, one motorcycle, thirty seconds.
//
// Everything is built once from the sim's own centreline: the open road, the
// rock cutting, the bored tunnel with its cast segment rings, kerbs, walkway
// and crown services, then the lighting rig that changes as the bike goes
// under. The camera is a fixed 30-second script rather than an orbit control,
// so the page has nothing to click.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { MutableRefObject } from 'react'
import type { SimResult } from '../lib/sim/engine'
import { samplePose, damp } from '../lib/smooth'
import {
  TUNNEL,
  boreGeometry,
  clamp,
  faceGeometry,
  portalGeometry,
  resample,
  ringGeometry,
  roadGeometry,
  rx,
  rz,
  stripGeometry,
  type Pt,
} from '../lib/tunnel'
import {
  LANE_TILE_M,
  concreteMap,
  concreteNormal,
  concreteRough,
  glowSprite,
  roadNormal,
  roadRough,
  roadSurfaceMap,
  rockMap,
} from '../lib/textures'
import Motorcycle from './Motorcycle'
import NavCorridor from './NavCorridor'

interface Props {
  sim: SimResult
  idxRef: MutableRefObject<number>
  /** 0..1 through the 30-second script, drives the camera and the light rig. */
  progress: MutableRefObject<number>
  /**
   * FOLLOW rides the AI+ESKF estimate down the corridor. CINEMATIC is the
   * original scripted camera and stays the default, so the existing
   * presentation is unchanged unless the viewer asks for FOLLOW.
   */
  cameraMode?: 'cinematic' | 'follow'
}

const SKY = '#a9c4d8'
const HAZE = '#c3d3dd'
const DEEP = '#0a0c0e'

const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Sample the sim's centreline into evenly spaced stations. */
function useCenterline(sim: SimResult, spacing = 1.6) {
  return useMemo(() => {
    const pts: Pt[] = sim.frames.map((f) => ({ x: f.x, z: f.z, yaw: f.yaw }))
    return resample(pts, spacing)
  }, [sim])
}

/** How deep inside the bore a point is, 0 outside and 1 fully inside. */
function insideAmount(s: number, sim: SimResult) {
  return smoothstep(sim.entry - 14, sim.entry + 10, s) * (1 - smoothstep(sim.exit - 10, sim.exit + 18, s))
}

// ---------------------------------------------------------------------------
// Ground, cutting and portal faces
// ---------------------------------------------------------------------------

function Terrain({ sim, line }: { sim: SimResult; line: Pt[] }) {
  const mat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#8d8f80',
        roughness: 1,
        metalness: 0,
        map: rockMap(),
      }),
    [],
  )
  // The hillside the tunnel is bored through. It is not a trench: the uphill
  // side is a tall cut face, the downhill side is a low shoulder, and the
  // whole thing tapers to nothing well before the run starts — so the road
  // opens out, then the rock closes in and the portal appears in it.
  const cutting = useMemo(() => {
    const n = line.length
    const pos: number[] = []
    const idx: number[] = []
    const uv: number[] = []
    // out from the carriageway edge, and up
    const prof: [number, number][] = [
      [1.3, -0.25],
      [5, 3.2],
      [13, 7.4],
      [28, 14],
      [54, 22],
      [100, 33],
    ]
    const arc = [0]
    for (let k = 1; k < prof.length; k++) {
      arc.push(arc[k - 1] + Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]))
    }
    // where the rock exists at all, and how tall it stands
    const zAt = (i: number) => line[i].z
    const z0 = sim.entry
    const z1 = sim.exit
    const ramp = (z: number) => {
      const up = smoothstep(z0 - 105, z0 - 26, z)
      const down = 1 - smoothstep(z1 + 26, z1 + 105, z)
      return Math.min(up, down)
    }
    for (const side of [-1, 1] as const) {
      // the uphill side stands tall, the downhill side is a low bank
      const scaleY = side === -1 ? 1 : 0.42
      const reachX = side === -1 ? 1 : 0.7
      const base = pos.length / 3
      let run = 0
      for (let i = 0; i < n; i++) {
        if (i > 0) run += Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z)
        const p = line[i]
        const R = rx(p.yaw)
        const Z = rz(p.yaw)
        // as the rock subsides it also sinks under the ground plane, so the
        // ends of the sweep vanish instead of ending in a hard edge
        const w = ramp(zAt(i))
        for (let k = 0; k < prof.length; k++) {
          const lx = (TUNNEL.laneHalf + prof[k][0] * reachX) * side * (0.12 + 0.88 * w)
          const y = prof[k][1] * scaleY * w - (1 - w) * 4
          pos.push(p.x + R * lx, y, p.z + Z * lx)
          uv.push(arc[k] * 0.05, run * 0.05)
        }
      }
      for (let i = 0; i < n - 1; i++) {
        // skip the triangles where the rock has fully subsided
        if (ramp(zAt(i)) < 0.02 && ramp(zAt(i + 1)) < 0.02) continue
        for (let k = 0; k < prof.length - 1; k++) {
          const a = base + i * prof.length + k
          const b = base + (i + 1) * prof.length + k
          if (side === 1) idx.push(a, b, a + 1, a + 1, b, b + 1)
          else idx.push(a, a + 1, b, a + 1, b + 1, b)
        }
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    g.setIndex(idx)
    g.computeVertexNormals()
    return g
  }, [line, sim])

  useEffect(() => () => cutting.dispose(), [cutting])

  const roadMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#8f939a',
        roughness: 0.9,
        metalness: 0.04,
        map: roadSurfaceMap(),
        normalMap: roadNormal(),
        roughnessMap: roadRough(),
      }),
    [],
  )
  const approachRoad = useMemo(() => roadGeometry(line, TUNNEL.laneHalf, 0, 1 / LANE_TILE_M), [line])
  useEffect(() => () => approachRoad.dispose(), [approachRoad])

  // ground plane, big enough that the fog does its job before the edge shows
  const mid = line[Math.floor(line.length / 2)]
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[mid.x, -0.16, mid.z]} receiveShadow material={mat}>
        <planeGeometry args={[900, 2400]} />
      </mesh>
      <mesh geometry={cutting} receiveShadow castShadow material={mat} />
      {/* the stretch of asphalt outside the portals */}
      <mesh geometry={approachRoad} receiveShadow material={roadMat} />
      <Portal sim={sim} line={line} />
    </group>
  )
}

function Portal({ sim, line }: { sim: SimResult; line: Pt[] }) {
  const mat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#8d8f88',
        roughness: 0.92,
        map: concreteMap(),
        normalMap: concreteNormal(),
        roughnessMap: concreteRough(),
        side: THREE.DoubleSide,
      }),
    [],
  )
  const geo = useMemo(() => portalGeometry(), [])
  useEffect(() => () => geo.dispose(), [geo])

  // find the station nearest a given distance-along-path
  const station = (s: number) => {
    const p = sim.frames.find((f) => f.s >= s) ?? sim.frames[sim.frames.length - 1]
    let best = line[0]
    let bd = Infinity
    for (const q of line) {
      const d = Math.hypot(q.x - p.x, q.z - p.z)
      if (d < bd) {
        bd = d
        best = q
      }
    }
    return best
  }

  const a = station(sim.entry)
  const b = station(sim.exit)
  const band = useMemo(() => {
    const c = new THREE.MeshStandardMaterial({ color: '#d8c24a', roughness: 0.6, emissive: '#4a3c08', emissiveIntensity: 0.5 })
    return c
  }, [])

  return (
    <group>
      {[
        { p: a, flip: false, key: 'in' },
        { p: b, flip: true, key: 'out' },
      ].map(({ p, flip, key }) => (
        <group key={key} position={[p.x, 0, p.z]} rotation={[0, p.yaw + (flip ? Math.PI : 0), 0]}>
          <mesh geometry={geo} material={mat} castShadow receiveShadow />
          {/* a lit band across the crown, the way portals are marked */}
          <mesh position={[0, TUNNEL.wallHeight + TUNNEL.archRise + 0.85, 0.5]} material={band}>
            <boxGeometry args={[TUNNEL.halfWidth * 2 + 3.4, 0.28, 0.1]} />
          </mesh>
          {/* wing walls splaying into the cutting */}
          {[-1, 1].map((sd) => (
            <mesh
              key={sd}
              position={[sd * (TUNNEL.halfWidth + 2.1), 2.2, 2.2]}
              rotation={[0, -sd * 0.22, 0]}
              material={mat}
              castShadow
            >
              <boxGeometry args={[4.6, 4.6, 0.5]} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  )
}

// ---------------------------------------------------------------------------
// The bore
// ---------------------------------------------------------------------------

function Bore({ sim, line }: { sim: SimResult; line: Pt[] }) {
  const inTun = useMemo(() => line.filter((p) => p.z >= sim.entry - 6 && p.z <= sim.exit + 6), [line, sim])

  const geo = useMemo(() => {
    const carriage = roadGeometry(inTun, TUNNEL.laneHalf, 0.0, 1 / LANE_TILE_M)
    const bore = boreGeometry(inTun)
    // kerb + walkway on the right (the escape side), and just a kerb on the left
    const walkR = stripGeometry(
      inTun,
      [
        [TUNNEL.laneHalf, 0.01],
        [TUNNEL.laneHalf + TUNNEL.kerbWidth, TUNNEL.kerbHeight],
        [TUNNEL.halfWidth, TUNNEL.kerbHeight],
      ],
      0.5,
    )
    const walkL = stripGeometry(
      inTun,
      [
        [-TUNNEL.laneHalf, 0.01],
        [-TUNNEL.laneHalf - TUNNEL.kerbWidth, TUNNEL.kerbHeight],
        [-TUNNEL.halfWidth, TUNNEL.kerbHeight],
      ],
      0.5,
    )
    const kerbR = faceGeometry(inTun, TUNNEL.laneHalf + TUNNEL.kerbWidth, 0.005, TUNNEL.kerbHeight, -1)
    const kerbL = faceGeometry(inTun, -(TUNNEL.laneHalf + TUNNEL.kerbWidth), 0.005, TUNNEL.kerbHeight, 1)
    // handrail on the escape walkway
    const rail = stripGeometry(
      inTun,
      [
        [TUNNEL.halfWidth - 0.12, 1.02],
        [TUNNEL.halfWidth - 0.12, 1.06],
      ],
      0.5,
    )
    const post = stripGeometry(
      inTun,
      [
        [TUNNEL.halfWidth - 0.12, TUNNEL.kerbHeight],
        [TUNNEL.halfWidth - 0.12, 1.04],
      ],
      0.5,
    )
    // crown conduit and the cable tray on the right wall
    const conduit = stripGeometry(
      inTun,
      [
        [-0.28, TUNNEL.wallHeight + TUNNEL.archRise - 0.55],
        [0.28, TUNNEL.wallHeight + TUNNEL.archRise - 0.55],
      ],
      0.6,
    )
    const tray = stripGeometry(
      inTun,
      [
        [TUNNEL.halfWidth - 0.34, 2.5],
        [TUNNEL.halfWidth - 0.12, 2.5],
        [TUNNEL.halfWidth - 0.12, 2.66],
        [TUNNEL.halfWidth - 0.34, 2.66],
      ],
      0.5,
    )
    return { carriage, bore, walkR, walkL, kerbR, kerbL, rail, post, conduit, tray }
  }, [inTun])

  useEffect(
    () => () => {
      Object.values(geo).forEach((g) => g.dispose())
    },
    [geo],
  )

  const concrete = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#a3a49c',
        roughness: 0.95,
        metalness: 0.02,
        map: concreteMap(),
        normalMap: concreteNormal(),
        normalScale: new THREE.Vector2(0.45, 0.45),
        roughnessMap: concreteRough(),
        side: THREE.FrontSide,
      }),
    [],
  )
  const asphalt = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#8f939a',
        roughness: 0.88,
        metalness: 0.05,
        map: roadSurfaceMap(),
        normalMap: roadNormal(),
        roughnessMap: roadRough(),
      }),
    [],
  )
  const kerb = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#cfd0c8', roughness: 0.82, map: concreteMap() }),
    [],
  )
  const steel = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#9aa3a8', roughness: 0.34, metalness: 0.9 }),
    [],
  )
  const service = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#5a5f63', roughness: 0.7, metalness: 0.4 }),
    [],
  )

  // cast segment rings every 6 m, alternating a proud and a recessed band
  const ring = useMemo(() => ringGeometry(0.2, 0.2), [])
  useEffect(() => () => ring.dispose(), [ring])
  const rings = useMemo(() => {
    const out: { p: Pt; proud: boolean }[] = []
    let run = 0
    for (let i = 1; i < inTun.length; i++) {
      run += Math.hypot(inTun[i].x - inTun[i - 1].x, inTun[i].z - inTun[i - 1].z)
      if (run < 6) continue
      run = 0
      out.push({ p: inTun[i], proud: out.length % 2 === 0 })
    }
    return out
  }, [inTun])

  return (
    <group>
      <mesh geometry={geo.bore} material={concrete} receiveShadow />
      <mesh geometry={geo.carriage} material={asphalt} receiveShadow />
      <mesh geometry={geo.walkR} material={kerb} receiveShadow />
      <mesh geometry={geo.walkL} material={kerb} receiveShadow />
      <mesh geometry={geo.kerbR} material={kerb} receiveShadow />
      <mesh geometry={geo.kerbL} material={kerb} receiveShadow />
      <mesh geometry={geo.rail} material={steel} />
      <mesh geometry={geo.post} material={steel} />
      <mesh geometry={geo.conduit} material={service} />
      <mesh geometry={geo.tray} material={service} />
      {rings.map(({ p, proud }, i) => (
        <mesh
          key={i}
          geometry={ring}
          material={concrete}
          position={[p.x, 0, p.z]}
          rotation={[0, p.yaw, 0]}
          scale={proud ? 1 : 0.995}
        />
      ))}
    </group>
  )
}

// ---------------------------------------------------------------------------
// Lighting rig: daylight outside, sodium strip inside
// ---------------------------------------------------------------------------

function Lights({ sim, idxRef }: { sim: SimResult; idxRef: MutableRefObject<number> }) {
  const sun = useRef<THREE.DirectionalLight>(null!)
  const amb = useRef<THREE.AmbientLight>(null!)
  const hemi = useRef<THREE.HemisphereLight>(null!)
  const { scene } = useThree()
  const outBg = useMemo(() => new THREE.Color(SKY), [])
  const inBg = useMemo(() => new THREE.Color(DEEP), [])
  const outFog = useMemo(() => new THREE.Color(HAZE), [])
  const inFog = useMemo(() => new THREE.Color('#0d0f11'), [])
  const tmp = useMemo(() => new THREE.Color(), [])

  useFrame(() => {
    const p = samplePose(sim.frames, idxRef.current)
    const k = insideAmount(p.s, sim)
    scene.background = tmp.lerpColors(outBg, inBg, k)
    const fog = scene.fog as THREE.Fog | null
    if (fog) {
      fog.color.lerpColors(outFog, inFog, k)
      fog.near = 150 - 138 * k
      fog.far = 1100 - 1010 * k
    }
    amb.current.intensity = 1.9 - 1.84 * k
    hemi.current.intensity = 2.2 - 1.95 * k
    sun.current.intensity = 3.4 - 3.37 * k
    // keep the shadow frustum tight around the bike
    sun.current.position.set(p.x + 42, 68, p.z - 34)
    sun.current.target.position.set(p.x, 0, p.z)
    sun.current.target.updateMatrixWorld()
  })

  return (
    <>
      <ambientLight ref={amb} intensity={1.9} />
      <hemisphereLight ref={hemi} args={['#dceaf5', '#5a5c56', 2.2]} />
      <directionalLight
        ref={sun}
        position={[42, 68, -34]}
        intensity={3.4}
        color="#fff8f0"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-near={4}
        shadow-camera-far={220}
        shadow-camera-left={-38}
        shadow-camera-right={38}
        shadow-camera-top={38}
        shadow-camera-bottom={-38}
        shadow-bias={-0.0006}
        shadow-normalBias={0.04}
      />
    </>
  )
}

/**
 * Sodium fittings in the crown. The housings and tubes are instanced (one draw
 * call each) and only two real point lights exist — they are re-seated every
 * frame onto whichever fittings are nearest the bike, so the pools of light
 * travel with the viewer at a fixed cost.
 */
function Fittings({ sim, line, idxRef }: { sim: SimResult; line: Pt[]; idxRef: MutableRefObject<number> }) {
  const inTun = useMemo(() => line.filter((p) => p.z >= sim.entry - 4 && p.z <= sim.exit + 4), [line, sim])
  const spacing = 10

  const spots = useMemo(() => {
    const out: { x: number; y: number; z: number; yaw: number }[] = []
    let run = spacing
    for (let i = 1; i < inTun.length; i++) {
      run += Math.hypot(inTun[i].x - inTun[i - 1].x, inTun[i].z - inTun[i - 1].z)
      if (run < spacing) continue
      run = 0
      const p = inTun[i]
      const side = out.length % 2 === 0 ? -1 : 1
      const R = rx(p.yaw)
      const Z = rz(p.yaw)
      const lx = side * (TUNNEL.halfWidth - 0.55)
      out.push({ x: p.x + R * lx, y: 3.05, z: p.z + Z * lx, yaw: p.yaw })
    }
    return out
  }, [inTun])

  const dummy = useMemo(() => new THREE.Object3D(), [])
  const housings = useRef<THREE.InstancedMesh>(null!)
  const tubes = useRef<THREE.InstancedMesh>(null!)
  const halos = useRef<THREE.InstancedMesh>(null!)
  const l1 = useRef<THREE.PointLight>(null!)
  const l2 = useRef<THREE.PointLight>(null!)

  useLayoutEffect(() => {
    spots.forEach((p, i) => {
      dummy.position.set(p.x, p.y + 0.07, p.z)
      dummy.rotation.set(0, p.yaw, 0.2)
      dummy.updateMatrix()
      housings.current.setMatrixAt(i, dummy.matrix)
      dummy.position.set(p.x, p.y - 0.02, p.z)
      dummy.rotation.set(0, p.yaw, 0)
      dummy.updateMatrix()
      tubes.current.setMatrixAt(i, dummy.matrix)
      dummy.position.set(p.x, p.y - 0.14, p.z)
      dummy.rotation.set(0, p.yaw, 0)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      halos.current.setMatrixAt(i, dummy.matrix)
    })
    for (const m of [housings.current, tubes.current, halos.current]) {
      m.instanceMatrix.needsUpdate = true
      m.count = spots.length
    }
  }, [spots, dummy])

  useFrame(() => {
    // seat the two lights on the fittings bracketing the bike
    const p = samplePose(sim.frames, idxRef.current)
    let best = 0
    let bd = Infinity
    let second = 0
    let sd = Infinity
    for (let i = 0; i < spots.length; i++) {
      const d = Math.abs(spots[i].z - p.z)
      if (d < bd) {
        sd = bd
        second = best
        bd = d
        best = i
      } else if (d < sd) {
        sd = d
        second = i
      }
    }
    if (l1.current && spots[best]) l1.current.position.set(spots[best].x, spots[best].y - 0.25, spots[best].z)
    if (l2.current && spots[second]) l2.current.position.set(spots[second].x, spots[second].y - 0.25, spots[second].z)
  })

  const shell = useMemo(() => new THREE.MeshStandardMaterial({ color: '#43474c', roughness: 0.55, metalness: 0.6 }), [])
  const tubeMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffe6bd' }), [])
  const haloMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: glowSprite('fitting', 'rgba(255,236,200,0.9)', 'rgba(255,196,110,0.3)'),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
        side: THREE.DoubleSide,
      }),
    [],
  )

  return (
    <group>
      <instancedMesh ref={housings} args={[undefined, undefined, Math.max(1, spots.length)]} frustumCulled={false} material={shell}>
        <boxGeometry args={[0.36, 0.18, 1.6]} />
      </instancedMesh>
      <instancedMesh ref={tubes} args={[undefined, undefined, Math.max(1, spots.length)]} frustumCulled={false} material={tubeMat}>
        <boxGeometry args={[0.24, 0.06, 1.34]} />
      </instancedMesh>
      <instancedMesh ref={halos} args={[undefined, undefined, Math.max(1, spots.length)]} frustumCulled={false} material={haloMat}>
        <planeGeometry args={[2.8, 2.8]} />
      </instancedMesh>
      <pointLight ref={l1} color="#ffca7d" intensity={85} distance={30} decay={1.7} />
      <pointLight ref={l2} color="#ffca7d" intensity={60} distance={24} decay={1.7} />
    </group>
  )
}

/** A faint haze of dust in the beam, so the light has volume. */
function BeamHaze({ sim, idxRef }: { sim: SimResult; idxRef: MutableRefObject<number> }) {
  const ref = useRef<THREE.Mesh>(null!)
  const mat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: glowSprite('haze', 'rgba(255,226,180,0.5)', 'rgba(255,196,120,0.16)'),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
      }),
    [],
  )
  useFrame(() => {
    const p = samplePose(sim.frames, idxRef.current)
    const fx = Math.sin(p.yaw)
    const fz = Math.cos(p.yaw)
    ref.current.position.set(p.x + fx * 7, 1.5, p.z + fz * 7)
    ref.current.rotation.set(-Math.PI / 2, 0, -p.yaw)
  })
  return (
    <mesh ref={ref} material={mat}>
      <planeGeometry args={[7, 22]} />
    </mesh>
  )
}

// ---------------------------------------------------------------------------
// Camera: a 30-second script, not an orbit control
// ---------------------------------------------------------------------------

/** Keyframes in (time fraction, behind, height, lateral, look-ahead, fov). */
const SHOTS: { t: number; back: number; up: number; side: number; ahead: number; fov: number }[] = [
  { t: 0.0, back: 7.6, up: 1.85, side: 2.1, ahead: 13, fov: 44 },
  { t: 0.16, back: 6.2, up: 1.35, side: -1.1, ahead: 14, fov: 42 },
  { t: 0.3, back: 5.0, up: 1.1, side: 0, ahead: 12, fov: 40 },
  { t: 0.52, back: 4.4, up: 1.0, side: 0.35, ahead: 11, fov: 38 },
  { t: 0.72, back: 5.4, up: 1.3, side: -1.4, ahead: 13, fov: 42 },
  { t: 0.88, back: 7.4, up: 1.8, side: 1.9, ahead: 15, fov: 46 },
  { t: 1.0, back: 8.6, up: 2.2, side: 2.6, ahead: 16, fov: 48 },
]

function CameraScript({ sim, idxRef, progress }: Props) {
  const { camera } = useThree()
  const look = useMemo(() => new THREE.Vector3(), [])
  const pos = useMemo(() => new THREE.Vector3(), [])
  const first = useRef(true)

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const p = samplePose(sim.frames, idxRef.current)
    const t = clamp(progress.current, 0, 1)

    // find the bracketing keyframes and ease between them
    let a = SHOTS[0]
    let b = SHOTS[SHOTS.length - 1]
    for (let i = 0; i < SHOTS.length - 1; i++) {
      if (t >= SHOTS[i].t && t <= SHOTS[i + 1].t) {
        a = SHOTS[i]
        b = SHOTS[i + 1]
        break
      }
    }
    const span = Math.max(1e-4, b.t - a.t)
    const u = smoothstep(0, 1, (t - a.t) / span)

    const back = a.back + (b.back - a.back) * u
    const up = a.up + (b.up - a.up) * u
    const side = a.side + (b.side - a.side) * u
    const ahead = a.ahead + (b.ahead - a.ahead) * u
    const fov = a.fov + (b.fov - a.fov) * u

    const fx = Math.sin(p.yaw)
    const fz = Math.cos(p.yaw)
    const rxn = fz
    const rzn = -fx
    pos.set(p.x - fx * back + rxn * side, up, p.z - fz * back + rzn * side)
    look.set(p.x + fx * ahead, 1.15, p.z + fz * ahead)

    if (first.current) {
      camera.position.copy(pos)
      first.current = false
    }
    // damped, so scrubbing never snaps
    camera.position.x = damp(camera.position.x, pos.x, 6, dt)
    camera.position.y = damp(camera.position.y, pos.y, 6, dt)
    camera.position.z = damp(camera.position.z, pos.z, 6, dt)
    camera.lookAt(look)

    const cam = camera as THREE.PerspectiveCamera
    const targetFov = fov + clamp(p.v - 16.7, 0, 6) * 1.1
    const nf = damp(cam.fov, targetFov, 3, dt)
    if (Math.abs(nf - cam.fov) > 0.002) {
      cam.fov = nf
      cam.updateProjectionMatrix()
    }
  })
  return null
}

/**
 * FOLLOW mode: the camera rides the AI+ESKF estimate itself rather than a
 * scripted path, which is what makes the corridor read as something being
 * navigated rather than something being played back.
 *
 * It sits behind and above the estimate, looks a short way ahead along the
 * estimate's own heading, and damps every channel so a 10 Hz frame rate never
 * reaches the eye as judder. It adds nothing to the scene; it only drives the
 * existing camera.
 */
function FollowCamera({ sim, idxRef }: { sim: SimResult; idxRef: MutableRefObject<number> }) {
  const { camera } = useThree()
  const look = useMemo(() => new THREE.Vector3(), [])
  const desired = useMemo(() => new THREE.Vector3(), [])
  const ahead = useMemo(() => new THREE.Vector3(), [])
  const settled = useRef(false)

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const p = samplePose(sim.frames, idxRef.current)

    const fx = Math.sin(p.yaw)
    const fz = Math.cos(p.yaw)

    const back = 7.2
    const height = 2.35
    const lead = 9.5
    desired.set(p.x - fx * back, height, p.z - fz * back)
    ahead.set(p.x + fx * lead, 1.05, p.z + fz * lead)

    if (!settled.current) {
      camera.position.copy(desired)
      look.copy(ahead)
      settled.current = true
    }

    camera.position.x = damp(camera.position.x, desired.x, 5, dt)
    camera.position.y = damp(camera.position.y, desired.y, 5, dt)
    camera.position.z = damp(camera.position.z, desired.z, 5, dt)

    look.x = damp(look.x, ahead.x, 6, dt)
    look.y = damp(look.y, ahead.y, 6, dt)
    look.z = damp(look.z, ahead.z, 6, dt)
    camera.lookAt(look)
  })

  return null
}

/** A soft contact shadow under the bike, so it never looks like it floats. */
function ContactShadow({ sim, idxRef }: { sim: SimResult; idxRef: MutableRefObject<number> }) {
  const ref = useRef<THREE.Mesh>(null!)
  const mat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: glowSprite('contact', 'rgba(0,0,0,0.5)', 'rgba(0,0,0,0.2)'),
        transparent: true,
        depthWrite: false,
        color: '#0b0d0f',
      }),
    [],
  )
  useFrame(() => {
    const p = samplePose(sim.frames, idxRef.current)
    ref.current.position.set(p.x, 0.02, p.z)
    ref.current.rotation.set(-Math.PI / 2, 0, -p.yaw)
  })
  return (
    <mesh ref={ref} material={mat} renderOrder={2}>
      <planeGeometry args={[1.5, 2.9]} />
    </mesh>
  )
}

// ---------------------------------------------------------------------------

function Scene({ sim, idxRef, progress, cameraMode }: Props) {
  const line = useCenterline(sim)
  return (
    <>
      <fog attach="fog" args={[HAZE, 120, 900]} />
      <Lights sim={sim} idxRef={idxRef} />
      {cameraMode === 'follow' ? (
        <FollowCamera sim={sim} idxRef={idxRef} />
      ) : (
        <CameraScript sim={sim} idxRef={idxRef} progress={progress} />
      )}
      <Terrain sim={sim} line={line} />
      <Bore sim={sim} line={line} />
      <Fittings sim={sim} line={line} idxRef={idxRef} />
      <BeamHaze sim={sim} idxRef={idxRef} />
      <ContactShadow sim={sim} idxRef={idxRef} />
      <Motorcycle sim={sim} idxRef={idxRef} />
      {/* The navigation corridor, drawn over the tunnel it is describing. */}
      <NavCorridor sim={sim} idxRef={idxRef} />
    </>
  )
}

export default function TunnelScene({ sim, idxRef, progress, cameraMode = 'cinematic' }: Props) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const dpr = useMemo<[number, number]>(
    () => [1, Math.min(1.75, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)],
    [],
  )

  if (!ready) {
    return (
      <div className="on-dark grid h-full w-full place-items-center bg-ink">
        <span className="label">Building the tunnel…</span>
      </div>
    )
  }

  return (
    <Canvas
      shadows
      dpr={dpr}
      gl={{ antialias: true, powerPreference: 'high-performance', toneMapping: THREE.ACESFilmicToneMapping }}
      camera={{ fov: 46, near: 0.25, far: 1400, position: [0, 3, -12] }}
    >
      <Scene sim={sim} idxRef={idxRef} progress={progress} cameraMode={cameraMode} />
      <AdaptiveQuality />
    </Canvas>
  )
}

/** Drops the pixel ratio once, if the frame budget is being missed. */
function AdaptiveQuality() {
  const { gl } = useThree()
  const frames = useRef(0)
  const acc = useRef(0)
  const dropped = useRef(false)
  useFrame((_, dt) => {
    if (dropped.current) return
    frames.current++
    acc.current += dt
    if (frames.current < 90) return
    if (acc.current / frames.current > 1 / 34) {
      gl.setPixelRatio(1)
      dropped.current = true
    }
    frames.current = 0
    acc.current = 0
  })
  return null
}
