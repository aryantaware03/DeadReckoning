// Compiles every corridor shader against a real WebGL context.
//
// Why this exists: a GLSL error passes `tsc` and `vite build` untouched and only
// shows up as a black canvas in the browser. Each pair in navshaders.ts is fed
// through three's own program compiler, which reports the same diagnostics the
// runtime would.
//
//   node check-shaders.mjs        needs Chrome/Edge on PATH resolution below
//
// Writes JSON to stdout: { ok, results: [{ name, ok, errors }] }

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Vite 8 bundles with rolldown, so that is what this uses. Resolved from
// node_modules by path rather than imported by name, so the check adds no
// dependency to the project.
const projectRoot = resolve(new URL('.', import.meta.url).pathname.replace(/^\//, ''))
const { build } = await import(
  pathToFileURL(join(projectRoot, 'node_modules/rolldown/dist/index.mjs')).href
)

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]

const browser = BROWSERS.find((p) => {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
})
if (!browser) {
  console.error('No Chrome or Edge found; cannot compile shaders.')
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'glsl-'))

// Bundle three + the shader sources into a self-contained IIFE the page loads.
const entry = join(work, 'entry.ts')
// Imported by absolute path: the entry lives in a temp directory, so a bare
// 'three' specifier would not resolve from the project's node_modules.
const threePath = join(projectRoot, 'node_modules/three/build/three.module.js').replace(/\\/g, '/')
writeFileSync(
  entry,
  `import * as THREE from ${JSON.stringify(threePath)}
import { NAV_SHADERS } from ${JSON.stringify(join(projectRoot, 'src/lib/navshaders.ts').replace(/\\/g, '/'))}
;(window as any).THREE = THREE
;(window as any).NAV_SHADERS = NAV_SHADERS
`,
)

const bundle = join(work, 'bundle.js')
await build({
  input: entry,
  platform: 'browser',
  output: { file: bundle, format: 'iife' },
})

const html = join(work, 'index.html')
writeFileSync(
  html,
  `<!doctype html><html><body><div id="out">pending</div>
<script src="bundle.js"></script>
<script>
(async () => {
  const out = document.getElementById('out')
  const results = []
  let renderer
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false })
    renderer.debug.checkShaderErrors = true
  } catch (e) {
    out.textContent = JSON.stringify({ ok: false, results, fatal: 'no webgl: ' + e.message })
    document.title = 'done'
    return
  }

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.z = 3

  for (const entry of NAV_SHADERS) {
    const errors = []
    const origError = console.error
    console.error = (...args) => { errors.push(args.map(String).join(' ')) }

    const uniforms = {}
    for (const name of entry.uniforms) {
      uniforms[name] = { value: /^(uColor|uTight|uLoose|uAccent|uPortal|uSlip)$/.test(name)
        ? new THREE.Color(0xffffff)
        : name.startsWith('u') ? 0.5 : 0 }
    }

    const mat = new THREE.ShaderMaterial({
      vertexShader: entry.vertex,
      fragmentShader: entry.fragment,
      uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })

    // The attributes the vertex shader declares have to exist on the geometry,
    // so build a small mesh carrying every one of them.
    const geo = new THREE.PlaneGeometry(1, 1, 1, 1)
    geo.setAttribute('aStation', new THREE.BufferAttribute(new Float32Array([0, 0.5, 0.5, 1]), 1))
    geo.setAttribute('aMajor', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 1]), 1))
    geo.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array([1, 2, 1, 2]), 1))
    geo.setAttribute('aSigma', new THREE.BufferAttribute(new Float32Array([1, 1, 3, 3]), 1))

    const mesh = new THREE.Mesh(geo, mat)
    scene.add(mesh)

    let threw = null
    try {
      renderer.render(scene, camera)
    } catch (e) {
      threw = e.message
    }

    console.error = origError
    scene.remove(mesh)
    geo.dispose()
    mat.dispose()

    results.push({ name: entry.name, ok: !threw && errors.length === 0, errors: threw ? [threw] : errors })
  }

  out.textContent = JSON.stringify({ ok: results.every(r => r.ok), results })
  document.title = 'done'
})()
</script></body></html>`,
)

const userDir = join(work, 'profile')
const proc = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--virtual-time-budget=15000',
    `--user-data-dir=${userDir}`,
    '--dump-dom',
    `file://${html.replace(/\\/g, '/')}`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

let dom = ''
proc.stdout.on('data', (d) => (dom += d))
await new Promise((resolve) => proc.on('close', resolve))

const match = dom.match(/<div id="out">([\s\S]*?)<\/div>/)
if (!match) {
  console.error('Could not read the result div from the page.')
  console.error(dom.slice(0, 800))
  process.exit(2)
}

const decoded = match[1]
  .replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&')

let payload
try {
  payload = JSON.parse(decoded)
} catch {
  console.error('Page reported:', decoded.slice(0, 400))
  process.exit(2)
}

for (const r of payload.results) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`)
  for (const e of r.errors) console.log(`         ${String(e).split('\n').slice(0, 6).join('\n         ')}`)
}
if (payload.fatal) console.log(`  fatal: ${payload.fatal}`)

rmSync(work, { recursive: true, force: true })
console.log(payload.ok ? '\nall shaders compiled' : '\nshader compilation failed')
process.exit(payload.ok ? 0 : 1)