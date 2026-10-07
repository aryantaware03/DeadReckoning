// The tunnel. Not two flat walls and a lid: a real bored-tunnel cross-section
// — vertical side walls, a springing line, then an elliptical arch — swept
// along the road centreline, with cast segment rings, kerbs, an emergency
// walkway and a crown conduit. Everything is generated from the sim's own
// path, so the bore always follows the trajectory exactly.

import * as THREE from 'three'

export interface Pt {
  x: number
  z: number
  yaw: number
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Right-hand normal of a heading. yaw = 0 is +z, so right is +x. */
export const rx = (yaw: number) => Math.cos(yaw)
export const rz = (yaw: number) => -Math.sin(yaw)

// ---- the cross-section, in metres ----------------------------------------
export const TUNNEL = {
  halfWidth: 6.2, // side-wall half-span at the springing line
  wallHeight: 3.6, // vertical wall before the arch springs
  archRise: 4.4, // extra height at the crown
  kerbHeight: 0.17,
  kerbWidth: 0.5,
  laneHalf: 3.5, // painted carriageway half-width
} as const

const ARCH_STEPS = 26

export interface SectionPt {
  x: number
  y: number
  nx: number
  ny: number
}

/** Interior profile, right floor → right wall → arch → left wall → left floor. */
export const SECTION: SectionPt[] = (() => {
  const out: SectionPt[] = []
  const { halfWidth: W, wallHeight: H, archRise: A } = TUNNEL

  // right wall, up
  for (let i = 0; i <= 6; i++) {
    const y = (i / 6) * H
    out.push({ x: W, y, nx: -1, ny: 0 })
  }
  // arch, right springing over the crown to the left springing
  for (let i = 0; i <= ARCH_STEPS; i++) {
    const a = (i / ARCH_STEPS) * Math.PI
    const cx = -Math.cos(a) * W
    const cy = H + Math.sin(a) * A
    // ellipse inward normal
    let nx = -Math.cos(a) / W
    let ny = -Math.sin(a) / A
    const l = Math.hypot(nx, ny) || 1
    nx /= l
    ny /= l
    out.push({ x: cx, y: cy, nx, ny })
  }
  // left wall, down
  for (let i = 6; i >= 0; i--) {
    const y = (i / 6) * H
    out.push({ x: -W, y, nx: 1, ny: 0 })
  }
  return out
})()

/** Cumulative arc length along the profile — used for even UVs. */
const SECTION_ARC: number[] = (() => {
  const a: number[] = [0]
  for (let i = 1; i < SECTION.length; i++) {
    a.push(a[i - 1] + Math.hypot(SECTION[i].x - SECTION[i - 1].x, SECTION[i].y - SECTION[i - 1].y))
  }
  return a
})()

export const SECTION_LEN = SECTION_ARC[SECTION_ARC.length - 1]

/** Sample a smooth centreline at a fixed arc spacing. */
export function resample(pts: Pt[], spacing: number): Pt[] {
  if (pts.length < 2) return pts
  const out: Pt[] = [pts[0]]
  let carry = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const seg = Math.hypot(b.x - a.x, b.z - a.z)
    if (seg < 1e-6) continue
    let d = spacing - carry
    while (d <= seg) {
      const t = d / seg
      out.push({
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        yaw: a.yaw + (b.yaw - a.yaw) * t,
      })
      d += spacing
    }
    carry = (carry + seg) % spacing
  }
  out.push(pts[pts.length - 1])
  return out
}


// ---- builders -------------------------------------------------------------

