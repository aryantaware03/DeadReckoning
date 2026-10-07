// The motorcycle. Built the way a real one is laid out: 17" wheels with
// three-spoke rims and drilled discs, USD forks with a sliding lower leg, a
// trellis-ish frame, a tank that sits on the spine, a swingarm on a rising
// linkage, a chain, an underslung exhaust and a rider whose weight shifts with
// the bike. Every material is a real PBR material, so the tunnel's lights
// actually read off the paint and the chrome.

import { useMemo, useRef, useEffect, memo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { SimResult } from '../lib/sim/engine'
import { samplePose, damp, dampAngle } from '../lib/smooth'
import { clamp } from '../lib/tunnel'
import type { MutableRefObject } from 'react'

interface Props {
  sim: SimResult
  idxRef: MutableRefObject<number>
}

const R_WHEEL = 0.335
const R_TYRE = 0.052
const WHEELBASE_F = 0.72
const WHEELBASE_R = -0.74
const RIDER_SEAT_Y = 0.82

function std(color: string, roughness: number, metalness: number, extra?: THREE.MeshStandardMaterialParameters) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra })
}

type Ride = MutableRefObject<{ v: number; slip: number }>

function Wheel({ mats, ride, rear }: { mats: Meters; ride: Ride; rear: boolean }) {
  const spin = useRef<THREE.Group>(null!)
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    // rolling radius slightly larger under load; the rear also spins up in a slip
    const r = R_WHEEL + (rear ? 0.012 : 0)
    const slip = rear ? ride.current.slip : 0
    spin.current.rotation.x -= (ride.current.v / r) * (1 + slip) * dt
  })
  return (
    <group ref={spin} position={[0.115, R_WHEEL, 0]}>
      {/* tyre carcass */}
      <mesh castShadow rotation={[0, 0, Math.PI / 2]} material={mats.tyre}>
        <torusGeometry args={[R_WHEEL - R_TYRE * 0.55, R_TYRE, 12, 34]} />
      </mesh>
      {/* tread blocks, so the tyre is not a smooth doughnut up close */}
      {Array.from({ length: 26 }, (_, i) => {
        const a = (i / 26) * Math.PI * 2
        return (
          <mesh
            key={i}
            position={[0.028, Math.sin(a) * (R_WHEEL - R_TYRE * 0.1), Math.cos(a) * (R_WHEEL - R_TYRE * 0.1)]}
            rotation={[-a, 0, 0]}
            material={mats.tyre}
          >
            <boxGeometry args={[0.09, 0.016, 0.05]} />
          </mesh>
        )
      })}
      {/* rim barrel */}
      <mesh rotation={[0, 0, Math.PI / 2]} material={mats.rim}>
        <cylinderGeometry args={[0.215, 0.215, 0.062, 30, 1, true]} />
      </mesh>
      {/* three-spoke pattern */}
      {[0, 1, 2].map((i) => {
        const a = (i / 3) * Math.PI * 2
        return (
          <group key={i} rotation={[a, 0, 0]}>
            <mesh position={[0, 0.11, 0]} rotation={[0, 0, Math.PI / 2]} material={mats.rim}>
              <boxGeometry args={[0.05, 0.2, 0.05]} />
            </mesh>
            <mesh position={[0, 0.205, 0]} material={mats.rim}>
              <cylinderGeometry args={[0.055, 0.055, 0.07, 14]} />
            </mesh>
          </group>
        )
      })}
      <mesh position={[0, 0.04, 0]} rotation={[0, 0, Math.PI / 2]} material={mats.rim}>
        <cylinderGeometry args={[0.062, 0.062, 0.1, 16]} />
      </mesh>
      {/* brake disc */}
      <mesh position={[0.088, 0, 0]} rotation={[0, 0, Math.PI / 2]} material={mats.disc}>
        <cylinderGeometry args={[0.155, 0.155, 0.006, 34]} />
      </mesh>
      <mesh position={[0.092, 0, 0]} rotation={[0, 0, Math.PI / 2]} material={mats.rim}>
        <cylinderGeometry args={[0.075, 0.075, 0.012, 20]} />
      </mesh>
      {/* brake caliper */}
      <mesh position={[0.1, 0.13, -0.02]} rotation={[0.2, 0, 0]} material={mats.caliper}>
        <boxGeometry args={[0.045, 0.1, 0.08]} />
      </mesh>
    </group>
  )
}

