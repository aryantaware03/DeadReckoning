// Procedural texture kitchen. Everything is drawn once into an offscreen
// canvas at load and handed to the GPU as a normal/roughness/AO set, so the
// tunnel has real surface detail (pores, stains, aggregate, tyre polish)
// without shipping a single image file.

import * as THREE from 'three'

const cache = new Map<string, THREE.Texture>()

function make(key: string, size: number, draw: (c: CanvasRenderingContext2D, s: number) => void): THREE.Texture {
  const hit = cache.get(key)
  if (hit) return hit
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const ctx = cv.getContext('2d')!
  draw(ctx, size)
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  cache.set(key, tex)
  return tex
}

function data(key: string, size: number, draw: (c: CanvasRenderingContext2D, s: number) => void): THREE.Texture {
  const hit = cache.get(key)
  if (hit) return hit
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const ctx = cv.getContext('2d')!
  draw(ctx, size)
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 4
  cache.set(key, tex)
  return tex
}

// deterministic value noise so every reload looks identical
function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function grain(ctx: CanvasRenderingContext2D, s: number, amount: number, seed: number) {
  const img = ctx.getImageData(0, 0, s, s)
  const d = img.data
  const rng = mulberry(seed)
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * amount
    d[i] = Math.max(0, Math.min(255, d[i] + n))
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n))
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n))
  }
  ctx.putImageData(img, 0, 0)
}

/** Blotchy large-scale discolouration, the thing that kills flatness. */
function blotches(ctx: CanvasRenderingContext2D, s: number, count: number, seed: number, maxR: number, alpha: number) {
  const rng = mulberry(seed)
  for (let i = 0; i < count; i++) {
    const x = rng() * s
    const y = rng() * s
    const r = (0.05 + rng() * 0.3) * maxR * s
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    const dark = rng() > 0.5
    g.addColorStop(0, dark ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha * 0.55})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
}

// ---- concrete: tunnel lining, walls, portals ------------------------------

export const concreteMap = () =>
  make('concrete', 512, (ctx, s) => {
    ctx.fillStyle = '#9a9a96'
    ctx.fillRect(0, 0, s, s)
    blotches(ctx, s, 26, 11, 0.5, 0.16)
    blotches(ctx, s, 14, 29, 0.34, 0.1)
    // formwork panel joints — the giveaway that concrete was cast in panels
    ctx.strokeStyle = 'rgba(0,0,0,0.16)'
    ctx.lineWidth = Math.max(1, s / 340)
    const cell = s / 4
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath()
      ctx.moveTo(i * cell, 0)
      ctx.lineTo(i * cell, s)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, i * cell)
      ctx.lineTo(s, i * cell)
      ctx.stroke()
    }
    // tie-rod holes
    const rng = mulberry(7)
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    for (let i = 0; i < 16; i++) {
      const x = cell * 0.5 + (i % 4) * cell
      const y = cell * 0.5 + Math.floor(i / 4) * cell
      ctx.beginPath()
      ctx.arc(x + (rng() - 0.5) * 6, y + (rng() - 0.5) * 6, s / 190, 0, Math.PI * 2)
      ctx.fill()
    }
    // vertical damp streaks from the crown
    for (let i = 0; i < 22; i++) {
      const x = rng() * s
      const h = (0.1 + rng() * 0.4) * s
      const g = ctx.createLinearGradient(0, 0, 0, h)
      g.addColorStop(0, 'rgba(40,44,42,0.22)')
      g.addColorStop(1, 'rgba(40,44,42,0)')
      ctx.fillStyle = g
      ctx.fillRect(x, 0, s / 90 + rng() * (s / 60), h)
    }
    grain(ctx, s, 26, 3)
  })

export const concreteRough = () =>
  data('concreteR', 512, (ctx, s) => {
    ctx.fillStyle = '#b4b4b4'
    ctx.fillRect(0, 0, s, s)
    blotches(ctx, s, 24, 11, 0.5, 0.2)
    blotches(ctx, s, 14, 29, 0.34, 0.14)
    grain(ctx, s, 34, 5)
  })

/** Height field → tangent-space normal map. Cheap Sobel, good enough. */
function heightToNormal(src: HTMLCanvasElement, strength: number): THREE.Texture {
  const s = src.width
  const sctx = src.getContext('2d')!
  const h = sctx.getImageData(0, 0, s, s).data
  const out = document.createElement('canvas')
  out.width = s
  out.height = s
  const octx = out.getContext('2d')!
  const img = octx.createImageData(s, s)
  const at = (x: number, y: number) => h[(((y + s) % s) * s + ((x + s) % s)) * 4] / 255
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) - (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) - (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
      let nx = dx * strength
      let ny = dy * strength
      const nz = 1
      const len = Math.hypot(nx, ny, nz) || 1
      const i = (y * s + x) * 4
      img.data[i] = ((nx / len) * 0.5 + 0.5) * 255
      img.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255
      img.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255
      img.data[i + 3] = 255
    }
  }
  octx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(out)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 4
  return tex
}