/** Sweep the bore surface along the path. */
export function boreGeometry(pts: Pt[], scale = 1): THREE.BufferGeometry {
  const n = pts.length
  const m = SECTION.length
  const pos = new Float32Array(n * m * 3)
  const nor = new Float32Array(n * m * 3)
  const uv = new Float32Array(n * m * 2)
  const idx: number[] = []
  let run = 0

  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const a = pts[i - 1]
      const b = pts[i]
      run += Math.hypot(b.x - a.x, b.z - a.z)
    }
    const p = pts[i]
    const R = rx(p.yaw)
    const Z = rz(p.yaw)
    for (let j = 0; j < m; j++) {
      const s = SECTION[j]
      const lx = s.x * scale
      const ly = s.y * scale
      const o = (i * m + j) * 3
      pos[o] = p.x + R * lx
      pos[o + 1] = ly
      pos[o + 2] = p.z + Z * lx
      nor[o] = R * s.nx
      nor[o + 1] = s.ny
      nor[o + 2] = Z * s.nx
      const t = (i * m + j) * 2
      uv[t] = SECTION_ARC[j] * 0.32
      uv[t + 1] = run * 0.32
      if (i < n - 1 && j < m - 1) {
        const a = i * m + j
        idx.push(a, a + m, a + 1, a + 1, a + m, a + m + 1)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

/** Carriageway ribbon. UVs run u = 0..1 across the width and v = length in
 *  metres, so the caller sets vScale to 1/tileMetres for a road texture that
 *  spans the full width. */
export function roadGeometry(pts: Pt[], halfW: number, y: number, vScale = 0.28): THREE.BufferGeometry {
  const n = pts.length
  const pos = new Float32Array(n * 2 * 3)
  const nor = new Float32Array(n * 2 * 3)
  const uv = new Float32Array(n * 2 * 2)
  const idx: number[] = []
  let run = 0
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const a = pts[i - 1]
      const b = pts[i]
      run += Math.hypot(b.x - a.x, b.z - a.z)
    }
    const p = pts[i]
    const R = rx(p.yaw)
    const Z = rz(p.yaw)
    for (let k = 0; k < 2; k++) {
      const lx = k === 0 ? -halfW : halfW
      const o = (i * 2 + k) * 3
      pos[o] = p.x + R * lx
      pos[o + 1] = y
      pos[o + 2] = p.z + Z * lx
      nor[o + 1] = 1
      const t = (i * 2 + k) * 2
      uv[t] = k
      uv[t + 1] = run * vScale
      if (i < n - 1 && k === 0) {
        // wind counter-clockwise seen from above, or the road is culled and
        // you end up looking straight through it at the ground plane
        const a = i * 2
        idx.push(a, a + 2, a + 3, a, a + 3, a + 1)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

/** A side strip of constant cross-section: [lateral offset, height] pairs. */
export function stripGeometry(pts: Pt[], profile: [number, number][], vScale = 0.3): THREE.BufferGeometry {
  const n = pts.length
  const m = profile.length
  const pos = new Float32Array(n * m * 3)
  const nor = new Float32Array(n * m * 3)
  const uv = new Float32Array(n * m * 2)
  const idx: number[] = []
  let run = 0
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const a = pts[i - 1]
      const b = pts[i]
      run += Math.hypot(b.x - a.x, b.z - a.z)
    }
    const p = pts[i]
    const R = rx(p.yaw)
    const Z = rz(p.yaw)
    for (let j = 0; j < m; j++) {
      const [lx, ly] = profile[j]
      const o = (i * m + j) * 3
      pos[o] = p.x + R * lx
      pos[o + 1] = ly
      pos[o + 2] = p.z + Z * lx
      nor[o + 1] = 1
      const t = (i * m + j) * 2
      uv[t] = j / (m - 1)
      uv[t + 1] = run * vScale
      if (i < n - 1 && j < m - 1) {
        const a = i * m + j
        idx.push(a, a + 1, a + m, a + 1, a + m + 1, a + m)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

/** Vertical face only — kerb risers, portal returns, anything seen edge-on. */
export function faceGeometry(pts: Pt[], lx: number, y0: number, y1: number, facing: 1 | -1): THREE.BufferGeometry {
  const n = pts.length
  const pos = new Float32Array(n * 2 * 3)
  const nor = new Float32Array(n * 2 * 3)
  const uv = new Float32Array(n * 2 * 2)
  const idx: number[] = []
  let run = 0
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const a = pts[i - 1]
      const b = pts[i]
      run += Math.hypot(b.x - a.x, b.z - a.z)
    }
    const p = pts[i]
    const R = rx(p.yaw)
    const Z = rz(p.yaw)
    for (let k = 0; k < 2; k++) {
      const o = (i * 2 + k) * 3
      pos[o] = p.x + R * lx
      pos[o + 1] = k === 0 ? y0 : y1
      pos[o + 2] = p.z + Z * lx
      nor[o] = R * facing
      nor[o + 2] = Z * facing
      const t = (i * 2 + k) * 2
      uv[t] = run * 0.3
      uv[t + 1] = k
      if (i < n - 1) {
        const a = i * 2
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

/** Portal headwall: a slab that closes the bore, pierced by the arch. */
export function portalGeometry(): THREE.BufferGeometry {
  const { halfWidth: W, wallHeight: H, archRise: A } = TUNNEL
  const shape = new THREE.Shape()
  const ow = W + 2.6
  const oh = H + A + 1.5
  shape.moveTo(-ow, -0.4)
  shape.lineTo(ow, -0.4)
  shape.lineTo(ow, oh)
  shape.lineTo(-ow, oh)
  shape.closePath()

  const hole = new THREE.Path()
  hole.moveTo(W, -0.05)
  hole.lineTo(W, H)
  const steps = 28
  for (let i = 1; i <= steps; i++) {
    const a = (i / steps) * Math.PI
    hole.lineTo(-Math.cos(a) * W, H + Math.sin(a) * A)
  }
  hole.lineTo(-W, -0.05)
  hole.closePath()
  shape.holes.push(hole)

  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.9, bevelEnabled: false, curveSegments: 8 })
  g.translate(0, 0, -0.45)
  g.computeVertexNormals()
  return g
}

/** A cast segment ring — a proud band that follows the bore. */
export function ringGeometry(width = 0.16, proud = 0.14): THREE.BufferGeometry {
  const m = SECTION.length
  const pos: number[] = []
  const idx: number[] = []
  const l = SECTION_LEN
  for (let j = 0; j < m; j++) {
    const s = SECTION[j]
    // direction along the profile, so the band has real thickness
    const prev = SECTION[Math.max(0, j - 1)]
    const next = SECTION[Math.min(m - 1, j + 1)]
    let tx = next.x - prev.x
    let ty = next.y - prev.y
    const tl = Math.hypot(tx, ty) || 1
    tx /= tl
    ty /= tl
    const g = (SECTION_ARC[j] / l) * 2 - 1 // 0..2 around the bore
    const bow = Math.sin((g * Math.PI) / 2) // 0 at the ends, 1 at the crown
    const off = proud * bow
    const o = s.x + s.nx * -off
    const oy = s.y + s.ny * -off
    const half = (width / 2) * bow + 0.001
    pos.push(o - tx * half, oy - ty * half, 0)
    pos.push(o + tx * half, oy + ty * half, 0)
  }
  for (let j = 0; j < m - 1; j++) {
    const a = j * 2
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