function useMats() {
  return useMemo(
    () => ({
      tyre: std('#14161a', 0.92, 0.0),
      rim: std('#8f9aa6', 0.28, 0.92),
      disc: std('#6e7479', 0.34, 0.95),
      caliper: std('#20242a', 0.5, 0.6),
      chrome: std('#cfd6dd', 0.13, 1.0),
      darkChrome: std('#7c858e', 0.24, 0.95),
      frame: std('#2a3138', 0.42, 0.75),
      engine: std('#4a5158', 0.38, 0.88),
      engineDark: std('#22262b', 0.55, 0.7),
      tank: std('#0e5f6e', 0.22, 0.55),
      tankDark: std('#093f4a', 0.3, 0.5),
      fairing: std('#0b4d5c', 0.2, 0.5),
      seat: std('#17191d', 0.85, 0.05),
      tail: std('#0e5f6e', 0.24, 0.5),
      exhaust: std('#b7bfc6', 0.2, 1.0),
      exhaustDark: std('#4b5258', 0.35, 0.9),
      brake: std('#3a2027', 0.45, 0.6),
      lever: std('#c8ced4', 0.3, 0.9),
      suit: std('#1a1d22', 0.7, 0.06),
      suitAccent: std('#b0246e', 0.55, 0.1),
      glove: std('#22262c', 0.7, 0.08),
      boot: std('#191c21', 0.65, 0.12),
      helmet: std('#e8eaec', 0.18, 0.25),
      visor: new THREE.MeshPhysicalMaterial({
        color: '#101820',
        roughness: 0.06,
        metalness: 0.4,
        transmission: 0.35,
        thickness: 0.02,
        transparent: true,
        opacity: 0.86,
      }),
      lens: new THREE.MeshBasicMaterial({ color: '#fff6d8' }),
      lensRed: new THREE.MeshBasicMaterial({ color: '#ff2f43' }),
      glass: new THREE.MeshPhysicalMaterial({
        color: '#cfe4ee',
        roughness: 0.05,
        metalness: 0,
        transmission: 0.9,
        thickness: 0.01,
        transparent: true,
        opacity: 0.34,
      }),
    }),
    [],
  )
}

type Meters = ReturnType<typeof useMats>

function Rider({ mats, crouch }: { mats: Meters; crouch: MutableRefObject<THREE.Group | null> }) {
  return (
    <group ref={crouch}>
      {/* pelvis / seat contact */}
      <mesh position={[0, RIDER_SEAT_Y + 0.06, -0.34]} rotation={[0.28, 0, 0]} material={mats.suit}>
        <capsuleGeometry args={[0.115, 0.24, 4, 12]} />
      </mesh>
      {/* torso, leaning forward over the tank */}
      <mesh position={[0, RIDER_SEAT_Y + 0.4, -0.12]} rotation={[-0.62, 0, 0]} material={mats.suit}>
        <capsuleGeometry args={[0.135, 0.4, 5, 14]} />
      </mesh>
      {/* back hump of the suit */}
      <mesh position={[0, RIDER_SEAT_Y + 0.5, -0.3]} rotation={[-0.5, 0, 0]} material={mats.suitAccent}>
        <capsuleGeometry args={[0.07, 0.2, 4, 10]} />
      </mesh>
      {/* shoulders */}
      <mesh position={[0, RIDER_SEAT_Y + 0.52, -0.02]} rotation={[0, 0, Math.PI / 2]} material={mats.suit}>
        <capsuleGeometry args={[0.082, 0.3, 4, 12]} />
      </mesh>
      {/* arms reaching the bars */}
      {[-1, 1].map((s) => (
        <group key={s}>
          <mesh position={[s * 0.16, RIDER_SEAT_Y + 0.42, 0.13]} rotation={[-0.95, 0, -s * 0.1]} material={mats.suit}>
            <capsuleGeometry args={[0.055, 0.36, 4, 10]} />
          </mesh>
          <mesh position={[s * 0.24, RIDER_SEAT_Y + 0.2, 0.36]} rotation={[-0.5, 0, -s * 0.25]} material={mats.suit}>
            <capsuleGeometry args={[0.048, 0.3, 4, 10]} />
          </mesh>
          <mesh position={[s * 0.29, RIDER_SEAT_Y + 0.07, 0.52]} rotation={[0, 0, -s * 0.2]} material={mats.glove}>
            <boxGeometry args={[0.07, 0.075, 0.11]} />
          </mesh>
        </group>
      ))}
      {/* legs tucked onto the pegs */}
      {[-1, 1].map((s) => (
        <group key={s}>
          <mesh position={[s * 0.13, RIDER_SEAT_Y + 0.02, -0.14]} rotation={[0.95, 0, -s * 0.06]} material={mats.suit}>
            <capsuleGeometry args={[0.078, 0.4, 4, 12]} />
          </mesh>
          <mesh position={[s * 0.16, 0.5, -0.28]} rotation={[-0.25, 0, 0]} material={mats.suit}>
            <capsuleGeometry args={[0.062, 0.4, 4, 10]} />
          </mesh>
          <mesh position={[s * 0.17, 0.29, -0.16]} rotation={[-0.1, 0, 0]} material={mats.boot}>
            <boxGeometry args={[0.09, 0.1, 0.24]} />
          </mesh>
        </group>
      ))}
      {/* neck + helmet */}
      <mesh position={[0, RIDER_SEAT_Y + 0.62, 0.08]} rotation={[0.3, 0, 0]} material={mats.suit}>
        <capsuleGeometry args={[0.055, 0.07, 4, 10]} />
      </mesh>
      <group position={[0, RIDER_SEAT_Y + 0.74, 0.11]}>
        <mesh castShadow material={mats.helmet}>
          <sphereGeometry args={[0.135, 22, 18]} />
        </mesh>
        {/* chin bar */}
        <mesh position={[0, -0.07, 0.07]} rotation={[0.35, 0, 0]} material={mats.helmet}>
          <boxGeometry args={[0.19, 0.1, 0.16]} />
        </mesh>
        {/* visor aperture */}
        <mesh position={[0, 0.015, 0.088]} rotation={[0.12, 0, 0]} material={mats.visor}>
          <sphereGeometry args={[0.122, 20, 14, -0.9, 1.8, 0.85, 0.72]} />
        </mesh>
        {/* rear spoiler */}
        <mesh position={[0, 0.07, -0.11]} rotation={[-0.3, 0, 0]} material={mats.helmet}>
          <boxGeometry args={[0.16, 0.035, 0.1]} />
        </mesh>
      </group>
    </group>
  )
}

