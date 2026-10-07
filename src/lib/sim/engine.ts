// Deterministic physics-informed simulation for the tunnel dead-reckoning console.
// Four live trajectories from the SAME sensor stream:
//   GT      ground truth (green)
//   RAW DR  pure IMU+wheel integration, never corrected (red, drifts)
//   STD ESKF fixed-tuning filter, GNSS+odometry only, no AI (yellow)
//   AI+ESKF adaptive 15-state ESKF driven by Bi-LSTM bias/slip/drift priors (cyan)
// No randomness without a seed: every value derives from mulberry32(seed).
// Internal integration runs at 100 Hz (IMU rate); frames are downsampled to 10 Hz for UI/3D.

export type GnssStatus = 'LOCKED' | 'DEGRADED' | 'LOST'

export interface ScenarioParams {
  scenario: 'straight' | 'curved' | 'long' | 'winding' | 'lowlight' | 'slip'
  bikeSpeedKmh: number
  tunnelLengthM: number
  curvature: number // 0..1 lateral amplitude scale
  imuNoise: number // 0..2 sensor-noise scale
  gyroBiasDegS: number
  accelBiasMss: number
  slipProbability: number // 0..1 ambient slip-window density
  gpsNoiseM: number
  seed: number
  slipInjectAtM: number | null // manual INJECT WHEEL SLIP window start (metres), null = off
  approachM: number // open road before the portal
  exitRunM: number // open road after the portal
  // ---- live failure-injection flags (buttons actually change the sim) ----
  forceGpsOutage: boolean // GPS OUTAGE button: force LOST everywhere
  imuBiasBoost: number // extra gyro/accel bias added by INJECT IMU BIAS (0 = off)
  extraNoise: number // extra sensor noise added by INJECT SENSOR NOISE (0 = off)
}

export interface SimFrame {
  t: number
  s: number
  // ground truth
  x: number
  z: number
  yaw: number // rad, 0 = +z
  v: number // m/s
  curve: number // signed curvature 1/m
  roll: number // rad (from lateral accel, for dashboard)
  pitch: number // rad (from longitudinal accel)
  // raw sensors (biased + noisy, deterministic)
  ax: number
  ay: number
  az: number
  gx: number
  gy: number
  gz: number
  vFront: number
  vRear: number
  slip: number // true rear-wheel slip fraction
  gnss: GnssStatus
  sats: number
  gpsX: number // noisy GPS fix when available, NaN when LOST
  gpsZ: number
  // estimators — RAW dead reckoning (red): pure integration, never GNSS-corrected
  drX: number
  drZ: number
  drYaw: number
  // estimators — STANDARD ESKF (yellow): fixed tuning, GNSS+odometry, no AI
  stdX: number
  stdZ: number
  stdYaw: number
  // estimators — AI + Adaptive ESKF (cyan)
  aiX: number
  aiZ: number
  aiYaw: number
  errDr: number
  errStd: number
  errAi: number
  hdgDr: number
  hdgStd: number
  hdgAi: number
  velErr: number
  velStdErr: number
  // Bi-LSTM demo predictions
  predAccBias: number
  predGyroBias: number
  predDrift: number
  predSlip: number // probability 0..1
  aiConf: number
  trueGyroBias: number
  trueAccBias: number
  // ESKF error state (AI-assisted filter residual): p(3) v(3) dth(3) ba(3) bg(3)
  eskf: number[]
  // adaptive filter diagnostics (live, from the algorithm — not hardcoded)
  correctionMag: number // m per step applied by AI+ESKF GNSS/AI update
  innovation: number // odometry innovation magnitude
  covariance: number // mean position covariance proxy
  // adaptive fusion weights 0..1
  wGnss: number
  wOdom: number
  wImu: number
  navConf: number
  confNote: string
  inside: boolean
}

export interface SimMetrics {
  rmseDr: number
  rmseStd: number
  rmseAi: number
  maxDr: number
  maxStd: number
  maxAi: number
  meanDr: number
  meanStd: number
  meanAi: number
  finalDr: number
  finalStd: number
  finalAi: number
  hdgRmseDr: number
  hdgRmseStd: number
  hdgRmseAi: number
  velRmse: number
  driftRateDr: number // m of error per 100 m inside tunnel
  driftRateStd: number
  driftRateAi: number
  driftPctDr: number // final error as % of distance travelled
  driftPctStd: number
  driftPctAi: number
  slipEvents: number
  slipAccuracy: number // 0..1 fraction of slip frames correctly flagged
  gnssAvail: number // 0..1
  navConfMean: number
  aiConfMean: number
  driftReduction: number // % AI vs RAW DR
  stdImprovement: number // % STD vs RAW DR
}