let concreteNormalCache: THREE.Texture | null = null
export const concreteNormal = () => {
  if (concreteNormalCache) return concreteNormalCache
  const cv = document.createElement('canvas')
  cv.width = cv.height = 256
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#808080'
  ctx.fillRect(0, 0, 256, 256)
  const rng = mulberry(19)
  // pores and small blowholes
  for (let i = 0; i < 1400; i++) {
    const r = 0.4 + rng() * 1.5
    ctx.fillStyle = `rgba(0,0,0,${0.08 + rng() * 0.22})`
    ctx.beginPath()
    ctx.arc(rng() * 256, rng() * 256, r, 0, Math.PI * 2)
    ctx.fill()
  }
  blotches(ctx, 256, 10, 11, 0.5, 0.07)
  grain(ctx, 256, 14, 13)
  concreteNormalCache = heightToNormal(cv, 0.9)
  return concreteNormalCache
}

export const asphaltRough = () =>
  data('asphaltR', 512, (ctx, s) => {
    ctx.fillStyle = '#cfcfcf'
    ctx.fillRect(0, 0, s, s)
    blotches(ctx, s, 30, 41, 0.55, 0.22)
    const rng = mulberry(23)
    for (let i = 0; i < 7000; i++) {
      const v = rng()
      ctx.fillStyle = v > 0.6 ? 'rgba(255,255,255,0.16)' : 'rgba(120,120,120,0.18)'
      ctx.beginPath()
      ctx.arc(rng() * s, rng() * s, 0.5 + rng() * 1.8, 0, Math.PI * 2)
      ctx.fill()
    }
    grain(ctx, s, 26, 37)
  })