function Motorcycle({ sim, idxRef }: Props) {
  const mats = useMats()
  const sprites = useSpriteMats()
  const root = useRef<THREE.Group>(null!)
  const lean = useRef<THREE.Group>(null!)
  const steer = useRef<THREE.Group>(null!)
  const swing = useRef<THREE.Group>(null!)
  const forkSlide = useRef<THREE.Group>(null!)
  const bodyPitch = useRef<THREE.Group>(null!)
  const crouch = useRef<THREE.Group>(null!)
  const beamTarget = useMemo(() => new THREE.Object3D(), [])
  const beam = useRef<THREE.SpotLight>(null!)
  const glow = useRef<THREE.Sprite>(null!)
  const tailGlow = useRef<THREE.Sprite>(null!)

  const s = useRef({ yaw: 0, lean: 0, pitch: 0, steer: 0, init: false, prevV: 0, accel: 0, comp: 0 })
  const wheels = useRef({ v: 0, slip: 0 })

  useEffect(() => {
    root.current?.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh && m.material !== mats.lens && m.material !== mats.lensRed) m.castShadow = true
    })
  }, [mats])

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const p = samplePose(sim.frames, idxRef.current)
    const st = s.current
    if (!st.init) {
      st.yaw = p.yaw
      st.prevV = p.v
      st.init = true
    }

    // road contact: small constant chatter, larger at speed
    const ride = clamp(p.v / 16.7, 0, 1.2)
    const t = state.clock.elapsedTime
    const chatter = (Math.sin(t * 27.3) * 0.0035 + Math.sin(t * 41.7 + 1.1) * 0.0022) * ride
    root.current.position.set(p.x, chatter, p.z)

    st.yaw = dampAngle(st.yaw, p.yaw, 14, dt)
    root.current.rotation.y = st.yaw

    // lean from lateral acceleration
    const leanT = clamp((-p.v * p.v * p.curve) / 9.81, -0.44, 0.44)
    st.lean = damp(st.lean, leanT, 6, dt)
    lean.current.rotation.z = st.lean

    // dive under braking, squat under power
    const accel = dt > 1e-4 ? (p.v - st.prevV) / dt : 0
    st.prevV = p.v
    st.accel = damp(st.accel, clamp(accel, -5, 5), 4, dt)
    st.pitch = damp(st.pitch, clamp(-st.accel * 0.014, -0.04, 0.04), 5, dt)
    bodyPitch.current.rotation.x = st.pitch

    // steering follows curvature, and the fork visibly compresses with it
    st.steer = damp(st.steer, clamp(p.curve * 2.2, -0.3, 0.3), 6, dt)
    steer.current.rotation.y = st.steer
    forkSlide.current.position.y = -Math.abs(st.lean) * 0.03

    // swingarm and shock travel with the rear load
    st.comp = damp(st.comp, clamp(st.accel * 0.01, -0.03, 0.03), 5, dt)
    swing.current.rotation.x = -st.comp

    // rider tucks in at speed, sits up when slow
    crouch.current.rotation.x = -0.14 - ride * 0.2

    // hand the wheels their speed; the rear takes the slip
    wheels.current.v = p.v
    wheels.current.slip = p.slip

    const fx = Math.sin(st.yaw)
    const fz = Math.cos(st.yaw)
    beamTarget.position.set(p.x + fx * 26, -0.5, p.z + fz * 26)
    beamTarget.updateMatrixWorld()
    if (beam.current) beam.current.intensity = 60 + ride * 45
    glow.current.position.set(fx * 0.84, 0.88, fz * 0.84)
    tailGlow.current.position.set(-fx * 1.2, 0.96, -fz * 1.2)
  })

  return (
    <group ref={root}>
      <group ref={lean}>
        <group ref={bodyPitch}>
          <Rider mats={mats} crouch={crouch} />

          {/* ---- rear end ---- */}
          <group ref={swing} position={[0, R_WHEEL + 0.34, WHEELBASE_R]}>
            <Wheel mats={mats} ride={wheels} rear />
            {/* swingarm arms */}
            {[-1, 1].map((sd) => (
              <mesh key={sd} position={[sd * 0.115, 0.16, 0.35]} rotation={[Math.PI / 2, 0, 0]} material={mats.frame}>
                <boxGeometry args={[0.05, 0.7, 0.11]} />
              </mesh>
            ))}
            <mesh position={[0, 0.1, 0.36]} material={mats.frame}>
              <boxGeometry args={[0.2, 0.08, 0.2]} />
            </mesh>
          </group>
          {/* chain run + sprocket */}
          <mesh position={[-0.115, R_WHEEL + 0.02, -0.36]} material={mats.engineDark}>
            <boxGeometry args={[0.022, 0.055, 1.28]} />
          </mesh>
          <mesh position={[-0.115, R_WHEEL + 0.02, -0.3]} rotation={[Math.PI / 2, 0, 0]} material={mats.darkChrome}>
            <cylinderGeometry args={[0.115, 0.115, 0.014, 20]} />
          </mesh>

          {/* ---- frame spine + engine ---- */}
          <mesh position={[0, 0.62, -0.08]} rotation={[0.12, 0, 0]} material={mats.frame}>
            <boxGeometry args={[0.16, 0.2, 0.78]} />
          </mesh>
          {[-1, 1].map((sd) => (
            <mesh
              key={sd}
              position={[sd * 0.13, 0.44, -0.02]}
              rotation={[0.55, 0, sd * 0.14]}
              material={mats.frame}
            >
              <boxGeometry args={[0.045, 0.5, 0.1]} />
            </mesh>
          ))}
          {/* engine block with cylinder head */}
          <mesh position={[0, 0.47, -0.02]} rotation={[0.16, 0, 0]} material={mats.engine}>
            <boxGeometry args={[0.34, 0.3, 0.4]} />
          </mesh>
          <mesh position={[0, 0.63, 0.04]} rotation={[-0.42, 0, 0]} material={mats.engine}>
            <boxGeometry args={[0.28, 0.26, 0.3]} />
          </mesh>
          {/* cooling fins */}
          {Array.from({ length: 5 }, (_, i) => (
            <mesh key={i} position={[0, 0.58 + i * 0.035, 0.04]} rotation={[-0.42, 0, 0]} material={mats.engineDark}>
              <boxGeometry args={[0.31, 0.012, 0.32]} />
            </mesh>
          ))}
          {/* clutch cover */}
          <mesh position={[-0.18, 0.46, -0.06]} rotation={[0, 0, Math.PI / 2]} material={mats.darkChrome}>
            <cylinderGeometry args={[0.12, 0.12, 0.04, 20]} />
          </mesh>
          {/* radiator */}
          <mesh position={[0.16, 0.6, 0.44]} rotation={[0.1, 0, -0.16]} material={mats.engineDark}>
            <boxGeometry args={[0.05, 0.3, 0.26]} />
          </mesh>

          {/* ---- exhaust, underslung, sweeping up to a can ---- */}
          <mesh position={[-0.15, 0.3, 0.1]} rotation={[Math.PI / 2 - 0.14, 0, 0]} material={mats.exhaustDark}>
            <cylinderGeometry args={[0.038, 0.042, 0.62, 12]} />
          </mesh>
          <mesh
            position={[-0.19, 0.44, -0.34]}
            rotation={[Math.PI / 2 - 0.36, 0, 0.1]}
            material={mats.exhaust}
          >
            <cylinderGeometry args={[0.056, 0.048, 0.6, 14]} />
          </mesh>
          <mesh position={[-0.2, 0.52, -0.62]} rotation={[Math.PI / 2 - 0.4, 0, 0.1]} material={mats.exhaustDark}>
            <cylinderGeometry args={[0.058, 0.056, 0.12, 14]} />
          </mesh>

          {/* ---- footpegs + rear sets ---- */}
          {[-1, 1].map((sd) => (
            <mesh key={sd} position={[sd * 0.19, 0.3, -0.22]} rotation={[0, 0, Math.PI / 2]} material={mats.lever}>
              <cylinderGeometry args={[0.016, 0.016, 0.12, 8]} />
            </mesh>
          ))}

          {/* ---- tail unit + seat ---- */}
          <mesh position={[0, 0.86, -0.78]} rotation={[0.16, 0, 0]} material={mats.seat}>
            <boxGeometry args={[0.24, 0.11, 0.5]} />
          </mesh>
          <mesh position={[0, 0.93, -1.0]} rotation={[0.28, 0, 0]} material={mats.tail}>
            <boxGeometry args={[0.19, 0.16, 0.32]} />
          </mesh>
          <mesh position={[0, 0.97, -1.17]} material={mats.lensRed}>
            <boxGeometry args={[0.14, 0.05, 0.02]} />
          </mesh>
          <sprite ref={tailGlow} scale={[0.55, 0.36, 1]} material={sprites.red} />
          {/* tail bracket + plate */}
          <mesh position={[0, 0.84, -1.24]} rotation={[0.2, 0, 0]} material={mats.frame}>
            <boxGeometry args={[0.14, 0.16, 0.02]} />
          </mesh>

          {/* ---- fuel tank over the spine ---- */}
          <mesh position={[0, 0.88, 0.02]} rotation={[-0.06, 0, 0]} material={mats.tank}>
            <capsuleGeometry args={[0.15, 0.36, 6, 18]} />
          </mesh>
          <mesh position={[0, 0.83, 0.02]} rotation={[-0.06, 0, 0]} material={mats.tankDark}>
            <boxGeometry args={[0.3, 0.07, 0.5]} />
          </mesh>
          {/* filler cap */}
          <mesh position={[0, 1.0, -0.02]} rotation={[-0.06, 0, 0]} material={mats.chrome}>
            <cylinderGeometry args={[0.045, 0.045, 0.02, 14]} />
          </mesh>
          {/* knee recesses */}
          {[-1, 1].map((sd) => (
            <mesh key={sd} position={[sd * 0.14, 0.79, 0.14]} rotation={[0, 0, sd * 0.2]} material={mats.tankDark}>
              <sphereGeometry args={[0.07, 12, 10]} />
            </mesh>
          ))}

          {/* ---- front end: steering assembly ---- */}
          <group ref={steer}>
            {/* triple clamps + steering stem */}
            <mesh position={[0, 0.78, 0.6]} rotation={[0.3, 0, 0]} material={mats.frame}>
              <boxGeometry args={[0.1, 0.06, 0.14]} />
            </mesh>
            <mesh position={[0, 0.95, 0.56]} rotation={[0.3, 0, 0]} material={mats.frame}>
              <boxGeometry args={[0.1, 0.06, 0.14]} />
            </mesh>
            {/* handlebar + grips + levers + mirrors */}
            <mesh position={[0, 1.0, 0.53]} rotation={[0, 0, Math.PI / 2]} material={mats.darkChrome}>
              <cylinderGeometry args={[0.015, 0.015, 0.62, 10]} />
            </mesh>
            {[-1, 1].map((sd) => (
              <group key={sd}>
                <mesh position={[sd * 0.27, 1.0, 0.53]} rotation={[0, 0, Math.PI / 2]} material={mats.glove}>
                  <cylinderGeometry args={[0.022, 0.022, 0.11, 10]} />
                </mesh>
                <mesh position={[sd * 0.21, 1.0, 0.47]} rotation={[0, 0.5 * sd, 0]} material={mats.lever}>
                  <boxGeometry args={[0.11, 0.012, 0.03]} />
                </mesh>
                <mesh position={[sd * 0.19, 1.16, 0.5]} rotation={[0, 0, sd * 0.3]} material={mats.frame}>
                  <cylinderGeometry args={[0.01, 0.01, 0.16, 8]} />
                </mesh>
                <mesh position={[sd * 0.24, 1.24, 0.5]} rotation={[0, sd * 0.4, 0]} material={mats.glass}>
                  <boxGeometry args={[0.13, 0.07, 0.02]} />
                </mesh>
                {/* instrument cluster */}
                <mesh position={[sd * 0.1, 1.05, 0.55]} rotation={[-0.5, 0, 0]} material={mats.engineDark}>
                  <boxGeometry args={[0.09, 0.06, 0.02]} />
                </mesh>
              </group>
            ))}
            {/* headlight cowl + lens */}
            <mesh position={[0, 0.9, 0.66]} rotation={[0.22, 0, 0]} material={mats.fairing}>
              <boxGeometry args={[0.3, 0.22, 0.2]} />
            </mesh>
            <mesh position={[0, 0.89, 0.75]} rotation={[Math.PI / 2 + 0.22, 0, 0]} material={mats.lens}>
              <cylinderGeometry args={[0.085, 0.085, 0.03, 20]} />
            </mesh>
            <sprite ref={glow} scale={[1.1, 0.78, 1]} material={sprites.beam} />
            <spotLight
              ref={beam}
              position={[0, 0.9, 0.78]}
              angle={0.52}
              penumbra={0.62}
              intensity={70}
              distance={78}
              decay={1.6}
              color="#fff2cf"
              target={beamTarget}
            />
            {/* front mudguard */}
            <mesh position={[0, 0.62, 0.7]} rotation={[0.5, 0, 0]} material={mats.fairing}>
              <boxGeometry args={[0.16, 0.02, 0.42]} />
            </mesh>
            {/* fork: chromed upper tubes, sliding lower legs */}
            {[-1, 1].map((sd) => (
              <mesh
                key={sd}
                position={[sd * 0.115, 0.86, 0.61]}
                rotation={[0.28, 0, 0]}
                material={mats.chrome}
              >
                <cylinderGeometry args={[0.028, 0.028, 0.42, 12]} />
              </mesh>
            ))}
            <group ref={forkSlide}>
              {[-1, 1].map((sd) => (
                <group key={sd}>
                  <mesh position={[sd * 0.115, 0.6, 0.66]} rotation={[0.28, 0, 0]} material={mats.engineDark}>
                    <cylinderGeometry args={[0.042, 0.038, 0.44, 12]} />
                  </mesh>
                  <mesh position={[sd * 0.115, 0.71, 0.64]} rotation={[0.28, 0, 0]} material={mats.caliper}>
                    <cylinderGeometry args={[0.046, 0.046, 0.07, 12]} />
                  </mesh>
                </group>
              ))}
            </group>
            {/* front wheel */}
            <group position={[0, 0, WHEELBASE_F]}>
              <Wheel mats={mats} ride={wheels} rear={false} />
            </group>
          </group>

          <primitive object={beamTarget} />
        </group>
      </group>
    </group>
  )
}

/** Two additive sprites: the headlight flare and the tail-light glow. */
function useSpriteMats() {
  const beam = useMemo(() => {
    const cv = document.createElement('canvas')
    cv.width = cv.height = 64
    const ctx = cv.getContext('2d')!
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,250,228,1)')
    g.addColorStop(0.28, 'rgba(255,214,140,0.42)')
    g.addColorStop(1, 'rgba(255,190,90,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
    return spriteMat(new THREE.CanvasTexture(cv))
  }, [])
  const red = useMemo(() => {
    const cv = document.createElement('canvas')
    cv.width = cv.height = 64
    const ctx = cv.getContext('2d')!
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,130,130,1)')
    g.addColorStop(0.3, 'rgba(255,40,60,0.45)')
    g.addColorStop(1, 'rgba(255,0,40,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
    return spriteMat(new THREE.CanvasTexture(cv))
  }, [])
  return { beam, red }
}

function spriteMat(map: THREE.Texture) {
  map.colorSpace = THREE.SRGBColorSpace
  return new THREE.SpriteMaterial({
    map,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
}

export default memo(Motorcycle)