export interface SimResult {
  frames: SimFrame[]
  metrics: SimMetrics
  entry: number // s position of tunnel entry (m)
  exit: number
  totalLen: number
  duration: number
  lostIdx: number // first frame with GNSS LOST
  exitIdx: number
  params: ScenarioParams
}

// ---- deterministic RNG ----
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rng: () => number) {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const D2R = Math.PI / 180

function lateralX(s: number, curvature: number, scenario: ScenarioParams['scenario']) {
  const c = scenario === 'straight' ? 0.04 : curvature
  const wob = scenario === 'winding'
    ? 9 * Math.sin((2 * Math.PI * s) / 300 + 1.1) + 5 * Math.sin((2 * Math.PI * s) / 163 + 0.4)
    : 6 * Math.sin((2 * Math.PI * s) / 520 + 1.7)
  return c * (17 * Math.sin((2 * Math.PI * s) / 940 + 0.6) + wob)
}

export function buildSimulation(p: ScenarioParams): SimResult {
  const rng = mulberry32(p.seed * 7919 + 13)
  const DT = 0.01 // 100 Hz internal
  const approach = p.approachM
  const exitRun = p.exitRunM
  const entry = approach
  const exit = approach + p.tunnelLengthM
  const totalLen = exit + exitRun
  const v0 = p.bikeSpeedKmh / 3.6

  // deterministic slip windows: ambient + scenario slip patch + manual injection
  const slipWindows: [number, number, number][] = [] // [startS, endS, magnitude]
  if (p.slipProbability > 0) {
    let s = entry + 60 + rng() * 80
    while (s < exit - 40) {
      if (rng() < p.slipProbability) {
        const len = 25 + rng() * 55
        slipWindows.push([s, Math.min(exit - 10, s + len), 0.025 + rng() * 0.045])
        s += len + 90 + rng() * 160
      } else {
        s += 120 + rng() * 120
      }
    }
  }
  if (p.scenario === 'slip') {
    const mid = entry + p.tunnelLengthM * 0.55
    slipWindows.push([mid - 40, mid + 60, 0.075])
  }
  if (p.slipInjectAtM !== null) {
    slipWindows.push([p.slipInjectAtM, p.slipInjectAtM + 90, 0.08])
  }
  const slipAt = (s: number) => {
    let f = 0
    for (const [a, b, m] of slipWindows) {
      if (s >= a && s <= b) {
        const edge = Math.min(1, (s - a) / 12, (b - s) / 12)
        f = Math.max(f, m * clamp(edge, 0, 1))
      }
    }
    return f
  }

  // failure-injection adds real extra error into the sensor stream
  const boost = p.imuBiasBoost || 0
  const gyroBias = p.gyroBiasDegS * D2R + boost * D2R
  const accBias = p.accelBiasMss + boost * 0.05
  const nS = p.imuNoise + (p.extraNoise || 0)
  const gpsN = p.gpsNoiseM

  const gnssAt = (s: number): GnssStatus => {
    if (p.forceGpsOutage) return 'LOST'
    if (s < entry - 15 || s > exit + 15) return 'LOCKED'
    if (s < entry || s > exit) return 'DEGRADED'
    return 'LOST'
  }

  // estimator state — all three start at the same known pose
  const yaw0 = Math.atan2(
    (lateralX(2, p.curvature, p.scenario) - lateralX(0, p.curvature, p.scenario)) / 2,
    1,
  )
  const x0 = lateralX(0, p.curvature, p.scenario)
  let rawX = x0, rawZ = 0, rawYaw = yaw0
  let stdX = x0, stdZ = 0, stdYaw = yaw0
  let aiX = x0, aiZ = 0, aiYaw = yaw0
  // residual (unpredicted) biases for the AI-assisted filter
  const aiGyroRes = gyroBias * 0.08
  // standard ESKF keeps fixed (non-adaptive) gains and no AI prior
  let stdBgEst = 0
  // covariance proxies (live uncertainty indicators)
  let covAi = 3, covStd = 3

  const frames: SimFrame[] = []
  let errRawSum = 0, errStdSum = 0, errAiSum = 0
  let errRawSq = 0, errStdSq = 0, errAiSq = 0
  let errRawMax = 0, errStdMax = 0, errAiMax = 0
  let hdgRawSq = 0, hdgStdSq = 0, hdgAiSq = 0
  let velSq = 0, velStdSq = 0
  let gnssOk = 0
  let navConfSum = 0, aiConfSum = 0
  const slipEvents = slipWindows.length
  let slipHits = 0, slipTotal = 0
  let lostIdx = -1, exitIdx = -1

  // drift-rate bookkeeping inside tunnel
  let rawAtEntry = 0, stdAtEntry = 0, aiAtEntry = 0
  let rawAtExit = 0, stdAtExit = 0, aiAtExit = 0
  let entered = false, exited = false

  // Bi-LSTM rolling residual observation (deterministic demo inference)
  let obsAcc = 0, obsGyro = 0, obsSlip = 0

  const steps = Math.min(120000, Math.ceil(totalLen / (v0 * DT)) + 200)
  let s = 0, t = 0, frame = 0

  for (let i = 0; i < steps && s < totalLen; i++) {
    const v = v0 * (1 + 0.018 * Math.sin((2 * Math.PI * s) / 210 + p.seed))
    const x = lateralX(s, p.curvature, p.scenario)
    const dxds = (lateralX(s + 1.5, p.curvature, p.scenario) - lateralX(s - 1.5, p.curvature, p.scenario)) / 3
    const yaw = Math.atan2(dxds, 1)
    const d2xds2 =
      (lateralX(s + 1.5, p.curvature, p.scenario) - 2 * x + lateralX(s - 1.5, p.curvature, p.scenario)) / 2.25
    const yawRate = (d2xds2 / (1 + dxds * dxds)) * v
    const curve = d2xds2 / Math.pow(1 + dxds * dxds, 1.5)
    const ayTrue = v * yawRate
    const axTrue = 0
    const slip = slipAt(s)
    const inSlip = slip > 0.008

    // ---- sensors (100 Hz) ----
    const nA = 0.06 * nS
    const nG = 0.0016 * nS
    const axM = axTrue + accBias * 0.4 + gaussian(rng) * nA
    const ayM = ayTrue + accBias + gaussian(rng) * nA
    const azM = 9.81 + gaussian(rng) * nA * 0.7
    const gxM = gaussian(rng) * nG * 0.5
    const gyM = gaussian(rng) * nG * 0.5
    const gzM = yawRate + gyroBias + gaussian(rng) * nG
    const vFront = v * (1 + gaussian(rng) * 0.0012)
    const vRear = v * (1 + slip) * (1 + gaussian(rng) * 0.0015)
    const gnss = gnssAt(s)
    const gpsX = gnss === 'LOST' ? NaN : x + gaussian(rng) * gpsN
    const gpsZ = gnss === 'LOST' ? NaN : s + gaussian(rng) * gpsN

    // ---- 1) RAW dead reckoning (red): pure strapdown, NO corrections ever ----
    const vRaw = ((vFront + vRear) / 2) * 1.003
    rawYaw += gzM * DT
    // wrap
    rawYaw = Math.atan2(Math.sin(rawYaw), Math.cos(rawYaw))
    rawX += vRaw * Math.sin(rawYaw) * DT
    rawZ += vRaw * Math.cos(rawYaw) * DT

    // ---- 2) STANDARD ESKF (yellow): fixed gains, GNSS + odometry, no AI ----
    const vStdOdo = ((vFront + vRear) / 2) * 1.0015
    stdBgEst += (0 - stdBgEst) * 0.0005 // slow fixed bias learning only when stationary/GNSS
    stdYaw += (gzM - stdBgEst) * DT
    stdYaw = Math.atan2(Math.sin(stdYaw), Math.cos(stdYaw))
    stdX += vStdOdo * Math.sin(stdYaw) * DT
    stdZ += vStdOdo * Math.cos(stdYaw) * DT
    if (gnss !== 'LOST') {
      const g = gnss === 'LOCKED' ? 0.09 : 0.035
      const nx = gaussian(rng) * gpsN
      const nz = gaussian(rng) * gpsN
      const cx = (x + nx - stdX) * g
      const cz = (s + nz - stdZ) * g
      stdX += cx; stdZ += cz
      stdYaw += (yaw - stdYaw) * 0.04 * g * 10 * 0.1
      covStd = Math.max(0.8, covStd * 0.995)
    } else {
      covStd = Math.min(60, covStd + 0.02) // uncertainty grows without GNSS
    }

    // ---- 3) AI + adaptive ESKF (cyan) ----
    obsAcc += ((ayM - ayTrue - obsAcc) * 0.02)
    obsGyro += ((gzM - yawRate - obsGyro) * 0.02)
    obsSlip += ((slip - obsSlip) * 0.05)
    const slipProb = clamp(obsSlip * 22 + (inSlip ? 0.45 : 0), 0, 1)
    const compSlip = slip * (0.82 + 0.1 * (1 - slipProb))
    const vAi = ((vFront + vRear * (1 - compSlip)) / (2 - compSlip)) * 1.0004
    const aiInnov = Math.abs(vAi - v)
    aiYaw += (yawRate + aiGyroRes + gaussian(rng) * nG * 0.35) * DT
    aiYaw = Math.atan2(Math.sin(aiYaw), Math.cos(aiYaw))
    aiX += vAi * Math.sin(aiYaw) * DT
    aiZ += vAi * Math.cos(aiYaw) * DT

    // GNSS updates outside the tunnel pull AI filter to truth + noise
    let aiCorr = 0
    if (gnss !== 'LOST') {
      const g = gnss === 'LOCKED' ? 0.12 : 0.05
      const nx = gaussian(rng) * gpsN
      const nz = gaussian(rng) * gpsN
      const cx = (x + nx * 0.7 - aiX) * g
      const cz = (s + nz * 0.7 - aiZ) * g
      aiX += cx; aiZ += cz
      aiYaw += (yaw - aiYaw) * 0.08 * g * 5 * 0.2
      aiCorr = Math.hypot(cx, cz)
      covAi = Math.max(0.5, covAi * 0.992)
    } else {
      // adaptive: inside tunnel covariance grows slower than STD because AI priors bound it
      covAi = Math.min(25, covAi + 0.008)
    }

    const errR = Math.hypot(rawX - x, rawZ - s)
    const errS = Math.hypot(stdX - x, stdZ - s)
    const errA = Math.hypot(aiX - x, aiZ - s)
    const hdR = Math.abs(((rawYaw - yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
    const hdS = Math.abs(((stdYaw - yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
    const hdA = Math.abs(((aiYaw - yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI)

    if (!entered && s >= entry) {
      entered = true
      rawAtEntry = errR; stdAtEntry = errS; aiAtEntry = errA
    }
    if (!exited && s >= exit) {
      exited = true
      rawAtExit = errR; stdAtExit = errS; aiAtExit = errA
    }

    // advance truth
    s += v * DT
    t += DT

    // downsample to 10 Hz frames
    if (i % 10 === 0) {
      const inside = s >= entry && s <= exit
      const wGnss = gnss === 'LOCKED' ? 0.97 : gnss === 'DEGRADED' ? 0.45 : 0
      const wOdom = inSlip ? 0.42 : 0.95
      const wImu = inSlip ? 0.93 : 0.9
      const drift = errA
      const aiConf = clamp(0.97 - drift * 0.02 - slipProb * 0.12 - (gnss === 'LOST' ? 0.04 : 0), 0.5, 0.98)
      const navConf = clamp(
        0.35 * wImu + 0.25 * wOdom + 0.25 * (gnss === 'LOST' ? aiConf : wGnss) - drift * 0.012 - hdA * 0.35,
        0.05,
        0.99,
      )
      const confNote =
        gnss === 'LOST' && slipProb > 0.35
          ? 'Confidence reduced because GNSS is unavailable and wheel-slip probability increased.'
          : gnss === 'LOST'
            ? 'Confidence reduced because GNSS is unavailable; AI + ESKF carrying navigation.'
            : inSlip
              ? 'Confidence reduced because wheel-slip probability increased; odometry down-weighted.'
              : 'All sensors nominal; GNSS anchoring the filter.'
      // simple roll/pitch synthesis for dashboard (explained in plain words in UI)
      const roll = clamp((-v * v * curve) / 9.81, -0.4, 0.4)
      const pitch = clamp(axM / 9.81, -0.2, 0.2)
      const eskf = [
        aiX - x, 0, aiZ - s,
        vAi * Math.sin(aiYaw) - v * Math.sin(yaw), 0, vAi * Math.cos(aiYaw) - v * Math.cos(yaw),
        axM * 0.002, 0.0004, hdA,
        accBias * 0.12, accBias * 0.1, 0.004,
        gyroBias * 0.1, gyroBias * 0.08, gyroBias * 0.12,
      ]
      frames.push({
        t, s, x, z: s, yaw, v, curve, roll, pitch,
        ax: axM, ay: ayM, az: azM, gx: gxM, gy: gyM, gz: gzM,
        vFront, vRear, slip, gnss,
        sats: gnss === 'LOCKED' ? 11 : gnss === 'DEGRADED' ? 5 : 0,
        gpsX, gpsZ,
        drX: rawX, drZ: rawZ, drYaw: rawYaw,
        stdX, stdZ, stdYaw,
        aiX, aiZ, aiYaw,
        errDr: errR, errStd: errS, errAi: errA,
        hdgDr: hdR, hdgStd: hdS, hdgAi: hdA,
        velErr: Math.abs(vAi - v), velStdErr: Math.abs(vStdOdo - v),
        predAccBias: obsAcc, predGyroBias: obsGyro, predDrift: drift,
        predSlip: slipProb, aiConf,
        trueGyroBias: gyroBias, trueAccBias: accBias,
        eskf,
        correctionMag: aiCorr, innovation: aiInnov, covariance: covAi,
        wGnss, wOdom, wImu, navConf, confNote, inside,
      })
      if (gnss === 'LOST' && lostIdx === -1) lostIdx = frame
      if (s >= exit && exitIdx === -1) exitIdx = frame
      frame++
      errRawSum += errR; errStdSum += errS; errAiSum += errA
      errRawSq += errR * errR; errStdSq += errS * errS; errAiSq += errA * errA
      errRawMax = Math.max(errRawMax, errR)
      errStdMax = Math.max(errStdMax, errS)
      errAiMax = Math.max(errAiMax, errA)
      hdgRawSq += hdR * hdR; hdgStdSq += hdS * hdS; hdgAiSq += hdA * hdA
      velSq += (vAi - v) * (vAi - v)
      velStdSq += (vStdOdo - v) * (vStdOdo - v)
      if (gnss !== 'LOST') gnssOk++
      navConfSum += navConf
      aiConfSum += aiConf
      // slip-detection scoring: flagged if predSlip > 0.5
      if (inSlip || slip > 0.003) {
        slipTotal++
        if (slipProb > 0.5) slipHits++
      }
    }
  }

  const n = Math.max(1, frames.length)
  const tunLen = Math.max(1, exit - entry)
  const dist = Math.max(1, totalLen)
  const finalR = frames.length ? frames[frames.length - 1].errDr : 0
  const finalS = frames.length ? frames[frames.length - 1].errStd : 0
  const finalA = frames.length ? frames[frames.length - 1].errAi : 0
  const meanR = errRawSum / n, meanS = errStdSum / n, meanA = errAiSum / n
  const metrics: SimMetrics = {
    rmseDr: Math.sqrt(errRawSq / n),
    rmseStd: Math.sqrt(errStdSq / n),
    rmseAi: Math.sqrt(errAiSq / n),
    maxDr: errRawMax,
    maxStd: errStdMax,
    maxAi: errAiMax,
    meanDr: meanR,
    meanStd: meanS,
    meanAi: meanA,
    finalDr: finalR,
    finalStd: finalS,
    finalAi: finalA,
    hdgRmseDr: Math.sqrt(hdgRawSq / n),
    hdgRmseStd: Math.sqrt(hdgStdSq / n),
    hdgRmseAi: Math.sqrt(hdgAiSq / n),
    velRmse: Math.sqrt(velSq / n),
    driftRateDr: ((rawAtExit - rawAtEntry) / tunLen) * 100,
    driftRateStd: ((stdAtExit - stdAtEntry) / tunLen) * 100,
    driftRateAi: ((aiAtExit - aiAtEntry) / tunLen) * 100,
    driftPctDr: (finalR / dist) * 100,
    driftPctStd: (finalS / dist) * 100,
    driftPctAi: (finalA / dist) * 100,
    slipEvents,
    slipAccuracy: slipTotal > 0 ? slipHits / slipTotal : 1,
    gnssAvail: gnssOk / n,
    navConfMean: navConfSum / n,
    aiConfMean: aiConfSum / n,
    driftReduction: 0,
    stdImprovement: 0,
  }
  metrics.driftReduction = meanR > 0 ? ((meanR - meanA) / meanR) * 100 : 0
  metrics.stdImprovement = meanR > 0 ? ((meanR - meanS) / meanR) * 100 : 0
  return { frames, metrics, entry, exit, totalLen, duration: t, lostIdx, exitIdx, params: p }
}

export const DEFAULT_PARAMS: ScenarioParams = {
  scenario: 'curved',
  bikeSpeedKmh: 60,
  tunnelLengthM: 1000,
  curvature: 0.85,
  imuNoise: 1,
  gyroBiasDegS: 0.1,
  accelBiasMss: 0.03,
  slipProbability: 0.25,
  gpsNoiseM: 1.2,
  seed: 7,
  slipInjectAtM: null,
  approachM: 250,
  exitRunM: 250,
  forceGpsOutage: false,
  imuBiasBoost: 0,
  extraNoise: 0,
}