let asphaltNormalCache: THREE.Texture | null = null
export const asphaltNormal = () => {
  if (asphaltNormalCache) return asphaltNormalCache
  const cv = document.createElement('canvas')
  cv.width = cv.height = 256
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#808080'
  ctx.fillRect(0, 0, 256, 256)
  const rng = mulberry(23)
  for (let i = 0; i < 5200; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.05 + rng() * 0.18})`
    ctx.beginPath()
    ctx.arc(rng() * 256, rng() * 256, 0.5 + rng() * 1.6, 0, Math.PI * 2)
    ctx.fill()
  }
  grain(ctx, 256, 34, 31)
  asphaltNormalCache = heightToNormal(cv, 1.5)
  return asphaltNormalCache
}

// ---- rock cut: the hillside the tunnel is bored through ------------------

export const rockMap = () =>
  make('rock', 512, (ctx, s) => {
    ctx.fillStyle = '#6e6a60'
    ctx.fillRect(0, 0, s, s)
    blotches(ctx, s, 40, 91, 0.6, 0.26)
    blotches(ctx, s, 22, 53, 0.4, 0.16)
    // strata bands
    const rng = mulberry(77)
    for (let i = 0; i < 30; i++) {
      const y = rng() * s
      const h = 3 + rng() * 16
      ctx.fillStyle = rng() > 0.5 ? `rgba(40,38,34,${0.1 + rng() * 0.16})` : `rgba(150,142,128,${0.08 + rng() * 0.14})`
      ctx.beginPath()
      ctx.moveTo(0, y)
      for (let x = 0; x <= s; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.03 + i) * 4)
      ctx.lineTo(s, y + h)
      for (let x = s; x >= 0; x -= 16) ctx.lineTo(x, y + h + Math.sin(x * 0.03 + i) * 4)
      ctx.closePath()
      ctx.fill()
    }
    // fracture lines
    ctx.strokeStyle = 'rgba(28,26,24,0.42)'
    for (let i = 0; i < 26; i++) {
      ctx.lineWidth = 0.7 + rng() * 2
      ctx.beginPath()
      let x = rng() * s
      let y = rng() * s
      ctx.moveTo(x, y)
      for (let k = 0; k < 5; k++) {
        x += (rng() - 0.5) * 90
        y += (rng() - 0.4) * 70
        ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    grain(ctx, s, 30, 83)
  })

// ---- the carriageway, with its paint baked in ---------------------------
// u runs across the road, v runs along it, and one tile covers LANE_TILE_M
// metres of length. Baking the paint into the surface is deliberate: a second
// coplanar ribbon of paint z-fights the road to death at grazing angles, and
// this way there is only ever one surface.

export const LANE_TILE_M = 12

export const roadSurfaceMap = () =>
  make('road', 1024, (ctx, s) => {
    // the canvas is square; stretch the length by drawing the along-axis twice
    ctx.fillStyle = '#3d4046'
    ctx.fillRect(0, 0, s, s)
    blotches(ctx, s, 34, 41, 0.5, 0.18)
    blotches(ctx, s, 20, 67, 0.3, 0.1)
    const rng = mulberry(23)

    // aggregate
    for (let i = 0; i < 22000; i++) {
      const v = rng()
      ctx.fillStyle = v > 0.62 ? `rgba(178,180,176,${0.05 + rng() * 0.16})` : `rgba(14,15,18,${0.05 + rng() * 0.2})`
      ctx.beginPath()
      ctx.arc(rng() * s, rng() * s, 0.6 + rng() * 1.8, 0, Math.PI * 2)
      ctx.fill()
    }
    // the two wheel tracks per lane, polished lighter by traffic
    for (const c of [0.27, 0.73]) {
      const g = ctx.createLinearGradient((c - 0.14) * s, 0, (c + 0.14) * s, 0)
      g.addColorStop(0, 'rgba(190,192,188,0)')
      g.addColorStop(0.5, 'rgba(190,192,188,0.1)')
      g.addColorStop(1, 'rgba(190,192,188,0)')
      ctx.fillStyle = g
      ctx.fillRect((c - 0.14) * s, 0, 0.28 * s, s)
    }
    // crack repairs
    ctx.strokeStyle = 'rgba(20,20,22,0.42)'
    for (let i = 0; i < 9; i++) {
      ctx.lineWidth = 1 + rng() * 2.5
      ctx.beginPath()
      let x = rng() * s
      let y = rng() * s
      ctx.moveTo(x, y)
      for (let k = 0; k < 7; k++) {
        x += (rng() - 0.5) * 80
        y += (rng() - 0.5) * 80
        ctx.lineTo(x, y)
      }
      ctx.stroke()
    }

    // ---- paint ----
    // solid edge lines just inside the shoulder
    ctx.fillStyle = 'rgba(226,226,219,0.88)'
    ctx.fillRect(s * 0.032, 0, s * 0.028, s)
    ctx.fillRect(s * 0.94, 0, s * 0.028, s)
    // dashed centre line: 3 m paint, 6 m gap over the 12 m tile
    ctx.fillStyle = 'rgba(232,226,202,0.8)'
    ctx.fillRect(s * 0.482, 0, s * 0.036, s * 0.25)
    ctx.fillRect(s * 0.482, s * 0.5, s * 0.036, s * 0.25)
    // wear the paint where the tyres cross it
    ctx.globalCompositeOperation = 'destination-out'
    for (let i = 0; i < 900; i++) {
      const onEdge = rng() > 0.5
      const x = onEdge ? (rng() > 0.5 ? s * 0.032 + rng() * s * 0.028 : s * 0.94 + rng() * s * 0.028) : s * 0.482 + rng() * s * 0.036
      ctx.fillStyle = `rgba(0,0,0,${0.15 + rng() * 0.6})`
      ctx.beginPath()
      ctx.arc(x, rng() * s, 0.8 + rng() * 3, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
    grain(ctx, s, 24, 31)
  })

/** A tiling clone, so a detail map can run at its own scale. */
function tiled(t: THREE.Texture, rx: number, ry: number): THREE.Texture {
  const c = t.clone()
  c.wrapS = c.wrapT = THREE.RepeatWrapping
  c.repeat.set(rx, ry)
  c.needsUpdate = true
  return c
}

let roadRoughCache: THREE.Texture | null = null
/** Roughness for the carriageway, running at a finer scale than the colour. */
export const roadRough = () => {
  if (!roadRoughCache) roadRoughCache = tiled(asphaltRough(), 6, 6)
  return roadRoughCache
}

let roadNormalCache: THREE.Texture | null = null
export const roadNormal = () => {
  if (!roadNormalCache) roadNormalCache = tiled(asphaltNormal(), 7, 7)
  return roadNormalCache
}

// ---- soft radial sprite: light bloom, headlight haze ---------------------

export const glowSprite = (
  key: string,
  inner = 'rgba(255,246,224,1)',
  mid = 'rgba(255,214,140,0.42)',
) =>
  make(key, 128, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
    g.addColorStop(0, inner)
    g.addColorStop(0.22, mid)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, s, s)
  })
